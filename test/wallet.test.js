import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { mockProvider } from '../src/sms/provider.js';
import { runAutomation } from '../src/messaging.js';
import { addDays, todayLocal } from '../src/util.js';

process.env.SMS_LOG = '0';

let app, db, tk, owner, shop, svc, cust;
const call = async (method, url, body, token = tk) => {
  const res = await app.inject({ method, url, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const ct = res.headers['content-type'] ?? '';
  return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body };
};

before(async () => {
  db = openDb(':memory:');
  app = buildApp({ db });
  tk = (await call('POST', '/api/auth/register', { shopName: '월렛샵', ownerName: '사장', loginId: 'wal', password: 'password123' }, null)).body.token;
  const me = (await call('GET', '/api/me')).body;
  owner = me.staff.id; shop = me.shop.id;
  svc = Object.fromEntries((await call('GET', '/api/services')).body.map((s) => [s.name, s]));
  cust = (await call('POST', '/api/customers', { name: '지갑고객', phone: '010-7000-0001', marketingConsent: true, birth: '1990-05-01' })).body.id;
});

test('고객번호 자동 부여와 번호 검색', async () => {
  const c = (await call('GET', `/api/customers/${cust}`)).body;
  assert.equal(c.no, '000001');
  const c2 = (await call('POST', '/api/customers', { name: '둘째', phone: '010-7000-0002' })).body;
  assert.equal(c2.no, '000002');
  assert.equal((await call('GET', '/api/customers?q=000002')).body[0].name, '둘째');
});

test('회원권 판매→사용(횟수 차감)→환불 규칙', async () => {
  const prod = (await call('POST', '/api/pass-products', { name: '컷 5회권', price: 100000, totalCount: 5, validDays: 90, serviceId: svc['커트'].id })).body.id;
  const sale = await call('POST', `/api/customers/${cust}/passes`, { productId: prod, lines: [{ method: 'card', amount: 100000 }] });
  assert.equal(sale.status, 200);
  const passId = (await call('GET', `/api/customers/${cust}/wallet`)).body.passes[0].id;
  // 다른 시술에는 사용 불가
  assert.equal((await call('POST', '/api/payments', { customerId: cust, staffId: owner, items: [{ serviceId: svc['펌'].id, usePassId: passId }], lines: [] })).status, 400);
  const use = await call('POST', '/api/payments', { customerId: cust, staffId: owner, items: [{ serviceId: svc['커트'].id, usePassId: passId }], lines: [] });
  assert.equal(use.status, 200);
  assert.equal(use.body.total, 0);
  assert.equal((await call('GET', `/api/customers/${cust}/wallet`)).body.passes[0].remaining, 4);
  // 사용 환불 시 횟수 복원, 일부 사용한 판매는 환불 불가
  await call('POST', `/api/payments/${use.body.id}/refund`);
  assert.equal((await call('GET', `/api/customers/${cust}/wallet`)).body.passes[0].remaining, 5);
  assert.equal((await call('POST', `/api/payments/${sale.body.paymentId}/refund`)).status, 200); // 미사용이라 환불 가능
  assert.equal((await call('GET', `/api/customers/${cust}/wallet`)).body.passes.length, 0);
});

test('정액권: 보너스 충전, 결제 사용, 유효기간 만료 시 소멸, 판매 매출 분리', async () => {
  const prod = (await call('POST', '/api/stored-products', { name: 'VIP권', payAmount: 500000, creditAmount: 550000, validDays: 365 })).body.id;
  const r = await call('POST', `/api/customers/${cust}/stored`, { productId: prod, lines: [{ method: 'cash', amount: 500000 }] });
  assert.equal(r.body.balance, 550000);
  assert.equal((await call('POST', '/api/payments', { customerId: cust, staffId: owner, items: [{ serviceId: svc['펌'].id }], lines: [{ method: 'prepaid', amount: 80000 }], paidAt: '2030-03-01T10:00' })).status, 200);
  assert.equal((await call('GET', `/api/customers/${cust}/wallet`)).body.prepaid, 470000);
  // 정액권 판매는 서비스 매출에 포함되지 않는다(이중 집계 방지)
  const st = (await call('GET', `/api/stats/summary?from=${todayLocal()}&to=${todayLocal()}`)).body;
  assert.equal(st.sales, 0);
  // 유효기간 경과 → 잔액 소멸
  db.prepare('UPDATE customer SET prepaid_expires_at = ? WHERE id = ?').run(addDays(todayLocal(), -1), cust);
  assert.equal((await call('GET', `/api/customers/${cust}/wallet`)).body.prepaid, 0);
});

test('할인 프리셋, 포인트 적립/사용/환불, 등급 자동 승급', async () => {
  await call('PUT', '/api/settings/point_rates', { value: { cash: 5, card: 1, naverpay: 0, etc: 0 } });
  await call('POST', '/api/grades', { name: 'vip', rank: 1, minVisits: 3 });
  const c = (await call('POST', '/api/customers', { name: '포인트', phone: '010-7000-0003' })).body.id;
  const d = (await call('POST', '/api/discounts', { name: '10%할인', kind: 'percent', value: 10 })).body.id;
  const pay = await call('POST', '/api/payments', { customerId: c, staffId: owner, items: [{ serviceId: svc['커트'].id }], discountPresetId: d, lines: [{ method: 'cash', amount: 18000 }] });
  assert.equal(pay.body.discount, 2000);
  assert.equal(pay.body.earned, 900); // 18000 × 5%
  assert.equal((await call('GET', `/api/customers/${c}/wallet`)).body.points, 900);
  // 포인트로 결제
  const p2 = await call('POST', '/api/payments', { customerId: c, staffId: owner, items: [{ serviceId: svc['커트'].id }], lines: [{ method: 'point', amount: 900 }, { method: 'card', amount: 19100 }] });
  assert.equal(p2.status, 200);
  assert.equal((await call('POST', '/api/payments', { customerId: c, staffId: owner, items: [{ name: '기타', price: 1000 }], lines: [{ method: 'point', amount: 1000 }] })).status, 400); // 잔액 부족
  // 3번째 방문에서 등급 승급
  const p3 = await call('POST', '/api/payments', { customerId: c, staffId: owner, items: [{ serviceId: svc['커트'].id }], lines: [{ method: 'cash', amount: 20000 }] });
  assert.equal(p3.body.gradeUp, 'vip');
  assert.equal((await call('GET', `/api/customers/${c}`)).body.grade, 'vip');
  // 환불 시 적립 취소 + 사용 포인트 복원
  await call('POST', `/api/payments/${p2.body.id}/refund`);
  assert.equal((await call('GET', `/api/customers/${c}/wallet`)).body.points, 1900); // 900 - 900 + 191 + 1000 + 900(복원) - 191(적립취소)
});

test('외상 결제/수금과 미수금 목록', async () => {
  const c = (await call('POST', '/api/customers', { name: '외상', phone: '010-7000-0004' })).body.id;
  await call('POST', '/api/payments', { customerId: c, staffId: owner, items: [{ serviceId: svc['커트'].id }], lines: [{ method: 'credit', amount: 20000 }] });
  assert.equal((await call('GET', '/api/receivables')).body.find((r) => r.id === c).balance, 20000);
  assert.equal((await call('POST', `/api/customers/${c}/credit/pay`, { amount: 30000 })).status, 400);
  assert.equal((await call('POST', `/api/customers/${c}/credit/pay`, { amount: 20000 })).body.credit, 0);
});

test('제품 판매: 재고 차감·부족 차단·환불 복원·재고 부족 알림 목록', async () => {
  const sup = (await call('POST', '/api/suppliers', { name: '핸드' })).body.id;
  const g = (await call('POST', '/api/goods', { name: '스프레이', supplierId: sup, cost: 10000, price: 15000, stock: 2, minStock: 2 })).body.id;
  assert.equal((await call('GET', '/api/goods-low')).body.length, 1);
  const c = (await call('GET', '/api/customers?q=포인트')).body[0].id;
  const p = await call('POST', '/api/payments', { customerId: c, staffId: owner, items: [{ goodsId: g, qty: 2 }], lines: [{ method: 'card', amount: 30000 }] });
  assert.equal(p.status, 200);
  assert.equal((await call('POST', '/api/payments', { customerId: c, staffId: owner, items: [{ goodsId: g, qty: 1 }], lines: [{ method: 'card', amount: 15000 }] })).status, 400);
  await call('POST', `/api/payments/${p.body.id}/refund`);
  assert.equal((await call('GET', '/api/goods')).body[0].stock, 2);
  assert.equal((await call('POST', `/api/goods/${g}/stock`, { delta: -5 })).status, 400);
});

test('고객 삭제/복구/병합/중복 조회', async () => {
  const a = (await call('POST', '/api/customers', { name: '동명', phone: '010-7100-0001' })).body.id;
  const b = (await call('POST', '/api/customers', { name: '동명', phone: '010-7100-0002' })).body.id;
  assert.ok((await call('GET', '/api/customers/duplicates')).body.some((g) => g.name === '동명'));
  await call('POST', `/api/customers/${b}/prepaid`, { amount: 10000 });
  assert.equal((await call('POST', '/api/customers/merge', { targetId: a, sourceId: b })).status, 200);
  assert.equal((await call('GET', `/api/customers/${a}`)).body.prepaidBalance, 10000); // 이력 이전
  assert.equal((await call('GET', `/api/customers/${b}`)).status, 404);
  await call('DELETE', `/api/customers/${a}`);
  assert.equal((await call('GET', '/api/customers?q=동명')).body.length, 0);
  assert.equal((await call('POST', '/api/customers', { name: '재등록', phone: '010-7100-0001' })).status, 409); // 삭제 고객 연락처
  await call('POST', `/api/customers/${a}/restore`);
  assert.equal((await call('GET', '/api/customers?q=동명')).body.length, 1);
});

test('이벤트/스케줄 문자: 신규등록·소개자·회원권 만료 예정·정액권 잔액 미달', async () => {
  const tpl = (await call('POST', '/api/templates', { name: '알림', body: '[{{shop}}] {{name}}님 안내 {{referred}}{{pass}}{{balance}}' })).body.id;
  for (const trigger of ['customer_created', 'referrer_thanks']) await call('POST', '/api/automation', { name: trigger, trigger, templateId: tpl });
  await call('POST', '/api/automation', { name: '만료', trigger: 'pass_expiring', param: 7, templateId: tpl });
  await call('POST', '/api/automation', { name: '미달', trigger: 'stored_low', param: 50000, templateId: tpl });
  mockProvider.sent.length = 0;
  const ref = (await call('POST', '/api/customers', { name: '소개자', phone: '010-7200-0001' })).body.id;
  await call('POST', '/api/customers', { name: '소개받은', phone: '010-7200-0002', referrerId: ref });
  assert.equal(mockProvider.sent.length, 3); // 소개자 신규 1 + 소개받은 신규 1 + 소개자 감사 1
  // 회원권 만료 3일 전
  const prod = (await call('POST', '/api/pass-products', { name: '단기권', price: 10000, totalCount: 2, validDays: 3 })).body.id;
  await call('POST', `/api/customers/${ref}/passes`, { productId: prod, lines: [{ method: 'cash', amount: 10000 }] });
  await call('POST', `/api/customers/${ref}/prepaid`, { amount: 30000 });
  mockProvider.sent.length = 0;
  const r = await runAutomation({ db, sms: mockProvider }, shop, `${todayLocal()}T10:00`);
  assert.ok(r.sent >= 2, `만료 예정 + 잔액 미달 발송: ${JSON.stringify(r)}`);
});
