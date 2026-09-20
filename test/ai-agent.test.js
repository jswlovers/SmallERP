// src/ai/bookingAgent.js 의 도구 호출 루프를 실제 Anthropic 네트워크 호출 없이 검증한다.
// callAnthropic 자리에 시나리오대로 응답하는 스텁을 주입해, 우리 쪽 오케스트레이션 코드(도구 실행,
// 인증 게이트, 세션 상태, 무한루프 방지, 다중 도구 호출)만 테스트한다 — 모델의 실제 판단력은 대상이 아니다.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { mockProvider } from '../src/sms/provider.js';
import { addDays, todayLocal } from '../src/util.js';

process.env.SMS_LOG = '0';

let db, app, tk, shop, cutId, ownerId;
const call = async (method, url, body, token = tk) => {
  const res = await app.inject({ method, url, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const ct = res.headers['content-type'] ?? '';
  return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body };
};

before(async () => {
  db = openDb(':memory:');
  app = buildApp({ db });
  tk = (await call('POST', '/api/auth/register', { shopName: 'AI테스트샵', ownerName: '사장', loginId: 'aiag', password: 'password123' }, null)).body.token;
  const me = (await call('GET', '/api/me')).body;
  shop = db.prepare('SELECT * FROM shop WHERE id = ?').get(me.shop.id);
  ownerId = me.staff.id;
  cutId = (await call('GET', '/api/services')).body.find((s) => s.name === '커트').id;
});

const ctx = () => ({ db, sms: mockProvider });
const newSession = () => ({ history: [], customerId: null, customerName: null });
const toolUse = (id, name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
const finalText = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
/** 직전 라운드의 tool_result(들)을 꺼낸다. round 0은 사용자 원문 텍스트라 호출부에서 쓰지 않는다. */
const lastToolResults = (messages) => messages[messages.length - 1].content.map((r) => JSON.parse(r.content));

test('설정 안 됨: ANTHROPIC_API_KEY 없이는 네트워크 호출 전에 503으로 막는다', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const { runTurn } = await import('../src/ai/bookingAgent.js');
  await assert.rejects(() => runTurn(ctx(), shop, newSession(), '안녕하세요'), (e) => e.status === 503);
  process.env.ANTHROPIC_API_KEY = 'test-dummy-key'; // 이후 테스트는 스텁을 직접 주입하므로 실제 키 값은 쓰이지 않는다
});

test('전체 흐름: 정보조회→시간조회→인증→예약생성까지 실제 DB에 반영된다', async () => {
  const { runTurn } = await import('../src/ai/bookingAgent.js');
  const session = newSession();
  const date = addDays(todayLocal(), 3);
  let slot, devCode;

  const script = [
    () => toolUse('t1', 'getShopInfo', {}),
    () => toolUse('t2', 'getAvailability', { date, serviceIds: [cutId] }),
    (msgs) => { [slot] = lastToolResults(msgs)[0].slots; return toolUse('t3', 'requestOtp', { phone: '010-7100-0001' }); },
    (msgs) => { devCode = lastToolResults(msgs)[0].devCode; return toolUse('t4', 'verifyOtp', { phone: '010-7100-0001', code: devCode, name: 'AI고객' }); },
    () => toolUse('t5', 'createReservation', { startAt: `${date}T${slot}`, serviceIds: [cutId], staffId: ownerId }),
    () => finalText('예약이 접수되었습니다!'),
  ];
  let i = 0;
  const reply = await runTurn(ctx(), shop, session, '이번 주 커트 예약하고 싶어요', async (payload) => script[i++](payload.messages));

  assert.equal(reply, '예약이 접수되었습니다!');
  assert.ok(Number.isInteger(session.customerId));
  assert.equal(session.customerName, 'AI고객');
  const resv = db.prepare('SELECT * FROM reservation WHERE customer_id = ?').get(session.customerId);
  assert.equal(resv.source, 'public');
  assert.equal(resv.status, 'pending'); // 기본 정책: 확인필요
  assert.equal(resv.start_at, `${date}T${slot}`);
});

test('인증 전 예약 시도는 도구 결과에 오류로 담겨 돌아오고, 대화가 끊기지 않는다', async () => {
  const { runTurn } = await import('../src/ai/bookingAgent.js');
  const session = newSession();
  const script = [
    () => toolUse('t1', 'createReservation', { startAt: `${addDays(todayLocal(), 2)}T10:00`, serviceIds: [cutId] }),
    (msgs) => { assert.equal(msgs[msgs.length - 1].content[0].is_error, true); assert.match(msgs[msgs.length - 1].content[0].content, /인증/); return finalText('먼저 휴대폰 인증이 필요해요.'); },
  ];
  let i = 0;
  const reply = await runTurn(ctx(), shop, session, '지금 바로 예약해줘', async (p) => script[i++](p.messages));
  assert.equal(reply, '먼저 휴대폰 인증이 필요해요.');
  assert.equal(session.customerId, null);
});

test('인증 전/후로 노출되는 도구 목록이 달라진다(인증 도구는 로그인 후 숨김)', async () => {
  const { runTurn } = await import('../src/ai/bookingAgent.js');
  const session = newSession();
  const seenTools = [];
  const script = [
    (p) => { seenTools.push(p.tools.map((t) => t.name)); return toolUse('t1', 'requestOtp', { phone: '010-7200-0001' }); },
    (p) => { seenTools.push(p.tools.map((t) => t.name)); const code = lastToolResults(p.messages)[0].devCode; return toolUse('t2', 'verifyOtp', { phone: '010-7200-0001', code }); },
    (p) => { seenTools.push(p.tools.map((t) => t.name)); return finalText('인증되었습니다.'); },
  ];
  let i = 0;
  await runTurn(ctx(), shop, session, '인증할게요', async (p) => script[i++](p));
  assert.ok(seenTools[0].includes('requestOtp') && seenTools[0].includes('verifyOtp'));
  assert.ok(!seenTools[2].includes('requestOtp') && !seenTools[2].includes('verifyOtp')); // 인증 완료 후에는 제외
});

test('한 응답에 도구를 여러 개 요청해도 각각 결과가 올바른 tool_use_id로 매핑된다', async () => {
  const { runTurn } = await import('../src/ai/bookingAgent.js');
  const session = newSession();
  const script = [
    () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'getShopInfo', input: {} }, { type: 'tool_use', id: 'b', name: 'getShopInfo', input: {} }] }),
    (msgs) => {
      const results = msgs[msgs.length - 1].content;
      assert.equal(results.length, 2);
      assert.deepEqual(results.map((r) => r.tool_use_id), ['a', 'b']);
      return finalText('확인했습니다.');
    },
  ];
  let i = 0;
  const reply = await runTurn(ctx(), shop, session, '매장 정보 알려줘', async (p) => script[i++](p.messages));
  assert.equal(reply, '확인했습니다.');
});

test('도구 호출이 끝없이 이어지면 안전장치가 대화를 종료시킨다', async () => {
  const { runTurn } = await import('../src/ai/bookingAgent.js');
  const session = newSession();
  let calls = 0;
  const reply = await runTurn(ctx(), shop, session, '계속 물어봐줘', async () => { calls++; return toolUse(`x${calls}`, 'getShopInfo', {}); });
  assert.equal(calls, 6); // MAX_TOOL_ROUNDS
  assert.match(reply, /시간이 걸리고|다시 시도/);
});

test('시스템 프롬프트에 오늘 날짜가 명시된다(연도 추측으로 "이미 지난 시간" 오류가 나던 실사용 버그 회귀 방지)', async () => {
  const { runTurn } = await import('../src/ai/bookingAgent.js');
  const session = newSession();
  let seenSystem;
  await runTurn(ctx(), shop, session, '오늘이 며칠이야?', async (p) => { seenSystem = p.system; return finalText('확인했습니다.'); });
  assert.match(seenSystem, new RegExp(todayLocal().replace(/-/g, '-')));
  assert.match(seenSystem, /연도.*계산|임의의 연도를 추측하지/);
});
