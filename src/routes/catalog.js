import { HttpError, bad, crud, int, notFound } from '../util.js';
import { DEFAULT_SETTINGS, getSetting, setSetting } from '../settings.js';

/** 기초등록: 시술 대분류, 회원권/정액권 상품, 할인, 고객등급, 제품·매입처·재고, 솔루션 설정 */
export default function (app, { db }) {
  const S = { type: 'str', req: true };
  crud(app, db, { path: '/api/categories', table: 'service_category', order: 'name', ownerOnly: true,
    fields: [{ key: 'name', col: 'name', ...S }, { key: 'color', col: 'color', type: 'str', def: '#5b5bd6' }] });
  crud(app, db, { path: '/api/pass-products', table: 'pass_product', order: 'name', ownerOnly: true,
    fields: [{ key: 'name', col: 'name', ...S }, { key: 'price', col: 'price', type: 'int', req: true },
      { key: 'totalCount', col: 'total_count', type: 'int', req: true }, { key: 'validDays', col: 'valid_days', type: 'int', def: 0 },
      { key: 'serviceId', col: 'service_id', type: 'int' }] });
  crud(app, db, { path: '/api/stored-products', table: 'stored_product', order: 'name', ownerOnly: true,
    fields: [{ key: 'name', col: 'name', ...S }, { key: 'payAmount', col: 'pay_amount', type: 'int', req: true },
      { key: 'creditAmount', col: 'credit_amount', type: 'int', req: true }, { key: 'validDays', col: 'valid_days', type: 'int', def: 0 }] });
  crud(app, db, { path: '/api/discounts', table: 'discount_preset', order: 'name', ownerOnly: true,
    fields: [{ key: 'name', col: 'name', ...S }, { key: 'kind', col: 'kind', ...S }, { key: 'value', col: 'value', type: 'int', req: true }] });
  crud(app, db, { path: '/api/grades', table: 'grade_rule', order: 'rank', ownerOnly: true, hasActive: false,
    fields: [{ key: 'name', col: 'name', ...S }, { key: 'rank', col: 'rank', type: 'int', req: true },
      { key: 'minVisits', col: 'min_visits', type: 'int', def: 0 }, { key: 'minSpent', col: 'min_spent', type: 'int', def: 0 }] });
  crud(app, db, { path: '/api/suppliers', table: 'supplier', order: 'name', ownerOnly: true,
    fields: [{ key: 'name', col: 'name', ...S }, { key: 'contact', col: 'contact', type: 'str', def: '' }, { key: 'memo', col: 'memo', type: 'str', def: '' }] });
  crud(app, db, { path: '/api/goods', table: 'goods', order: 'name', ownerOnly: true,
    fields: [{ key: 'name', col: 'name', ...S }, { key: 'supplierId', col: 'supplier_id', type: 'int' }, { key: 'cost', col: 'cost', type: 'int', def: 0 },
      { key: 'price', col: 'price', type: 'int', def: 0 }, { key: 'stock', col: 'stock', type: 'int', def: 0 }, { key: 'minStock', col: 'min_stock', type: 'int', def: 0 }] });

  // 입고/출고/재고조정 (재고는 항상 이동 이력과 함께 변경)
  app.post('/api/goods/:id/stock', async (req) => {
    const g = db.prepare('SELECT * FROM goods WHERE id = ? AND shop_id = ?').get(req.params.id, req.user.shop);
    if (!g) throw notFound('제품');
    const delta = int(req.body?.delta, '수량');
    const kind = ['in', 'out', 'adjust'].includes(req.body?.kind) ? req.body.kind : delta >= 0 ? 'in' : 'out';
    if (delta === 0) throw bad('수량이 0입니다.');
    if (g.stock + delta < 0) throw bad('재고가 부족합니다.');
    db.prepare('UPDATE goods SET stock = stock + ? WHERE id = ?').run(delta, g.id);
    db.prepare('INSERT INTO goods_move(shop_id, goods_id, delta, kind, memo) VALUES (?,?,?,?,?)').run(req.user.shop, g.id, delta, kind, req.body?.memo ?? '');
    return { stock: g.stock + delta };
  });
  app.get('/api/goods-moves', async (req) =>
    db.prepare(`SELECT m.*, g.name AS goods_name FROM goods_move m JOIN goods g ON g.id = m.goods_id WHERE m.shop_id = ? ORDER BY m.id DESC LIMIT 300`).all(req.user.shop));
  app.get('/api/goods-low', async (req) => db.prepare('SELECT * FROM goods WHERE shop_id = ? AND active = 1 AND stock <= min_stock ORDER BY stock').all(req.user.shop));

  // 솔루션 간편설정 (고객번호 규칙, 포인트 적립률, 예약 단위 등)
  app.get('/api/settings', async (req) => {
    const out = {};
    for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) out[k] = getSetting(db, req.user.shop, k, def);
    return out;
  });
  app.put('/api/settings/:key', async (req) => {
    if (req.user.role !== 'owner') throw new HttpError(403, '사장 권한이 필요합니다.');
    if (!(req.params.key in DEFAULT_SETTINGS)) throw notFound('설정');
    if (req.body?.value === undefined) throw bad('value 가 필요합니다.');
    setSetting(db, req.user.shop, req.params.key, req.body.value);
    return { ok: true };
  });
}
