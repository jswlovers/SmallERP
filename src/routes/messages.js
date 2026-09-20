import { HttpError, bad, int, notFound, required } from '../util.js';
import { TRIGGERS, runAutomation, sendToCustomer } from '../messaging.js';
import { audit } from '../audit.js';


export default function (app, ctx) {
  const { db } = ctx;

  app.get('/api/templates', async (req) => db.prepare('SELECT * FROM message_template WHERE shop_id = ? ORDER BY id').all(req.user.shop));

  app.post('/api/templates', async (req) => {
    required(req.body, 'name', 'body');
    const r = db.prepare('INSERT INTO message_template(shop_id, name, body, is_ad) VALUES (?,?,?,?)').run(req.user.shop, req.body.name, req.body.body, req.body.isAd ? 1 : 0);
    return { id: Number(r.lastInsertRowid) };
  });

  app.patch('/api/templates/:id', async (req) => {
    const t = db.prepare('SELECT * FROM message_template WHERE id = ? AND shop_id = ?').get(req.params.id, req.user.shop);
    if (!t) throw notFound('템플릿');
    const b = req.body ?? {};
    db.prepare('UPDATE message_template SET name=?, body=?, is_ad=? WHERE id=?').run(b.name ?? t.name, b.body ?? t.body, b.isAd === undefined ? t.is_ad : b.isAd ? 1 : 0, t.id);
    return { ok: true };
  });

  app.delete('/api/templates/:id', async (req) => {
    if (db.prepare('SELECT 1 FROM automation_rule WHERE template_id = ? AND shop_id = ?').get(req.params.id, req.user.shop)) throw new HttpError(409, '자동화 규칙에서 사용 중인 템플릿입니다.');
    db.prepare('DELETE FROM message_template WHERE id = ? AND shop_id = ?').run(req.params.id, req.user.shop);
    return { ok: true };
  });

  // 수동 발송(캠페인). body 직접 입력 또는 templateId
  app.post('/api/messages/send', async (req) => {
    const b = req.body ?? {};
    const shop = req.user.shop;
    if (!Array.isArray(b.customerIds) || !b.customerIds.length) throw bad('대상 고객을 선택하세요.');
    let body = b.body;
    let isAd = !!b.isAd;
    if (b.templateId) {
      const t = db.prepare('SELECT * FROM message_template WHERE id = ? AND shop_id = ?').get(b.templateId, shop);
      if (!t) throw notFound('템플릿');
      body = t.body;
      isAd = !!t.is_ad;
    }
    if (!body) throw bad('내용이 필요합니다.');
    const results = { sent: 0, failed: 0, skipped: 0 };
    for (const id of b.customerIds) {
      const c = db.prepare('SELECT * FROM customer WHERE id = ? AND shop_id = ?').get(id, shop);
      if (!c) { results.skipped++; continue; }
      results[(await sendToCustomer(ctx, shop, c, { body, isAd })).status]++;
    }
    return results;
  });

  app.get('/api/messages/log', async (req) =>
    db
      .prepare(
        `SELECT m.*, c.name AS customer_name FROM message_log m LEFT JOIN customer c ON c.id = m.customer_id
         WHERE m.shop_id = ? ORDER BY m.id DESC LIMIT 200`,
      )
      .all(req.user.shop),
  );

  // 문자 충전 (실제 서비스에서는 PG 결제 후 승인 처리)
  app.post('/api/messages/charge', async (req) => {
    if (req.user.role !== 'owner') throw new HttpError(403, '사장 권한이 필요합니다.');
    const amount = int(req.body?.amount, '충전 포인트');
    if (amount <= 0) throw bad('충전 포인트는 0보다 커야 합니다.');
    db.prepare('UPDATE shop SET sms_balance = sms_balance + ? WHERE id = ?').run(amount, req.user.shop);
    audit(db, req, 'sms.charge', `${amount}P`);
    return { balance: db.prepare('SELECT sms_balance FROM shop WHERE id = ?').get(req.user.shop).sms_balance };
  });

  app.get('/api/automation/triggers', async () => TRIGGERS);

  app.get('/api/automation', async (req) =>
    db.prepare('SELECT r.*, t.name AS template_name FROM automation_rule r JOIN message_template t ON t.id = r.template_id WHERE r.shop_id = ? ORDER BY r.id').all(req.user.shop),
  );

  app.post('/api/automation', async (req) => {
    const b = req.body ?? {};
    required(b, 'name', 'trigger', 'templateId');
    if (!TRIGGERS[b.trigger]) throw bad('지원하지 않는 트리거입니다.');
    if (TRIGGERS[b.trigger].param && !(int(b.param ?? 0, 'param') > 0)) throw bad(`${TRIGGERS[b.trigger].param}(param)를 입력하세요.`);
    if (!db.prepare('SELECT 1 FROM message_template WHERE id = ? AND shop_id = ?').get(b.templateId, req.user.shop)) throw notFound('템플릿');
    const r = db.prepare('INSERT INTO automation_rule(shop_id, name, trigger, param, template_id) VALUES (?,?,?,?,?)').run(req.user.shop, b.name, b.trigger, b.param ?? 0, b.templateId);
    return { id: Number(r.lastInsertRowid) };
  });

  app.patch('/api/automation/:id', async (req) => {
    const r = db.prepare('SELECT * FROM automation_rule WHERE id = ? AND shop_id = ?').get(req.params.id, req.user.shop);
    if (!r) throw notFound('규칙');
    db.prepare('UPDATE automation_rule SET active = ? WHERE id = ?').run(req.body?.active ? 1 : 0, r.id);
    return { ok: true };
  });

  app.post('/api/automation/run', async (req) => runAutomation(ctx, req.user.shop));
}
