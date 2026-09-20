// POST /api/public/:code/chat 라우트 자체(세션·요율제한·검증)를 실제 Anthropic 호출 없이 검증한다.
// runAiTurn을 buildApp({ runAiTurn })으로 주입해 src/ai/bookingAgent.js는 완전히 건너뛴다.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';

process.env.SMS_LOG = '0';

const call = async (app, method, url, body, token) => {
  const res = await app.inject({ method, url, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const ct = res.headers['content-type'] ?? '';
  return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body };
};

let db, code;
before(async () => {
  db = openDb(':memory:');
  const boot = buildApp({ db });
  await call(boot, 'POST', '/api/auth/register', { shopName: '챗봇샵', ownerName: '사장', loginId: 'chatr', password: 'password123' });
  code = db.prepare('SELECT public_code FROM shop').get().public_code;
});

test('runAiTurn 을 주입하지 않으면(기본값) ANTHROPIC_API_KEY 없이 503이 내려온다', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const app = buildApp({ db });
  const r = await call(app, 'POST', `/api/public/${code}/chat`, { message: '안녕' });
  assert.equal(r.status, 503);
});

test('세션이 없으면 새로 발급되고, 같은 sessionId로 다시 보내면 같은 세션 상태가 이어진다', async () => {
  const calls = [];
  const app = buildApp({ db, runAiTurn: async (ctx, shop, session, message) => { calls.push({ message, historyLen: session.history?.length ?? 0 }); return `echo:${message}`; } });
  const r1 = await call(app, 'POST', `/api/public/${code}/chat`, { message: '안녕하세요' });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.reply, 'echo:안녕하세요');
  assert.ok(r1.body.sessionId);
  assert.equal(r1.body.authenticated, false);

  const r2 = await call(app, 'POST', `/api/public/${code}/chat`, { message: '두번째', sessionId: r1.body.sessionId });
  assert.equal(r2.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].message, '두번째');

  // 존재하지 않는 sessionId 를 보내면 에러 없이 새 세션을 만든다
  const r3 = await call(app, 'POST', `/api/public/${code}/chat`, { message: '아무거나', sessionId: 'no-such-session' });
  assert.equal(r3.status, 200);
  assert.notEqual(r3.body.sessionId, 'no-such-session');
});

test('세션은 매장 코드가 다르면 재사용되지 않는다(다른 매장 대화가 섞이지 않음)', async () => {
  const app = buildApp({ db, runAiTurn: async (ctx, shop, session) => `shop:${shop.id}` });
  await call(app, 'POST', '/api/auth/register', { shopName: '다른챗봇샵', ownerName: '사장2', loginId: 'chatr2', password: 'password123' });
  const code2 = db.prepare("SELECT public_code FROM shop WHERE name = '다른챗봇샵'").get().public_code;
  const r1 = await call(app, 'POST', `/api/public/${code}/chat`, { message: 'hi' });
  const r2 = await call(app, 'POST', `/api/public/${code2}/chat`, { message: 'hi', sessionId: r1.body.sessionId });
  assert.notEqual(r2.body.sessionId, r1.body.sessionId);
  assert.equal(r2.body.reply, `shop:${db.prepare("SELECT id FROM shop WHERE public_code = ?").get(code2).id}`);
});

test('빈 메시지는 거부되고, 너무 긴 메시지는 잘려서 전달된다', async () => {
  let received;
  const app = buildApp({ db, runAiTurn: async (ctx, shop, session, message) => { received = message; return 'ok'; } });
  assert.equal((await call(app, 'POST', `/api/public/${code}/chat`, { message: '   ' })).status, 400);
  assert.equal((await call(app, 'POST', `/api/public/${code}/chat`, {})).status, 400);
  await call(app, 'POST', `/api/public/${code}/chat`, { message: 'a'.repeat(1000) });
  assert.ok(received.length <= 500);
});

test('세션당 분당 메시지 수를 넘기면 429', async () => {
  const app = buildApp({ db, runAiTurn: async () => 'ok' });
  let sessionId;
  for (let i = 0; i < 12; i++) {
    const r = await call(app, 'POST', `/api/public/${code}/chat`, { message: `m${i}`, sessionId });
    sessionId = r.body.sessionId;
    assert.equal(r.status, 200);
  }
  const blocked = await call(app, 'POST', `/api/public/${code}/chat`, { message: '한번더', sessionId });
  assert.equal(blocked.status, 429);
});

test('runAiTurn 이 인증 상태를 세션에 남기면 응답의 authenticated 플래그에 반영된다', async () => {
  const app = buildApp({ db, runAiTurn: async (ctx, shop, session) => { session.customerId = 42; return '인증완료'; } });
  const r = await call(app, 'POST', `/api/public/${code}/chat`, { message: '인증해줘' });
  assert.equal(r.body.authenticated, true);
});
