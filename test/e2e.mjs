// 브라우저 E2E (수동 실행: node test/e2e.mjs). 시스템에 설치된 Chrome/Edge 사용.
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';

process.env.SMS_LOG = '0';
process.env.DB_FILE = ':memory:';
const { buildApp } = await import('../src/app.js');
const { openDb } = await import('../src/db.js');

const exe = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
const app = buildApp({ db: openDb(':memory:') });
await app.listen({ port: 3222, host: '127.0.0.1' });

const browser = await puppeteer.launch({ executablePath: exe, headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
// 충돌 테스트의 409 는 의도된 응답
page.on('console', (m) => m.type() === 'error' && !/status of 409/.test(m.text()) && errors.push(`console: ${m.text()}`));
page.on('dialog', (d) => d.accept());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setVal = (sel, v) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
const tab = async (name) => { await page.evaluate((n) => [...document.querySelectorAll('#tabs button')].find((b) => b.textContent === n).click(), name); await sleep(400); };
const click = async (sel) => { await page.waitForSelector(sel); await page.$eval(sel, (el) => el.click()); };
const bodyText =() => page.$eval('body', (b) => b.innerText);
const today = new Date(); const p2 = (n) => String(n).padStart(2, '0');
const ymd = `${today.getFullYear()}-${p2(today.getMonth() + 1)}-${p2(today.getDate())}`;

try {
  await page.goto('http://127.0.0.1:3222/');
  await page.waitForSelector('#loginForm');
  await click('#toggleReg');
  await page.type('[name=shopName]', '테스트살롱');
  await page.type('[name=ownerName]', '원장');
  await page.type('[name=loginId]', 'e2e');
  await page.type('[name=password]', 'password123');
  await click('#loginBtn');
  await page.waitForSelector('#app:not(.hidden)');
  assert.match(await bodyText(), /테스트살롱/);

  await tab('고객');
  await click('#ca'); await page.waitForSelector('#f');
  await page.type('#f [name=name]', '김고객');
  await page.type('#f [name=phone]', '010-1111-2222');
  await click('#f [name=marketingConsent]');
  await click('#f button.primary'); await sleep(500);
  assert.match(await bodyText(), /김고객/);

  await tab('예약');
  await click('#addResv'); await page.waitForSelector('#f [name=svc]');
  await click('#f [name=svc]'); // 첫 시술(정렬상 첫 항목)
  await setVal('#f [name=startAt]', `${ymd}T10:00`);
  await click('#f button.primary'); await sleep(600);
  let t = await bodyText();
  assert.match(t, /김고객/); assert.match(t, /10:00/);

  // 같은 시간 재예약 → 충돌 토스트
  await click('#addResv'); await page.waitForSelector('#f [name=svc]');
  await click('#f [name=svc]'); await setVal('#f [name=startAt]', `${ymd}T10:10`);
  await click('#f button.primary'); await sleep(500);
  assert.match(await page.$eval('#toast', (e) => e.textContent), /다른 예약/);
  await page.evaluate(() => document.getElementById('modal').close());

  // 결제
  await click('[data-pay]'); await page.waitForSelector('#f [data-m=cash]');
  const total = await page.$eval('#sum', (e) => e.textContent);
  const amount = Number(total.match(/합계 ([\d,]+)/)[1].replace(/,/g, ''));
  assert.ok(amount > 0, `예약 시술이 결제창에 선택되어야 함: ${total}`);
  await setVal('#f [data-m=cash]', String(amount));
  await click('#f button.primary'); await sleep(600);
  assert.match(await page.$eval('#toast', (e) => e.textContent), /결제가 완료/);

  await tab('통계');
  assert.match(await bodyText(), new RegExp(`${amount.toLocaleString('ko-KR')}원`));
  await tab('결제'); assert.match(await bodyText(), /김고객/);
  await tab('문자'); assert.match(await bodyText(), /생일 축하/);
  await tab('상품'); assert.match(await bodyText(), /커트/);
  await tab('설정'); assert.match(await bodyText(), /솔루션 간편설정|고객번호/);
  await tab('입출금'); assert.match(await bodyText(), /입출금 등록/);
  await tab('매장'); assert.match(await bodyText(), /출퇴근/);
  await tab('대기'); assert.match(await bodyText(), /대기 접수/);
  await tab('대시보드'); assert.match(await bodyText(), /오늘 매출/);
  await page.screenshot({ path: process.env.SHOT || 'data/e2e.png' });
  assert.deepEqual(errors, []);
  console.log('E2E OK');
} catch (e) {
  console.error('E2E FAIL:', e.message, errors);
  await page.screenshot({ path: 'data/e2e-fail.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  await app.close();
}
