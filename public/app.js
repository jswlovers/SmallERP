// 살롱 CRM 프런트엔드 셸 (빌드 없음): 로그인, 탭 라우팅, 공통 상태 관리. 화면은 views/*.js 모듈.
import { $, fd, get, guard, post, refreshCache, state } from './core.js';
import { vDash } from './views/dash.js';
import { vResv } from './views/resv.js';
import { vWait } from './views/wait.js';
import { vCust } from './views/cust.js';
import { vPay } from './views/pay.js';
import { vProd } from './views/prod.js';
import { vMsg } from './views/msg.js';
import { vStats } from './views/analysis.js';
import { vCash } from './views/cash.js';
import { vShop } from './views/shop.js';
import { vSet } from './views/set.js';

// ---------- 로그인 ----------
let registering = false;
$('#toggleReg').onclick = () => {
  registering = !registering;
  $('#registerFields').classList.toggle('hidden', !registering);
  $('#loginBtn').textContent = registering ? '매장 등록' : '로그인';
  $('#toggleReg').textContent = registering ? '로그인으로 돌아가기' : '신규 매장 등록';
};
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  try {
    const r = await post(registering ? '/api/auth/register' : '/api/auth/login', fd(e.target));
    state.token = r.token; localStorage.setItem('token', r.token);
    await boot();
  } catch (err) { $('#loginErr').textContent = err.message; }
};
function logout() { state.token = null; localStorage.removeItem('token'); $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
state.onLogout = logout;
$('#logout').onclick = logout;

// ---------- 탭 ----------
const TABS = [['dash', '대시보드', vDash], ['resv', '예약', vResv], ['wait', '대기', vWait], ['cust', '고객', vCust], ['pay', '결제', vPay], ['prod', '상품', vProd],
  ['msg', '문자', vMsg], ['stats', '통계', vStats], ['cash', '입출금', vCash], ['shop', '매장', vShop], ['set', '설정', vSet]];
let tab = 'dash';

const renderSms = () => { $('#smsBal').textContent = `문자 잔액 ${state.me.shop.sms_balance.toLocaleString()}P`; };
state.refreshMe = async () => { state.me = await get('/api/me'); renderSms(); };
state.refreshCache = refreshCache;
state.rerender = guard(async () => { await TABS.find((t) => t[0] === tab)[2]($('#view')); });

async function boot() {
  if (!state.token) return logout();
  try { state.me = await get('/api/me'); } catch { return logout(); }
  await refreshCache();
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#shopName').textContent = state.me.shop.name;
  $('#who').textContent = `${state.me.staff.name} (${state.me.staff.role === 'owner' ? '사장' : '직원'})`;
  renderSms();
  $('#tabs').innerHTML = TABS.map(([k, n]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${n}</button>`).join('');
  $('#tabs').onclick = (e) => { const t = e.target.dataset.t; if (t) { tab = t; [...$('#tabs').children].forEach((b) => b.classList.toggle('on', b.dataset.t === t)); state.rerender(); } };
  state.rerender();
}

boot();
