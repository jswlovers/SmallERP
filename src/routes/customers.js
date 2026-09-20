import { decrypt, encrypt, normalizePhone, phoneHash } from '../crypto.js';
import { HttpError, bad, int, notFound, nowLocal, required, todayLocal } from '../util.js';
import { parseCsv, toCsv } from '../csv.js';
import { tx } from '../db.js';
import { audit } from '../audit.js';
import { DEFAULT_SETTINGS, getSetting } from '../settings.js';
import { creditBalance, pointBalance, prepaidBalance } from '../wallet.js';
import { fire } from '../messaging.js';
import { addStandby } from './ops.js';

export { prepaidBalance };

export function toCustomer(row) {
  const { phone_enc, phone_hash, ...rest } = row;
  return { ...rest, phone: decrypt(phone_enc) };
}

/** 고객번호 자동 부여: [접두어] + 자릿수 맞춘 일련번호 */
export function nextCustomerNo(db, shop) {
  const cfg = getSetting(db, shop, 'customer_no', DEFAULT_SETTINGS.customer_no);
  if (!cfg.auto) return null;
  const prefix = cfg.prefix ?? '';
  const max = db
    .prepare('SELECT MAX(CAST(substr(no, ?) AS INTEGER)) AS m FROM customer WHERE shop_id = ? AND no IS NOT NULL AND no LIKE ?')
    .get(prefix.length + 1, shop, `${prefix}%`).m ?? 0;
  return `${prefix}${String(max + 1).padStart(cfg.digits ?? 6, '0')}`;
}

const HEADERS = { name: ['이름', 'name'], phone: ['연락처', '전화번호', 'phone'], birth: ['생일', 'birth'], gender: ['성별', 'gender'],
  grade: ['등급', 'grade'], tags: ['태그', 'tags'], memo: ['메모', 'memo'], consent: ['수신동의', 'marketing_consent', 'consent'] };
const truthy = (v) => ['y', 'yes', '1', 'true', '동의', 'o'].includes(String(v).trim().toLowerCase());
const REF_TABLES = ['reservation', 'payment', 'prepaid_ledger', 'point_ledger', 'credit_ledger', 'customer_pass', 'standby', 'message_log'];

export default function (app, ctx) {
  const { db } = ctx;
  const owner = (req) => { if (req.user.role !== 'owner') throw new HttpError(403, '사장 권한이 필요합니다.'); };
  const load = (shop, id, { deleted = false } = {}) => {
    const c = db.prepare(`SELECT * FROM customer WHERE id = ? AND shop_id = ? ${deleted ? '' : 'AND deleted_at IS NULL'}`).get(id, shop);
    if (!c) throw notFound('고객');
    return c;
  };
  const lastVisitStmt = db.prepare("SELECT MAX(substr(paid_at,1,10)) v FROM payment WHERE customer_id = ? AND status = 'paid' AND kind = 'service'");

  // 고객 CSV 내보내기 (사장 전용, 엑셀 호환 UTF-8 BOM, 수식 주입 방지 처리)
  app.get('/api/customers/export.csv', async (req, reply) => {
    owner(req);
    const rows = db.prepare('SELECT * FROM customer WHERE shop_id = ? AND deleted_at IS NULL ORDER BY id').all(req.user.shop).map(toCustomer);
    audit(db, req, 'customer.export', `${rows.length}건`);
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="customers.csv"');
    return toCsv([['고객번호', '이름', '연락처', '생일', '성별', '등급', '태그', '메모', '수신동의'], ...rows.map((c) => [c.no, c.name, c.phone, c.birth, c.gender, c.grade, c.tags, c.memo, c.marketing_consent ? 'Y' : 'N'])]);
  });

  // 고객 CSV 가져오기: { csv }. 연락처 중복은 건너뛰고, 행별 오류를 보고한다. 수신동의 열이 없으면 미동의로 저장한다.
  app.post('/api/customers/import', { bodyLimit: 5 * 1024 * 1024 }, async (req) => {
    owner(req);
    const rows = parseCsv(String(req.body?.csv ?? ''));
    if (rows.length < 2) throw bad('헤더와 데이터 행이 필요합니다.');
    if (rows.length > 20001) throw bad('한 번에 20,000행까지 가져올 수 있습니다.');
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const col = Object.fromEntries(Object.entries(HEADERS).map(([k, names]) => [k, head.findIndex((h) => names.includes(h))]));
    if (col.name < 0) throw bad('"이름" 열이 필요합니다.');
    const shop = req.user.shop;
    const out = { created: 0, skipped: 0, errors: [] };
    tx(db, () => {
      const seen = new Set();
      rows.slice(1).forEach((r, i) => {
        const line = i + 2;
        const cell = (k) => (col[k] >= 0 ? (r[col[k]] ?? '').trim() : '');
        const name = cell('name');
        if (!name) { out.errors.push({ line, error: '이름이 비어 있습니다.' }); return; }
        const phone = normalizePhone(cell('phone'));
        if (cell('phone') && !/^0\d{8,10}$/.test(phone)) { out.errors.push({ line, error: `연락처 형식 오류: ${cell('phone')}` }); return; }
        const hash = phoneHash(phone);
        if (hash && (seen.has(hash) || db.prepare('SELECT 1 FROM customer WHERE shop_id = ? AND phone_hash = ?').get(shop, hash))) { out.skipped++; return; }
        if (hash) seen.add(hash);
        const consent = col.consent >= 0 && truthy(cell('consent')) ? 1 : 0;
        db.prepare('INSERT INTO customer(shop_id, no, name, phone_enc, phone_hash, birth, gender, grade, tags, memo, marketing_consent, consent_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
          shop, nextCustomerNo(db, shop), name, encrypt(phone), hash, cell('birth') || null, cell('gender') || null, cell('grade') || 'normal', cell('tags'), cell('memo'), consent, consent ? nowLocal() : null,
        );
        out.created++;
      });
    });
    audit(db, req, 'customer.import', `생성 ${out.created}, 중복 ${out.skipped}, 오류 ${out.errors.length}`);
    out.errors = out.errors.slice(0, 50);
    return out;
  });

  // 목록/검색: 고객번호 완전일치 → 연락처(해시) 완전일치 → 이름 부분일치
  app.get('/api/customers', async (req) => {
    const { q = '', tag = '', grade = '', flag = '' } = req.query;
    const shop = req.user.shop;
    let rows;
    const extra = `${grade ? 'AND grade = @grade' : ''} ${flag === 'noshow' ? 'AND noshow_flag = 1' : ''}`;
    const bind = (o) => (grade ? { ...o, grade } : o);
    if (normalizePhone(q).length >= 8 && /^[\d\-\s]+$/.test(q)) {
      rows = db.prepare(`SELECT * FROM customer WHERE shop_id = @shop AND deleted_at IS NULL AND phone_hash = @h ${extra}`).all(bind({ shop, h: phoneHash(q) }));
    } else {
      rows = db
        .prepare(`SELECT * FROM customer WHERE shop_id = @shop AND deleted_at IS NULL AND (name LIKE @like OR no = @q) AND (@tag = '' OR (',' || tags || ',') LIKE @tagLike) ${extra} ORDER BY id DESC LIMIT 200`)
        .all(bind({ shop, like: `%${q}%`, q, tag, tagLike: `%,${tag},%` }));
    }
    return rows.map((r) => ({ ...toCustomer(r), lastVisit: lastVisitStmt.get(r.id).v }));
  });

  app.post('/api/customers', async (req) => {
    required(req.body, 'name');
    const b = req.body;
    const shop = req.user.shop;
    const hash = phoneHash(b.phone);
    if (hash) {
      const dup = db.prepare('SELECT deleted_at FROM customer WHERE shop_id = ? AND phone_hash = ?').get(shop, hash);
      if (dup) throw new HttpError(409, dup.deleted_at ? '삭제된 고객의 연락처입니다. 삭제 고객 복구를 이용하세요.' : '이미 등록된 연락처입니다.');
    }
    if (b.referrerId) load(shop, b.referrerId);
    if (b.familyHeadId) load(shop, b.familyHeadId);
    const consent = b.marketingConsent ? 1 : 0;
    const id = tx(db, () => Number(
      db
        .prepare(
          `INSERT INTO customer(shop_id, no, name, phone_enc, phone_hash, birth, anniversary, gender, grade, tags, memo, staff_id, marketing_consent, consent_at, referrer_id, family_head_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          shop, nextCustomerNo(db, shop), b.name, encrypt(normalizePhone(b.phone)), hash, b.birth ?? null, b.anniversary ?? null, b.gender ?? null,
          b.grade ?? 'normal', b.tags ?? '', b.memo ?? '', b.staffId ?? null, consent, consent ? nowLocal() : null, b.referrerId ?? null, b.familyHeadId ?? null,
        ).lastInsertRowid,
    ));
    const me = db.prepare('SELECT * FROM customer WHERE id = ?').get(id);
    if (getSetting(db, shop, 'defaults', DEFAULT_SETTINGS.defaults).standbyOnCreate) addStandby(db, shop, { customerId: id, name: me.name });
    await fire(ctx, shop, 'customer_created', me, {}, `c${id}`);
    if (b.referrerId) {
      const ref = db.prepare('SELECT * FROM customer WHERE id = ?').get(b.referrerId);
      await fire(ctx, shop, 'referred_welcome', me, { referrer: ref.name }, `c${id}`);
      await fire(ctx, shop, 'referrer_thanks', ref, { referred: me.name }, `c${id}`);
    }
    return { id, no: me.no };
  });

  app.get('/api/customers/deleted', async (req) => db.prepare('SELECT id, no, name, deleted_at FROM customer WHERE shop_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC').all(req.user.shop));

  // 동명 고객 묶음 (중복 병합 후보)
  app.get('/api/customers/duplicates', async (req) => {
    const shop = req.user.shop;
    const names = db.prepare('SELECT name FROM customer WHERE shop_id = ? AND deleted_at IS NULL GROUP BY name HAVING COUNT(*) > 1').all(shop);
    return names.map(({ name }) => ({
      name,
      customers: db.prepare('SELECT * FROM customer WHERE shop_id = ? AND deleted_at IS NULL AND name = ? ORDER BY id').all(shop, name)
        .map((c) => ({ id: c.id, no: c.no, phone: decrypt(c.phone_enc), birth: c.birth, lastVisit: lastVisitStmt.get(c.id).v })),
    }));
  });

  // 병합: source 의 모든 이력을 target 으로 옮기고 source 를 삭제한다 (사장 전용)
  app.post('/api/customers/merge', async (req) => {
    owner(req);
    const shop = req.user.shop;
    const targetId = int(req.body?.targetId, 'targetId');
    const sourceId = int(req.body?.sourceId, 'sourceId');
    if (targetId === sourceId) throw bad('같은 고객은 병합할 수 없습니다.');
    const t = load(shop, targetId);
    const s = load(shop, sourceId);
    tx(db, () => {
      for (const tbl of REF_TABLES) db.prepare(`UPDATE ${tbl} SET customer_id = ? WHERE customer_id = ?`).run(t.id, s.id);
      db.prepare('UPDATE customer SET referrer_id = ? WHERE referrer_id = ?').run(t.id, s.id);
      db.prepare('UPDATE customer SET family_head_id = ? WHERE family_head_id = ?').run(t.id, s.id);
      const tags = [...new Set([...t.tags.split(','), ...s.tags.split(',')].map((x) => x.trim()).filter(Boolean))].join(',');
      db.prepare(
        `UPDATE customer SET tags = ?, memo = ?, noshow_flag = ?, phone_enc = COALESCE(phone_enc, ?), phone_hash = COALESCE(phone_hash, ?), birth = COALESCE(birth, ?),
           prepaid_expires_at = MAX(COALESCE(prepaid_expires_at,''), COALESCE(?, '')) WHERE id = ?`,
      ).run(tags, [t.memo, s.memo].filter(Boolean).join(' / '), Math.max(t.noshow_flag, s.noshow_flag), s.phone_enc, s.phone_hash, s.birth, s.prepaid_expires_at, t.id);
      db.prepare('UPDATE customer SET prepaid_expires_at = NULL WHERE id = ? AND prepaid_expires_at = \'\'').run(t.id);
      db.prepare('DELETE FROM customer WHERE id = ?').run(s.id);
    });
    audit(db, req, 'customer.merge', `#${s.id} → #${t.id}`);
    return { ok: true };
  });

  app.get('/api/families', async (req) => {
    const shop = req.user.shop;
    const heads = db.prepare('SELECT DISTINCT family_head_id AS id FROM customer WHERE shop_id = ? AND deleted_at IS NULL AND family_head_id IS NOT NULL').all(shop);
    return heads.map(({ id }) => {
      const head = db.prepare('SELECT id, no, name FROM customer WHERE id = ?').get(id);
      const members = db.prepare('SELECT id, no, name FROM customer WHERE family_head_id = ? AND deleted_at IS NULL').all(id);
      return { head, members };
    });
  });

  app.get('/api/customers/:id', async (req) => {
    const shop = req.user.shop;
    const c = load(shop, req.params.id);
    const visits = db
      .prepare(
        `SELECT p.id, p.paid_at, p.total, p.status, p.kind, s.name AS staff,
                (SELECT group_concat(name, ', ') FROM payment_item WHERE payment_id = p.id) AS items
         FROM payment p JOIN staff s ON s.id = p.staff_id
         WHERE p.customer_id = ? AND p.shop_id = ? ORDER BY p.paid_at DESC`,
      )
      .all(c.id, shop);
    const reservations = db
      .prepare('SELECT id, start_at, status FROM reservation WHERE customer_id = ? AND shop_id = ? ORDER BY start_at DESC LIMIT 20')
      .all(c.id, shop);
    const passes = db.prepare('SELECT * FROM customer_pass WHERE customer_id = ? AND shop_id = ? ORDER BY id DESC').all(c.id, shop);
    const referrer = c.referrer_id ? db.prepare('SELECT id, name FROM customer WHERE id = ?').get(c.referrer_id) : null;
    const familyId = c.family_head_id ?? c.id;
    const family = db.prepare('SELECT id, name FROM customer WHERE deleted_at IS NULL AND id <> ? AND (family_head_id = ? OR id = ?)').all(c.id, familyId, c.family_head_id ?? -1);
    return {
      ...toCustomer(c), visits, reservations, passes, referrer, family,
      prepaidBalance: prepaidBalance(db, shop, c.id), points: pointBalance(db, shop, c.id), credit: creditBalance(db, shop, c.id),
      noshowCount: db.prepare("SELECT COUNT(*) n FROM reservation WHERE customer_id = ? AND status = 'noshow'").get(c.id).n,
      lastVisit: lastVisitStmt.get(c.id).v,
    };
  });

  app.patch('/api/customers/:id', async (req) => {
    const c = load(req.user.shop, req.params.id);
    const b = req.body ?? {};
    let phone_enc = c.phone_enc;
    let phone_hash = c.phone_hash;
    if (b.phone !== undefined) {
      phone_enc = encrypt(normalizePhone(b.phone));
      phone_hash = phoneHash(b.phone);
      const dup = phone_hash && db.prepare('SELECT id FROM customer WHERE shop_id = ? AND phone_hash = ? AND id <> ?').get(req.user.shop, phone_hash, c.id);
      if (dup) throw bad('이미 등록된 연락처입니다.');
    }
    if (b.referrerId) load(req.user.shop, b.referrerId);
    if (b.familyHeadId) load(req.user.shop, b.familyHeadId);
    const consent = b.marketingConsent === undefined ? c.marketing_consent : b.marketingConsent ? 1 : 0;
    const pick = (k, cur) => (b[k] === undefined ? cur : b[k] === '' ? null : b[k]);
    db.prepare(
      `UPDATE customer SET name=?, phone_enc=?, phone_hash=?, birth=?, anniversary=?, gender=?, grade=?, tags=?, memo=?, staff_id=?, marketing_consent=?, consent_at=?,
         referrer_id=?, family_head_id=?, noshow_flag=? WHERE id=?`,
    ).run(
      b.name ?? c.name, phone_enc, phone_hash, pick('birth', c.birth), pick('anniversary', c.anniversary), pick('gender', c.gender), b.grade ?? c.grade,
      b.tags ?? c.tags, b.memo ?? c.memo, pick('staffId', c.staff_id), consent, consent !== c.marketing_consent ? nowLocal() : c.consent_at,
      pick('referrerId', c.referrer_id), pick('familyHeadId', c.family_head_id), b.noshowFlag === undefined ? c.noshow_flag : b.noshowFlag ? 1 : 0, c.id,
    );
    return { ok: true };
  });

  app.delete('/api/customers/:id', async (req) => {
    owner(req);
    const c = load(req.user.shop, req.params.id);
    db.prepare('UPDATE customer SET deleted_at = ? WHERE id = ?').run(nowLocal(), c.id);
    audit(db, req, 'customer.delete', `#${c.id} ${c.name}`);
    return { ok: true };
  });

  app.post('/api/customers/:id/restore', async (req) => {
    owner(req);
    const c = load(req.user.shop, req.params.id, { deleted: true });
    db.prepare('UPDATE customer SET deleted_at = NULL WHERE id = ?').run(c.id);
    audit(db, req, 'customer.restore', `#${c.id} ${c.name}`);
    return { ok: true };
  });

  // 선불권 수동 충전(결제 없이 잔액 조정). 정식 판매는 POST /api/customers/:id/stored
  app.post('/api/customers/:id/prepaid', async (req) => {
    const c = load(req.user.shop, req.params.id);
    const amount = int(req.body?.amount, '금액');
    if (amount <= 0) throw bad('충전 금액은 0보다 커야 합니다.');
    db.prepare("INSERT INTO prepaid_ledger(shop_id, customer_id, delta, reason) VALUES (?,?,?, '충전')").run(req.user.shop, c.id, amount);
    return { balance: prepaidBalance(db, req.user.shop, c.id) };
  });
}
