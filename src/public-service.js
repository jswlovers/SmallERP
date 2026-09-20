import { encrypt, hashOtp, normalizePhone, phoneHash } from './crypto.js';
import { HttpError, addDays, addMinutes, bad, dt, notFound, nowLocal, required, todayLocal } from './util.js';
import { DEFAULT_SETTINGS, getSetting } from './settings.js';
import { freeSlots } from './schedule.js';
import { bookReservation } from './routes/reservations.js';
import { nextCustomerNo } from './routes/customers.js';
import { fire } from './messaging.js';

/**
 * 고객 셀프 예약의 실제 도메인 로직. Fastify 라우트(src/routes/public.js)와 AI 예약봇
 * (src/ai/bookingAgent.js)이 이 모듈의 같은 함수를 호출해 동일한 검증·정책을 공유한다.
 * (JWT 발급은 Fastify 플러그인이 필요해 라우트 쪽에서 처리하고, 이 모듈은 순수 도메인 함수만 둔다.)
 */

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_PER_DAY = 8;
const PHONE_RE = /^01[0-9]\d{7,8}$/;
const resend = new Map(); // `${shopId}:${phoneHash}` -> 마지막 발송 시각(ms), 재발송 쿨다운용

export function shopByCode(db, code) {
  const s = db.prepare('SELECT * FROM shop WHERE public_code = ?').get(code);
  if (!s) throw notFound('예약 페이지');
  if (!s.active) throw new HttpError(403, '이용이 정지된 매장입니다.');
  return s;
}

export function custOf(db, shop, customerId) {
  const c = db.prepare('SELECT * FROM customer WHERE id = ? AND shop_id = ? AND deleted_at IS NULL').get(customerId, shop.id);
  if (!c) throw new HttpError(401, '로그인이 필요합니다.');
  return c;
}

export function getInfo(db, shop) {
  const booking = getSetting(db, shop.id, 'public_booking', DEFAULT_SETTINGS.public_booking);
  const services = db.prepare('SELECT id, name, category, price, duration_min FROM service WHERE shop_id = ? AND active = 1 ORDER BY category, name').all(shop.id);
  const staff = db.prepare('SELECT id, name FROM staff WHERE shop_id = ? AND active = 1 ORDER BY id').all(shop.id);
  return { shopName: shop.name, services, staff, booking };
}

export function getAvailability(db, shop, { date, serviceIds, staffId }) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('date(YYYY-MM-DD)가 필요합니다.');
  if (date < todayLocal()) throw bad(`${date}는 이미 지난 날짜입니다. 오늘(${todayLocal()}) 이후 날짜로 다시 확인해 주세요.`);
  const ids = String(serviceIds || '').split(',').filter(Boolean).map(Number);
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
}

export async function requestOtp(ctx, shop, { phone }) {
  const { db } = ctx;
  required({ phone }, 'phone');
  const norm = normalizePhone(phone);
  if (!PHONE_RE.test(norm)) throw bad('휴대폰 번호를 다시 확인해 주세요.');
  const ph = phoneHash(norm);
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
  try { await ctx.sms.send({ to: norm, body, isAd: false }); } catch { /* 발송 실패해도 devCode 로 테스트 진행 가능 */ }
  // 문자 에이전시 실연동 전 개발/테스트 편의: 운영 환경이 아니면 발급한 코드를 응답에 함께 보낸다.
  return { ok: true, ...(process.env.NODE_ENV === 'production' ? {} : { devCode: code }) };
}

// 문자 에이전시(솔라피 등) 연동 전 임시 조치: 운영 환경이 아니면 고정 코드로도 항상 통과시킨다.
// 실제 SMS 발송이 붙기 전까지 테스트/시연을 쉽게 하기 위함이며, NODE_ENV=production 이면 자동으로 꺼진다.
// 실제 발급 코드는 100000~999999 범위(아래 requestOtp 참고)라 '000000'과 절대 겹치지 않는다.
// TODO(솔라피 연동 후 제거): 실제 문자 발송이 연결되면 이 우회를 지운다.
const TEMP_BYPASS_CODE = '000000';
const bypassAllowed = () => process.env.NODE_ENV !== 'production';

/** OTP 검증 + 없으면 고객 자동 생성. JWT는 발급하지 않는다(호출부 책임). */
export async function verifyOtp(ctx, shop, { phone, code, name, marketingConsent }) {
  const { db } = ctx;
  required({ phone, code }, 'phone', 'code');
  const norm = normalizePhone(phone);
  const ph = phoneHash(norm);
  const trimmed = String(code).trim();
  const bypass = bypassAllowed() && trimmed === TEMP_BYPASS_CODE;
  if (!bypass) {
    const row = db.prepare('SELECT * FROM otp_code WHERE shop_id = ? AND phone_hash = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1').get(shop.id, ph);
    if (!row || row.expires_at < new Date().toISOString()) throw new HttpError(401, '인증번호가 만료되었습니다. 다시 요청해 주세요.');
    if (row.attempts >= MAX_ATTEMPTS) throw new HttpError(429, '시도 횟수를 초과했습니다. 인증번호를 다시 요청해 주세요.');
    if (hashOtp(trimmed) !== row.code_hash) {
      db.prepare('UPDATE otp_code SET attempts = attempts + 1 WHERE id = ?').run(row.id);
      throw new HttpError(401, '인증번호가 올바르지 않습니다.');
    }
    db.prepare('UPDATE otp_code SET used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  }
  let cust = db.prepare('SELECT * FROM customer WHERE shop_id = ? AND phone_hash = ? AND deleted_at IS NULL').get(shop.id, ph);
  let created = false;
  if (!cust) {
    const custName = String(name ?? '').trim().slice(0, 30) || `고객${norm.slice(-4)}`;
    const id = Number(
      db.prepare('INSERT INTO customer(shop_id, no, name, phone_enc, phone_hash, marketing_consent) VALUES (?,?,?,?,?,?)')
        .run(shop.id, nextCustomerNo(db, shop.id), custName, encrypt(norm), ph, marketingConsent ? 1 : 0).lastInsertRowid,
    );
    cust = db.prepare('SELECT * FROM customer WHERE id = ?').get(id);
    created = true;
    await fire(ctx, shop.id, 'customer_created', cust, {}, `c${id}`);
  }
  return { customer: cust, created };
}

export function updateCustomerName(db, customerId, name) {
  const n = String(name ?? '').trim().slice(0, 30);
  if (!n) throw bad('이름을 입력해 주세요.');
  db.prepare('UPDATE customer SET name = ? WHERE id = ?').run(n, customerId);
  return { ok: true };
}

export function listMyReservations(db, shop, customerId) {
  return db
    .prepare(
      `SELECT r.id, r.start_at, r.end_at, r.status, r.source, s.name AS staff_name,
              (SELECT group_concat(sv.name, ', ') FROM reservation_item ri JOIN service sv ON sv.id = ri.service_id WHERE ri.reservation_id = r.id) AS items
       FROM reservation r JOIN staff s ON s.id = r.staff_id
       WHERE r.shop_id = ? AND r.customer_id = ? ORDER BY r.start_at DESC LIMIT 50`,
    )
    .all(shop.id, customerId);
}

export async function createReservation(ctx, shop, customerId, { startAt, serviceIds, staffId }) {
  required({ startAt, serviceIds }, 'startAt', 'serviceIds');
  const booking = getSetting(ctx.db, shop.id, 'public_booking', DEFAULT_SETTINGS.public_booking);
  if (!booking.enabled) throw new HttpError(403, '지금은 온라인 예약을 받지 않는 매장입니다. 전화로 문의해 주세요.');
  const start = dt(startAt, 'startAt');
  const now = nowLocal();
  if (start < now) throw bad(`${startAt}는 이미 지난 시간입니다. 오늘(${now.slice(0, 10)}) 이후의 미래 날짜·시간으로 다시 요청해 주세요.`);
  if (start < addMinutes(now, booking.minLeadMinutes)) throw bad(`예약은 최소 ${booking.minLeadMinutes}분 전에 가능합니다.`);
  if (start.slice(0, 10) > addDays(todayLocal(), booking.maxDays)) throw bad(`예약은 최대 ${booking.maxDays}일 이내만 가능합니다.`);
  const status = booking.autoConfirm ? 'confirmed' : 'pending';
  return bookReservation(ctx, shop.id, {
    customerId, staffId: staffId ? Number(staffId) : undefined, startAt: start, serviceIds,
    status, source: 'public', memo: '고객 온라인 예약',
  });
}

export async function cancelReservation(ctx, shop, customerId, id) {
  const { db } = ctx;
  const r = db.prepare('SELECT * FROM reservation WHERE id = ? AND shop_id = ? AND customer_id = ?').get(id, shop.id, customerId);
  if (!r) throw notFound('예약');
  if (!['pending', 'confirmed', 'waiting'].includes(r.status)) throw bad('취소할 수 없는 예약입니다.');
  db.prepare("UPDATE reservation SET status = 'cancelled' WHERE id = ?").run(r.id);
  const c = db.prepare('SELECT * FROM customer WHERE id = ?').get(customerId);
  await fire(ctx, shop.id, 'reservation_cancelled', c, { date: r.start_at.slice(0, 10), time: r.start_at.slice(11) }, `r${r.id}`);
  return { ok: true };
}
