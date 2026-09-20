import { addDays, bad, todayLocal } from '../util.js';

export default function (app, { db }) {
  // 매출 통계 (환불 제외). 선불권 '사용'도 매출로 잡고, 충전액은 prepaidCharged 로 별도 표기한다.
  app.get('/api/stats/summary', async (req) => {
    const { from, to } = req.query;
    if (!from || !to) throw bad('from, to(YYYY-MM-DD)가 필요합니다.');
    const shop = req.user.shop;
    const end = addDays(to, 1);
    const P = "p.shop_id = ? AND p.status = 'paid' AND p.kind = 'service' AND p.paid_at >= ? AND p.paid_at < ?";
    const args = [shop, from, end];

    const totals = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS sales FROM payment p WHERE ${P}`).get(...args);
    const byDay = db.prepare(`SELECT substr(paid_at,1,10) AS day, COUNT(*) AS count, SUM(total) AS sales FROM payment p WHERE ${P} GROUP BY day ORDER BY day`).all(...args);
    const byStaff = db
      .prepare(
        `SELECT s.id, s.name, COUNT(*) AS count, SUM(p.total) AS sales, CAST(ROUND(SUM(p.total) * s.commission_rate / 100.0) AS INTEGER) AS commission
         FROM payment p JOIN staff s ON s.id = p.staff_id WHERE ${P} GROUP BY s.id ORDER BY sales DESC`,
      )
      .all(...args);
    const byService = db
      .prepare(`SELECT pi.name, COUNT(*) AS count, SUM(pi.price) AS sales FROM payment_item pi JOIN payment p ON p.id = pi.payment_id WHERE ${P} GROUP BY pi.name ORDER BY sales DESC`)
      .all(...args);
    const byMethod = db
      .prepare(`SELECT pl.method, SUM(pl.amount) AS amount FROM payment_line pl JOIN payment p ON p.id = pl.payment_id WHERE ${P} GROUP BY pl.method ORDER BY amount DESC`)
      .all(...args);

    const custs = db.prepare(`SELECT DISTINCT p.customer_id AS id FROM payment p WHERE ${P}`).all(...args);
    const firstPay = db.prepare("SELECT MIN(substr(paid_at,1,10)) d FROM payment WHERE customer_id = ? AND status = 'paid'");
    let newCount = 0;
    for (const c of custs) if (firstPay.get(c.id).d >= from) newCount++;

    const prepaidCharged = db
      .prepare("SELECT COALESCE(SUM(delta),0) v FROM prepaid_ledger WHERE shop_id = ? AND reason = '충전' AND substr(created_at,1,10) >= ? AND substr(created_at,1,10) <= ?")
      .get(shop, from, to).v;

    // 회원권/정액권 판매 입금액(매출과 분리 집계)
    const deposits = db.prepare("SELECT COALESCE(SUM(total),0) v FROM payment WHERE shop_id = ? AND status = 'paid' AND kind IN ('pass_sale','stored_sale') AND paid_at >= ? AND paid_at < ?").get(shop, from, end).v;
    return {
      ...totals, deposits,
      average: totals.count ? Math.round(totals.sales / totals.count) : 0,
      byDay, byStaff, byService, byMethod,
      customers: { total: custs.length, new: newCount, returning: custs.length - newCount },
      prepaidCharged,
    };
  });

  // 오늘의 현황 (대시보드)
  app.get('/api/stats/today', async (req) => {
    const shop = req.user.shop;
    const today = todayLocal();
    const next = addDays(today, 1);
    const resv = db
      .prepare('SELECT status, COUNT(*) AS n FROM reservation WHERE shop_id = ? AND start_at >= ? AND start_at < ? GROUP BY status')
      .all(shop, today, next);
    const sales = db
      .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS sales FROM payment WHERE shop_id = ? AND status = 'paid' AND kind = 'service' AND paid_at >= ? AND paid_at < ?")
      .get(shop, today, next);
    const upcoming = db
      .prepare(
        `SELECT r.id, r.start_at, c.name AS customer_name, s.name AS staff_name
         FROM reservation r JOIN customer c ON c.id = r.customer_id JOIN staff s ON s.id = r.staff_id
         WHERE r.shop_id = ? AND r.start_at >= ? AND r.start_at < ? AND r.status IN ('pending','confirmed') ORDER BY r.start_at`,
      )
      .all(shop, today, next);
    return { date: today, reservations: Object.fromEntries(resv.map((r) => [r.status, r.n])), ...sales, upcoming };
  });
}
