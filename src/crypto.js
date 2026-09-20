import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const APP_KEY = process.env.APP_KEY || 'dev-only-change-me-please-32bytes!';
const key = scryptSync(APP_KEY, 'smallerp-salt', 32);

export const normalizePhone = (p) => String(p ?? '').replace(/\D/g, '');

export function encrypt(text) {
  if (!text) return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload) {
  if (!payload) return '';
  const [iv, tag, enc] = payload.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

/** 검색용 결정적 해시 (연락처 완전일치 검색) */
export const phoneHash = (phone) => {
  const n = normalizePhone(phone);
  return n ? createHmac('sha256', key).update(n).digest('hex') : null;
};

/** OTP(문자 인증번호) 저장용 해시. 평문 코드를 DB에 남기지 않는다. */
export const hashOtp = (code) => createHmac('sha256', key).update(`otp:${code}`).digest('hex');

/** 매장 공개 예약 링크용 코드 (URL-safe, 추측 방지를 위해 충분히 길게) */
export const genShopCode = () => randomBytes(6).toString('base64url');

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pw, salt, 64).toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const a = Buffer.from(hash, 'hex');
  const b = scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return a.length === b.length && timingSafeEqual(a, b);
}
