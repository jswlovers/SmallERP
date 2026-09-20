// GET /book.html 이 자바스크립트를 실행하지 않는 읽기 전용 웹 브라우징(ChatGPT/Claude 기본 브라우징,
// 검색엔진 등)에도 매장 정보를 답할 수 있도록 서버에서 미리 HTML로 그려주는지 검증한다.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';

let db, app, tk, code;
const call = async (method, url, body, token) => {
  const res = await app.inject({ method, url, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const ct = res.headers['content-type'] ?? '';
  return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body };
};

before(async () => {
  db = openDb(':memory:');
  app = buildApp({ db });
  tk = (await call('POST', '/api/auth/register', { shopName: 'SSR테스트샵', ownerName: '사장', loginId: 'ssrshop', password: 'password123' })).body.token;
  await call('POST', '/api/categories', { name: '헤어' }, tk);
  code = (await call('GET', '/api/me', null, tk)).body.shop.public_code;
});

test('코드 없이 접속하면 자바스크립트 없이도 안내 문구가 보이고 상태코드는 400', async () => {
  const r = await app.inject({ method: 'GET', url: '/book.html' });
  assert.equal(r.statusCode, 400);
  assert.match(r.body, /예약 링크가 올바르지 않습니다/);
  assert.match(r.body, /<div id="root">/); // 실제 앱 껍데기도 여전히 포함(정상 브라우저는 JS로 이어받음)
});

test('존재하지 않는 코드는 404', async () => {
  const r = await app.inject({ method: 'GET', url: '/book.html?s=no-such-code' });
  assert.equal(r.statusCode, 404);
});

test('정지된 매장은 403', async () => {
  const shopId = db.prepare('SELECT id FROM shop WHERE public_code = ?').get(code).id;
  db.prepare('UPDATE shop SET active = 0 WHERE id = ?').run(shopId);
  const r = await app.inject({ method: 'GET', url: `/book.html?s=${code}` });
  assert.equal(r.statusCode, 403);
  db.prepare('UPDATE shop SET active = 1 WHERE id = ?').run(shopId);
});

test('유효한 코드: 시술·가격·담당자·예약 정책이 순수 HTML에 그대로 들어있다(JS 실행 없이)', async () => {
  const svcId = (await call('POST', '/api/services', { name: '커트', price: 25000, durationMin: 40 }, tk)).body.id;
  await call('PATCH', `/api/services/${svcId}`, { categoryId: (await call('GET', '/api/categories', null, tk)).body[0].id }, tk);
  await call('POST', '/api/staff', { name: '김디자이너' }, tk);
  const r = await app.inject({ method: 'GET', url: `/book.html?s=${code}` });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /<title>SSR테스트샵 온라인 예약<\/title>/);
  assert.match(r.body, /커트/);
  assert.match(r.body, /25,000원/);
  assert.match(r.body, /40분/);
  assert.match(r.body, /김디자이너/);
  assert.match(r.body, /확인필요/); // 기본 정책: 자동확정 꺼짐
  assert.match(r.body, /최소 60분 전/);
  assert.match(r.body, /<section id="ssr">[\s\S]*<div id="root">/); // ssr 블록이 root보다 앞에 온다(진행형 향상)
  assert.match(r.body, /<script type="module" src="book.js">/); // 실제 앱도 여전히 로드된다
});

test('이름/가격에 특수문자가 있어도 HTML이 깨지지 않는다(이스케이프)', async () => {
  await call('POST', '/api/services', { name: '<b>염색</b> & "탈색"', price: 10000, durationMin: 30 }, tk);
  const r = await app.inject({ method: 'GET', url: `/book.html?s=${code}` });
  assert.equal(r.statusCode, 200);
  assert.ok(!r.body.includes('<b>염색</b>'));
  assert.match(r.body, /&lt;b&gt;염색&lt;\/b&gt; &amp; &quot;탈색&quot;/);
});

test('예약을 받지 않는 매장은 요약에도 반영된다', async () => {
  await call('PUT', '/api/settings/public_booking', { value: { enabled: false, autoConfirm: false, minLeadMinutes: 60, maxDays: 30 } }, tk);
  const r = await app.inject({ method: 'GET', url: `/book.html?s=${code}` });
  assert.match(r.body, /지금은 받지 않습니다/);
});
