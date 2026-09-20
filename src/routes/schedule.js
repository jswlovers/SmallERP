import { HttpError, bad, crud, dt, int, notFound } from '../util.js';
import { freeSlots } from '../schedule.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 직원 근무 스케줄, 브레이크 타임, 휴무일, 예약금지 시간대, 빈 시간 조회 */
export default function (app, { db }) {
  const owner = (req) => { if (req.user.role !== 'owner') throw new HttpError(403, '사장 권한이 필요합니다.'); };
  const staffOf = (shop, id) => {
    const s = db.prepare('SELECT * FROM staff WHERE id = ? AND shop_id = ?').get(id, shop);
    if (!s) throw notFound('직원');
    return s;
  };

  // 요일별 근무시간(0=일 … 6=토). 행이 없는 요일은 매장 기본 영업시간을 따른다.
  app.get('/api/staff/:id/schedule', async (req) => {
    staffOf(req.user.shop, req.params.id);
    return db.prepare('SELECT weekday, off, start_time, end_time FROM staff_schedule WHERE staff_id = ? ORDER BY weekday').all(req.params.id);
  });

  app.put('/api/staff/:id/schedule', async (req) => {
    owner(req);
    const s = staffOf(req.user.shop, req.params.id);
    const days = req.body?.days;
    if (!Array.isArray(days)) throw bad('days 배열이 필요합니다.');
    const up = db.prepare(
      `INSERT INTO staff_schedule(staff_id, weekday, off, start_time, end_time) VALUES (?,?,?,?,?)
       ON CONFLICT(staff_id, weekday) DO UPDATE SET off = excluded.off, start_time = excluded.start_time, end_time = excluded.end_time`,
    );
    for (const d of days) {
      const wd = int(d.weekday, 'weekday');
      if (wd < 0 || wd > 6) throw bad('weekday 는 0~6 입니다.');
      const st = d.start ?? '09:00', en = d.end ?? '21:00';
      if (!HHMM.test(st) || !HHMM.test(en) || st >= en) throw bad('근무 시간이 올바르지 않습니다.');
      up.run(s.id, wd, d.off ? 1 : 0, st, en);
    }
    return { ok: true };
  });

  const inShop = async (req) => {
    if (req.body?.staffId) staffOf(req.user.shop, req.body.staffId);
    for (const k of ['startTime', 'endTime']) if (req.body?.[k] !== undefined && !HHMM.test(req.body[k])) throw bad(`${k} 형식은 HH:MM 입니다.`);
    if (req.body?.startAt) dt(req.body.startAt, 'startAt');
    if (req.body?.endAt) dt(req.body.endAt, 'endAt');
    if (req.body?.date && !/^\d{4}-\d{2}-\d{2}$/.test(req.body.date)) throw bad('date 형식은 YYYY-MM-DD 입니다.');
  };
  // crud 는 라우트를 직접 등록하므로, POST/PATCH 검증은 훅(preValidation)으로 걸기 위해 앱에 스코프를 만든다.
  app.register(async (scope) => {
    scope.addHook('preValidation', async (req) => { if (['POST', 'PATCH'].includes(req.method)) await inShop(req); });
    crud(scope, db, { path: '/api/breaks', table: 'staff_break', order: 'staff_id, weekday', ownerOnly: true, hasActive: false,
      fields: [{ key: 'staffId', col: 'staff_id', type: 'int', req: true }, { key: 'weekday', col: 'weekday', type: 'int' },
        { key: 'startTime', col: 'start_time', type: 'str', req: true }, { key: 'endTime', col: 'end_time', type: 'str', req: true }, { key: 'label', col: 'label', type: 'str', def: '브레이크' }] });
    crud(scope, db, { path: '/api/days-off', table: 'day_off', order: 'date DESC', ownerOnly: true, hasActive: false,
      fields: [{ key: 'staffId', col: 'staff_id', type: 'int' }, { key: 'date', col: 'date', type: 'str', req: true }, { key: 'reason', col: 'reason', type: 'str', def: '' }] });
    crud(scope, db, { path: '/api/blocks', table: 'time_block', order: 'start_at DESC', hasActive: false,
      fields: [{ key: 'staffId', col: 'staff_id', type: 'int' }, { key: 'startAt', col: 'start_at', type: 'str', req: true },
        { key: 'endAt', col: 'end_at', type: 'str', req: true }, { key: 'reason', col: 'reason', type: 'str', def: '' }] });
  });

  // 예약 가능 시간 조회: date(필수), staffId(선택), minutes(기본 60) 또는 serviceIds
  app.get('/api/availability', async (req) => {
    const shop = req.user.shop;
    const { date, staffId } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('date(YYYY-MM-DD)가 필요합니다.');
    let dur = Number(req.query.minutes ?? 0);
    if (!dur && req.query.serviceIds) {
      const ids = String(req.query.serviceIds).split(',').map(Number);
      dur = ids.reduce((a, id) => a + (db.prepare('SELECT duration_min FROM service WHERE id = ? AND shop_id = ?').get(id, shop)?.duration_min ?? 0), 0);
    }
    dur = dur || 60;
    const staff = staffId ? [staffOf(shop, staffId)] : db.prepare('SELECT * FROM staff WHERE shop_id = ? AND active = 1').all(shop);
    return { date, minutes: dur, staff: staff.map((s) => ({ staffId: s.id, name: s.name, slots: freeSlots(db, shop, s.id, date, dur) })) };
  });
}
