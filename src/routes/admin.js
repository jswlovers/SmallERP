import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from '../crypto.js';
import { HttpError, bad, int, notFound, required, todayLocal } from '../util.js';

const PLANS = ['basic', 'standard', 'premium'];

/**
 * 플랫폼 관리자 API (/api/admin/*). 매장 직원 토큰과는 완전히 분리된 admin_user 계정/토큰(claim: admin)만 허용한다.
 * 관리자는 매장의 고객 개인정보(연락처 등)를 조회할 수 없고, 매장 운영 메타데이터만 다룬다.
 */
export default function (app, { db }) {
  const logAdmin = (req, shopId, action, detail = '') =>
    db.prepare('INSERT INTO audit_log(shop_id, staff_id, action, detail, ip) VALUES (?, NULL, ?, ?, ?)').run(shopId, `admin.${action}`, `[${req.user.login}] ${detail}`, req.ip);

  app.post('/api/admin/auth/login', async (req) => {
    required(req.body, 'loginId', 'password');
    const a = db.prepare('SELECT * FROM admin_user WHERE login_id = ?').get(req.body.loginId);
    if (!a || !verifyPassword(req.body.password, a.password_hash)) throw new HttpError(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
    return { token: app.jwt.sign({ admin: a.id, login: a.login_id }, { expiresIn: '4h' }) };
  });

  const guard = async (req) => {
    try {
      await req.jwtVerify();
    } catch {
      throw new HttpError(401, '관리자 로그인이 필요합니다.');
    }
    if (!req.user.admin || !db.prepare('SELECT 1 FROM admin_user WHERE id = ?').get(req.user.admin)) throw new HttpError(401, '관리자 로그인이 필요합니다.');
  };
  const A = { onRequest: guard };

  app.get('/api/admin/overview', A, async () => {
    const month = todayLocal().slice(0, 7);
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    return {
      shops: one('SELECT COUNT(*) n, COALESCE(SUM(active),0) active FROM shop'),
      staff: one('SELECT COUNT(*) n FROM staff WHERE active = 1').n,
      customers: one('SELECT COUNT(*) n FROM customer').n,
      monthSales: one("SELECT COALESCE(SUM(total),0) v FROM payment WHERE status='paid' AND substr(paid_at,1,7) = ?", month).v,
      monthMessages: one("SELECT COUNT(*) n FROM message_log WHERE status='sent' AND substr(sent_at,1,7) = ?", month).n,
      plans: db.prepare('SELECT plan, COUNT(*) n FROM shop GROUP BY plan').all(),
    };
  });

  app.get('/api/admin/shops', A, async (req) => {
    const month = todayLocal().slice(0, 7);
    const q = `%${req.query.q ?? ''}%`;
    return db
      .prepare(
        `SELECT s.id, s.name, s.plan, s.active, s.sms_balance, s.created_at,
                (SELECT name FROM staff WHERE shop_id = s.id AND role='owner' LIMIT 1) AS owner,
                (SELECT login_id FROM staff WHERE shop_id = s.id AND role='owner' LIMIT 1) AS owner_login,
                (SELECT COUNT(*) FROM staff WHERE shop_id = s.id AND active = 1) AS staff_count,
                (SELECT COUNT(*) FROM customer WHERE shop_id = s.id) AS customer_count,
                (SELECT COALESCE(SUM(total),0) FROM payment WHERE shop_id = s.id AND status='paid' AND substr(paid_at,1,7) = ?) AS month_sales
         FROM shop s WHERE s.name LIKE ? ORDER BY s.id DESC LIMIT 500`,
      )
      .all(month, q);
  });

  app.patch('/api/admin/shops/:id', A, async (req) => {
    const s = db.prepare('SELECT * FROM shop WHERE id = ?').get(req.params.id);
    if (!s) throw notFound('매장');
    const b = req.body ?? {};
    if (b.plan !== undefined && !PLANS.includes(b.plan)) throw bad('올바르지 않은 플랜입니다.');
    const active = b.active === undefined ? s.active : b.active ? 1 : 0;
    db.prepare('UPDATE shop SET plan = ?, active = ? WHERE id = ?').run(b.plan ?? s.plan, active, s.id);
    logAdmin(req, s.id, 'shop.update', JSON.stringify(b));
    return { ok: true };
  });

  app.post('/api/admin/shops/:id/charge', A, async (req) => {
    const s = db.prepare('SELECT * FROM shop WHERE id = ?').get(req.params.id);
    if (!s) throw notFound('매장');
    const amount = int(req.body?.amount, '충전 포인트');
    if (amount === 0 || Math.abs(amount) > 10_000_000) throw bad('충전 포인트가 올바르지 않습니다.');
    if (s.sms_balance + amount < 0) throw bad('잔액이 음수가 될 수 없습니다.');
    db.prepare('UPDATE shop SET sms_balance = sms_balance + ? WHERE id = ?').run(amount, s.id);
    logAdmin(req, s.id, 'sms.charge', `${amount}P`);
    return { balance: s.sms_balance + amount };
  });

  // 사장 비밀번호 초기화: 임시 비밀번호를 1회만 응답으로 돌려준다.
  app.post('/api/admin/shops/:id/reset-owner-password', A, async (req) => {
    const owner = db.prepare("SELECT * FROM staff WHERE shop_id = ? AND role = 'owner' AND login_id IS NOT NULL LIMIT 1").get(req.params.id);
    if (!owner) throw notFound('사장 계정');
    const temp = `${randomBytes(6).toString('base64url')}A1`;
    db.prepare('UPDATE staff SET password_hash = ? WHERE id = ?').run(hashPassword(temp), owner.id);
    logAdmin(req, owner.shop_id, 'owner.password_reset', owner.login_id);
    return { loginId: owner.login_id, tempPassword: temp };
  });

  app.get('/api/admin/audit', A, async (req) =>
    db
      .prepare(
        `SELECT a.*, s.name AS shop_name FROM audit_log a LEFT JOIN shop s ON s.id = a.shop_id
         WHERE (? IS NULL OR a.shop_id = ?) ORDER BY a.id DESC LIMIT 200`,
      )
      .all(req.query.shopId ?? null, req.query.shopId ?? null),
  );

  app.post('/api/admin/password', A, async (req) => {
    const { current, next } = req.body ?? {};
    required(req.body, 'current', 'next');
    if (String(next).length < 10) throw bad('관리자 비밀번호는 10자 이상이어야 합니다.');
    const a = db.prepare('SELECT * FROM admin_user WHERE id = ?').get(req.user.admin);
    if (!verifyPassword(current, a.password_hash)) throw new HttpError(403, '현재 비밀번호가 올바르지 않습니다.');
    db.prepare('UPDATE admin_user SET password_hash = ? WHERE id = ?').run(hashPassword(next), a.id);
    return { ok: true };
  });
}
