// UI 스모크: 모든 탭·서브탭을 실제 브라우저로 열어 콘솔 오류/에러 토스트가 없는지 확인 (수동 실행: node test/ui-smoke.mjs)
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

process.env.SMS_LOG = '0';
const { buildApp } = await import('../src/app.js');
const { openDb } = await import('../src/db.js');
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const app = buildApp({ db: openDb(':memory:') });
await app.listen({ port: 3223, host: '127.0.0.1' });
const base = 'http://127.0.0.1:3223';

// 화면이 의미 있게 그려지도록 샘플 데이터를 API 로 채운다.
const call = async (method, url, body, token) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const { token } = await call('POST', '/api/auth/register', { shopName: '스모크살롱', ownerName: '원장', loginId: 'smoke', password: 'password123' });
const me = await call('GET', '/api/me', null, token);
const svcs = await call('GET', '/api/services', null, token);
const c1 = (await call('POST', '/api/customers', { name: '김고객', phone: '010-1111-2222', marketingConsent: true, birth: '1990-05-01' }, token)).id;
await call('POST', '/api/customers', { name: '김고객', phone: '010-1111-3333' }, token); // 동명(중복 후보)
const pp = (await call('POST', '/api/pass-products', { name: '컷 5회', price: 100000, totalCount: 5, validDays: 90 }, token)).id;
await call('POST', `/api/customers/${c1}/passes`, { productId: pp, lines: [{ method: 'card', amount: 100000 }] }, token);
await call('POST', '/api/goods', { name: '샴푸', price: 15000, stock: 1, minStock: 2 }, token);
await call('POST', '/api/grades', { name: 'vip', rank: 1, minVisits: 3 }, token);
const today = new Date().toISOString().slice(0, 10);
await call('POST', '/api/reservations', { customerId: c1, staffId: me.staff.id, startAt: `${today}T10:00`, serviceIds: [svcs[0].id] }, token);
await call('POST', '/api/payments', { customerId: c1, staffId: me.staff.id, items: [{ serviceId: svcs[0].id }], lines: [{ method: 'cash', amount: svcs[0].price }] }, token);
await call('POST', '/api/standby', { name: '워크인' }, token);
await call('POST', '/api/cash', { kind: 'out', amount: 3000, memo: '소모품' }, token);

const browser = await puppeteer.launch({ executablePath: exe, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
page.on('dialog', (d) => d.dismiss());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(base + '/');
await page.evaluate((t) => localStorage.setItem('token', t), token);
await page.goto(base + '/');
await page.waitForSelector('#app:not(.hidden)');

const tabs = await page.$$eval('#tabs button', (bs) => bs.map((b) => b.textContent));
let visited = 0;
for (const name of tabs) {
  await page.evaluate((n) => [...document.querySelectorAll('#tabs button')].find((b) => b.textContent === n).click(), name);
  await sleep(500);
  const subs = await page.$$eval('#view .subtabs button', (bs) => bs.map((b) => b.textContent)).catch(() => []);
  for (const sub of subs.length ? subs : [null]) {
    if (sub) await page.evaluate((s) => [...document.querySelectorAll('#view .subtabs button')].find((b) => b.textContent === s)?.click(), sub);
    await sleep(500);
    visited++;
    const toast = await page.$eval('#toast', (e) => (e.classList.contains('show') ? e.textContent : '')).catch(() => '');
    const body = await page.$eval('#view', (e) => e.innerText.trim().length);
    if (toast) problems.push(`toast @ ${name}/${sub}: ${toast}`);
    if (!body) problems.push(`빈 화면 @ ${name}/${sub}`);
  }
}
// 키오스크 화면도 로드 확인
await page.goto(base + '/kiosk.html'); await sleep(600);
const kiosk = await page.$eval('#k', (e) => e.innerText);
if (!/회원 검색/.test(kiosk)) problems.push(`키오스크 화면 이상: ${kiosk.slice(0, 60)}`);

await browser.close(); await app.close();
console.log(`탭/서브탭 ${visited}개 화면 확인`);
if (problems.length) { console.error('문제:', problems); process.exitCode = 1; } else console.log('UI SMOKE OK');
