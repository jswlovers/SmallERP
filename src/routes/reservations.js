import { timingSafeEqual } from 'node:crypto';
import { encrypt, normalizePhone, phoneHash } from '../crypto.js';
import { tx } from '../db.js';
import { HttpError, addDays, addMinutes, bad, dt, int, notFound, required } from '../util.js';
import { checkAvailability } from '../schedule.js';
import { fire, staffRecipient } from '../messaging.js';
import { nextCustomerNo } from './customers.js';

// pending 확인필요 · confirmed 예약확정 · waiting 대기중 · in_service 시술중 · visited 방문완료 · noshow 노쇼 · cancelled 취소
const STATUSES = ['pending', 'confirmed', 'waiting', 'in_service', 'visited', 'noshow', 'cancelled'];
const NOSHOW_FLAG_AT = 3; // 노쇼 누적 N회 이상이면 고객에 주의 표시

/** 시술 ID 목록 → 항목/총 소요시간 */
export function resolveServices(db, shop, serviceIds) {
  if (!Array.isArray(serviceIds) || !serviceIds.length) throw bad('시술을 1개 이상 선택하세요.');
  const items = serviceIds.map((id) => {
    const s = db.prepare('SELECT * FROM service WHERE id = ? AND shop_id = ? AND active = 1').get(id, shop);
    if (!s) throw notFound('시술');
    return s;
  });
  return { items, minutes: items.reduce((a, s) => a + s.duration_min, 0) };
}

export function assertStaff(db, shop, staffId) {
  if (!db.prepare('SELECT 1 FROM staff WHERE id = ? AND shop_id = ? AND active = 1').get(staffId, shop)) throw notFound('직원');
}

export function custOrThrow(db, shop, id) {
  const c = db.prepare('SELECT * FROM customer WHERE id = ? AND shop_id = ? AND deleted_at IS NULL').get(id, shop);
  if (!c) throw notFound('고객');
  return c;
}

export async function notifyStaff(ctx, shop, resv, customer) {
  const st = ctx.db.prepare('SELECT * FROM staff WHERE id = ?').get(resv.staff_id);
  if (st?.phone_enc)
    await fire(ctx, shop, 'staff_notify', staffRecipient(st), { customer: customer.name, date: resv.start_at.slice(0, 10), time: resv.start_at.slice(11) }, `sn${resv.id}`);
}

/**
 * 예약 생성 공통 로직. staffId 를 생략하면 해당 시간에 가능한 담당자를 자동 배정한다(고객 셀프 예약용).
 * status: 'confirmed' | 'pending' | 'waiting'. source: 'internal' | 'naver' | 'public'.
 */
export async function bookReservation(ctx, shop, { customerId, staffId, startAt, serviceIds, status = 'confirmed', source = 'internal', memo = '' }) {
  const { db } = ctx;
  const cust = custOrThrow(db, shop, customerId);
  const { items, minutes } = resolveServices(db, shop, serviceIds);
  const end = addMinutes(startAt, minutes);
  const result = tx(db, () => {
    let sid = staffId;
    if (sid) {
      assertStaff(db, shop, sid);
      const why = checkAvailability(db, shop, sid, startAt, end);
      if (why) throw new HttpError(409, why);
    } else {
      const candidates = db.prepare('SELECT id FROM staff WHERE shop_id = ? AND active = 1 ORDER BY id').all(shop).map((r) => r.id);
      sid = candidates.find((id) => !checkAvailability(db, shop, id, startAt, end));
      if (!sid) throw new HttpError(409, '선택하신 시간에 예약 가능한 담당자가 없습니다.');
    }
    const id = Number(
      db.prepare('INSERT INTO reservation(shop_id, customer_id, staff_id, start_at, end_at, status, source, memo) VALUES (?,?,?,?,?,?,?,?)')
        .run(shop, customerId, sid, startAt, end, status, source, memo).lastInsertRowid,
    );
    const ins = db.prepare('INSERT INTO reservation_item(reservation_id, service_id, price) VALUES (?,?,?)');
    for (const s of items) ins.run(id, s.id, s.price);
    return { id, endAt: end, staffId: sid };
  });
  const resv = db.prepare('SELECT * FROM reservation WHERE id = ?').get(result.id);
  const vars = { date: startAt.slice(0, 10), time: startAt.slice(11) };
  await fire(ctx, shop, status === 'pending' ? 'reservation_pending' : 'reservation_created', cust, vars, `r${result.id}`);
  await notifyStaff(ctx, shop, resv, cust);
  return { ...result, status };
}

export default function (app, ctx) {
  const { db } = ctx;

  const detail = (shop, where, ...params) =>
    db
      .prepare(
        `SELECT r.*, c.name AS customer_name, c.no AS customer_no, c.noshow_flag AS customer_noshow, s.name AS staff_name,
                (SELECT group_concat(sv.name, ', ') FROM reservation_item ri JOIN service sv ON sv.id = ri.service_id WHERE ri.reservation_id = r.id) AS items,
                (SELECT COALESCE(SUM(price),0) FROM reservation_item WHERE reservation_id = r.id) AS total
         FROM reservation r JOIN customer c ON c.id = r.customer_id JOIN staff s ON s.id = r.staff_id
         WHERE r.shop_id = ? ${where} ORDER BY r.start_at`,
      )
      .all(shop, ...params);

  app.get('/api/reservations', async (req) => {
    const { from, to, staffId } = req.query;
    if (!from || !to) throw bad('from, to(YYYY-MM-DD)가 필요합니다.');
    return detail(req.user.shop, `AND r.start_at >= ? AND r.start_at < ? AND (? IS NULL OR r.staff_id = ?)`, from, addDays(to, 1), staffId ?? null, staffId ?? null);
  });

  app.post('/api/reservations', async (req) => {
    const b = req.body ?? {};
    required(b, 'customerId', 'staffId', 'startAt', 'serviceIds');
    const shop = req.user.shop;
    const start = dt(b.startAt, 'startAt');
    const status = b.status && ['confirmed', 'pending', 'waiting'].includes(b.status) ? b.status : 'confirmed';
    return bookReservation(ctx, shop, { customerId: b.customerId, staffId: b.staffId, startAt: start, serviceIds: b.serviceIds, status, source: 'internal', memo: b.memo ?? '' });
  });

  app.patch('/api/reservations/:id', async (req) => {
    const shop = req.user.shop;
    const cur = db.prepare('SELECT * FROM reservation WHERE id = ? AND shop_id = ?').get(req.params.id, shop);
    if (!cur) throw notFound('예약');
    const b = req.body ?? {};
    if (b.status && !STATUSES.includes(b.status)) throw bad('올바르지 않은 상태입니다.');
    const staffId = b.staffId ?? cur.staff_id;
    if (b.staffId) assertStaff(db, shop, staffId);
    const start = b.startAt ? dt(b.startAt, 'startAt') : cur.start_at;
    const out = tx(db, () => {
      let end = cur.end_at;
      const timeChanged = b.startAt || b.serviceIds || b.staffId;
      if (b.serviceIds) {
        const { items, minutes } = resolveServices(db, shop, b.serviceIds);
        end = addMinutes(start, minutes);
        db.prepare('DELETE FROM reservation_item WHERE reservation_id = ?').run(cur.id);
        const ins = db.prepare('INSERT INTO reservation_item(reservation_id, service_id, price) VALUES (?,?,?)');
        for (const s of items) ins.run(cur.id, s.id, s.price);
      } else if (b.startAt) {
        end = addMinutes(start, (new Date(`${cur.end_at}:00Z`) - new Date(`${cur.start_at}:00Z`)) / 60000);
      }
      const status = b.status ?? cur.status;
      if (timeChanged && !['cancelled', 'noshow'].includes(status)) {
        const why = checkAvailability(db, shop, staffId, start, end, { excludeId: cur.id });
        if (why) throw new HttpError(409, why);
      }
      db.prepare('UPDATE reservation SET staff_id=?, start_at=?, end_at=?, status=?, memo=? WHERE id=?').run(staffId, start, end, status, b.memo ?? cur.memo, cur.id);
      if (status === 'noshow' && cur.status !== 'noshow') {
        const n = db.prepare("SELECT COUNT(*) n FROM reservation WHERE customer_id = ? AND status = 'noshow'").get(cur.customer_id).n;
        if (n >= NOSHOW_FLAG_AT) db.prepare('UPDATE customer SET noshow_flag = 1 WHERE id = ?').run(cur.customer_id);
      }
      return { ok: true, endAt: end, status };
    });
    if (b.status && b.status !== cur.status) {
      const cust = db.prepare('SELECT * FROM customer WHERE id = ?').get(cur.customer_id);
      if (b.status === 'cancelled') await fire(ctx, shop, 'reservation_cancelled', cust, { date: cur.start_at.slice(0, 10), time: cur.start_at.slice(11) }, `r${cur.id}`);
    }
    return out;
  });

  // 네이버 예약 연동용 웹훅 (공유 시크릿 헤더 인증). 같은 externalId 재수신은 갱신(멱등)으로 처리.
  //  body: { externalId, name, phone, startAt, durationMin?, status?('cancelled') }
  app.post('/api/webhooks/naver/:shopId', async (req) => {
    const secret = process.env.NAVER_WEBHOOK_SECRET;
    const given = String(req.headers['x-webhook-secret'] ?? '');
    if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) throw new HttpError(401, '인증 실패');
    const shop = int(req.params.shopId, 'shopId');
    if (!db.prepare('SELECT 1 FROM shop WHERE id = ?').get(shop)) throw notFound('매장');
    const b = req.body ?? {};
    required(b, 'externalId', 'name', 'startAt');
    const start = dt(b.startAt, 'startAt');

    const out = tx(db, () => {
      const existing = db.prepare("SELECT * FROM reservation WHERE shop_id = ? AND source = 'naver' AND external_id = ?").get(shop, String(b.externalId));
      if (existing) {
        if (b.status === 'cancelled') db.prepare("UPDATE reservation SET status = 'cancelled' WHERE id = ?").run(existing.id);
        return { id: existing.id, duplicate: true, cancelled: b.status === 'cancelled' };
      }
      const hash = phoneHash(b.phone);
      let cust = hash && db.prepare('SELECT * FROM customer WHERE shop_id = ? AND phone_hash = ? AND deleted_at IS NULL').get(shop, hash);
      if (!cust) {
        const id = Number(db.prepare('INSERT INTO customer(shop_id, no, name, phone_enc, phone_hash) VALUES (?,?,?,?,?)').run(shop, nextCustomerNo(db, shop), b.name, encrypt(normalizePhone(b.phone)), hash).lastInsertRowid);
        cust = db.prepare('SELECT * FROM customer WHERE id = ?').get(id);
      }
      const staff = db.prepare("SELECT id FROM staff WHERE shop_id = ? AND active = 1 ORDER BY (role='owner') DESC, id LIMIT 1").get(shop);
      const end = addMinutes(start, Number(b.durationMin) || 60);
      const why = checkAvailability(db, shop, staff.id, start, end);
      const memo = [why ? `네이버 예약: ${why} 확인 필요` : '', cust.noshow_flag ? '[노쇼주의 고객]' : ''].filter(Boolean).join(' ');
      const r = db
        .prepare("INSERT INTO reservation(shop_id, customer_id, staff_id, start_at, end_at, status, source, external_id, memo) VALUES (?,?,?,?,?,?, 'naver', ?, ?)")
        .run(shop, cust.id, staff.id, start, end, why ? 'pending' : 'confirmed', String(b.externalId), memo);
      return { id: Number(r.lastInsertRowid), conflict: !!why, customerId: cust.id, staffId: staff.id };
    });
    if (!out.duplicate) {
      const cust = db.prepare('SELECT * FROM customer WHERE id = ?').get(out.customerId);
      await fire(ctx, shop, 'naver_reservation', cust, { date: start.slice(0, 10), time: start.slice(11) }, `r${out.id}`);
      const resv = db.prepare('SELECT * FROM reservation WHERE id = ?').get(out.id);
      await notifyStaff(ctx, shop, resv, cust);
    }
    return out;
  });
}
