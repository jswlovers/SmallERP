import { HttpError, addDays, bad, crud, dt, int, notFound, nowLocal, required, todayLocal } from '../util.js';
import { audit } from '../audit.js';

const STANDBY_STATUS = ['waiting', 'in_service', 'done', 'cancelled'];

/** 고객 대기자 등록 (당일 번호표 자동 채번). 고객 등록 시 자동 대기 등록에서도 재사용 */
export function addStandby(db, shop, { customerId = null, name, staffId = null, memo = '' }) {
  const day = todayLocal();
  const n = db.prepare('SELECT COALESCE(MAX(number),0) + 1 AS n FROM standby WHERE shop_id = ? AND day = ?').get(shop, day).n;
  const r = db.prepare('INSERT INTO standby(shop_id, day, number, customer_id, name, staff_id, memo) VALUES (?,?,?,?,?,?,?)').run(shop, day, n, customerId, name, staffId, memo);
  return { id: Number(r.lastInsertRowid), number: n };
}

/** 대기 관리, 매장 현황판, 입출금, 출퇴근, 매장 일정 */
export default function (app, { db }) {
  const owner = (req) => { if (req.user.role !== 'owner') throw new HttpError(403, '사장 권한이 필요합니다.'); };

  // ---------- 대기(간편 접수) ----------
  app.get('/api/standby', async (req) =>
    db
      .prepare(
        `SELECT w.*, s.name AS staff_name FROM standby w LEFT JOIN staff s ON s.id = w.staff_id
         WHERE w.shop_id = ? AND w.day = ? ORDER BY w.number`,
      )
      .all(req.user.shop, req.query.day || todayLocal()),
  );

  app.post('/api/standby', async (req) => {
    const shop = req.user.shop;
    const b = req.body ?? {};
    let name = b.name;
    if (b.customerId) {
      const c = db.prepare('SELECT name FROM customer WHERE id = ? AND shop_id = ? AND deleted_at IS NULL').get(b.customerId, shop);
      if (!c) throw notFound('고객');
      name = c.name;
    }
    if (!name) throw bad('고객 또는 이름이 필요합니다.');
    if (b.staffId && !db.prepare('SELECT 1 FROM staff WHERE id = ? AND shop_id = ?').get(b.staffId, shop)) throw notFound('직원');
    return addStandby(db, shop, { customerId: b.customerId ?? null, name, staffId: b.staffId ?? null, memo: b.memo ?? '' });
  });

  app.patch('/api/standby/:id', async (req) => {
    const w = db.prepare('SELECT * FROM standby WHERE id = ? AND shop_id = ?').get(req.params.id, req.user.shop);
    if (!w) throw notFound('대기');
    const b = req.body ?? {};
    if (b.status && !STANDBY_STATUS.includes(b.status)) throw bad('올바르지 않은 상태입니다.');
    db.prepare('UPDATE standby SET status = ?, staff_id = ?, memo = ? WHERE id = ?').run(b.status ?? w.status, b.staffId ?? w.staff_id, b.memo ?? w.memo, w.id);
    return { ok: true };
  });

  // ---------- 매장 현황판(우측 패널): 예약중/대기중/시술중 + 오늘~+4일 건수 ----------
  app.get('/api/board', async (req) => {
    const shop = req.user.shop;
    const date = req.query.date || todayLocal();
    const resv = db
      .prepare(
        `SELECT r.id, r.status, substr(r.start_at,12) AS time, c.name AS customer, s.name AS staff, r.memo,
                (SELECT group_concat(sv.name, ', ') FROM reservation_item ri JOIN service sv ON sv.id = ri.service_id WHERE ri.reservation_id = r.id) AS menu
         FROM reservation r JOIN customer c ON c.id = r.customer_id JOIN staff s ON s.id = r.staff_id
         WHERE r.shop_id = ? AND substr(r.start_at,1,10) = ? AND r.status IN ('pending','confirmed','waiting','in_service') ORDER BY r.start_at`,
      )
      .all(shop, date)
      .map((r) => ({ type: 'reservation', ...r, group: r.status === 'in_service' ? 'in_service' : r.status === 'waiting' ? 'waiting' : 'reserved' }));
    const stand = db
      .prepare(
        `SELECT w.id, w.status, w.number, w.name AS customer, s.name AS staff, w.memo, substr(w.created_at,12,5) AS time
         FROM standby w LEFT JOIN staff s ON s.id = w.staff_id WHERE w.shop_id = ? AND w.day = ? AND w.status IN ('waiting','in_service') ORDER BY w.number`,
      )
      .all(shop, date)
      .map((w) => ({ type: 'standby', ...w, menu: '', group: w.status }));
    const rows = [...resv, ...stand];
    const days = [0, 1, 2, 3, 4].map((i) => {
      const d = addDays(date, i);
      return { date: d, count: db.prepare("SELECT COUNT(*) n FROM reservation WHERE shop_id = ? AND substr(start_at,1,10) = ? AND status IN ('pending','confirmed','waiting','in_service')").get(shop, d).n };
    });
    return {
      date, days, rows,
      counts: { all: rows.length, reserved: rows.filter((r) => r.group === 'reserved').length, waiting: rows.filter((r) => r.group === 'waiting').length, in_service: rows.filter((r) => r.group === 'in_service').length },
    };
  });

  // ---------- 입출금 관리 ----------
  crud(app, db, { path: '/api/cash-categories', table: 'cash_category', order: 'kind, name', ownerOnly: true,
    fields: [{ key: 'kind', col: 'kind', type: 'str', req: true }, { key: 'name', col: 'name', type: 'str', req: true }] });

  app.get('/api/cash', async (req) => {
    const { from, to } = req.query;
    if (!from || !to) throw bad('from, to(YYYY-MM-DD)가 필요합니다.');
    const entries = db
      .prepare(`SELECT e.*, c.name AS category FROM cash_entry e LEFT JOIN cash_category c ON c.id = e.category_id WHERE e.shop_id = ? AND e.date >= ? AND e.date <= ? ORDER BY e.date DESC, e.id DESC`)
      .all(req.user.shop, from, to);
    const sum = (k) => entries.filter((e) => e.kind === k).reduce((a, e) => a + e.amount, 0);
    return { entries, totalIn: sum('in'), totalOut: sum('out'), net: sum('in') - sum('out') };
  });

  app.post('/api/cash', async (req) => {
    const b = req.body ?? {};
    required(b, 'kind', 'amount');
    if (!['in', 'out'].includes(b.kind)) throw bad('kind 는 in/out 입니다.');
    const amount = int(b.amount, '금액');
    if (amount <= 0) throw bad('금액은 0보다 커야 합니다.');
    if (b.categoryId && !db.prepare('SELECT 1 FROM cash_category WHERE id = ? AND shop_id = ?').get(b.categoryId, req.user.shop)) throw notFound('계정 항목');
    const date = b.date ?? todayLocal();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('date 형식은 YYYY-MM-DD 입니다.');
    const r = db.prepare('INSERT INTO cash_entry(shop_id, kind, category_id, amount, memo, date, created_by) VALUES (?,?,?,?,?,?,?)').run(req.user.shop, b.kind, b.categoryId ?? null, amount, b.memo ?? '', date, req.user.sid);
    return { id: Number(r.lastInsertRowid) };
  });

  app.delete('/api/cash/:id', async (req) => {
    owner(req);
    db.prepare('DELETE FROM cash_entry WHERE id = ? AND shop_id = ?').run(req.params.id, req.user.shop);
    audit(db, req, 'cash.delete', `#${req.params.id}`);
    return { ok: true };
  });

  // ---------- 출퇴근 ----------
  app.post('/api/attendance/clock', async (req) => {
    const shop = req.user.shop;
    const staffId = req.body?.staffId ?? req.user.sid;
    if (staffId !== req.user.sid) owner(req);
    if (!db.prepare('SELECT 1 FROM staff WHERE id = ? AND shop_id = ? AND active = 1').get(staffId, shop)) throw notFound('직원');
    const now = nowLocal();
    const today = now.slice(0, 10);
    const row = db.prepare('SELECT * FROM attendance WHERE staff_id = ? AND date = ?').get(staffId, today);
    if (!row) {
      db.prepare('INSERT INTO attendance(shop_id, staff_id, date, clock_in) VALUES (?,?,?,?)').run(shop, staffId, today, now.slice(11));
      return { action: 'clock_in', time: now.slice(11) };
    }
    if (row.clock_out) throw new HttpError(409, '이미 퇴근 처리되었습니다.');
    db.prepare('UPDATE attendance SET clock_out = ? WHERE id = ?').run(now.slice(11), row.id);
    return { action: 'clock_out', time: now.slice(11) };
  });

  app.get('/api/attendance', async (req) => {
    const { from, to } = req.query;
    if (!from || !to) throw bad('from, to(YYYY-MM-DD)가 필요합니다.');
    return db
      .prepare('SELECT a.*, s.name AS staff_name FROM attendance a JOIN staff s ON s.id = a.staff_id WHERE a.shop_id = ? AND a.date >= ? AND a.date <= ? ORDER BY a.date DESC, s.name')
      .all(req.user.shop, from, to)
      .map((a) => {
        let hours = null;
        if (a.clock_in && a.clock_out) hours = Math.round(((Number(a.clock_out.slice(0, 2)) * 60 + Number(a.clock_out.slice(3)) - Number(a.clock_in.slice(0, 2)) * 60 - Number(a.clock_in.slice(3))) / 60) * 10) / 10;
        return { ...a, hours };
      });
  });

  app.patch('/api/attendance/:id', async (req) => {
    owner(req);
    const a = db.prepare('SELECT * FROM attendance WHERE id = ? AND shop_id = ?').get(req.params.id, req.user.shop);
    if (!a) throw notFound('출퇴근');
    const T = /^([01]\d|2[0-3]):[0-5]\d$/;
    for (const k of ['clockIn', 'clockOut']) if (req.body?.[k] && !T.test(req.body[k])) throw bad(`${k} 형식은 HH:MM 입니다.`);
    db.prepare('UPDATE attendance SET clock_in = ?, clock_out = ? WHERE id = ?').run(req.body?.clockIn ?? a.clock_in, req.body?.clockOut ?? a.clock_out, a.id);
    audit(db, req, 'attendance.edit', `#${a.id}`);
    return { ok: true };
  });

  // ---------- 매장 일정 ----------
  crud(app, db, { path: '/api/events', table: 'shop_event', order: 'date DESC', hasActive: false,
    fields: [{ key: 'date', col: 'date', type: 'str', req: true }, { key: 'title', col: 'title', type: 'str', req: true }, { key: 'memo', col: 'memo', type: 'str', def: '' }] });
}
