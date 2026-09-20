import { tx } from '../db.js';
import { HttpError, addDays, bad, dt, int, notFound, nowLocal, required } from '../util.js';
import { METHODS, NO_EARN, creditBalance, pointBalance, pointRates, prepaidBalance, promoteGrade } from '../wallet.js';
import { audit } from '../audit.js';
import { fire, staffRecipient } from '../messaging.js';

export { METHODS };

export default function (app, ctx) {
  const { db } = ctx;

  app.get('/api/payments', async (req) => {
    const { from, to } = req.query;
    if (!from || !to) throw bad('from, to(YYYY-MM-DD)가 필요합니다.');
    return db
      .prepare(
        `SELECT p.*, c.name AS customer_name, s.name AS staff_name,
                (SELECT group_concat(name, ', ') FROM payment_item WHERE payment_id = p.id) AS items,
                (SELECT group_concat(method || ':' || amount, ' ') FROM payment_line WHERE payment_id = p.id) AS lines
         FROM payment p JOIN customer c ON c.id = p.customer_id JOIN staff s ON s.id = p.staff_id
         WHERE p.shop_id = ? AND p.paid_at >= ? AND p.paid_at < ? ORDER BY p.paid_at DESC`,
      )
      .all(req.user.shop, from, addDays(to, 1));
  });

  app.post('/api/payments', async (req) => {
    const b = req.body ?? {};
    required(b, 'customerId', 'staffId', 'items', 'lines');
    const shop = req.user.shop;
    const cust = db.prepare('SELECT * FROM customer WHERE id = ? AND shop_id = ? AND deleted_at IS NULL').get(b.customerId, shop);
    if (!cust) throw notFound('고객');
    if (!db.prepare('SELECT 1 FROM staff WHERE id = ? AND shop_id = ?').get(b.staffId, shop)) throw notFound('직원');
    if (!Array.isArray(b.items) || !b.items.length) throw bad('결제 항목이 필요합니다.');
    if (!Array.isArray(b.lines)) throw bad('결제 수단 형식이 올바르지 않습니다.');

    let resv = null;
    if (b.reservationId) {
      resv = db.prepare('SELECT * FROM reservation WHERE id = ? AND shop_id = ?').get(b.reservationId, shop);
      if (!resv) throw notFound('예약');
      if (db.prepare("SELECT 1 FROM payment WHERE reservation_id = ? AND status = 'paid'").get(resv.id)) throw new HttpError(409, '이미 결제된 예약입니다.');
    }

    const today = nowLocal().slice(0, 10);
    const passUse = new Map(); // passId -> 사용 횟수
    const items = b.items.map((it) => {
      const qty = it.qty === undefined ? 1 : int(it.qty, '수량');
      if (qty < 1) throw bad('수량은 1 이상이어야 합니다.');
      if (it.goodsId) {
        const g = db.prepare('SELECT * FROM goods WHERE id = ? AND shop_id = ?').get(it.goodsId, shop);
        if (!g) throw notFound('제품');
        return { goodsId: g.id, name: g.name, price: it.price === undefined ? g.price * qty : int(it.price, '가격'), qty };
      }
      if (it.serviceId) {
        const s = db.prepare('SELECT * FROM service WHERE id = ? AND shop_id = ?').get(it.serviceId, shop);
        if (!s) throw notFound('시술');
        if (it.usePassId) {
          const p = db.prepare('SELECT * FROM customer_pass WHERE id = ? AND shop_id = ? AND customer_id = ?').get(it.usePassId, shop, cust.id);
          if (!p) throw notFound('회원권');
          if (p.service_id && p.service_id !== s.id) throw bad('이 회원권으로 사용할 수 없는 시술입니다.');
          if (p.expires_at && p.expires_at < today) throw bad('유효기간이 지난 회원권입니다.');
          passUse.set(p.id, (passUse.get(p.id) ?? 0) + 1);
          if (passUse.get(p.id) > p.remaining) throw bad('회원권 잔여 횟수가 부족합니다.');
          return { serviceId: s.id, name: `${s.name} (회원권)`, price: 0, qty: 1, passId: p.id };
        }
        return { serviceId: s.id, name: s.name, price: it.price === undefined ? s.price : int(it.price, '가격'), qty: 1 };
      }
      required(it, 'name', 'price');
      return { name: it.name, price: int(it.price, '가격'), qty };
    });
    if (items.some((i) => i.price < 0)) throw bad('가격은 0 이상이어야 합니다.');
    const subtotal = items.reduce((a, i) => a + i.price, 0);

    let discount = 0;
    if (b.discountPresetId) {
      const d = db.prepare('SELECT * FROM discount_preset WHERE id = ? AND shop_id = ? AND active = 1').get(b.discountPresetId, shop);
      if (!d) throw notFound('할인');
      discount = d.kind === 'percent' ? Math.floor((subtotal * d.value) / 100) : d.value;
    } else if (b.discount) discount = int(b.discount, '할인');
    if (discount < 0 || discount > subtotal) throw bad('할인 금액이 올바르지 않습니다.');
    const total = subtotal - discount;

    const lines = b.lines.map((l) => {
      if (!METHODS.includes(l.method)) throw bad(`지원하지 않는 결제수단: ${l.method}`);
      const amount = int(l.amount, '결제금액');
      if (amount <= 0) throw bad('결제금액은 0보다 커야 합니다.');
      return { method: l.method, amount };
    });
    if (lines.reduce((a, l) => a + l.amount, 0) !== total) throw bad(`결제수단 합계가 총액(${total})과 일치해야 합니다.`);
    const sum = (m) => lines.filter((l) => l.method === m).reduce((a, l) => a + l.amount, 0);
    const prepaidUse = sum('prepaid');
    const pointUse = sum('point');
    const creditUse = sum('credit');
    const paidAt = b.paidAt ? dt(b.paidAt, 'paidAt') : nowLocal();
    const rates = pointRates(db, shop);

    const result = tx(db, () => {
      if (prepaidUse > prepaidBalance(db, shop, cust.id)) throw bad('선불권 잔액이 부족합니다.');
      if (pointUse > pointBalance(db, shop, cust.id)) throw bad('포인트 잔액이 부족합니다.');
      const pid = Number(
        db
          .prepare('INSERT INTO payment(shop_id, customer_id, staff_id, reservation_id, total, discount, paid_at, memo) VALUES (?,?,?,?,?,?,?,?)')
          .run(shop, cust.id, b.staffId, resv?.id ?? null, total, discount, paidAt, b.memo ?? '').lastInsertRowid,
      );
      const insI = db.prepare('INSERT INTO payment_item(payment_id, service_id, goods_id, name, price, qty) VALUES (?,?,?,?,?,?)');
      for (const i of items) insI.run(pid, i.serviceId ?? null, i.goodsId ?? null, i.name, i.price, i.qty);
      const insL = db.prepare('INSERT INTO payment_line(payment_id, method, amount) VALUES (?,?,?)');
      for (const l of lines) insL.run(pid, l.method, l.amount);

      if (prepaidUse) db.prepare("INSERT INTO prepaid_ledger(shop_id, customer_id, delta, reason, payment_id) VALUES (?,?,?, '결제 사용', ?)").run(shop, cust.id, -prepaidUse, pid);
      if (pointUse) db.prepare("INSERT INTO point_ledger(shop_id, customer_id, delta, reason, payment_id) VALUES (?,?,?, '결제 사용', ?)").run(shop, cust.id, -pointUse, pid);
      if (creditUse) db.prepare("INSERT INTO credit_ledger(shop_id, customer_id, delta, reason, payment_id) VALUES (?,?,?, '외상 결제', ?)").run(shop, cust.id, creditUse, pid);

      for (const i of items.filter((x) => x.goodsId)) {
        const g = db.prepare('SELECT stock FROM goods WHERE id = ?').get(i.goodsId);
        if (g.stock < i.qty) throw bad(`재고 부족: ${i.name}`);
        db.prepare('UPDATE goods SET stock = stock - ? WHERE id = ?').run(i.qty, i.goodsId);
        db.prepare("INSERT INTO goods_move(shop_id, goods_id, delta, kind, payment_id) VALUES (?,?,?, 'sale', ?)").run(shop, i.goodsId, -i.qty, pid);
      }
      for (const [passId, n] of passUse) {
        db.prepare('UPDATE customer_pass SET remaining = remaining - ? WHERE id = ?').run(n, passId);
        db.prepare("INSERT INTO pass_usage(pass_id, payment_id, delta, reason) VALUES (?,?,?, '결제 사용')").run(passId, pid, -n);
      }

      let earned = 0;
      for (const l of lines) if (!NO_EARN.includes(l.method)) earned += Math.floor((l.amount * (Number(rates[l.method]) || 0)) / 100);
      if (earned > 0) db.prepare("INSERT INTO point_ledger(shop_id, customer_id, delta, reason, payment_id) VALUES (?,?,?, '적립', ?)").run(shop, cust.id, earned, pid);

      if (resv) db.prepare("UPDATE reservation SET status = 'visited' WHERE id = ?").run(resv.id);
      const gradeUp = promoteGrade(db, shop, cust.id);
      return { id: pid, total, discount, earned, gradeUp };
    });

    // 업무 이벤트 문자 (실패해도 결제는 유지)
    const pid = result.id;
    const vars = { total, amount: total };
    await fire(ctx, shop, 'visit_thanks', cust, vars, `pay${pid}`);
    if (resv?.source === 'naver') await fire(ctx, shop, 'naver_review', cust, vars, `pay${pid}`);
    if (result.earned) await fire(ctx, shop, 'point_earned', cust, { ...vars, point: result.earned, balance: pointBalance(db, shop, cust.id) }, `pay${pid}`);
    if (pointUse) await fire(ctx, shop, 'point_used', cust, { ...vars, point: pointUse, balance: pointBalance(db, shop, cust.id) }, `pay${pid}`);
    if (prepaidUse) await fire(ctx, shop, 'stored_used', cust, { ...vars, used: prepaidUse, balance: prepaidBalance(db, shop, cust.id) }, `pay${pid}`);
    if (passUse.size) await fire(ctx, shop, 'pass_used', cust, vars, `pay${pid}`);
    return result;
  });

  app.post('/api/payments/:id/refund', async (req) => {
    const shop = req.user.shop;
    if (req.user.role !== 'owner') throw new HttpError(403, '환불은 사장 권한이 필요합니다.');
    const p = db.prepare('SELECT * FROM payment WHERE id = ? AND shop_id = ?').get(req.params.id, shop);
    if (!p) throw notFound('결제');
    if (p.status === 'refunded') throw new HttpError(409, '이미 환불된 결제입니다.');
    return tx(db, () => {
      const cid = p.customer_id;
      if (p.kind === 'pass_sale') {
        const pass = db.prepare('SELECT * FROM customer_pass WHERE payment_id = ?').get(p.id);
        if (pass && pass.remaining !== pass.total_count) throw new HttpError(409, '일부 사용한 회원권은 환불할 수 없습니다.');
        if (pass) {
          db.prepare('UPDATE customer_pass SET remaining = 0 WHERE id = ?').run(pass.id);
          db.prepare("INSERT INTO pass_usage(pass_id, payment_id, delta, reason) VALUES (?,?,?, '판매 환불')").run(pass.id, p.id, -pass.total_count);
        }
      }
      if (p.kind === 'stored_sale') {
        const credited = db.prepare('SELECT COALESCE(SUM(delta),0) v FROM prepaid_ledger WHERE payment_id = ? AND delta > 0').get(p.id).v;
        if (credited > prepaidBalance(db, shop, cid)) throw new HttpError(409, '정액권을 일부 사용해 환불할 수 없습니다.');
        db.prepare("INSERT INTO prepaid_ledger(shop_id, customer_id, delta, reason, payment_id) VALUES (?,?,?, '판매 환불', ?)").run(shop, cid, -credited, p.id);
      }
      db.prepare("UPDATE payment SET status = 'refunded' WHERE id = ?").run(p.id);
      const used = db.prepare("SELECT COALESCE(SUM(amount),0) a FROM payment_line WHERE payment_id = ? AND method = 'prepaid'").get(p.id).a;
      if (used) db.prepare("INSERT INTO prepaid_ledger(shop_id, customer_id, delta, reason, payment_id) VALUES (?,?,?, '환불 복원', ?)").run(shop, cid, used, p.id);
      const pointUsed = db.prepare("SELECT COALESCE(SUM(amount),0) a FROM payment_line WHERE payment_id = ? AND method = 'point'").get(p.id).a;
      if (pointUsed) db.prepare("INSERT INTO point_ledger(shop_id, customer_id, delta, reason, payment_id) VALUES (?,?,?, '환불 복원', ?)").run(shop, cid, pointUsed, p.id);
      const earned = db.prepare("SELECT COALESCE(SUM(delta),0) a FROM point_ledger WHERE payment_id = ? AND reason = '적립'").get(p.id).a;
      if (earned) db.prepare("INSERT INTO point_ledger(shop_id, customer_id, delta, reason, payment_id) VALUES (?,?,?, '적립 취소', ?)").run(shop, cid, -earned, p.id);
      const credit = db.prepare("SELECT COALESCE(SUM(delta),0) a FROM credit_ledger WHERE payment_id = ?").get(p.id).a;
      if (credit) db.prepare("INSERT INTO credit_ledger(shop_id, customer_id, delta, reason, payment_id) VALUES (?,?,?, '환불 정정', ?)").run(shop, cid, -credit, p.id);
      for (const u of db.prepare("SELECT * FROM pass_usage WHERE payment_id = ? AND reason = '결제 사용'").all(p.id)) {
        db.prepare('UPDATE customer_pass SET remaining = remaining - ? WHERE id = ?').run(u.delta, u.pass_id); // delta 는 음수 → 복원
        db.prepare("INSERT INTO pass_usage(pass_id, payment_id, delta, reason) VALUES (?,?,?, '환불 복원')").run(u.pass_id, p.id, -u.delta);
      }
      for (const m of db.prepare("SELECT * FROM goods_move WHERE payment_id = ? AND kind = 'sale'").all(p.id)) {
        db.prepare('UPDATE goods SET stock = stock - ? WHERE id = ?').run(m.delta, m.goods_id);
        db.prepare("INSERT INTO goods_move(shop_id, goods_id, delta, kind, memo, payment_id) VALUES (?,?,?, 'adjust', '환불 복원', ?)").run(shop, m.goods_id, -m.delta, p.id);
      }
      if (p.reservation_id) db.prepare("UPDATE reservation SET status = 'confirmed' WHERE id = ?").run(p.reservation_id);
      audit(db, req, 'payment.refund', `#${p.id} ${p.total}원`);
      return { ok: true, restoredPrepaid: used };
    });
  });
}
