import { hashPassword } from './crypto.js';

/**
 * 플랫폼 관리자 계정 보장. ADMIN_LOGIN / ADMIN_PASSWORD 환경 변수가 있을 때만 생성·갱신한다.
 * (기본 비밀번호를 코드에 두지 않는다. 개발용 계정은 `npm run seed` 참고)
 */
export function ensureAdmin(db, login = process.env.ADMIN_LOGIN, password = process.env.ADMIN_PASSWORD) {
  if (!login || !password) return false;
  if (password.length < 10) throw new Error('ADMIN_PASSWORD 는 10자 이상이어야 합니다.');
  const hash = hashPassword(password);
  const cur = db.prepare('SELECT id FROM admin_user WHERE login_id = ?').get(login);
  if (cur) db.prepare('UPDATE admin_user SET password_hash = ? WHERE id = ?').run(hash, cur.id);
  else db.prepare('INSERT INTO admin_user(login_id, password_hash) VALUES (?,?)').run(login, hash);
  return true;
}
