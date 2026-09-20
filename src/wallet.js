import { DEFAULT_SETTINGS, getSetting } from './settings.js';
import { HttpError, bad, todayLocal } from './util.js';

export const METHODS = ['cash', 'card', 'prepaid', 'naverpay', 'etc', 'point', 'credit'];
/** 포인트 적립 대상에서 제외되는 결제수단(잔액성 수단) */
export const NO_EARN = ['prepaid', 'point', 'credit'];

/** 정액권 잔액. 유효기간이 지났으면 잔액을 '기간만료 소멸'로 정리한 뒤 0 을 돌려준다. */
export function prepaidBalance(db, shop, customerId) {
  let b = db.prepare('SELECT COALESCE(SUM(delta),0) AS b FROM prepaid_ledger WHERE shop_id = ? AND customer_id = ?').get(shop, customerId).b;
  if (b > 0) {
    const c = db.prepare('SELECT prepaid_expires_at AS e FROM customer WHERE id = ?').get(customerId);
    if (c?.e && c.e < todayLocal()) {
      db.prepare("INSERT INTO prepaid_ledger(shop_id, customer_id, delta, reason) VALUES (?,?,?, '기간만료 소멸')").run(shop, customerId, -b);
      b = 0;
    }
  }
  return b;
}

export const pointBalance = (db, shop, customerId) =>
  db.prepare('SELECT COALESCE(SUM(delta),0) AS b FROM point_ledger WHERE shop_id = ? AND customer_id = ?').get(shop, customerId).b;

export const creditBalance = (db, shop, customerId) =>
  db.prepare('SELECT COALESCE(SUM(delta),0) AS b FROM credit_ledger WHERE shop_id = ? AND customer_id = ?').get(shop, customerId).b;

export const pointRates = (db, shop) => getSetting(db, shop, 'point_rates', DEFAULT_SETTINGS.point_rates);

/** 방문 횟수·누적 결제액 기준으로 더 높은 등급 조건을 만족하면 승급(강등 없음). 승급한 등급명을 반환. */
export function promoteGrade(db, shop, customerId) {
  const rules = db.prepare('SELECT * FROM grade_rule WHERE shop_id = ? ORDER BY rank').all(shop);
  if (!rules.length) return null;
  const st = db.prepare("SELECT COUNT(*) AS v, COALESCE(SUM(total),0) AS t FROM payment WHERE shop_id = ? AND customer_id = ? AND status = 'paid' AND kind = 'service'").get(shop, customerId);
  const cur = db.prepare('SELECT grade FROM customer WHERE id = ?').get(customerId);
  const curRank = rules.find((r) => r.name === cur.grade)?.rank ?? -Infinity;
  let best = null;
  for (const r of rules) if (st.v >= r.min_visits && st.t >= r.min_spent && (r.min_visits > 0 || r.min_spent > 0)) best = r;
  if (best && best.rank > curRank) {
    db.prepare('UPDATE customer SET grade = ? WHERE id = ?').run(best.name, customerId);
    return best.name;
  }
  return null;
}

/** 상품 판매용 결제(회원권/정액권 판매)를 기록. 서비스 매출(kind=service)과 분리해 이중 집계를 막는다. */
export function insertSale(db, shop, { customerId, staffId, name, total, lines, kind, paidAt }) {
  if (!Array.isArray(lines) || !lines.length) throw bad('결제 수단이 필요합니다.');
  let sum = 0;
  for (const l of lines) {
    if (!METHODS.includes(l.method) || ['prepaid', 'point'].includes(l.method)) throw bad(`상품 판매에 사용할 수 없는 결제수단: ${l.method}`);
    if (!Number.isInteger(l.amount) || l.amount <= 0) throw bad('결제금액이 올바르지 않습니다.');
    sum += l.amount;
  }
  if (sum !== total) throw bad(`결제수단 합계가 금액(${total})과 일치해야 합니다.`);
  const pid = Number(db.prepare('INSERT INTO payment(shop_id, customer_id, staff_id, total, paid_at, kind) VALUES (?,?,?,?,?,?)').run(shop, customerId, staffId, total, paidAt, kind).lastInsertRowid);
  db.prepare('INSERT INTO payment_item(payment_id, name, price) VALUES (?,?,?)').run(pid, name, total);
  const ins = db.prepare('INSERT INTO payment_line(payment_id, method, amount) VALUES (?,?,?)');
  for (const l of lines) {
    ins.run(pid, l.method, l.amount);
    if (l.method === 'credit') db.prepare("INSERT INTO credit_ledger(shop_id, customer_id, delta, reason, payment_id) VALUES (?,?,?, '외상 판매', ?)").run(shop, customerId, l.amount, pid);
  }
  return pid;
}

export const need = (cond, status, msg) => { if (!cond) throw new HttpError(status, msg); };
