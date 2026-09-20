import { tx } from '../db.js';
import { hashPassword, verifyPassword } from '../crypto.js';
import { HttpError, bad, required } from '../util.js';
import { audit } from '../audit.js';

const DUMMY_HASH = hashPassword('dummy-password-for-timing');

const DEFAULT_SERVICES = [
  ['커트', '헤어', 20000, 40],
  ['펌', '헤어', 80000, 120],
  ['염색', '헤어', 70000, 100],
  ['젤 네일', '네일', 50000, 60],
];

export default function (app, { db }) {
  const sign = (staff) => app.jwt.sign({ sid: staff.id, shop: staff.shop_id, role: staff.role });

  // 매장 + 사장 계정 생성
  app.post('/api/auth/register', async (req) => {
    const { shopName, ownerName, loginId, password } = req.body ?? {};
    required(req.body, 'shopName', 'ownerName', 'loginId', 'password');
    if (String(password).length < 8) throw bad('비밀번호는 8자 이상이어야 합니다.');
    const staff = tx(db, () => {
      const shopId = Number(db.prepare('INSERT INTO shop(name, sms_balance) VALUES (?, 1000)').run(shopName).lastInsertRowid);
      const sid = Number(
        db
          .prepare("INSERT INTO staff(shop_id, name, login_id, password_hash, role) VALUES (?,?,?,?, 'owner')")
          .run(shopId, ownerName, loginId, hashPassword(password)).lastInsertRowid,
      );
      const ins = db.prepare('INSERT INTO service(shop_id, name, category, price, duration_min) VALUES (?,?,?,?,?)');
      for (const [n, c, p, d] of DEFAULT_SERVICES) ins.run(shopId, n, c, p, d);
      const tpl = db.prepare('INSERT INTO message_template(shop_id, name, body, is_ad) VALUES (?,?,?,?)');
      tpl.run(shopId, '예약 안내', '[{{shop}}] {{name}}님, {{date}} {{time}} 예약 안내드립니다.', 0);
      tpl.run(shopId, '생일 축하', '[{{shop}}] {{name}}님, 생일을 축하드립니다! 방문 시 특별 혜택을 드려요.', 1);
      tpl.run(shopId, '재방문 안내', '[{{shop}}] {{name}}님, 오랜만이에요. 예약해 주시면 정성껏 모시겠습니다.', 1);
      return { id: sid, shop_id: shopId, role: 'owner' };
    });
    return { token: sign(staff) };
  });

  // 무차별 대입 방지: 아이디+IP 기준 연속 5회 실패 시 15분 잠금 (단일 프로세스 메모리; 다중 서버는 Redis로 이전)
  const fails = new Map();
  const MAX_FAILS = 5;
  const LOCK_MS = 15 * 60 * 1000;

  app.post('/api/auth/login', async (req) => {
    const { loginId, password } = req.body ?? {};
    required(req.body, 'loginId', 'password');
    const key = `${req.ip}|${String(loginId).toLowerCase()}`;
    const f = fails.get(key);
    if (f && f.count >= MAX_FAILS && Date.now() - f.last < LOCK_MS) throw new HttpError(429, '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
    const s = db.prepare('SELECT * FROM staff WHERE login_id = ? AND active = 1').get(loginId);
    // 존재하지 않는 계정도 동일한 해시 비용을 쓰도록 더미 검증 (계정 유무 노출/타이밍 차이 완화)
    const ok = verifyPassword(password, s?.password_hash ?? DUMMY_HASH);
    if (!s || !ok) {
      fails.set(key, { count: (f && Date.now() - f.last < LOCK_MS ? f.count : 0) + 1, last: Date.now() });
      throw new HttpError(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
    }
    if (!db.prepare('SELECT active FROM shop WHERE id = ?').get(s.shop_id)?.active) throw new HttpError(403, '이용이 정지된 매장입니다. 관리자에게 문의하세요.');
    fails.delete(key);
    return { token: sign(s) };
  });

  app.post('/api/me/password', async (req) => {
    const { current, next } = req.body ?? {};
    required(req.body, 'current', 'next');
    if (String(next).length < 8) throw bad('새 비밀번호는 8자 이상이어야 합니다.');
    const s = db.prepare('SELECT * FROM staff WHERE id = ?').get(req.user.sid);
    if (!verifyPassword(current, s.password_hash)) throw new HttpError(403, '현재 비밀번호가 올바르지 않습니다.');
    db.prepare('UPDATE staff SET password_hash = ? WHERE id = ?').run(hashPassword(next), s.id);
    audit(db, req, 'password.change', s.login_id);
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const s = db.prepare('SELECT id, name, role, shop_id FROM staff WHERE id = ?').get(req.user.sid);
    const shop = db.prepare('SELECT id, name, plan, sms_balance FROM shop WHERE id = ?').get(req.user.shop);
    return { staff: s, shop };
  });
}
