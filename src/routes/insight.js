import { HttpError, addDays, bad, int, notFound, required, todayLocal } from '../util.js';
import { audit } from '../audit.js';
import { decrypt, encrypt, normalizePhone } from '../crypto.js';
import { fire } from '../messaging.js';
import { DEFAULT_SETTINGS, getSetting } from '../settings.js';
import { pointBalance, prepaidBalance } from '../wallet.js';

const days = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
const pct = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);
const PAID = "p.status = 'paid' AND p.kind = 'service'";

/** 고객 동향, 예약 통계, 기간 비교, 성장률, 캘린더, 목표 달성, 급여, 일마감 */
export default function (app, ctx) {
  const { db } = ctx;
  const owner = (req) => { if (req.user.role !== 'owner') throw new HttpError(403, '사장 권한이 필요합니다.'); };
  const range = (req) => {
    const { from, to } = req.query;
    if (!from || !to) throw bad('from, to(YYYY-MM-DD)가 필요합니다.');
    return { from, to, end: addDays(to, 1) };
  };
  const salesOf = (shop, from, end) =>
    db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS sales, COUNT(DISTINCT customer_id) AS customers FROM payment p WHERE p.shop_id = ? AND ${PAID} AND p.paid_at >= ? AND p.paid_at < ?`).get(shop, from, end);

  const lastVisits = (shop) =>
    db
      .prepare(
        `SELECT c.id, c.no, c.name, c.phone_enc, c.marketing_consent, c.grade,
                (SELECT MAX(substr(paid_at,1,10)) FROM payment p WHERE p.customer_id = c.id AND ${PAID}) AS last_visit,
                (SELECT COUNT(*) FROM payment p WHERE p.customer_id = c.id AND ${PAID}) AS visits,
                (SELECT COALESCE(SUM(total),0) FROM payment p WHERE p.customer_id = c.id AND ${PAID}) AS spent
         FROM customer c WHERE c.shop_id = ? AND c.deleted_at IS NULL`,
      )
      .all(shop);

  // 고객 동향: 최근 방문 경과일 구간별 고객 수
  app.get('/api/insight/customer-trend', async (req) => {
    const today = todayLocal();
    const t = { total: 0, within2y: 0, d30: 0, d31_60: 0, d61_90: 0, d91_120: 0, d121_180: 0, over180: 0, never: 0 };
    for (const c of lastVisits(req.user.shop)) {
      t.total++;
      if (!c.last_visit) { t.never++; continue; }
      const d = days(c.last_visit, today);
      if (d <= 730) t.within2y++;
      if (d <= 30) t.d30++; else if (d <= 60) t.d31_60++; else if (d <= 90) t.d61_90++; else if (d <= 120) t.d91_120++; else if (d <= 180) t.d121_180++; else t.over180++;
    }
    return t;
  });

  // 휴면(미방문) 고객 목록. 문자 발송 화면과 연결하기 위해 수신동의 여부를 함께 준다.
  app.get('/api/insight/dormant', async (req) => {
    const min = Number(req.query.days ?? 90);
    const max = Number(req.query.maxDays ?? 100000);
    const today = todayLocal();
    return lastVisits(req.user.shop)
      .filter((c) => c.last_visit && days(c.last_visit, today) >= min && days(c.last_visit, today) <= max)
      .map(({ phone_enc, ...c }) => ({ ...c, phone: decrypt(phone_enc), daysSince: days(c.last_visit, today) }))
      .sort((a, b) => b.daysSince - a.daysSince)
      .slice(0, 500);
  });

  // 예약 동향: 상태·요일·시간대·경로별 분포와 노쇼율
  app.get('/api/insight/reservations', async (req) => {
    const { from, end } = range(req);
    const rows = db.prepare('SELECT status, source, start_at FROM reservation WHERE shop_id = ? AND start_at >= ? AND start_at < ?').all(req.user.shop, from, end);
    const byStatus = {}, bySource = {};
    const byWeekday = Array(7).fill(0), byHour = Array(24).fill(0);
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      bySource[r.source] = (bySource[r.source] ?? 0) + 1;
      if (r.status !== 'cancelled') {
        byWeekday[new Date(`${r.start_at.slice(0, 10)}T00:00:00Z`).getUTCDay()]++;
        byHour[Number(r.start_at.slice(11, 13))]++;
      }
    }
    const valid = rows.filter((r) => r.status !== 'cancelled').length;
    return { total: rows.length, byStatus, bySource, byWeekday, byHour, noshowRate: valid ? Math.round(((byStatus.noshow ?? 0) / valid) * 1000) / 10 : 0 };
  });

  // 기간 비교: 선택 기간 vs 직전 동일 길이 기간
  app.get('/api/insight/compare', async (req) => {
    const { from, to, end } = range(req);
    const len = days(from, to) + 1;
    const pFrom = addDays(from, -len), pEnd = from;
    const cur = salesOf(req.user.shop, from, end), prev = salesOf(req.user.shop, pFrom, pEnd);
    const avg = (x) => (x.count ? Math.round(x.sales / x.count) : 0);
    return {
      current: { from, to, ...cur, average: avg(cur) }, previous: { from: pFrom, to: addDays(from, -1), ...prev, average: avg(prev) },
      delta: { sales: pct(cur.sales, prev.sales), count: pct(cur.count, prev.count), average: pct(avg(cur), avg(prev)), customers: pct(cur.customers, prev.customers) },
    };
  });

  // 월별 성장률 (전월 대비 / 전년 동월 대비)
  app.get('/api/insight/growth', async (req) => {
    const year = Number(req.query.year ?? todayLocal().slice(0, 4));
    const q = db.prepare(`SELECT substr(paid_at,1,7) AS m, COUNT(*) AS count, SUM(total) AS sales FROM payment p WHERE p.shop_id = ? AND ${PAID} AND substr(paid_at,1,4) = ? GROUP BY m`);
    const cur = Object.fromEntries(q.all(req.user.shop, String(year)).map((r) => [r.m, r]));
    const prv = Object.fromEntries(q.all(req.user.shop, String(year - 1)).map((r) => [r.m, r]));
    let last = 0;
    return Array.from({ length: 12 }, (_, i) => {
      const mm = String(i + 1).padStart(2, '0');
      const c = cur[`${year}-${mm}`], p = prv[`${year - 1}-${mm}`];
      const row = { month: `${year}-${mm}`, sales: c?.sales ?? 0, count: c?.count ?? 0, prevYearSales: p?.sales ?? 0, mom: i ? pct(c?.sales ?? 0, last) : null, yoy: pct(c?.sales ?? 0, p?.sales ?? 0) };
      last = c?.sales ?? 0;
      return row;
    });
  });

  // 매출 캘린더: 월의 일자별 매출/건수/예약/일정
  app.get('/api/insight/calendar', async (req) => {
    const month = req.query.month ?? todayLocal().slice(0, 7);
    const shop = req.user.shop;
    const pay = Object.fromEntries(db.prepare(`SELECT substr(paid_at,1,10) AS d, COUNT(*) AS count, SUM(total) AS sales FROM payment p WHERE p.shop_id = ? AND ${PAID} AND substr(paid_at,1,7) = ? GROUP BY d`).all(shop, month).map((r) => [r.d, r]));
    const rsv = Object.fromEntries(db.prepare("SELECT substr(start_at,1,10) AS d, COUNT(*) AS n FROM reservation WHERE shop_id = ? AND substr(start_at,1,7) = ? AND status NOT IN ('cancelled','noshow') GROUP BY d").all(shop, month).map((r) => [r.d, r.n]));
    const ev = db.prepare('SELECT date, title FROM shop_event WHERE shop_id = ? AND substr(date,1,7) = ?').all(shop, month);
    const off = db.prepare('SELECT date, reason, staff_id FROM day_off WHERE shop_id = ? AND substr(date,1,7) = ?').all(shop, month);
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
    return Array.from({ length: last }, (_, i) => {
      const d = `${month}-${String(i + 1).padStart(2, '0')}`;
      return { date: d, sales: pay[d]?.sales ?? 0, count: pay[d]?.count ?? 0, reservations: rsv[d] ?? 0, events: ev.filter((e) => e.date === d).map((e) => e.title), daysOff: off.filter((o) => o.date === d).length };
    });
  });

  // 대체 결제(정액권·회원권 사용) 현황
  app.get('/api/insight/replacement', async (req) => {
    const { from, end } = range(req);
    const shop = req.user.shop;
    const prepaid = db.prepare(`SELECT p.paid_at, c.name AS customer, l.amount FROM payment_line l JOIN payment p ON p.id = l.payment_id JOIN customer c ON c.id = p.customer_id
      WHERE p.shop_id = ? AND p.status = 'paid' AND l.method = 'prepaid' AND p.paid_at >= ? AND p.paid_at < ? ORDER BY p.paid_at DESC`).all(shop, from, end);
    const passes = db.prepare(`SELECT u.created_at, c.name AS customer, cp.name AS pass, -u.delta AS used FROM pass_usage u JOIN customer_pass cp ON cp.id = u.pass_id JOIN customer c ON c.id = cp.customer_id
      WHERE cp.shop_id = ? AND u.reason = '결제 사용' AND substr(u.created_at,1,10) >= ? AND substr(u.created_at,1,10) < ? ORDER BY u.id DESC`).all(shop, from, end);
    return { prepaid, passes, prepaidTotal: prepaid.reduce((a, r) => a + r.amount, 0), passUses: passes.reduce((a, r) => a + r.used, 0) };
  });

  // 문자 방문율: 발송 후 7일 내 방문(결제)한 고객 비율
  app.get('/api/insight/sms-visits', async (req) => {
    const { from, end } = range(req);
    const shop = req.user.shop;
    const sent = db.prepare("SELECT DISTINCT customer_id, substr(sent_at,1,10) AS d FROM message_log WHERE shop_id = ? AND status = 'sent' AND customer_id IS NOT NULL AND sent_at >= ? AND sent_at < ?").all(shop, from, end);
    const visited = sent.filter((s) => db.prepare(`SELECT 1 FROM payment p WHERE p.customer_id = ? AND ${PAID} AND substr(p.paid_at,1,10) >= ? AND substr(p.paid_at,1,10) <= ?`).get(s.customer_id, s.d, addDays(s.d, 7))).length;
    return { sent: sent.length, visited, rate: sent.length ? Math.round((visited / sent.length) * 1000) / 10 : 0 };
  });

  // 전화번호 없는 임시 고객("손님") 목록 → 병합 대상 찾기
  app.get('/api/insight/guests', async (req) =>
    db.prepare(`SELECT c.id, c.no, c.name, (SELECT COUNT(*) FROM payment WHERE customer_id = c.id AND status = 'paid') AS payments FROM customer c
      WHERE c.shop_id = ? AND c.deleted_at IS NULL AND (c.phone_hash IS NULL OR c.name = '손님') ORDER BY c.id DESC LIMIT 200`).all(req.user.shop));

  // 직원 목표 대비 달성률
  app.get('/api/goals', async (req) => {
    const month = req.query.month ?? todayLocal().slice(0, 7);
    const shop = req.user.shop;
    return db.prepare('SELECT id, name FROM staff WHERE shop_id = ? AND active = 1').all(shop).map((s) => {
      const goal = db.prepare('SELECT amount FROM staff_goal WHERE staff_id = ? AND month = ?').get(s.id, month)?.amount ?? 0;
      const actual = db.prepare(`SELECT COALESCE(SUM(total),0) v FROM payment p WHERE p.shop_id = ? AND p.staff_id = ? AND ${PAID} AND substr(p.paid_at,1,7) = ?`).get(shop, s.id, month).v;
      return { staffId: s.id, name: s.name, month, goal, actual, rate: goal ? Math.round((actual / goal) * 1000) / 10 : null };
    });
  });

  app.put('/api/goals', async (req) => {
    owner(req);
    required(req.body, 'staffId', 'month', 'amount');
    if (!/^\d{4}-\d{2}$/.test(req.body.month)) throw bad('month 형식은 YYYY-MM 입니다.');
    if (!db.prepare('SELECT 1 FROM staff WHERE id = ? AND shop_id = ?').get(req.body.staffId, req.user.shop)) throw notFound('직원');
    db.prepare('INSERT INTO staff_goal(shop_id, staff_id, month, amount) VALUES (?,?,?,?) ON CONFLICT(staff_id, month) DO UPDATE SET amount = excluded.amount')
      .run(req.user.shop, req.body.staffId, req.body.month, int(req.body.amount, '목표'));
    return { ok: true };
  });

  // 급여: 기본급 + 매출 × 인센티브율
  app.get('/api/insight/payroll', async (req) => {
    owner(req);
    const month = req.query.month ?? todayLocal().slice(0, 7);
    const shop = req.user.shop;
    return db.prepare('SELECT * FROM staff WHERE shop_id = ? AND active = 1').all(shop).map((s) => {
      const st = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS sales FROM payment p WHERE p.shop_id = ? AND p.staff_id = ? AND ${PAID} AND substr(p.paid_at,1,7) = ?`).get(shop, s.id, month);
      const commission = Math.round((st.sales * s.commission_rate) / 100);
      const workDays = db.prepare('SELECT COUNT(*) n FROM attendance WHERE staff_id = ? AND substr(date,1,7) = ?').get(s.id, month).n;
      return { staffId: s.id, name: s.name, month, basePay: s.base_pay, sales: st.sales, count: st.count, rate: s.commission_rate, commission, total: s.base_pay + commission, workDays };
    });
  });

  // ---------- 일마감 ----------
  const closeSummary = (shop, date) => {
    const next = addDays(date, 1);
    const P = 'p.shop_id = ? AND p.paid_at >= ? AND p.paid_at < ?';
    const service = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS sales FROM payment p WHERE ${P} AND ${PAID}`).get(shop, date, next);
    const deposits = db.prepare(`SELECT COALESCE(SUM(total),0) v FROM payment p WHERE ${P} AND p.status = 'paid' AND p.kind IN ('pass_sale','stored_sale')`).get(shop, date, next).v;
    const refunds = db.prepare(`SELECT COALESCE(SUM(total),0) v FROM payment p WHERE ${P} AND p.status = 'refunded'`).get(shop, date, next).v;
    const byMethod = db.prepare(`SELECT l.method, SUM(l.amount) AS amount FROM payment_line l JOIN payment p ON p.id = l.payment_id WHERE ${P} AND p.status = 'paid' GROUP BY l.method ORDER BY amount DESC`).all(shop, date, next);
    const cashIn = db.prepare("SELECT COALESCE(SUM(amount),0) v FROM cash_entry WHERE shop_id = ? AND date = ? AND kind = 'in'").get(shop, date).v;
    const cashOut = db.prepare("SELECT COALESCE(SUM(amount),0) v FROM cash_entry WHERE shop_id = ? AND date = ? AND kind = 'out'").get(shop, date).v;
    const cashSales = byMethod.find((m) => m.method === 'cash')?.amount ?? 0;
    return { date, ...service, deposits, refunds, byMethod, cashIn, cashOut, expectedCash: cashSales + cashIn - cashOut };
  };

  app.get('/api/close', async (req) => {
    const date = req.query.date || todayLocal();
    const rec = db.prepare('SELECT * FROM daily_close WHERE shop_id = ? AND date = ?').get(req.user.shop, date);
    return { summary: closeSummary(req.user.shop, date), record: rec ? { ...rec, snapshot: JSON.parse(rec.snapshot) } : null };
  });

  app.get('/api/close/list', async (req) => {
    const { from, to } = range(req);
    return db.prepare('SELECT date, cash_counted, note, closed_at, snapshot FROM daily_close WHERE shop_id = ? AND date >= ? AND date <= ? ORDER BY date DESC').all(req.user.shop, from, to)
      .map((r) => { const s = JSON.parse(r.snapshot); return { date: r.date, sales: s.sales, expectedCash: s.expectedCash, cashCounted: r.cash_counted, diff: r.cash_counted == null ? null : r.cash_counted - s.expectedCash, closedAt: r.closed_at }; });
  });

  app.post('/api/close', async (req) => {
    owner(req);
    const shop = req.user.shop;
    const date = req.body?.date || todayLocal();
    const counted = req.body?.cashCounted === undefined || req.body.cashCounted === null ? null : int(req.body.cashCounted, '현금 실사액');
    const snap = closeSummary(shop, date);
    db.prepare(
      `INSERT INTO daily_close(shop_id, date, cash_counted, note, snapshot, closed_by) VALUES (?,?,?,?,?,?)
       ON CONFLICT(shop_id, date) DO UPDATE SET cash_counted = excluded.cash_counted, note = excluded.note, snapshot = excluded.snapshot, closed_by = excluded.closed_by, closed_at = datetime('now')`,
    ).run(shop, date, counted, req.body?.note ?? '', JSON.stringify(snap), req.user.sid);
    audit(db, req, 'close.save', `${date} 매출 ${snap.sales}`);
    // 일마감 매출 문자를 사장 휴대폰으로 발송 (설정 owner_phone 이 있을 때)
    const phone = getSetting(db, shop, 'owner_phone', DEFAULT_SETTINGS.owner_phone);
    if (phone) await fire(ctx, shop, 'daily_report', { id: null, name: '사장', phone_enc: encrypt(normalizePhone(phone)), marketing_consent: 1 }, { date, sales: snap.sales, count: snap.count }, `close${date}${Date.now()}`);
    return { ok: true, diff: counted == null ? null : counted - snap.expectedCash, summary: snap };
  });

  // 대시보드 보조 지표 (미수금 총액, 재고 부족, 만료 임박, 오늘 생일)
  app.get('/api/insight/dashboard', async (req) => {
    const shop = req.user.shop;
    const today = todayLocal();
    const md = today.slice(5);
    return {
      birthdays: db.prepare('SELECT id, name FROM customer WHERE shop_id = ? AND deleted_at IS NULL AND birth IS NOT NULL AND substr(birth, -5) = ?').all(shop, md),
      lowStock: db.prepare('SELECT COUNT(*) n FROM goods WHERE shop_id = ? AND active = 1 AND stock <= min_stock').get(shop).n,
      receivable: db.prepare('SELECT COALESCE(SUM(delta),0) v FROM credit_ledger WHERE shop_id = ?').get(shop).v,
      passesExpiring: db.prepare('SELECT COUNT(*) n FROM customer_pass WHERE shop_id = ? AND remaining > 0 AND expires_at BETWEEN ? AND ?').get(shop, today, addDays(today, 30)).n,
      standbyWaiting: db.prepare("SELECT COUNT(*) n FROM standby WHERE shop_id = ? AND day = ? AND status = 'waiting'").get(shop, today).n,
    };
  });
}
