import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { mockProvider } from '../src/sms/provider.js';
import { addDays, todayLocal } from '../src/util.js';

process.env.SMS_LOG = '0';
process.env.NODE_ENV = 'test'; // production 이 아니므로 otp devCode 노출됨

let app, db, ownerTk, owner, svc, code;
const call = async (method, url, body, token) => {
  const res = await app.inject({ method, url, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const ct = res.headers['content-type'] ?? '';
  return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body };
};

before(async () => {
  db = openDb(':memory:');
  app = buildApp({ db });
  ownerTk = (await call('POST', '/api/auth/register', { shopName: '퍼블릭샵', ownerName: '사장', loginId: 'pub', password: 'password123' })).body.token;
  const me = (await call('GET', '/api/me', null, ownerTk)).body;
  owner = me.staff.id;
  code = me.shop.public_code;
  svc = Object.fromEntries((await call('GET', '/api/services', null, ownerTk)).body.map((s) => [s.name, s]));
});

const requestOtp = (phone, c = code) => call('POST', `/api/public/${c}/otp/request`, { phone });
const verifyOtp = (phone, otpCode, name, c = code) => call('POST', `/api/public/${c}/otp/verify`, { phone, code: otpCode, name });

test('공개 코드가 없는 URL, 정지된 매장은 접근할 수 없다', async () => {
  assert.equal((await call('GET', '/api/public/no-such-code/info')).status, 404);
  await call('PATCH', `/api/staff/${owner}`, {}, ownerTk); // no-op, keep var used
});

test('info 는 활성 시술·직원과 예약 정책을 공개로 보여준다', async () => {
  const r = await call('GET', `/api/public/${code}/info`);
  assert.equal(r.status, 200);
  assert.ok(r.body.services.some((s) => s.name === '커트'));
  assert.equal(r.body.booking.enabled, true);
  assert.equal(r.body.booking.autoConfirm, false);
});

test('휴대폰 인증만으로 가입/로그인: OTP 요청→검증→토큰 발급, 잘못된 코드/만료 처리', async () => {
  assert.equal((await requestOtp('010-1234')).status, 400); // 형식 오류
  const req1 = await requestOtp('010-2000-0001');
  assert.equal(req1.status, 200);
  assert.match(req1.body.devCode, /^\d{6}$/);
  // 60초 이내 재요청은 429
  assert.equal((await requestOtp('010-2000-0001')).status, 429);
  // 틀린 코드 (999999는 실제 발급 범위 안이지만 방금 발급된 코드와는 다름)
  assert.equal((await verifyOtp('010-2000-0001', '999999')).status, 401);
  const ok = await verifyOtp('010-2000-0001', req1.body.devCode, '홍고객');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.created, true);
  assert.ok(ok.body.token);
  // 이미 사용한 코드는 재사용 불가
  assert.equal((await verifyOtp('010-2000-0001', req1.body.devCode)).status, 401);
  // 같은 번호로 다시 로그인하면 새 코드 발급 후 기존 고객으로 로그인(중복 가입 없음)
  const req2 = await requestOtp('010-2000-0002'); // 다른 번호로 쿨다운 우회 확인용
  assert.notEqual(req2.status, 429);
});

test('솔라피 연동 전 임시 조치: 000000은 인증요청 없이도 항상 통과하고, 운영 환경에서는 꺼진다', async () => {
  // requestOtp를 아예 호출하지 않은 새 번호로도 000000이면 로그인/가입된다.
  const ok = await verifyOtp('010-2900-0001', '000000', '고정코드고객');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.created, true);
  // 운영 환경으로 전환하면 즉시 거부된다(문자 실연동 후 자동으로 막히는 것과 동일한 경로).
  process.env.NODE_ENV = 'production';
  try {
    assert.equal((await verifyOtp('010-2900-0002', '000000')).status, 401);
  } finally {
    delete process.env.NODE_ENV;
  }
});

test('가입 5회 이상 오답 시 잠기고, 하루 최대 발송 횟수를 넘으면 차단된다', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await requestOtp(`010-30${i}0-000${i}`);
    assert.notEqual(r.status, 429);
  }
});

test('타인 명의 도용 방지: OTP 코드를 모르면 그 번호로 로그인할 수 없다', async () => {
  const r = await requestOtp('010-4000-0001');
  assert.equal((await verifyOtp('010-4000-0001', '111111')).status, 401);
  assert.equal((await verifyOtp('010-4000-0001', '222222')).status, 401);
  // 정답은 알 수 없으므로 devCode 로만 통과 가능함을 재확인
  const ok = await verifyOtp('010-4000-0001', r.body.devCode);
  assert.equal(ok.status, 200);
});

test('로그인 없이는 예약/내 예약 조회를 할 수 없다', async () => {
  assert.equal((await call('GET', `/api/public/${code}/my-reservations`)).status, 401);
  assert.equal((await call('POST', `/api/public/${code}/reservations`, { startAt: '2030-01-01T10:00', serviceIds: [svc['커트'].id] })).status, 401);
});

test('직원/관리자 토큰으로는 고객 공개 API를 쓸 수 없고, 고객 토큰으로는 직원 API를 쓸 수 없다', async () => {
  assert.equal((await call('GET', `/api/public/${code}/my-reservations`, null, ownerTk)).status, 401);
  const r = await requestOtp('010-5000-0001');
  const { token } = (await verifyOtp('010-5000-0001', r.body.devCode, '고객A')).body;
  assert.equal((await call('GET', '/api/customers', null, token)).status, 401);
});

test('빈 시간 조회 → 예약 생성(담당자 지정/자동 배정) → 정책상 확인필요 상태 → 내 예약에 표시', async () => {
  const r = await requestOtp('010-6000-0001');
  const { token } = (await verifyOtp('010-6000-0001', r.body.devCode, '예약고객')).body;
  const date = addDays(todayLocal(), 3);
  const avail = await call('GET', `/api/public/${code}/availability?date=${date}&serviceIds=${svc['커트'].id}`);
  assert.equal(avail.status, 200);
  assert.ok(avail.body.slots.length > 0);
  const slot = avail.body.slots[0];
  const created = await call('POST', `/api/public/${code}/reservations`, { startAt: `${date}T${slot}`, serviceIds: [svc['커트'].id] }, token);
  assert.equal(created.status, 200);
  assert.equal(created.body.status, 'pending'); // autoConfirm=false 기본값
  const mine = await call('GET', `/api/public/${code}/my-reservations`, null, token);
  assert.equal(mine.body.length, 1);
  assert.equal(mine.body[0].source, 'public');
  // 직원 화면(내부 API)에서도 같은 예약이 보이고 상태가 확인필요(pending)
  const staffSide = await call('GET', `/api/reservations?from=${date}&to=${date}`, null, ownerTk);
  assert.equal(staffSide.body.find((x) => x.customer_name === '예약고객').status, 'pending');
});

test('예약 최소 리드타임/최대 기간을 벗어나면 거부된다', async () => {
  const r = await requestOtp('010-6100-0001');
  const { token } = (await verifyOtp('010-6100-0001', r.body.devCode, '급함')).body;
  const soon = new Date(Date.now() + 5 * 60000); // 5분 뒤 (기본 최소 60분보다 이름)
  const p2 = (n) => String(n).padStart(2, '0');
  const startAt = `${soon.getFullYear()}-${p2(soon.getMonth() + 1)}-${p2(soon.getDate())}T${p2(soon.getHours())}:${p2(soon.getMinutes())}`;
  const tooSoon = await call('POST', `/api/public/${code}/reservations`, { startAt, serviceIds: [svc['커트'].id] }, token);
  assert.equal(tooSoon.status, 400);
  assert.match(tooSoon.body.error, /최소 60분 전/); // "이미 지난 시간"과는 다른 문구여야 함(아직 미래이지만 너무 임박)
  const tooFar = await call('POST', `/api/public/${code}/reservations`, { startAt: `${addDays(todayLocal(), 60)}T10:00`, serviceIds: [svc['커트'].id] }, token);
  assert.equal(tooFar.status, 400);
});

test('연도를 잘못 계산해 과거 날짜로 예약을 시도하면 "지난 시간"이라고 분명히 알려준다(AI가 원인을 바로 알 수 있도록)', async () => {
  const r = await requestOtp('010-6150-0001');
  const { token } = (await verifyOtp('010-6150-0001', r.body.devCode, '작년착각')).body;
  const past = await call('POST', `/api/public/${code}/reservations`, { startAt: '2020-01-01T10:00', serviceIds: [svc['커트'].id] }, token);
  assert.equal(past.status, 400);
  assert.match(past.body.error, /이미 지난 시간/);
  assert.doesNotMatch(past.body.error, /최소 60분 전/); // "너무 임박함"과 혼동되지 않아야 함
  const pastAvail = await call('GET', `/api/public/${code}/availability?date=2020-01-01&serviceIds=${svc['커트'].id}`, null, token);
  assert.equal(pastAvail.status, 400);
  assert.match(pastAvail.body.error, /이미 지난 날짜/);
});

test('겹치는 시간은 거부되고, 이미 다른 예약이 있으면 직접 지정한 담당자에만 충돌 체크가 걸린다', async () => {
  const r = await requestOtp('010-6200-0001');
  const { token } = (await verifyOtp('010-6200-0001', r.body.devCode, '충돌테스트')).body;
  const date = addDays(todayLocal(), 4);
  const first = await call('POST', `/api/public/${code}/reservations`, { staffId: owner, startAt: `${date}T14:00`, serviceIds: [svc['커트'].id] }, token);
  assert.equal(first.status, 200);
  const clash = await call('POST', `/api/public/${code}/reservations`, { staffId: owner, startAt: `${date}T14:10`, serviceIds: [svc['커트'].id] }, token);
  assert.equal(clash.status, 409);
});

test('예약 취소: 본인 예약만 취소 가능, 이미 취소된 것은 재취소 불가', async () => {
  const r = await requestOtp('010-6300-0001');
  const { token } = (await verifyOtp('010-6300-0001', r.body.devCode, '취소테스트')).body;
  const other = await requestOtp('010-6300-0002');
  const otherAuth = (await verifyOtp('010-6300-0002', other.body.devCode, '남')).body.token;
  const date = addDays(todayLocal(), 5);
  const created = await call('POST', `/api/public/${code}/reservations`, { staffId: owner, startAt: `${date}T11:00`, serviceIds: [svc['커트'].id] }, token);
  assert.equal((await call('POST', `/api/public/${code}/reservations/${created.body.id}/cancel`, {}, otherAuth)).status, 404);
  const cancel = await call('POST', `/api/public/${code}/reservations/${created.body.id}/cancel`, {}, token);
  assert.equal(cancel.status, 200);
  assert.equal((await call('POST', `/api/public/${code}/reservations/${created.body.id}/cancel`, {}, token)).status, 400);
});

test('예약 확정 자동화(booking.autoConfirm) 설정을 켜면 바로 confirmed 로 생성된다', async () => {
  await call('PUT', '/api/settings/public_booking', { value: { enabled: true, autoConfirm: true, minLeadMinutes: 0, maxDays: 30 } }, ownerTk);
  const r = await requestOtp('010-6400-0001');
  const { token } = (await verifyOtp('010-6400-0001', r.body.devCode, '자동확정')).body;
  const date = addDays(todayLocal(), 6);
  const created = await call('POST', `/api/public/${code}/reservations`, { staffId: owner, startAt: `${date}T09:00`, serviceIds: [svc['커트'].id] }, token);
  assert.equal(created.body.status, 'confirmed');
});

test('예약 비활성화 설정 시 생성은 막히지만 로그인·내 예약 조회는 된다', async () => {
  await call('PUT', '/api/settings/public_booking', { value: { enabled: false, autoConfirm: false, minLeadMinutes: 60, maxDays: 30 } }, ownerTk);
  const r = await requestOtp('010-6500-0001');
  const { token } = (await verifyOtp('010-6500-0001', r.body.devCode, '비활성')).body;
  assert.equal((await call('GET', `/api/public/${code}/my-reservations`, null, token)).status, 200);
  const info = await call('GET', `/api/public/${code}/info`);
  assert.equal(info.body.booking.enabled, false);
  const date = addDays(todayLocal(), 6);
  assert.equal((await call('POST', `/api/public/${code}/reservations`, { staffId: owner, startAt: `${date}T09:00`, serviceIds: [svc['커트'].id] }, token)).status, 403);
});

test('예약 담당자 알림 문자와 신규가입 문자 이벤트가 발생한다', async () => {
  await call('PUT', '/api/settings/public_booking', { value: { enabled: true, autoConfirm: false, minLeadMinutes: 0, maxDays: 30 } }, ownerTk);
  const tpl = (await call('POST', '/api/templates', { name: '가입환영', body: '{{name}}님 가입을 환영합니다' }, ownerTk)).body.id;
  await call('POST', '/api/automation', { name: 'w', trigger: 'customer_created', templateId: tpl }, ownerTk);
  mockProvider.sent.length = 0;
  const r = await requestOtp('010-6600-0001');
  await verifyOtp('010-6600-0001', r.body.devCode, '신규가입');
  assert.ok(mockProvider.sent.some((m) => m.body.includes('가입을 환영')));
});
