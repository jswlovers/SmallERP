import { decrypt } from './crypto.js';
import { SMS_COST, smsType } from './sms/provider.js';
import { addDays, nowLocal } from './util.js';

const OPT_OUT = process.env.AD_OPT_OUT || '무료수신거부 080-000-0000';


/** 자동 문자 트리거 카탈로그. kind: schedule(주기 실행) | event(업무 이벤트 발생 시 즉시) */
export const TRIGGERS = {
  reservation_reminder: { label: '예약 전날 안내', kind: 'schedule' },
  birthday: { label: '생일 고객(매일)', kind: 'schedule' },
  birthday_month: { label: '생일 고객(매월 1일 일괄)', kind: 'schedule' },
  anniversary: { label: '기념일 고객', kind: 'schedule' },
  inactive: { label: 'N일 미방문 고객', kind: 'schedule', param: '미방문 일수' },
  pass_expiring: { label: '회원권 기간만료 예정', kind: 'schedule', param: '만료 N일 전' },
  stored_expiring: { label: '정액권 기간만료 예정', kind: 'schedule', param: '만료 N일 전' },
  stored_low: { label: '정액권 잔여금액 미달', kind: 'schedule', param: '잔액 N원 미만' },
  customer_created: { label: '신규등록 고객', kind: 'event' },
  referred_welcome: { label: '소개받고 온 신규고객', kind: 'event' },
  referrer_thanks: { label: '신규고객의 소개자', kind: 'event' },
  reservation_created: { label: '예약 고객', kind: 'event' },
  reservation_pending: { label: '예약대기 고객', kind: 'event' },
  reservation_cancelled: { label: '예약 취소 고객', kind: 'event' },
  naver_reservation: { label: '네이버 예약 고객', kind: 'event' },
  naver_review: { label: '네이버 예약 완료고객(리뷰 요청)', kind: 'event' },
  staff_notify: { label: '담당 직원 예약 알림', kind: 'event' },
  visit_thanks: { label: '시술 고객 자동발송', kind: 'event' },
  pass_sold: { label: '회원권 판매', kind: 'event' },
  pass_used: { label: '회원권 사용', kind: 'event' },
  stored_sold: { label: '정액권 판매', kind: 'event' },
  stored_used: { label: '정액권 사용', kind: 'event' },
  point_earned: { label: '포인트 적립', kind: 'event' },
  point_used: { label: '포인트 사용', kind: 'event' },
  daily_report: { label: '일마감 매출 발송(사장)', kind: 'event' },
};

/** 업무 이벤트 발생 시 해당 트리거의 활성 규칙을 즉시 발송. 실패해도 업무 흐름을 막지 않는다. */
export async function fire(ctx, shopId, trigger, customer, vars = {}, refKey = null, now = nowLocal()) {
  try {
    const rules = ctx.db
      .prepare('SELECT r.*, t.body, t.is_ad FROM automation_rule r JOIN message_template t ON t.id = r.template_id WHERE r.shop_id = ? AND r.active = 1 AND r.trigger = ?')
      .all(shopId, trigger);
    for (const rule of rules)
      await sendToCustomer(ctx, shopId, { ...customer, vars }, { body: rule.body, isAd: !!rule.is_ad, ruleId: rule.id, refKey: refKey ?? `${trigger}:${now}:${Math.random().toString(36).slice(2, 8)}`, now });
  } catch (e) {
    console.error('[fire]', trigger, e.message);
  }
}

/** 직원/사장 수신용 임시 수신자 */
export const staffRecipient = (row) => ({ id: null, name: row.name, phone_enc: row.phone_enc, marketing_consent: 1 });

export const render = (tpl, vars) => String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');

/** 광고성 정보 야간 전송 제한: 21:00 ~ 08:00 */
export const isNight = (local = nowLocal()) => {
  const h = Number(local.slice(11, 13));
  return h >= 21 || h < 8;
};

const log = (db, shop, row) =>
  db
    .prepare('INSERT INTO message_log(shop_id, customer_id, rule_id, ref_key, channel, body, status, reason, cost) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(shop, row.customerId ?? null, row.ruleId ?? null, row.refKey ?? null, row.channel ?? 'sms', row.body, row.status, row.reason ?? null, row.cost ?? 0);

/**
 * 고객 1명에게 문자 발송. 정책 검사(연락처/광고 동의/야간/잔액) → 발송 → 잔액 차감 → 로그.
 * @returns {{status:'sent'|'failed'|'skipped', reason?:string}}
 */
export async function sendToCustomer({ db, sms }, shopId, customer, { body, isAd = false, ruleId = null, refKey = null, now = nowLocal() }) {
  const shop = db.prepare('SELECT * FROM shop WHERE id = ?').get(shopId);
  const vars = { name: customer.name, shop: shop.name, ...(customer.vars ?? {}) };
  let text = render(body, vars);
  const skip = (reason) => {
    // 자동화 규칙은 10분마다 재평가되므로 스킵을 기록하지 않는다(조건이 바뀌면 다음 주기에 발송됨).
    if (!ruleId) log(db, shopId, { customerId: customer.id, ruleId, refKey, body: text, status: 'skipped', reason });
    return { status: 'skipped', reason };
  };
  const phone = decrypt(customer.phone_enc);
  if (ruleId && db.prepare('SELECT 1 FROM message_log WHERE rule_id = ? AND customer_id = ? AND ref_key = ?').get(ruleId, customer.id, String(refKey)))
    return { status: 'skipped', reason: '이미 발송됨' };
  if (!phone) return skip('연락처 없음');
  if (isAd) {
    if (!customer.marketing_consent) return skip('마케팅 수신 미동의');
    if (isNight(now)) return skip('야간(21~08시) 광고 발송 제한');
    text = `(광고) ${text}\n${OPT_OUT}`;
  }
  const type = smsType(text);
  const cost = SMS_COST[type];
  if (shop.sms_balance < cost) return skip('문자 잔액 부족');

  let res;
  try {
    res = await sms.send({ to: phone, body: text, isAd });
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  if (!res.ok) {
    log(db, shopId, { customerId: customer.id, ruleId, refKey: null, body: text, status: 'failed', reason: res.error, channel: type });
    return { status: 'failed', reason: res.error };
  }
  db.prepare('UPDATE shop SET sms_balance = sms_balance - ? WHERE id = ?').run(cost, shopId);
  log(db, shopId, { customerId: customer.id, ruleId, refKey, body: text, status: 'sent', cost, channel: type });
  return { status: 'sent' };
}

/** 한 매장의 활성 자동화 규칙을 실행한다. now 는 테스트에서 주입 가능. */
export async function runAutomation(ctx, shopId, now = nowLocal()) {
  const { db } = ctx;
  const today = now.slice(0, 10);
  const rules = db
    .prepare('SELECT r.*, t.body, t.is_ad FROM automation_rule r JOIN message_template t ON t.id = r.template_id WHERE r.shop_id = ? AND r.active = 1')
    .all(shopId);
  const counts = { sent: 0, failed: 0, skipped: 0 };
  const go = async (cust, rule, refKey, vars) => {
    const r = await sendToCustomer(ctx, shopId, { ...cust, vars }, { body: rule.body, isAd: !!rule.is_ad, ruleId: rule.id, refKey, now });
    if (r.reason !== '이미 발송됨') counts[r.status]++;
  };

  for (const rule of rules) {
    if (rule.trigger === 'reservation_reminder') {
      const tomorrow = addDays(today, 1);
      const list = db
        .prepare(
          `SELECT r.id AS rid, r.start_at, c.* FROM reservation r JOIN customer c ON c.id = r.customer_id
           WHERE r.shop_id = ? AND substr(r.start_at,1,10) = ? AND r.status IN ('pending','confirmed')`,
        )
        .all(shopId, tomorrow);
      for (const row of list) {
        const { rid, start_at, ...cust } = row;
        await go({ ...cust, id: cust.id }, rule, `r${rid}`, { date: start_at.slice(0, 10), time: start_at.slice(11, 16) });
      }
    } else if (rule.trigger === 'birthday') {
      const md = today.slice(5);
      const list = db.prepare('SELECT * FROM customer WHERE shop_id = ? AND deleted_at IS NULL AND birth IS NOT NULL AND substr(birth, -5) = ?').all(shopId, md);
      for (const c of list) await go(c, rule, today.slice(0, 4), {});
    } else if (rule.trigger === 'inactive' && rule.param > 0) {
      const cutoff = addDays(today, -rule.param);
      const list = db
        .prepare(
          `SELECT c.*, (SELECT MAX(substr(paid_at,1,10)) FROM payment WHERE customer_id = c.id AND status='paid') AS last_visit
           FROM customer c WHERE c.shop_id = ? AND c.deleted_at IS NULL AND last_visit IS NOT NULL AND last_visit <= ?`,
        )
        .all(shopId, cutoff);
      for (const { last_visit, ...c } of list) await go(c, rule, last_visit, {});
    } else if (rule.trigger === 'birthday_month' && today.slice(8) === '01') {
      const mm = today.slice(5, 7);
      const list = db.prepare('SELECT * FROM customer WHERE shop_id = ? AND deleted_at IS NULL AND birth IS NOT NULL AND substr(birth, -5, 2) = ?').all(shopId, mm);
      for (const c of list) await go(c, rule, `m${today.slice(0, 7)}`, {});
    } else if (rule.trigger === 'anniversary') {
      const list = db.prepare('SELECT * FROM customer WHERE shop_id = ? AND deleted_at IS NULL AND anniversary = ?').all(shopId, today.slice(5));
      for (const c of list) await go(c, rule, today.slice(0, 4), {});
    } else if (rule.trigger === 'pass_expiring' && rule.param > 0) {
      const target = addDays(today, rule.param);
      const list = db.prepare(`SELECT p.id AS pid, p.name AS pname, p.expires_at, p.remaining, c.* FROM customer_pass p JOIN customer c ON c.id = p.customer_id
        WHERE p.shop_id = ? AND p.remaining > 0 AND p.expires_at IS NOT NULL AND p.expires_at <= ? AND p.expires_at >= ?`).all(shopId, target, today);
      for (const { pid, pname, expires_at, remaining, ...c } of list) await go(c, rule, `p${pid}`, { pass: pname, date: expires_at, remain: remaining });
    } else if (rule.trigger === 'stored_expiring' && rule.param > 0) {
      const target = addDays(today, rule.param);
      const list = db.prepare(`SELECT c.*, (SELECT COALESCE(SUM(delta),0) FROM prepaid_ledger WHERE customer_id = c.id) AS bal FROM customer c
        WHERE c.shop_id = ? AND c.prepaid_expires_at IS NOT NULL AND c.prepaid_expires_at <= ? AND c.prepaid_expires_at >= ?`).all(shopId, target, today);
      for (const { bal, ...c } of list) if (bal > 0) await go(c, rule, `s${c.prepaid_expires_at}`, { date: c.prepaid_expires_at, balance: bal });
    } else if (rule.trigger === 'stored_low' && rule.param > 0) {
      const list = db.prepare(`SELECT c.*, (SELECT COALESCE(SUM(delta),0) FROM prepaid_ledger WHERE customer_id = c.id) AS bal FROM customer c
        WHERE c.shop_id = ? AND c.deleted_at IS NULL AND EXISTS (SELECT 1 FROM prepaid_ledger WHERE customer_id = c.id)`).all(shopId);
      for (const { bal, ...c } of list) if (bal > 0 && bal < rule.param) await go(c, rule, `low${today.slice(0, 7)}`, { balance: bal });
    }
  }
  return counts;
}

export async function runAutomationAllShops(ctx, now) {
  for (const { id } of ctx.db.prepare('SELECT id FROM shop').all()) await runAutomation(ctx, id, now);
}
