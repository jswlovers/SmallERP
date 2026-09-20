import { encrypt, decrypt, hashPassword, normalizePhone } from '../crypto.js';
import { audit } from '../audit.js';
import { HttpError, bad, int, notFound, required } from '../util.js';

export default function (app, { db }) {
  const ownerOnly = (req) => {
    if (req.user.role !== 'owner') throw new HttpError(403, '사장 권한이 필요합니다.');
  };
  const out = (s) => {
    const { phone_enc, password_hash, ...rest } = s;
    return { ...rest, phone: decrypt(phone_enc) };
  };

  app.get('/api/staff', async (req) =>
    db
      .prepare('SELECT id, name, login_id, role, commission_rate, base_pay, phone_enc, active FROM staff WHERE shop_id = ? ORDER BY id')
      .all(req.user.shop)
      .map(out),
  );

  app.post('/api/staff', async (req) => {
    ownerOnly(req);
    required(req.body, 'name');
    const { name, loginId, password, commissionRate = 0, phone, basePay = 0 } = req.body;
    if (loginId && (!password || String(password).length < 8)) throw bad('로그인 계정은 8자 이상 비밀번호가 필요합니다.');
    const r = db
      .prepare('INSERT INTO staff(shop_id, name, login_id, password_hash, commission_rate, phone_enc, base_pay) VALUES (?,?,?,?,?,?,?)')
      .run(req.user.shop, name, loginId || null, loginId ? hashPassword(password) : null, Number(commissionRate), encrypt(normalizePhone(phone)), int(basePay, '기본급'));
    audit(db, req, 'staff.create', `${name} (#${r.lastInsertRowid})`);
    return { id: Number(r.lastInsertRowid) };
  });

  app.get('/api/audit', async (req) => {
    ownerOnly(req);
    return db
      .prepare('SELECT a.*, s.name AS staff_name FROM audit_log a LEFT JOIN staff s ON s.id = a.staff_id WHERE a.shop_id = ? ORDER BY a.id DESC LIMIT 200')
      .all(req.user.shop);
  });

  app.patch('/api/staff/:id', async (req) => {
    ownerOnly(req);
    const cur = db.prepare('SELECT * FROM staff WHERE id = ? AND shop_id = ?').get(req.params.id, req.user.shop);
    if (!cur) throw notFound('직원');
    const b = req.body ?? {};
    db.prepare('UPDATE staff SET name = ?, commission_rate = ?, base_pay = ?, phone_enc = ?, active = ? WHERE id = ?').run(
      b.name ?? cur.name,
      b.commissionRate ?? cur.commission_rate,
      b.basePay === undefined ? cur.base_pay : int(b.basePay, '기본급'),
      b.phone === undefined ? cur.phone_enc : encrypt(normalizePhone(b.phone)),
      b.active === undefined ? cur.active : b.active ? 1 : 0,
      cur.id,
    );
    audit(db, req, 'staff.update', `#${cur.id} ${JSON.stringify({ ...b, phone: b.phone ? '***' : undefined })}`);
    return { ok: true };
  });
}
