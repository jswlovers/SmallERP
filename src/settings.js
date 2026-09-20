/** 매장별 키-값 설정 (JSON). 솔루션 간편설정, 포인트 적립률, 고객번호 규칙 등에 사용 */
export function getSetting(db, shop, key, fallback = null) {
  const r = db.prepare('SELECT value FROM shop_setting WHERE shop_id = ? AND key = ?').get(shop, key);
  if (!r) return fallback;
  try { return JSON.parse(r.value); } catch { return fallback; }
}

export function setSetting(db, shop, key, value) {
  db.prepare('INSERT INTO shop_setting(shop_id, key, value) VALUES (?,?,?) ON CONFLICT(shop_id, key) DO UPDATE SET value = excluded.value')
    .run(shop, key, JSON.stringify(value));
}

export const DEFAULT_SETTINGS = {
  customer_no: { auto: true, prefix: '', digits: 6 },
  defaults: { gender: 'F', standbyOnCreate: false, consentPrompt: true },
  point_rates: { cash: 0, card: 0, naverpay: 0, etc: 0 },
  point_use: { min: 1000 },
  reservation: { unit: 30, completeOn: 'payment', openTime: '09:00', closeTime: '21:00' },
  owner_phone: '',
};
