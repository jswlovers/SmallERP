// 플랫폼 관리자 페이지. 모든 동적 값은 html`` 태그가 자동 이스케이프한다.
const $ = (s, el = document) => el.querySelector(s);
class Raw { constructor(s) { this.s = s; } }
const raw = (s) => new Raw(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const one = (v) => (v instanceof Raw ? v.s : esc(v));
const html = (strs, ...vals) => new Raw(strs.reduce((out, s, i) => out + s + (i < vals.length ? (Array.isArray(vals[i]) ? vals[i].map(one).join('') : one(vals[i])) : ''), ''));
const won = (n) => `${Number(n || 0).toLocaleString('ko-KR')}원`;
const PLANS = { basic: 'Basic', standard: 'Standard', premium: 'Premium' };

let token = sessionStorage.getItem('admin_token'); // 탭을 닫으면 로그아웃되도록 sessionStorage 사용

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { logout(); throw new Error('세션이 만료되었습니다.'); }
  if (!res.ok) throw new Error(data.error || `오류 (${res.status})`);
  return data;
}
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2500); }
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };
const modal = (content, onMount) => { $('#modalBody').innerHTML = content.s; const m = $('#modal'); if (!m.open) m.showModal(); onMount?.($('#modalBody')); };
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' || e.target.dataset.close !== undefined) $('#modal').close(); });

function logout() { token = null; sessionStorage.removeItem('admin_token'); $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
$('#logout').onclick = logout;
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  try {
    const b = Object.fromEntries(new FormData(e.target));
    token = (await api('POST', '/api/admin/auth/login', b)).token;
    sessionStorage.setItem('admin_token', token);
    boot();
  } catch (err) { $('#loginErr').textContent = err.message; }
};

const TABS = [['shops', '매장'], ['audit', '감사 로그']];
let tab = 'shops';
function boot() {
  if (!token) return logout();
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#tabs').innerHTML = TABS.map(([k, n]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${n}</button>`).join('');
  $('#tabs').onclick = (e) => { const t = e.target.dataset.t; if (t) { tab = t; [...$('#tabs').children].forEach((b) => b.classList.toggle('on', b.dataset.t === t)); render(); } };
  render();
}
const render = guard(async () => { await ({ shops: vShops, audit: vAudit })[tab]($('#view')); });

let q = '';
async function vShops(el) {
  const [o, shops] = await Promise.all([api('GET', '/api/admin/overview'), api('GET', `/api/admin/shops?q=${encodeURIComponent(q)}`)]);
  el.innerHTML = html`
    <div class="grid">
      <div class="stat"><span class="muted">매장 (이용중/전체)</span><b>${o.shops.active} / ${o.shops.n}</b></div>
      <div class="stat"><span class="muted">활성 직원</span><b>${o.staff}명</b></div>
      <div class="stat"><span class="muted">고객 수</span><b>${o.customers.toLocaleString()}명</b></div>
      <div class="stat"><span class="muted">이번 달 총 매출</span><b>${won(o.monthSales)}</b></div>
      <div class="stat"><span class="muted">이번 달 문자 발송</span><b>${o.monthMessages}건</b></div>
    </div>
    <div class="card"><div class="row"><label>매장명 검색<input id="q" value="${q}"></label><div class="fit"><button class="sec" id="qs">검색</button></div></div></div>
    <div class="card tablewrap"><table>
      <tr><th>매장</th><th>사장</th><th>플랜</th><th>직원/고객</th><th>이번 달 매출</th><th>문자 잔액</th><th>상태</th><th></th></tr>
      ${shops.map((s) => html`<tr>
        <td>${s.name}<div class="muted">#${s.id} · ${s.created_at.slice(0, 10)}</div></td>
        <td>${s.owner}<div class="muted">${s.owner_login}</div></td>
        <td><select data-plan="${s.id}" style="margin:0">${Object.entries(PLANS).map(([k, n]) => html`<option value="${k}" ${k === s.plan ? raw('selected') : ''}>${n}</option>`)}</select></td>
        <td>${s.staff_count} / ${s.customer_count}</td>
        <td>${won(s.month_sales)}</td>
        <td>${s.sms_balance.toLocaleString()}P</td>
        <td><span class="badge ${s.active ? 'visited' : 'cancelled'}">${s.active ? '이용중' : '정지'}</span></td>
        <td>
          <button class="sec sm" data-charge="${s.id}">문자충전</button>
          <button class="sec sm" data-reset="${s.id}">비번초기화</button>
          <button class="${s.active ? 'danger' : 'primary'} sm" data-toggle="${s.id}:${s.active ? 0 : 1}">${s.active ? '정지' : '해제'}</button>
          <button class="link sm" data-log="${s.id}">로그</button></td></tr>`)}
      ${shops.length ? '' : html`<tr><td colspan="8" class="muted">매장이 없습니다.</td></tr>`}
    </table></div>`.s;
  const search = () => { q = $('#q').value; render(); };
  $('#qs').onclick = search; $('#q').onkeydown = (e) => e.key === 'Enter' && search();
  el.onchange = guard(async (e) => { const id = e.target.dataset.plan; if (id) { await api('PATCH', `/api/admin/shops/${id}`, { plan: e.target.value }); toast('플랜이 변경되었습니다.'); } });
  el.onclick = guard(async (e) => {
    const d = e.target.dataset;
    if (d.charge) {
      const v = prompt('충전(+)/차감(-) 포인트', '1000');
      if (v !== null) { const r = await api('POST', `/api/admin/shops/${d.charge}/charge`, { amount: Number(v) }); toast(`잔액 ${r.balance.toLocaleString()}P`); render(); }
    } else if (d.reset) {
      if (!confirm('사장 비밀번호를 임시 비밀번호로 초기화할까요?')) return;
      const r = await api('POST', `/api/admin/shops/${d.reset}/reset-owner-password`);
      modal(html`<h2>비밀번호 초기화 완료</h2><p>아이디 <b>${r.loginId}</b></p><p>임시 비밀번호 <b>${r.tempPassword}</b></p>
        <p class="muted">이 창을 닫으면 다시 볼 수 없습니다. 사장에게 전달하고 로그인 후 즉시 변경하도록 안내하세요.</p><button class="primary" data-close>확인</button>`);
    } else if (d.toggle) {
      const [id, a] = d.toggle.split(':');
      if (a === '0' && !confirm('매장을 정지하면 소속 직원 모두 로그인/사용이 차단됩니다. 정지할까요?')) return;
      await api('PATCH', `/api/admin/shops/${id}`, { active: a === '1' }); render();
    } else if (d.log) { tab = 'audit'; auditShop = d.log; boot(); }
  });
}

let auditShop = '';
async function vAudit(el) {
  const rows = await api('GET', `/api/admin/audit${auditShop ? `?shopId=${auditShop}` : ''}`);
  el.innerHTML = html`<div class="card tablewrap"><h2>감사 로그 ${auditShop ? html`(매장 #${auditShop}) <button class="link sm" id="all">전체 보기</button>` : ''}</h2>
    <table><tr><th>시각(UTC)</th><th>매장</th><th>작업자</th><th>작업</th><th>내용</th><th>IP</th></tr>
    ${rows.map((r) => html`<tr><td>${r.created_at}</td><td>${r.shop_name || r.shop_id}</td><td>${r.staff_name || '관리자'}</td><td>${r.action}</td><td>${r.detail}</td><td>${r.ip}</td></tr>`)}
    ${rows.length ? '' : html`<tr><td colspan="6" class="muted">기록이 없습니다.</td></tr>`}</table></div>`.s;
  $('#all')?.addEventListener('click', () => { auditShop = ''; render(); });
}

$('#pw').onclick = () => modal(html`<h2>관리자 비밀번호 변경</h2><form id="f">
  <label>현재 비밀번호<input type="password" name="current" required autocomplete="current-password"></label>
  <label>새 비밀번호 (10자 이상)<input type="password" name="next" required minlength="10" autocomplete="new-password"></label>
  <button class="primary">변경</button> <button type="button" class="link" data-close>닫기</button></form>`,
(m) => { $('#f', m).onsubmit = guard(async (e) => { e.preventDefault(); await api('POST', '/api/admin/password', Object.fromEntries(new FormData(e.target))); $('#modal').close(); toast('변경되었습니다.'); }); });

boot();
