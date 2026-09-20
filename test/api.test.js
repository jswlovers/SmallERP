import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { mockProvider } from '../src/sms/provider.js';
import { runAutomation } from '../src/messaging.js';

process.env.SMS_LOG = '0';
process.env.NAVER_WEBHOOK_SECRET = 'whsec';

let app, db, token, shopId, ownerId, services;
const call = async (method, url, body, tk = token, headers = {}) => {
  const res = await app.inject({ method, url, payload: body, headers: { ...(tk ? { authorization: `Bearer ${tk}` } : {}), ...headers } });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

before(async () => {
  db = openDb(':memory:');
  app = buildApp({ db });
  const r = await call('POST', '/api/auth/register', { shopName: '헤어굿', ownerName: '김원장', loginId: 'owner1', password: 'password123' }, null);
  assert.equal(r.status, 200);
  token = r.body.token;
  const me = await call('GET', '/api/me');
  shopId = me.body.shop.id;
  ownerId = me.body.staff.id;
  services = (await call('GET', '/api/services')).body;
});

test('인증 없이 접근하면 401', async () => {
  assert.equal((await call('GET', '/api/customers', null, null)).status, 401);
});

test('로그인 실패/성공', async () => {
  assert.equal((await call('POST', '/api/auth/login', { loginId: 'owner1', password: 'wrong' }, null)).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { loginId: 'owner1', password: 'password123' }, null)).status, 200);
});

test('고객 등록·연락처 암호화 저장·검색·중복 방지', async () => {
  const c = await call('POST', '/api/customers', { name: '홍길동', phone: '010-1234-5678', marketingConsent: true, birth: '1990-05-01' });
  assert.equal(c.status, 200);
  const raw = db.prepare('SELECT phone_enc FROM customer WHERE id = ?').get(c.body.id);
  assert.ok(!raw.phone_enc.includes('01012345678'));
  const byPhone = await call('GET', '/api/customers?q=010-1234-5678');
  assert.equal(byPhone.body[0].name, '홍길동');
  assert.equal(byPhone.body[0].phone, '01012345678');
  assert.equal((await call('GET', '/api/customers?q=홍')).body.length, 1);
  assert.equal((await call('POST', '/api/customers', { name: '중복', phone: '01012345678' })).status, 409);
});

test('예약: 소요시간 계산, 담당자 시간 충돌 409, 취소 후 재예약', async () => {
  const cust = (await call('GET', '/api/customers?q=홍')).body[0];
  const cut = services.find((s) => s.name === '커트'); // 40분
  const a = await call('POST', '/api/reservations', { customerId: cust.id, staffId: ownerId, startAt: '2030-01-10T10:00', serviceIds: [cut.id] });
  assert.equal(a.status, 200);
  assert.equal(a.body.endAt, '2030-01-10T10:40');
  const conflict = await call('POST', '/api/reservations', { customerId: cust.id, staffId: ownerId, startAt: '2030-01-10T10:30', serviceIds: [cut.id] });
  assert.equal(conflict.status, 409);
  const adjacent = await call('POST', '/api/reservations', { customerId: cust.id, staffId: ownerId, startAt: '2030-01-10T10:40', serviceIds: [cut.id] });
  assert.equal(adjacent.status, 200);
  await call('PATCH', `/api/reservations/${a.body.id}`, { status: 'cancelled' });
  assert.equal((await call('POST', '/api/reservations', { customerId: cust.id, staffId: ownerId, startAt: '2030-01-10T10:10', serviceIds: [cut.id] })).status, 409); // 10:40 예약과 겹침
  const list = await call('GET', '/api/reservations?from=2030-01-10&to=2030-01-10');
  assert.equal(list.body.length, 2);
});

test('결제: 합계 검증, 선불권 잔액/차감, 환불 시 복원', async () => {
  const cust = (await call('GET', '/api/customers?q=홍')).body[0];
  const cut = services.find((s) => s.name === '커트');
  const pay = (lines) => call('POST', '/api/payments', { customerId: cust.id, staffId: ownerId, items: [{ serviceId: cut.id }], lines, paidAt: '2030-01-11T12:00' });

  assert.equal((await pay([{ method: 'cash', amount: 10000 }])).status, 400); // 합계 불일치
  assert.equal((await pay([{ method: 'prepaid', amount: 20000 }])).status, 400); // 잔액 부족
  await call('POST', `/api/customers/${cust.id}/prepaid`, { amount: 50000 });
  const ok = await pay([{ method: 'prepaid', amount: 5000 }, { method: 'card', amount: 15000 }]);
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', `/api/customers/${cust.id}`)).body.prepaidBalance, 45000);

  const refund = await call('POST', `/api/payments/${ok.body.id}/refund`);
  assert.equal(refund.body.restoredPrepaid, 5000);
  assert.equal((await call('GET', `/api/customers/${cust.id}`)).body.prepaidBalance, 50000);
  assert.equal((await call('POST', `/api/payments/${ok.body.id}/refund`)).status, 409);
});

test('예약 연결 결제 → visited, 중복 결제 방지, 통계 반영', async () => {
  const cust = (await call('GET', '/api/customers?q=홍')).body[0];
  const cut = services.find((s) => s.name === '커트');
  const r = await call('POST', '/api/reservations', { customerId: cust.id, staffId: ownerId, startAt: '2030-01-12T09:00', serviceIds: [cut.id] });
  const body = { customerId: cust.id, staffId: ownerId, reservationId: r.body.id, items: [{ serviceId: cut.id }], lines: [{ method: 'cash', amount: 20000 }], paidAt: '2030-01-12T10:00' };
  assert.equal((await call('POST', '/api/payments', body)).status, 200);
  assert.equal((await call('POST', '/api/payments', body)).status, 409);
  const resv = (await call('GET', '/api/reservations?from=2030-01-12&to=2030-01-12')).body[0];
  assert.equal(resv.status, 'visited');
  const st = (await call('GET', '/api/stats/summary?from=2030-01-01&to=2030-01-31')).body;
  assert.equal(st.sales, 20000); // 환불된 건 제외
  assert.equal(st.customers.new, 1);
  assert.equal(st.byMethod[0].method, 'cash');
});

test('매장 간 데이터 격리', async () => {
  const other = await call('POST', '/api/auth/register', { shopName: '네일샵', ownerName: '박', loginId: 'owner2', password: 'password123' }, null);
  const t2 = other.body.token;
  assert.equal((await call('GET', '/api/customers', null, t2)).body.length, 0);
  const cust = (await call('GET', '/api/customers?q=홍')).body[0];
  assert.equal((await call('GET', `/api/customers/${cust.id}`, null, t2)).status, 404);
});

test('문자: 광고는 수신동의 필요, 잔액 차감, 자동화 중복 방지', async () => {
  mockProvider.sent.length = 0;
  const a = (await call('POST', '/api/customers', { name: '비동의', phone: '01099998888', marketingConsent: false })).body.id;
  const b = (await call('GET', '/api/customers?q=홍')).body[0].id;
  const before = (await call('GET', '/api/me')).body.shop.sms_balance;
  const r = await call('POST', '/api/messages/send', { customerIds: [a, b], body: '{{name}}님 이벤트', isAd: true });
  // 야간 시간대에 테스트가 돌면 둘 다 skipped 이므로 시간대에 따라 기대값 분기
  const hour = new Date().getHours();
  if (hour >= 8 && hour < 21) {
    assert.deepEqual(r.body, { sent: 1, failed: 0, skipped: 1 });
    assert.ok(mockProvider.sent[0].body.startsWith('(광고)'));
    assert.ok((await call('GET', '/api/me')).body.shop.sms_balance < before);
  } else assert.equal(r.body.sent, 0);

  // 자동화: 생일 규칙 (낮 시간 주입)
  const tpl = (await call('GET', '/api/templates')).body.find((t) => t.name === '생일 축하');
  await call('POST', '/api/automation', { name: '생일', trigger: 'birthday', templateId: tpl.id });
  const ctx = { db, sms: mockProvider };
  const first = await runAutomation(ctx, shopId, '2030-05-01T10:00');
  assert.equal(first.sent, 1); // 홍길동(동의) 생일
  const second = await runAutomation(ctx, shopId, '2030-05-01T10:30');
  assert.equal(second.sent, 0); // 중복 방지
  const night = await runAutomation(ctx, shopId, '2031-05-01T22:00');
  assert.equal(night.sent, 0); // 야간 제한
});

test('네이버 예약 웹훅: 인증, 멱등, 취소 반영', async () => {
  const hook = (body, secret = 'whsec') => call('POST', `/api/webhooks/naver/${shopId}`, body, null, { 'x-webhook-secret': secret });
  const payload = { externalId: 'N-1', name: '네이버손님', phone: '010-5555-6666', startAt: '2030-02-01T15:00', durationMin: 60 };
  assert.equal((await hook(payload, 'bad')).status, 401);
  const r1 = await hook(payload);
  assert.equal(r1.status, 200);
  const r2 = await hook(payload);
  assert.equal(r2.body.duplicate, true);
  const conflict = await hook({ ...payload, externalId: 'N-2', name: '충돌', phone: '010-7777-8888', startAt: '2030-02-01T15:30' });
  assert.equal(conflict.body.conflict, true);
  await hook({ ...payload, status: 'cancelled' });
  const list = (await call('GET', '/api/reservations?from=2030-02-01&to=2030-02-01')).body;
  assert.equal(list.find((x) => x.external_id === 'N-1').status, 'cancelled');
});
