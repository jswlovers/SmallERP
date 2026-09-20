import { encrypt, hashOtp, normalizePhone, phoneHash } from '../crypto.js';
import { HttpError, addDays, addMinutes, bad, dt, notFound, nowLocal, required, todayLocal } from '../util.js';
import { DEFAULT_SETTINGS, getSetting } from '../settings.js';
import { freeSlots } from '../schedule.js';
import { bookReservation } from './reservations.js';
import { nextCustomerNo } from './customers.js';
import { fire } from '../messaging.js';

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_PER_DAY = 8;
const PHONE_RE = /^01[0-9]\d{7,8}$/;

/**
 * 고객 셀프 예약(전화번호 인증 가입) 공개 API. 매장 직원 로그인과는 완전히 분리된 흐름이며
 * 이 라우트는 전역 인증 훅에서 제외되어(app.js) 자체적으로 인증을 처리한다.
 *   GET  /api/public/:code/info            매장/시술/직원 목록, 예약 정책 (공개)
 *   GET  /api/public/:code/availability     빈 시간 조회 (공개)
 *   POST /api/public/:code/otp/request      인증번호 발송
 *   POST /api/public/:code/otp/verify       인증번호 확인 → 로그인 토큰 발급(없으면 가입)
 *   GET  /api/public/:code/me               내 정보 (로그인 필요)
 *   PATCH /api/public/:code/me              이름 수정 (로그인 필요)
 *   GET  /api/public/:code/my-reservations  내 예약 목록 (로그인 필요)
 *   POST /api/public/:code/reservations     예약 생성 (로그인 필요)
 *   POST /api/public/:code/reservations/:id/cancel  내 예약 취소 (로그인 필요)
 */
export default function (app, ctx) {
  const { db } = ctx;
  const resend = new Map(); // `${shopId}:${phoneHash}` -> 마지막 발송 시각(ms), 재발송 쿨다운용

  const shopByCode = (code) => {
    const s = db.prepare('SELECT * FROM shop WHERE public_code = ?').get(code);
    if (!s) throw notFound('예약 페이지');
    if (!s.active) throw new HttpError(403, '이용이 정지된 매장입니다.');
    return s;
  };

  /** 고객 로그인 토큰(req.user.cust) 검증. 매장 직원/관리자 토큰은 cust 필드가 없어 자동으로 거부된다. */
  const custAuth = async (req) => {
    try { await req.jwtVerify(); } catch { throw new HttpError(401, '로그인이 필요합니다.'); }
    const shop = shopByCode(req.params.code);
    if (!Number.isInteger(req.user.cust) || req.user.shop !== shop.id) throw new HttpError(401, '로그인이 필요합니다.');
    const c = db.prepare('SELECT * FROM customer WHERE id = ? AND shop_id = ? AND deleted_at IS NULL').get(req.user.cust, shop.id);
    if (!c) throw new HttpError(401, '로그인이 필요합니다.');
    req.shop = shop;
    req.customer = c;
  };

  app.get('/api/public/:code/info', async (req) => {
    const shop = shopByCode(req.params.code);
    const booking = getSetting(db, shop.id, 'public_booking', DEFAULT_SETTINGS.public_booking);
    const services = db.prepare('SELECT id, name, category, price, duration_min FROM service WHERE shop_id = ? AND active = 1 ORDER BY category, name').all(shop.id);
    const staff = db.prepare('SELECT id, name FROM staff WHERE shop_id = ? AND active = 1 ORDER BY id').all(shop.id);
    return { shopName: shop.name, services, staff, booking };
  });

  app.get('/api/public/:code/availability', async (req) => {
    const shop = shopByCode(req.params.code);
    const { date, staffId } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('date(YYYY-MM-DD)가 필요합니다.');
    const ids = String(req.query.serviceIds || '').split(',').filter(Boolean).map(Number);
    if (!ids.length) throw bad('시술을 선택하세요.');
    const dur = ids.reduce((a, id) => a + (db.prepare('SELECT duration_min FROM service WHERE id = ? AND shop_id = ? AND active = 1').get(id, shop.id)?.duration_min ?? 0), 0);
    if (!dur) throw bad('올바르지 않은 시술입니다.');
    if (staffId) {
      if (!db.prepare('SELECT 1 FROM staff WHERE id = ? AND shop_id = ? AND active = 1').get(staffId, shop.id)) throw notFound('담당자');
      return { date, minutes: dur, slots: freeSlots(db, shop.id, Number(staffId), date, dur) };
    }
    const staff = db.prepare('SELECT id FROM staff WHERE shop_id = ? AND active = 1').all(shop.id);
    const set = new Set();
    for (const s of staff) for (const t of freeSlots(db, shop.id, s.id, date, dur)) set.add(t);
    return { date, minutes: dur, slots: [...set].sort() };
  });

  app.post('/api/public/:code/otp/request', async (req) => {
    const shop = shopByCode(req.params.code);
    required(req.body, 'phone');
    const phone = normalizePhone(req.body.phone);
    if (!PHONE_RE.test(phone)) throw bad('휴대폰 번호를 다시 확인해 주세요.');
    const ph = phoneHash(phone);
    const key = `${shop.id}:${ph}`;
    const last = resend.get(key) ?? 0;
    if (Date.now() - last < RESEND_COOLDOWN_MS) throw new HttpError(429, '잠시 후 다시 시도해 주세요.');
    const since = new Date(Date.now() - 86400000).toISOString();
    const dayCount = db.prepare('SELECT COUNT(*) n FROM otp_code WHERE shop_id = ? AND phone_hash = ? AND created_at >= ?').get(shop.id, ph, since).n;
    if (dayCount >= MAX_PER_DAY) throw new HttpError(429, '인증번호 요청 횟수를 초과했습니다. 잠시 후 다시 시도해 주세요.');
    const code = String(Math.floor(100000 + Math.random() * 900000));
    db.prepare('INSERT INTO otp_code(shop_id, phone_hash, code_hash, expires_at) VALUES (?,?,?,?)').run(shop.id, ph, hashOtp(code), new Date(Date.now() + OTP_TTL_MS).toISOString());
    resend.set(key, Date.now());
    const body = `[${shop.name}] 인증번호 ${code} (5분 이내 입력)`;
    try { await ctx.sms.send({ to: phone, body, isAd: false }); } catch { /* 발송 실패해도 devCode 로 테스트 진행 가능 */ }
    // 문자 에이전시 실연동 전 개발/테스트 편의: 운영 환경이 아니면 발급한 코드를 응답에 함께 보낸다.
    return { ok: true, ...(process.env.NODE_ENV === 'production' ? {} : { devCode: code }) };
  });

  app.post('/api/public/:code/otp/verify', async (req) => {
    const shop = shopByCode(req.params.code);
    required(req.body, 'phone', 'code');
    const phone = normalizePhone(req.body.phone);
    const ph = phoneHash(phone);
    const row = db.prepare('SELECT * FROM otp_code WHERE shop_id = ? AND phone_hash = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1').get(shop.id, ph);
    if (!row || row.expires_at < new Date().toISOString()) throw new HttpError(401, '인증번호가 만료되었습니다. 다시 요청해 주세요.');
    if (row.attempts >= MAX_ATTEMPTS) throw new HttpError(429, '시도 횟수를 초과했습니다. 인증번호를 다시 요청해 주세요.');
    if (hashOtp(String(req.body.code).trim()) !== row.code_hash) {
      db.prepare('UPDATE otp_code SET attempts = attempts + 1 WHERE id = ?').run(row.id);
      throw new HttpError(401, '인증번호가 올바르지 않습니다.');
    }
    db.prepare('UPDATE otp_code SET used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
    let cust = db.prepare('SELECT * FROM customer WHERE shop_id = ? AND phone_hash = ? AND deleted_at IS NULL').get(shop.id, ph);
    let created = false;
    if (!cust) {
      const name = String(req.body.name ?? '').trim().slice(0, 30) || `고객${phone.slice(-4)}`;
      const id = Number(
        db.prepare('INSERT INTO customer(shop_id, no, name, phone_enc, phone_hash, marketing_consent) VALUES (?,?,?,?,?,?)')
          .run(shop.id, nextCustomerNo(db, shop.id), name, encrypt(phone), ph, req.body.marketingConsent ? 1 : 0).lastInsertRowid,
      );
      cust = db.prepare('SELECT * FROM customer WHERE id = ?').get(id);
      created = true;
      await fire(ctx, shop.id, 'customer_created', cust, {}, `c${id}`);
    }
    const token = app.jwt.sign({ cust: cust.id, shop: shop.id }, { expiresIn: '90d' });
    return { token, created, name: cust.name };
  });

  app.get('/api/public/:code/me', { onRequest: custAuth }, async (req) => ({ id: req.customer.id, name: req.customer.name }));

  app.patch('/api/public/:code/me', { onRequest: custAuth }, async (req) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 30);
    if (!name) throw bad('이름을 입력해 주세요.');
    db.prepare('UPDATE customer SET name = ? WHERE id = ?').run(name, req.customer.id);
    return { ok: true };
  });

  app.get('/api/public/:code/my-reservations', { onRequest: custAuth }, async (req) =>
    db
      .prepare(
        `SELECT r.id, r.start_at, r.end_at, r.status, r.source, s.name AS staff_name,
                (SELECT group_concat(sv.name, ', ') FROM reservation_item ri JOIN service sv ON sv.id = ri.service_id WHERE ri.reservation_id = r.id) AS items
         FROM reservation r JOIN staff s ON s.id = r.staff_id
         WHERE r.shop_id = ? AND r.customer_id = ? ORDER BY r.start_at DESC LIMIT 50`,
      )
      .all(req.shop.id, req.customer.id),
  );

  app.post('/api/public/:code/reservations', { onRequest: custAuth }, async (req) => {
    const shop = req.shop;
    const b = req.body ?? {};
    required(b, 'startAt', 'serviceIds');
    const booking = getSetting(db, shop.id, 'public_booking', DEFAULT_SETTINGS.public_booking);
    if (!booking.enabled) throw new HttpError(403, '지금은 온라인 예약을 받지 않는 매장입니다. 전화로 문의해 주세요.');
    const start = dt(b.startAt, 'startAt');
    if (start < addMinutes(nowLocal(), booking.minLeadMinutes)) throw bad(`예약은 최소 ${booking.minLeadMinutes}분 전에 가능합니다.`);
    if (start.slice(0, 10) > addDays(todayLocal(), booking.maxDays)) throw bad(`예약은 최대 ${booking.maxDays}일 이내만 가능합니다.`);
    const staffId = b.staffId ? Number(b.staffId) : undefined;
    const status = booking.autoConfirm ? 'confirmed' : 'pending';
    return bookReservation(ctx, shop.id, {
      customerId: req.customer.id, staffId, startAt: start, serviceIds: b.serviceIds,
      status, source: 'public', memo: '고객 온라인 예약',
    });
  });

  app.post('/api/public/:code/reservations/:id/cancel', { onRequest: custAuth }, async (req) => {
    const shop = req.shop, c = req.customer;
    const r = db.prepare('SELECT * FROM reservation WHERE id = ? AND shop_id = ? AND customer_id = ?').get(req.params.id, shop.id, c.id);
    if (!r) throw notFound('예약');
    if (!['pending', 'confirmed', 'waiting'].includes(r.status)) throw bad('취소할 수 없는 예약입니다.');
    db.prepare("UPDATE reservation SET status = 'cancelled' WHERE id = ?").run(r.id);
    await fire(ctx, shop.id, 'reservation_cancelled', c, { date: r.start_at.slice(0, 10), time: r.start_at.slice(11) }, `r${r.id}`);
    return { ok: true };
  });
}
