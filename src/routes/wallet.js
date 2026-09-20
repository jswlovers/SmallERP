import { tx } from '../db.js';
import { HttpError, addDays, bad, int, notFound, nowLocal, required, todayLocal } from '../util.js';
import { creditBalance, insertSale, pointBalance, prepaidBalance } from '../wallet.js';
import { audit } from '../audit.js';
import { fire } from '../messaging.js';
import { decrypt } from '../crypto.js';

/** 회원권(횟수)·정액권(예치금) 판매, 외상 수금, 포인트 조정, 잔액 조회 */
export default function (app, ctx) {
  const { db } = ctx;
  const cust = (shop, id) => {
    const c = db.prepare('SELECT * FROM customer WHERE id = ? AND shop_id = ? AND deleted_at IS NULL').get(id, shop);
    if (!c) throw notFound('고객');
    return c;
  };
  const staffOf = (req, b) => {
    const sid = b.staffId ?? req.user.sid;
    if (!db.prepare('SELECT 1 FROM staff WHERE id = ? AND shop_id = ?').get(sid, req.user.shop)) throw notFound('직원');
    return sid;
  };

  app.get('/api/customers/:id/wallet', async (req) => {
    const c = cust(req.user.shop, req.params.id);
    const today = todayLocal();
    return {
      prepaid: prepaidBalance(db, req.user.shop, c.id), prepaidExpiresAt: c.prepaid_expires_at,
      points: pointBalance(db, req.user.shop, c.id), credit: creditBalance(db, req.user.shop, c.id),
      passes: db.prepare('SELECT * FROM customer_pass WHERE customer_id = ? AND remaining > 0 AND (expires_at IS NULL OR expires_at >= ?) ORDER BY id DESC').all(c.id, today),
    };
  });

  // 회원권(횟수권) 판매
  app.post('/api/customers/:id/passes', async (req) => {
    const shop = req.user.shop;
    const b = req.body ?? {};
    required(b, 'productId', 'lines');
    const c = cust(shop, req.params.id);
    const p = db.prepare('SELECT * FROM pass_product WHERE id = ? AND shop_id = ? AND active = 1').get(b.productId, shop);
    if (!p) throw notFound('회원권 상품');
    const price = b.price === undefined ? p.price : int(b.price, '가격');
    const staffId = staffOf(req, b);
    const out = tx(db, () => {
      const pid = insertSale(db, shop, { customerId: c.id, staffId, name: `회원권: ${p.name}`, total: price, lines: b.lines, kind: 'pass_sale', paidAt: nowLocal() });
      const exp = p.valid_days > 0 ? addDays(todayLocal(), p.valid_days) : null;
      const id = Number(db.prepare('INSERT INTO customer_pass(shop_id, customer_id, product_id, name, service_id, total_count, remaining, price, expires_at, payment_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(shop, c.id, p.id, p.name, p.service_id, p.total_count, p.total_count, price, exp, pid).lastInsertRowid);
      db.prepare("INSERT INTO pass_usage(pass_id, payment_id, delta, reason) VALUES (?,?,?, '판매')").run(id, pid, p.total_count);
      return { id, paymentId: pid, expiresAt: exp };
    });
    await fire(ctx, shop, 'pass_sold', c, { pass: p.name, count: p.total_count, date: out.expiresAt ?? '' }, `pay${out.paymentId}`);
    return out;
  });

  // 정액권(예치금) 판매: 결제금액과 실제 사용가능금액(보너스 포함)을 분리해 기록
  app.post('/api/customers/:id/stored', async (req) => {
    const shop = req.user.shop;
    const b = req.body ?? {};
    required(b, 'lines');
    const c = cust(shop, req.params.id);
    let pay, credit, days, name;
    if (b.productId) {
      const p = db.prepare('SELECT * FROM stored_product WHERE id = ? AND shop_id = ? AND active = 1').get(b.productId, shop);
      if (!p) throw notFound('정액권 상품');
      ({ pay_amount: pay, credit_amount: credit, valid_days: days, name } = p);
    } else {
      pay = int(b.payAmount, '결제금액'); credit = int(b.creditAmount ?? b.payAmount, '사용가능금액'); days = int(b.validDays ?? 0, '유효일수'); name = '정액권';
    }
    if (pay <= 0 || credit < pay) throw bad('사용가능금액은 결제금액 이상이어야 합니다.');
    const staffId = staffOf(req, b);
    const out = tx(db, () => {
      const pid = insertSale(db, shop, { customerId: c.id, staffId, name: `정액권: ${name}`, total: pay, lines: b.lines, kind: 'stored_sale', paidAt: nowLocal() });
      db.prepare("INSERT INTO prepaid_ledger(shop_id, customer_id, delta, reason, payment_id) VALUES (?,?,?,?,?)").run(shop, c.id, credit, `정액권 충전(${name})`, pid);
      let exp = c.prepaid_expires_at;
      if (days > 0) { const n = addDays(todayLocal(), days); if (!exp || n > exp) exp = n; }
      db.prepare('UPDATE customer SET prepaid_expires_at = ? WHERE id = ?').run(exp, c.id);
      return { paymentId: pid, balance: prepaidBalance(db, shop, c.id), expiresAt: exp };
    });
    await fire(ctx, shop, 'stored_sold', c, { pay, credit, balance: out.balance, date: out.expiresAt ?? '' }, `pay${out.paymentId}`);
    return out;
  });

  // 외상 수금
  app.post('/api/customers/:id/credit/pay', async (req) => {
    const shop = req.user.shop;
    const c = cust(shop, req.params.id);
    const amount = int(req.body?.amount, '금액');
    if (amount <= 0) throw bad('금액이 올바르지 않습니다.');
    if (amount > creditBalance(db, shop, c.id)) throw bad('외상 잔액보다 많이 수금할 수 없습니다.');
    db.prepare("INSERT INTO credit_ledger(shop_id, customer_id, delta, reason) VALUES (?,?,?, ?)").run(shop, c.id, -amount, `외상 수금(${req.body?.method ?? 'cash'})`);
    return { credit: creditBalance(db, shop, c.id) };
  });

  app.get('/api/receivables', async (req) =>
    db
      .prepare(
        `SELECT c.id, c.no, c.name, SUM(l.delta) AS balance FROM credit_ledger l JOIN customer c ON c.id = l.customer_id
         WHERE l.shop_id = ? AND c.deleted_at IS NULL GROUP BY c.id HAVING balance > 0 ORDER BY balance DESC`,
      )
      .all(req.user.shop),
  );

  // 포인트 수동 조정 (사장)
  app.post('/api/customers/:id/points', async (req) => {
    if (req.user.role !== 'owner') throw new HttpError(403, '사장 권한이 필요합니다.');
    const shop = req.user.shop;
    const c = cust(shop, req.params.id);
    const delta = int(req.body?.delta, '포인트');
    if (delta === 0) throw bad('포인트가 0입니다.');
    if (pointBalance(db, shop, c.id) + delta < 0) throw bad('포인트 잔액이 부족합니다.');
    db.prepare('INSERT INTO point_ledger(shop_id, customer_id, delta, reason) VALUES (?,?,?,?)').run(shop, c.id, delta, req.body?.reason || '수동 조정');
    audit(db, req, 'point.adjust', `#${c.id} ${delta}`);
    return { points: pointBalance(db, shop, c.id) };
  });

  // 만료 임박 회원권/정액권 (기간 내)
  app.get('/api/expiring', async (req) => {
    const days = Number(req.query.days ?? 30);
    const today = todayLocal();
    const until = addDays(today, days);
    const passes = db
      .prepare(`SELECT p.*, c.name AS customer_name FROM customer_pass p JOIN customer c ON c.id = p.customer_id WHERE p.shop_id = ? AND p.remaining > 0 AND p.expires_at BETWEEN ? AND ? ORDER BY p.expires_at`)
      .all(req.user.shop, today, until);
    const stored = db
      .prepare(`SELECT c.id, c.name, c.prepaid_expires_at AS expires_at FROM customer c WHERE c.shop_id = ? AND c.prepaid_expires_at BETWEEN ? AND ? ORDER BY c.prepaid_expires_at`)
      .all(req.user.shop, today, until)
      .map((c) => ({ ...c, balance: prepaidBalance(db, req.user.shop, c.id) }))
      .filter((c) => c.balance > 0);
    return { passes, stored };
  });
}
