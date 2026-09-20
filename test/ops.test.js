import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { mockProvider } from '../src/sms/provider.js';
import { addDays, todayLocal } from '../src/util.js';

process.env.SMS_LOG = '0';

let app, db, tk, owner, d2, svc, cust;
const call = async (method, url, body, token = tk) => {
  const res = await app.inject({ method, url, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const ct = res.headers['content-type'] ?? '';
  return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body };
};
const today = todayLocal();
// 2030-01-14 는 월요일(1), 2030-01-13 은 일요일(0)
const MON = '2030-01-14';

before(async () => {
  db = openDb(':memory:');
  app = buildApp({ db });
  tk = (await call('POST', '/api/auth/register', { shopName: '운영샵', ownerName: '사장', loginId: 'ops', password: 'password123' }, null)).body.token;
  owner = (await call('GET', '/api/me')).body.staff.id;
  d2 = (await call('POST', '/api/staff', { name: '디자이너', commissionRate: 30, basePay: 1000000, phone: '010-9999-0001' })).body.id;
  svc = Object.fromEntries((await call('GET', '/api/services')).body.map((s) => [s.name, s]));
  cust = (await call('POST', '/api/customers', { name: '운영고객', phone: '010-8000-0001', marketingConsent: true })).body.id;
});

const book = (startAt, staffId = owner, serviceName = '커트', customerId = cust) => call('POST', '/api/reservations', { customerId, staffId, startAt, serviceIds: [svc[serviceName].id] });

test('근무시간·요일 휴무·브레이크·휴무일·예약금지가 예약을 막는다', async () => {
  await call('PUT', `/api/staff/${owner}/schedule`, { days: [{ weekday: 1, start: '10:00', end: '19:00' }, { weekday: 0, off: true }] });
  assert.equal((await book(`${MON}T09:00`)).status, 409); // 근무 전
  assert.equal((await book(`${MON}T18:30`)).status, 409); // 종료 초과(40분)
  assert.equal((await book('2030-01-13T11:00')).status, 409); // 일요일 휴무
  await call('POST', '/api/breaks', { staffId: owner, startTime: '12:00', endTime: '13:00', label: '점심' });
  const lunch = await book(`${MON}T12:20`);
  assert.equal(lunch.status, 409);
  assert.match(lunch.body.error, /점심/);
  await call('POST', '/api/blocks', { staffId: owner, startAt: `${MON}T15:00`, endAt: `${MON}T16:00`, reason: '교육' });
  assert.match((await book(`${MON}T15:10`)).body.error, /교육/);
  await call('POST', '/api/days-off', { date: '2030-01-15', reason: '임시휴무' });
  assert.match((await book('2030-01-15T11:00')).body.error, /임시휴무/);
  assert.equal((await book(`${MON}T10:00`)).status, 200); // 정상
});

test('빈 시간 조회는 스케줄·브레이크·기존 예약을 반영', async () => {
  const r = (await call('GET', `/api/availability?date=${MON}&staffId=${owner}&minutes=60`)).body.staff[0].slots;
  assert.ok(r.includes('11:00'));
  assert.ok(!r.includes('10:00')); // 예약됨
  assert.ok(!r.includes('12:00')); // 점심
  assert.ok(!r.includes('15:00')); // 예약금지
  assert.ok(!r.includes('09:30')); // 근무 전
});

test('예약 상태 확장(대기중/시술중), 노쇼 3회 시 고객 주의 표시', async () => {
  const c = (await call('POST', '/api/customers', { name: '노쇼고객', phone: '010-8000-0002' })).body.id;
  const ids = [];
  for (const t of ['T16:30', 'T17:10', 'T17:50']) ids.push((await book(`${MON}${t}`, owner, '커트', c)).body.id);
  for (const id of ids) assert.equal((await call('PATCH', `/api/reservations/${id}`, { status: 'noshow' })).status, 200);
  assert.equal((await call('GET', '/api/customers?flag=noshow')).body[0].name, '노쇼고객');
  const w = (await book('2030-01-16T11:00', owner, '커트', c)).body.id;
  assert.equal((await call('PATCH', `/api/reservations/${w}`, { status: 'waiting' })).status, 200);
  assert.equal((await call('PATCH', `/api/reservations/${w}`, { status: 'in_service' })).status, 200);
  assert.equal((await call('PATCH', `/api/reservations/${w}`, { status: 'bogus' })).status, 400);
  assert.equal((await call('GET', '/api/reservations?from=2030-01-16&to=2030-01-16')).body[0].customer_noshow, 1);
});

test('담당 직원 알림·예약 취소 문자 이벤트', async () => {
  const tpl = (await call('POST', '/api/templates', { name: '직원알림', body: '{{customer}} {{date}} {{time}} 예약' })).body.id;
  const tpl2 = (await call('POST', '/api/templates', { name: '취소', body: '{{name}}님 예약 취소 {{date}}' })).body.id;
  await call('POST', '/api/automation', { name: 'sn', trigger: 'staff_notify', templateId: tpl });
  await call('POST', '/api/automation', { name: 'rc', trigger: 'reservation_cancelled', templateId: tpl2 });
  mockProvider.sent.length = 0;
  const r = await book('2030-01-16T14:00', d2); // 일정 없는 디자이너
  assert.equal(r.status, 200);
  assert.equal(mockProvider.sent.length, 1);
  assert.equal(mockProvider.sent[0].to, '01099990001');
  await call('PATCH', `/api/reservations/${r.body.id}`, { status: 'cancelled' });
  assert.equal(mockProvider.sent.length, 2);
});

test('대기 접수와 매장 현황판', async () => {
  const w1 = await call('POST', '/api/standby', { name: '워크인' });
  const w2 = await call('POST', '/api/standby', { customerId: cust });
  assert.deepEqual([w1.body.number, w2.body.number], [1, 2]);
  await call('PATCH', `/api/standby/${w2.body.id}`, { status: 'in_service' });
  const b = (await call('GET', `/api/board?date=${today}`)).body;
  assert.equal(b.counts.waiting, 1);
  assert.equal(b.counts.in_service, 1);
  assert.equal(b.days.length, 5);
  // 고객 등록 시 자동 대기 등록 옵션
  await call('PUT', '/api/settings/defaults', { value: { gender: 'F', standbyOnCreate: true, consentPrompt: true } });
  await call('POST', '/api/customers', { name: '자동대기', phone: '010-8000-0003' });
  assert.equal((await call('GET', '/api/standby')).body.length, 3);
});

test('입출금 관리와 일마감(현금 시재 차이)', async () => {
  const cat = (await call('POST', '/api/cash-categories', { kind: 'out', name: '소모품' })).body.id;
  await call('POST', '/api/cash', { kind: 'out', categoryId: cat, amount: 5000, date: today, memo: '샴푸' });
  await call('POST', '/api/cash', { kind: 'in', amount: 2000, date: today });
  const list = (await call('GET', `/api/cash?from=${today}&to=${today}`)).body;
  assert.deepEqual([list.totalIn, list.totalOut, list.net], [2000, 5000, -3000]);
  assert.equal((await call('POST', '/api/cash', { kind: 'x', amount: 1 })).status, 400);
  await call('POST', '/api/payments', { customerId: cust, staffId: owner, items: [{ serviceId: svc['커트'].id }], lines: [{ method: 'cash', amount: 20000 }, ] });
  const close = (await call('GET', `/api/close?date=${today}`)).body.summary;
  assert.equal(close.expectedCash, 20000 + 2000 - 5000);
  const saved = (await call('POST', '/api/close', { date: today, cashCounted: 16500, note: '500원 부족' })).body;
  assert.equal(saved.diff, -500); // 실사 16,500 - 예상 17,000
});

test('출퇴근 기록과 매장 일정', async () => {
  const c1 = await call('POST', '/api/attendance/clock', {});
  assert.equal(c1.body.action, 'clock_in');
  assert.equal((await call('POST', '/api/attendance/clock', {})).body.action, 'clock_out');
  assert.equal((await call('POST', '/api/attendance/clock', {})).status, 409);
  const att = (await call('GET', `/api/attendance?from=${today}&to=${today}`)).body;
  assert.equal(att.length, 1);
  await call('POST', '/api/events', { date: today, title: '직원 회식' });
  const cal = (await call('GET', `/api/insight/calendar?month=${today.slice(0, 7)}`)).body;
  assert.ok(cal.find((d) => d.date === today).events.includes('직원 회식'));
});

test('분석: 고객 동향 구간, 휴면 목록, 예약 통계, 기간 비교, 성장률', async () => {
  // 과거 방문 고객 3명: 20일 전, 100일 전, 200일 전
  const mk = async (name, phone, ago) => {
    const id = (await call('POST', '/api/customers', { name, phone })).body.id;
    const d = addDays(today, -ago);
    await call('POST', '/api/payments', { customerId: id, staffId: owner, items: [{ serviceId: svc['커트'].id }], lines: [{ method: 'cash', amount: 20000 }], paidAt: `${d}T11:00` });
    return id;
  };
  await mk('최근', '010-8100-0001', 20);
  const mid = await mk('중간', '010-8100-0002', 100);
  await mk('오래', '010-8100-0003', 200);
  const t = (await call('GET', '/api/insight/customer-trend')).body;
  assert.equal(t.d91_120, 1);
  assert.equal(t.over180, 1);
  assert.ok(t.d30 >= 2); // 오늘 결제한 운영고객 + 20일 전 고객
  const dormant = (await call('GET', '/api/insight/dormant?days=90')).body;
  assert.deepEqual(dormant.map((d) => d.name), ['오래', '중간']); // 오래된 순
  assert.equal(dormant.find((d) => d.id === mid).daysSince, 100);
  const rs = (await call('GET', '/api/insight/reservations?from=2030-01-01&to=2030-01-31')).body;
  assert.ok(rs.noshowRate > 0);
  assert.equal(rs.byWeekday.length, 7);
  const cmp = (await call('GET', `/api/insight/compare?from=${addDays(today, -29)}&to=${today}`)).body;
  assert.ok(cmp.current.sales > 0);
  assert.equal(cmp.previous.from, addDays(today, -59));
  assert.equal((await call('GET', `/api/insight/growth?year=${today.slice(0, 4)}`)).body.length, 12);
});

test('목표 달성률·급여·대체결제 현황·문자 방문율', async () => {
  const month = today.slice(0, 7);
  await call('PUT', '/api/goals', { staffId: owner, month, amount: 100000 });
  const g = (await call('GET', `/api/goals?month=${month}`)).body.find((x) => x.staffId === owner);
  assert.equal(g.goal, 100000);
  assert.ok(g.rate > 0);
  await call('POST', '/api/payments', { customerId: cust, staffId: d2, items: [{ name: '특별', price: 100000 }], lines: [{ method: 'card', amount: 100000 }] });
  const pay = (await call('GET', `/api/insight/payroll?month=${month}`)).body.find((p) => p.staffId === d2);
  assert.equal(pay.commission, 30000);
  assert.equal(pay.total, 1030000);
  const rep = (await call('GET', `/api/insight/replacement?from=${today}&to=${today}`)).body;
  assert.equal(rep.prepaidTotal, 0);
  assert.equal((await call('GET', `/api/insight/sms-visits?from=${addDays(today, -30)}&to=${today}`)).status, 200);
  assert.equal((await call('GET', '/api/insight/dashboard')).status, 200);
});

test('직원은 사장 전용 API(급여·마감·설정)를 쓸 수 없다', async () => {
  await call('POST', '/api/staff', { name: '일반', loginId: 'staff1', password: 'password123' });
  const st = (await call('POST', '/api/auth/login', { loginId: 'staff1', password: 'password123' }, null)).body.token;
  for (const [m, u, b] of [['GET', `/api/insight/payroll?month=${today.slice(0, 7)}`], ['POST', '/api/close', {}], ['PUT', '/api/settings/point_rates', { value: {} }], ['POST', '/api/categories', { name: 'x' }], ['DELETE', '/api/cash/1']])
    assert.equal((await call(m, u, b, st)).status, 403, `${m} ${u}`);
});
