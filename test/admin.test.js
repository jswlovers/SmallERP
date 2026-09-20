import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { ensureAdmin } from '../src/bootstrap.js';

process.env.SMS_LOG = '0';

let app, db, shopToken, adminToken, shopId;
const call = async (method, url, body, tk) => {
  const res = await app.inject({ method, url, payload: body, headers: tk ? { authorization: `Bearer ${tk}` } : {} });
  const ct = res.headers['content-type'] ?? '';
  return { status: res.statusCode, body: ct.includes('json') ? JSON.parse(res.body) : res.body };
};

before(async () => {
  db = openDb(':memory:');
  app = buildApp({ db });
  ensureAdmin(db, 'admin', 'admin12345!');
  shopToken = (await call('POST', '/api/auth/register', { shopName: '관리대상', ownerName: '사장', loginId: 'boss', password: 'password123' })).body.token;
  shopId = (await call('GET', '/api/me', null, shopToken)).body.shop.id;
  adminToken = (await call('POST', '/api/admin/auth/login', { loginId: 'admin', password: 'admin12345!' })).body.token;
});

test('관리자 로그인: 잘못된 비밀번호 401, 토큰 없이/매장 토큰으로 접근 401', async () => {
  assert.equal((await call('POST', '/api/admin/auth/login', { loginId: 'admin', password: 'nope' })).status, 401);
  assert.equal((await call('GET', '/api/admin/shops')).status, 401);
  assert.equal((await call('GET', '/api/admin/shops', null, shopToken)).status, 401);
});

test('관리자 토큰으로 매장 API 접근 불가', async () => {
  assert.equal((await call('GET', '/api/customers', null, adminToken)).status, 401);
});

test('매장 목록/개요, 플랜 변경, 문자 충전·차감', async () => {
  const list = (await call('GET', '/api/admin/shops', null, adminToken)).body;
  assert.equal(list[0].name, '관리대상');
  assert.equal(list[0].owner_login, 'boss');
  assert.equal((await call('GET', '/api/admin/overview', null, adminToken)).body.shops.n, 1);
  assert.equal((await call('PATCH', `/api/admin/shops/${shopId}`, { plan: 'gold' }, adminToken)).status, 400);
  assert.equal((await call('PATCH', `/api/admin/shops/${shopId}`, { plan: 'premium' }, adminToken)).status, 200);
  assert.equal((await call('POST', `/api/admin/shops/${shopId}/charge`, { amount: 500 }, adminToken)).body.balance, 1500);
  assert.equal((await call('POST', `/api/admin/shops/${shopId}/charge`, { amount: -99999 }, adminToken)).status, 400);
});

test('매장 정지 시 로그인·기존 토큰 모두 차단, 해제 시 복구', async () => {
  await call('PATCH', `/api/admin/shops/${shopId}`, { active: false }, adminToken);
  assert.equal((await call('POST', '/api/auth/login', { loginId: 'boss', password: 'password123' })).status, 403);
  assert.equal((await call('GET', '/api/customers', null, shopToken)).status, 403);
  await call('PATCH', `/api/admin/shops/${shopId}`, { active: true }, adminToken);
  assert.equal((await call('GET', '/api/customers', null, shopToken)).status, 200);
});

test('사장 비밀번호 초기화 → 임시 비밀번호로 로그인, 감사 로그 기록', async () => {
  const r = await call('POST', `/api/admin/shops/${shopId}/reset-owner-password`, null, adminToken);
  assert.equal(r.status, 200);
  assert.equal((await call('POST', '/api/auth/login', { loginId: 'boss', password: 'password123' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { loginId: 'boss', password: r.body.tempPassword })).status, 200);
  const audit = (await call('GET', `/api/admin/audit?shopId=${shopId}`, null, adminToken)).body;
  assert.ok(audit.some((a) => a.action === 'admin.owner.password_reset'));
  assert.ok(!JSON.stringify(audit).includes(r.body.tempPassword)); // 임시 비밀번호는 로그에 남기지 않는다
});

test('로그인 5회 실패 후 429 잠금', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/auth/login', { loginId: 'lockme', password: 'wrongpass1' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { loginId: 'lockme', password: 'wrongpass1' })).status, 429);
});

test('퇴사 처리된 직원의 기존 토큰은 즉시 무효', async () => {
  const staff = (await call('POST', '/api/staff', { name: '알바', loginId: 'alba', password: 'password123' }, shopToken)).body;
  const tk = (await call('POST', '/api/auth/login', { loginId: 'alba', password: 'password123' })).body.token;
  assert.equal((await call('GET', '/api/customers', null, tk)).status, 200);
  await call('PATCH', `/api/staff/${staff.id}`, { active: false }, shopToken);
  assert.equal((await call('GET', '/api/customers', null, tk)).status, 401);
});

test('고객 CSV 가져오기/내보내기: 중복·오류 보고, 수식 주입 방지, 직원 차단', async () => {
  const csv = '﻿이름,연락처,생일,수신동의,메모\r\n홍길동,010-1234-5678,1990-05-01,Y,"메모, 쉼표"\r\n김중복,01012345678,,N,\r\n,010-0000-0000,,,\r\n오류폰,12,,,\r\n=SUM(A1),010-9999-8888,,,=cmd\r\n';
  const r = await call('POST', '/api/customers/import', { csv }, shopToken);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.created, r.body.skipped, r.body.errors.length], [2, 1, 2]);
  const exp = await call('GET', '/api/customers/export.csv', null, shopToken);
  assert.equal(exp.status, 200);
  assert.match(exp.body, /"메모, 쉼표"/);
  assert.match(exp.body, /"'=SUM\(A1\)"/); // 수식 셀은 ' 로 무력화
  assert.ok(!exp.body.includes('"=SUM'));
  const staffTk = (await call('POST', '/api/staff', { name: '직원2', loginId: 'emp2', password: 'password123' }, shopToken)) && (await call('POST', '/api/auth/login', { loginId: 'emp2', password: 'password123' })).body.token;
  assert.equal((await call('GET', '/api/customers/export.csv', null, staffTk)).status, 403);
});
