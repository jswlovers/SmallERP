// 고객 온라인 예약 페이지(book.html) 브라우저 E2E: 가입(OTP)→예약→취소→로그인 유지 확인 (수동 실행: node test/booking-e2e.mjs)
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

process.env.SMS_LOG = '0';
const { buildApp } = await import('../src/app.js');
const { openDb } = await import('../src/db.js');
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

const app = buildApp({ db: openDb(':memory:') });
await app.listen({ port: 3224, host: '127.0.0.1' });
const base = 'http://127.0.0.1:3224';

const call = async (method, url, body, token) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const { token: ownerTk } = await call('POST', '/api/auth/register', { shopName: '예약테스트샵', ownerName: '원장', loginId: 'booke2e', password: 'password123' });
const me = await call('GET', '/api/me', null, ownerTk);
const code = me.shop.public_code;

const browser = await puppeteer.launch({ executablePath: exe, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 420, height: 900 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
// 잘못된 예약 코드 테스트가 의도적으로 유발하는 404는 기대된 응답이라 제외한다.
page.on('console', (m) => m.type() === 'error' && !/status of 404/.test(m.text()) && errors.push(`console: ${m.text()}`));
page.on('dialog', (d) => d.accept());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = () => page.$eval('#root', (e) => e.innerText);
const toastText = () => page.$eval('#toast', (e) => e.textContent);

try {
  await page.goto(`${base}/book.html?s=${code}`);
  await page.waitForSelector('#pf');
  console.log('로그인 화면 노출 확인');

  // 잘못된 링크는 안내 문구를 보여준다
  await page.goto(`${base}/book.html?s=nope`);
  await sleep(300);
  if (!/찾을 수 없습니다/.test(await text())) throw new Error('잘못된 코드 안내 실패: ' + (await text()));
  console.log('잘못된 예약 링크 처리 확인');

  await page.goto(`${base}/book.html?s=${code}`);
  await page.waitForSelector('#pf');
  await page.type('#pf [name=phone]', '01099998888');
  await page.$eval('#pf', (f) => f.requestSubmit());
  await page.waitForSelector('#vf');
  const devCode = await page.$eval('.devcode b', (e) => e.textContent).catch(() => null);
  if (!devCode) throw new Error('개발용 인증번호가 노출되지 않음');
  await page.type('#vf [name=code]', devCode);
  await page.type('#vf [name=name]', '홍고객');
  await page.$eval('#vf', (f) => f.requestSubmit());
  await sleep(500);
  if (!/가입되었습니다/.test(await toastText())) throw new Error('가입 토스트 실패: ' + (await toastText()));
  console.log('휴대폰 인증만으로 가입 확인');

  await page.waitForSelector('#findSlots');
  await page.$eval('input[data-svc]', (el) => el.click());
  const future = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  await page.$eval('#dateSel', (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, future);
  await page.$eval('#findSlots', (el) => el.click());
  await page.waitForSelector('.slot', { timeout: 5000 });
  await page.$eval('.slot', (el) => el.click());
  await page.waitForFunction(() => !document.getElementById('submitResv').disabled);
  await page.$eval('#submitResv', (el) => el.click());
  await sleep(500);
  if (!/예약을 접수했습니다/.test(await toastText())) throw new Error('예약 접수 토스트 실패: ' + (await toastText()));
  console.log('예약 생성(확인필요 상태) 확인');

  await sleep(300);
  const listed = await text();
  if (!/확인필요/.test(listed)) throw new Error('내 예약에 확인필요 상태가 보이지 않음: ' + listed);

  const staffSide = await call('GET', `/api/reservations?from=${future}&to=${future}`, null, ownerTk);
  if (!staffSide.some((r) => r.customer_name === '홍고객' && r.status === 'pending')) throw new Error('직원 화면에서 고객 예약이 보이지 않음');
  console.log('직원 화면에도 동일 예약 반영 확인');

  await page.$eval('[data-cancel]', (el) => el.click());
  await sleep(400);
  if (!/취소되었습니다/.test(await toastText())) throw new Error('취소 토스트 실패: ' + (await toastText()));
  console.log('고객 셀프 취소 확인');

  await page.reload();
  await page.waitForSelector('#logout');
  console.log('새로고침 후 로그인 유지 확인');

  if (errors.length) throw new Error('콘솔/페이지 오류: ' + JSON.stringify(errors));
  console.log('BOOKING E2E OK');
} catch (e) {
  console.error('BOOKING E2E FAIL:', e.message, errors);
  await page.screenshot({ path: 'data/booking-e2e-fail.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  await app.close();
}
