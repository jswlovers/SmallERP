import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { genShopCode } from './crypto.js';

// 날짜/시간은 매장 로컬 기준 'YYYY-MM-DDTHH:mm' 문자열로 저장한다(사전순 비교 가능).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS shop (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'basic',
  sms_balance INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shop(id),
  name TEXT NOT NULL,
  login_id TEXT UNIQUE,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'staff',
  commission_rate REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS customer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shop(id),
  name TEXT NOT NULL,
  phone_enc TEXT,
  phone_hash TEXT,
  birth TEXT,
  gender TEXT,
  grade TEXT NOT NULL DEFAULT 'normal',
  tags TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  staff_id INTEGER REFERENCES staff(id),
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  consent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_customer_phone ON customer(shop_id, phone_hash);
CREATE TABLE IF NOT EXISTS service (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shop(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 60,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS reservation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shop(id),
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',
  source TEXT NOT NULL DEFAULT 'internal',
  external_id TEXT,
  memo TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_resv_time ON reservation(shop_id, start_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_resv_ext ON reservation(shop_id, source, external_id) WHERE external_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS reservation_item (
  reservation_id INTEGER NOT NULL REFERENCES reservation(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES service(id),
  price INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shop(id),
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  reservation_id INTEGER REFERENCES reservation(id),
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'paid',
  paid_at TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_pay_time ON payment(shop_id, paid_at);
CREATE TABLE IF NOT EXISTS payment_item (
  payment_id INTEGER NOT NULL REFERENCES payment(id) ON DELETE CASCADE,
  service_id INTEGER REFERENCES service(id),
  name TEXT NOT NULL,
  price INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_line (
  payment_id INTEGER NOT NULL REFERENCES payment(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  amount INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS prepaid_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  payment_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS message_template (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  is_ad INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS automation_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  trigger TEXT NOT NULL,
  param INTEGER NOT NULL DEFAULT 0,
  template_id INTEGER NOT NULL REFERENCES message_template(id),
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS message_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  customer_id INTEGER,
  rule_id INTEGER,
  ref_key TEXT,
  channel TEXT NOT NULL DEFAULT 'sms',
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  cost INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS admin_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_setting (
  shop_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (shop_id, key)
);
CREATE TABLE IF NOT EXISTS service_category (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#5b5bd6',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS pass_product (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  valid_days INTEGER NOT NULL DEFAULT 0,
  service_id INTEGER REFERENCES service(id),
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS customer_pass (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  product_id INTEGER REFERENCES pass_product(id),
  name TEXT NOT NULL,
  service_id INTEGER,
  total_count INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  price INTEGER NOT NULL,
  expires_at TEXT,
  payment_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS pass_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pass_id INTEGER NOT NULL REFERENCES customer_pass(id),
  payment_id INTEGER,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS stored_product (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  pay_amount INTEGER NOT NULL,
  credit_amount INTEGER NOT NULL,
  valid_days INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS discount_preset (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  value INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS grade_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  rank INTEGER NOT NULL,
  min_visits INTEGER NOT NULL DEFAULT 0,
  min_spent INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS point_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  payment_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  payment_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS supplier (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS goods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  supplier_id INTEGER REFERENCES supplier(id),
  name TEXT NOT NULL,
  cost INTEGER NOT NULL DEFAULT 0,
  price INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS goods_move (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  goods_id INTEGER NOT NULL REFERENCES goods(id),
  delta INTEGER NOT NULL,
  kind TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  payment_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS staff_schedule (
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  weekday INTEGER NOT NULL,
  off INTEGER NOT NULL DEFAULT 0,
  start_time TEXT NOT NULL DEFAULT '09:00',
  end_time TEXT NOT NULL DEFAULT '21:00',
  PRIMARY KEY (staff_id, weekday)
);
CREATE TABLE IF NOT EXISTS staff_break (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  weekday INTEGER,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '브레이크'
);
CREATE TABLE IF NOT EXISTS day_off (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  staff_id INTEGER,
  date TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS time_block (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  staff_id INTEGER,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS standby (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  number INTEGER NOT NULL,
  customer_id INTEGER REFERENCES customer(id),
  name TEXT NOT NULL,
  staff_id INTEGER,
  status TEXT NOT NULL DEFAULT 'waiting',
  memo TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cash_category (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS cash_entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  category_id INTEGER REFERENCES cash_category(id),
  amount INTEGER NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  created_by INTEGER
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  date TEXT NOT NULL,
  clock_in TEXT,
  clock_out TEXT,
  UNIQUE (staff_id, date)
);
CREATE TABLE IF NOT EXISTS shop_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS staff_goal (
  shop_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  month TEXT NOT NULL,
  amount INTEGER NOT NULL,
  PRIMARY KEY (staff_id, month)
);
CREATE TABLE IF NOT EXISTS daily_close (
  shop_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  cash_counted INTEGER,
  note TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL,
  closed_by INTEGER,
  closed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (shop_id, date)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  staff_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_msg_dedupe ON message_log(rule_id, customer_id, ref_key) WHERE rule_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS otp_code (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  phone_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_otp_lookup ON otp_code(shop_id, phone_hash, created_at);
`;

export function openDb(file = process.env.DB_FILE || 'data/smallerp.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** 기존 DB 파일에 뒤늦게 추가된 컬럼 보정 */
function migrate(db) {
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  const add = (table, col, ddl) => { if (!has(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); };
  add('shop', 'active', 'INTEGER NOT NULL DEFAULT 1');
  add('customer', 'no', 'TEXT');
  add('customer', 'deleted_at', 'TEXT');
  add('customer', 'referrer_id', 'INTEGER');
  add('customer', 'family_head_id', 'INTEGER');
  add('customer', 'anniversary', 'TEXT');
  add('customer', 'noshow_flag', 'INTEGER NOT NULL DEFAULT 0');
  add('customer', 'prepaid_expires_at', 'TEXT');
  add('service', 'category_id', 'INTEGER');
  add('staff', 'phone_enc', 'TEXT');
  add('staff', 'base_pay', 'INTEGER NOT NULL DEFAULT 0');
  add('payment', 'kind', "TEXT NOT NULL DEFAULT 'service'");
  add('payment', 'discount', 'INTEGER NOT NULL DEFAULT 0');
  add('payment_item', 'goods_id', 'INTEGER');
  add('payment_item', 'qty', 'INTEGER NOT NULL DEFAULT 1');
  add('message_log', 'staff_id', 'INTEGER');
  add('shop', 'public_code', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_customer_no ON customer(shop_id, no) WHERE no IS NOT NULL');

  // 고객 온라인 예약 링크 코드가 없는 매장(기존 DB)에는 새로 발급한다.
  const noCode = db.prepare('SELECT id FROM shop WHERE public_code IS NULL').all();
  if (noCode.length) {
    const taken = db.prepare('UPDATE shop SET public_code = ? WHERE id = ?');
    for (const { id } of noCode) {
      let code;
      do { code = genShopCode(); } while (db.prepare('SELECT 1 FROM shop WHERE public_code = ?').get(code));
      taken.run(code, id);
    }
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_shop_public_code ON shop(public_code)');
}

/** 트랜잭션 헬퍼: 예외 시 롤백 */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
