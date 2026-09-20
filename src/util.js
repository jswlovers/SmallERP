export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const bad = (msg) => new HttpError(400, msg);
export const notFound = (what = '대상') => new HttpError(404, `${what}을(를) 찾을 수 없습니다.`);

export function required(obj, ...fields) {
  for (const f of fields) {
    const v = obj?.[f];
    if (v === undefined || v === null || v === '') throw bad(`${f} 값이 필요합니다.`);
  }
}

export function int(v, name = '값') {
  const n = Number(v);
  if (!Number.isInteger(n)) throw bad(`${name}은(는) 정수여야 합니다.`);
  return n;
}

/** 'YYYY-MM-DDTHH:mm' 검증 */
export function dt(v, name = '일시') {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) throw bad(`${name} 형식은 YYYY-MM-DDTHH:mm 입니다.`);
  return v;
}

export function addMinutes(local, min) {
  const d = new Date(`${local}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + min);
  return d.toISOString().slice(0, 16);
}

export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 서버 로컬 시각을 'YYYY-MM-DDTHH:mm' 로 */
export function nowLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const todayLocal = () => nowLocal().slice(0, 10);

/**
 * 단순 매장 소유 테이블용 CRUD 라우트 생성기.
 * fields: [{ key(body 키), col, type: 'str'|'int'|'bool'|'num', req?, def? }]
 * 목록은 shop_id 로 격리되고, ownerOnly 이면 쓰기는 사장만 가능하다.
 */
export function crud(app, db, { path, table, fields, order = 'id', ownerOnly = false, hasActive = true, where = '' }) {
  const conv = (f, v) => {
    if (f.type === 'int') return int(v, f.key);
    if (f.type === 'num') { const n = Number(v); if (!Number.isFinite(n)) throw bad(`${f.key} 은(는) 숫자여야 합니다.`); return n; }
    if (f.type === 'bool') return v ? 1 : 0;
    return String(v);
  };
  const guardOwner = (req) => { if (ownerOnly && req.user.role !== 'owner') throw new HttpError(403, '사장 권한이 필요합니다.'); };

  app.get(path, async (req) => db.prepare(`SELECT * FROM ${table} WHERE shop_id = ? ${where} ORDER BY ${order}`).all(req.user.shop));

  app.post(path, async (req) => {
    guardOwner(req);
    const b = req.body ?? {};
    const vals = fields.map((f) => {
      const v = b[f.key];
      if (v === undefined || v === null || v === '') {
        if (f.req) throw bad(`${f.key} 값이 필요합니다.`);
        return f.def ?? null;
      }
      return conv(f, v);
    });
    const r = db.prepare(`INSERT INTO ${table}(shop_id, ${fields.map((f) => f.col).join(',')}) VALUES (?,${fields.map(() => '?').join(',')})`).run(req.user.shop, ...vals);
    return { id: Number(r.lastInsertRowid) };
  });

  app.patch(`${path}/:id`, async (req) => {
    guardOwner(req);
    const cur = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND shop_id = ?`).get(req.params.id, req.user.shop);
    if (!cur) throw notFound('대상');
    const b = req.body ?? {};
    const sets = []; const vals = [];
    for (const f of fields) if (b[f.key] !== undefined) { sets.push(`${f.col} = ?`); vals.push(conv(f, b[f.key])); }
    if (hasActive && b.active !== undefined) { sets.push('active = ?'); vals.push(b.active ? 1 : 0); }
    if (sets.length) db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...vals, cur.id);
    return { ok: true };
  });

  app.delete(`${path}/:id`, async (req) => {
    guardOwner(req);
    db.prepare(`DELETE FROM ${table} WHERE id = ? AND shop_id = ?`).run(req.params.id, req.user.shop);
    return { ok: true };
  });
}
