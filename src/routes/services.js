import { bad, int, notFound, required } from '../util.js';

export default function (app, { db }) {
  /** 분류 ID 가 있으면 분류명을 문자열 필드(category)에 동기화 */
  const catName = (shop, id, fallback) => {
    if (id === null || id === undefined || id === '') return fallback;
    const c = db.prepare('SELECT name FROM service_category WHERE id = ? AND shop_id = ?').get(id, shop);
    if (!c) throw notFound('분류');
    return c.name;
  };

  app.get('/api/services', async (req) =>
    db.prepare('SELECT * FROM service WHERE shop_id = ? ORDER BY category, name').all(req.user.shop),
  );

  app.post('/api/services', async (req) => {
    required(req.body, 'name', 'price');
    const { name, price, durationMin = 60, categoryId = null } = req.body;
    const category = catName(req.user.shop, categoryId, req.body.category ?? '');
    if (int(price, '가격') < 0) throw bad('가격은 0 이상이어야 합니다.');
    const r = db
      .prepare('INSERT INTO service(shop_id, name, category, category_id, price, duration_min) VALUES (?,?,?,?,?,?)')
      .run(req.user.shop, name, category, categoryId, int(price, '가격'), int(durationMin, '소요시간'));
    return { id: Number(r.lastInsertRowid) };
  });

  app.patch('/api/services/:id', async (req) => {
    const cur = db.prepare('SELECT * FROM service WHERE id = ? AND shop_id = ?').get(req.params.id, req.user.shop);
    if (!cur) throw notFound('시술');
    const b = req.body ?? {};
    const cid = b.categoryId === undefined ? cur.category_id : b.categoryId;
    db.prepare('UPDATE service SET name=?, category=?, category_id=?, price=?, duration_min=?, active=? WHERE id=?').run(
      b.name ?? cur.name,
      b.categoryId === undefined ? (b.category ?? cur.category) : catName(req.user.shop, cid, ''),
      cid,
      b.price === undefined ? cur.price : int(b.price, '가격'),
      b.durationMin === undefined ? cur.duration_min : int(b.durationMin, '소요시간'),
      b.active === undefined ? cur.active : b.active ? 1 : 0,
      cur.id,
    );
    return { ok: true };
  });
}
