// 살롱 CRM 프런트엔드 (빌드 없음). 모든 동적 값은 html`` 태그가 자동 이스케이프한다.
const $ = (s, el = document) => el.querySelector(s);
class Raw { constructor(s) { this.s = s; } }
const raw = (s) => new Raw(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = (strs, ...vals) =>
  new Raw(strs.reduce((out, s, i) => out + s + (i < vals.length ? (Array.isArray(vals[i]) ? vals[i].map((v) => (v instanceof Raw ? v.s : esc(v))).join('') : vals[i] instanceof Raw ? vals[i].s : esc(vals[i])) : ''), ''));
const won = (n) => `${Number(n || 0).toLocaleString('ko-KR')}원`;
const p2 = (n) => String(n).padStart(2, '0');
const ymd = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00`); d.setDate(d.getDate() + n); return ymd(d); };
const nowLocal = () => `${ymd()}T${p2(new Date().getHours())}:${p2(new Date().getMinutes())}`;
const STATUS = { pending: '확인필요', confirmed: '예약확정', visited: '방문완료', noshow: '노쇼', cancelled: '취소' };
const METHOD = { cash: '현금', card: '카드', prepaid: '선불권', naverpay: '네이버페이', etc: '기타' };
const TRIGGER = { reservation_reminder: '예약 전날 안내', birthday: '생일 축하', inactive: 'N일 미방문' };

let token = localStorage.getItem('token');
let me = null;
const cache = { staff: [], services: [] };

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { logout(); throw new Error('세션이 만료되었습니다.'); }
  if (!res.ok) throw new Error(data.error || `오류 (${res.status})`);
  return data;
}
const get = (u) => api('GET', u);
const post = (u, b) => api('POST', u, b ?? {});
const patch = (u, b) => api('PATCH', u, b ?? {});

let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2500); }
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

function modal(content, onMount) { $('#modalBody').innerHTML = content.s; const m = $('#modal'); if (!m.open) m.showModal(); onMount?.($('#modalBody')); }
const closeModal = () => $('#modal').close();
// CSP(script-src 'self') 때문에 인라인 onclick 을 쓰지 않고 data-close 로 위임 처리
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' || e.target.dataset.close !== undefined) closeModal(); });
const fd = (form) => Object.fromEntries(new FormData(form));

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
    const b = fd(e.target);
    const r = await post(registering ? '/api/auth/register' : '/api/auth/login', b);
    token = r.token; localStorage.setItem('token', token);
    await boot();
  } catch (err) { $('#loginErr').textContent = err.message; }
};
function logout() { token = null; localStorage.removeItem('token'); $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
$('#logout').onclick = logout;

// ---------- 부트/라우팅 ----------
const TABS = [['dash', '대시보드'], ['resv', '예약'], ['cust', '고객'], ['pay', '결제'], ['msg', '문자'], ['stats', '통계'], ['set', '설정']];
let tab = 'dash';
async function boot() {
  if (!token) return logout();
  try { me = await get('/api/me'); } catch { return logout(); }
  await refreshCache();
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#shopName').textContent = me.shop.name; $('#who').textContent = `${me.staff.name} (${me.staff.role === 'owner' ? '사장' : '직원'})`;
  renderSms();
  $('#tabs').innerHTML = TABS.map(([k, n]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${n}</button>`).join('');
  $('#tabs').onclick = (e) => { const t = e.target.dataset.t; if (t) { tab = t; [...$('#tabs').children].forEach((b) => b.classList.toggle('on', b.dataset.t === t)); render(); } };
  render();
}
const renderSms = () => { $('#smsBal').textContent = `문자 잔액 ${me.shop.sms_balance.toLocaleString()}P`; };
async function refreshCache() { [cache.staff, cache.services] = await Promise.all([get('/api/staff'), get('/api/services')]); }
const refreshMe = async () => { me = await get('/api/me'); renderSms(); };
const views = { dash: vDash, resv: vResv, cust: vCust, pay: vPay, msg: vMsg, stats: vStats, set: vSet };
const render = guard(async () => { await views[tab]($('#view')); });
const activeStaff = () => cache.staff.filter((s) => s.active);
const activeServices = () => cache.services.filter((s) => s.active);
const opt = (list, sel) => list.map((o) => html`<option value="${o.id}" ${o.id == sel ? raw('selected') : ''}>${o.name}</option>`);

// ---------- 대시보드 ----------
async function vDash(el) {
  const t = await get('/api/stats/today');
  const r = t.reservations;
  const total = Object.values(r).reduce((a, b) => a + b, 0);
  el.innerHTML = html`
    <div class="grid">
      <div class="stat"><span class="muted">오늘 예약</span><b>${total}건</b></div>
      <div class="stat"><span class="muted">방문 완료</span><b>${r.visited || 0}건</b></div>
      <div class="stat"><span class="muted">오늘 매출</span><b>${won(t.sales)}</b></div>
      <div class="stat"><span class="muted">결제 건수</span><b>${t.count}건</b></div>
    </div>
    <div class="card"><h2>남은 예약 (${t.date})</h2>
      ${t.upcoming.length ? html`<table>${t.upcoming.map((u) => html`<tr><td>${u.start_at.slice(11)}</td><td>${u.customer_name}</td><td>${u.staff_name}</td></tr>`)}</table>` : html`<p class="muted">남은 예약이 없습니다.</p>`}
    </div>`.s;
}

// ---------- 예약 ----------
let resvDate = ymd(), resvStaff = '';
async function vResv(el) {
  const q = `from=${resvDate}&to=${resvDate}${resvStaff ? `&staffId=${resvStaff}` : ''}`;
  const list = await get(`/api/reservations?${q}`);
  el.innerHTML = html`
    <div class="card">
      <div class="row">
        <label>날짜<input type="date" id="rd" value="${resvDate}"></label>
        <label>담당<select id="rs"><option value="">전체</option>${opt(activeStaff(), resvStaff)}</select></label>
        <div class="fit"><button class="sec" id="prev">◀</button> <button class="sec" id="next">▶</button> <button class="primary" id="addResv">예약 추가</button></div>
      </div>
    </div>
    <div class="card tablewrap"><table>
      <tr><th>시간</th><th>고객</th><th>시술</th><th>담당</th><th>상태</th><th></th></tr>
      ${list.map((r) => html`<tr>
        <td>${r.start_at.slice(11)}~${r.end_at.slice(11)}</td>
        <td>${r.customer_name}${r.source === 'naver' ? raw(' <span class="badge">네이버</span>') : ''}</td>
        <td>${r.items}<div class="muted">${won(r.total)}</div></td><td>${r.staff_name}</td>
        <td><span class="badge ${r.status}">${STATUS[r.status]}</span>${r.memo ? html`<div class="muted">${r.memo}</div>` : ''}</td>
        <td>${['pending', 'confirmed'].includes(r.status) ? html`
          <button class="primary sm" data-pay="${r.id}">결제</button>
          ${r.status === 'pending' ? html`<button class="sec sm" data-st="${r.id}:confirmed">확정</button>` : ''}
          <button class="sec sm" data-st="${r.id}:noshow">노쇼</button>
          <button class="danger sm" data-st="${r.id}:cancelled">취소</button>` : ''}</td></tr>`)}
      ${list.length ? '' : html`<tr><td colspan="6" class="muted">예약이 없습니다.</td></tr>`}
    </table></div>`.s;
  $('#rd').onchange = (e) => { resvDate = e.target.value; render(); };
  $('#rs').onchange = (e) => { resvStaff = e.target.value; render(); };
  $('#prev').onclick = () => { resvDate = addDays(resvDate, -1); render(); };
  $('#next').onclick = () => { resvDate = addDays(resvDate, 1); render(); };
  $('#addResv').onclick = () => resvForm();
  el.onclick = guard(async (e) => {
    const st = e.target.dataset.st, pay = e.target.dataset.pay;
    if (st) { const [id, s] = st.split(':'); if (s !== 'confirmed' && !confirm(`${STATUS[s]} 처리할까요?`)) return; await patch(`/api/reservations/${id}`, { status: s }); render(); }
    if (pay) payForm(list.find((r) => r.id == pay));
  });
}

async function resvForm(prefillCustomer) {
  const customers = await get('/api/customers');
  modal(html`<h2>예약 추가</h2><form id="f">
    <label>고객<select name="customerId" required>${opt(customers, prefillCustomer)}</select></label>
    <div class="row"><label>담당<select name="staffId">${opt(activeStaff())}</select></label>
    <label>일시<input type="datetime-local" name="startAt" required value="${resvDate}T10:00"></label></div>
    <label>시술</label>${activeServices().map((s) => html`<label class="chk"><input type="checkbox" name="svc" value="${s.id}">${s.name} · ${won(s.price)} · ${s.duration_min}분</label>`)}
    <label>메모<input name="memo"></label>
    <button class="primary">저장</button> <button type="button" class="link" data-close>닫기</button></form>`,
  (m) => { $('#f', m).onsubmit = guard(async (e) => { e.preventDefault(); const f = e.target; const b = fd(f);
    await post('/api/reservations', { customerId: +b.customerId, staffId: +b.staffId, startAt: b.startAt, memo: b.memo, serviceIds: [...f.querySelectorAll('[name=svc]:checked')].map((c) => +c.value) });
    closeModal(); toast('예약이 등록되었습니다.'); render(); }); });
}

// ---------- 결제 ----------
async function payForm(resv) {
  const customers = resv ? [] : await get('/api/customers');
  const svcIds = resv ? null : [];
  modal(html`<h2>결제 ${resv ? html`- ${resv.customer_name}` : ''}</h2><form id="f">
    ${resv ? '' : html`<label>고객<select name="customerId" id="pc">${opt(customers)}</select></label>`}
    <label>담당<select name="staffId">${opt(activeStaff(), resv?.staff_id)}</select></label>
    <label>시술 (가격 수정 가능)</label>
    ${activeServices().map((s) => html`<div class="chk"><input type="checkbox" data-svc="${s.id}" ${resv && (resv.items || '').split(', ').includes(s.name) ? raw('checked') : ''}> <span style="flex:1">${s.name}</span><input type="number" data-price="${s.id}" value="${s.price}" style="width:120px;margin:0"></div>`)}
    <h3>결제 수단 <span class="muted" id="sum"></span></h3>
    ${Object.entries(METHOD).map(([k, n]) => html`<div class="chk"><span style="width:90px">${n}</span><input type="number" min="0" data-m="${k}" placeholder="0" style="margin:0"></div>`)}
    <div id="bal" class="muted"></div>
    <button class="primary">결제 완료</button> <button type="button" class="link" data-close>닫기</button></form>`,
  (m) => {
    const f = $('#f', m);
    const total = () => [...f.querySelectorAll('[data-svc]:checked')].reduce((a, c) => a + Number(f.querySelector(`[data-price="${c.dataset.svc}"]`).value || 0), 0);
    const paid = () => [...f.querySelectorAll('[data-m]')].reduce((a, i) => a + Number(i.value || 0), 0);
    const upd = () => { $('#sum', m).textContent = `합계 ${won(total())} / 입력 ${won(paid())}`; };
    f.oninput = upd; upd();
    const cid = () => resv ? resv.customer_id : +f.customerId.value;
    const showBal = guard(async () => { const c = await get(`/api/customers/${cid()}`); $('#bal', m).textContent = `선불권 잔액 ${won(c.prepaidBalance)}`; });
    showBal(); $('#pc', m)?.addEventListener('change', showBal);
    f.onsubmit = guard(async (e) => {
      e.preventDefault();
      const items = [...f.querySelectorAll('[data-svc]:checked')].map((c) => ({ serviceId: +c.dataset.svc, price: +f.querySelector(`[data-price="${c.dataset.svc}"]`).value }));
      const lines = [...f.querySelectorAll('[data-m]')].filter((i) => +i.value > 0).map((i) => ({ method: i.dataset.m, amount: +i.value }));
      await post('/api/payments', { customerId: cid(), staffId: +f.staffId.value, reservationId: resv?.id, items, lines });
      closeModal(); toast('결제가 완료되었습니다.'); await refreshMe(); render();
    });
  });
}

let payFrom = ymd(), payTo = ymd();
async function vPay(el) {
  const list = await get(`/api/payments?from=${payFrom}&to=${payTo}`);
  const sum = list.filter((p) => p.status === 'paid').reduce((a, p) => a + p.total, 0);
  el.innerHTML = html`
    <div class="card"><div class="row">
      <label>시작<input type="date" id="pf" value="${payFrom}"></label><label>종료<input type="date" id="pt" value="${payTo}"></label>
      <div class="fit"><button class="primary" id="np">결제 등록</button></div></div>
      <p class="muted">기간 매출(환불 제외): <b>${won(sum)}</b></p></div>
    <div class="card tablewrap"><table><tr><th>일시</th><th>고객</th><th>내역</th><th>수단</th><th>금액</th><th></th></tr>
    ${list.map((p) => html`<tr><td>${p.paid_at.replace('T', ' ')}</td><td>${p.customer_name}</td><td>${p.items}<div class="muted">${p.staff_name}</div></td>
      <td>${(p.lines || '').split(' ').map((l) => { const [m, a] = l.split(':'); return `${METHOD[m] || m} ${Number(a).toLocaleString()}`; }).join(', ')}</td>
      <td>${won(p.total)} <span class="badge ${p.status}">${p.status === 'paid' ? '결제' : '환불'}</span></td>
      <td>${p.status === 'paid' && me.staff.role === 'owner' ? html`<button class="danger sm" data-rf="${p.id}">환불</button>` : ''}</td></tr>`)}
    ${list.length ? '' : html`<tr><td colspan="6" class="muted">내역이 없습니다.</td></tr>`}</table></div>`.s;
  $('#pf').onchange = (e) => { payFrom = e.target.value; render(); };
  $('#pt').onchange = (e) => { payTo = e.target.value; render(); };
  $('#np').onclick = () => payForm();
  el.onclick = guard(async (e) => { const id = e.target.dataset.rf; if (id && confirm('환불 처리할까요? (선불권 사용분은 복원됩니다)')) { await post(`/api/payments/${id}/refund`); toast('환불되었습니다.'); render(); } });
}

// ---------- 고객 ----------
let custQ = '';
async function vCust(el) {
  const list = await get(`/api/customers?q=${encodeURIComponent(custQ)}`);
  el.innerHTML = html`
    <div class="card"><div class="row"><label>이름 / 연락처 검색<input id="cq" value="${custQ}" placeholder="이름 또는 010-0000-0000"></label>
      <div class="fit"><button class="sec" id="cs">검색</button> <button class="primary" id="ca">고객 등록</button>
      ${me.staff.role === 'owner' ? html` <button class="sec" id="cx">CSV 내보내기</button> <button class="sec" id="ci">CSV 가져오기</button><input type="file" id="cf" accept=".csv,text/csv" class="hidden">` : ''}</div></div></div>
    <div class="card tablewrap"><table><tr><th>이름</th><th>연락처</th><th>등급</th><th>최근 방문</th><th>수신동의</th></tr>
    ${list.map((c) => html`<tr style="cursor:pointer" data-id="${c.id}"><td>${c.name}</td><td>${fmtPhone(c.phone)}</td><td>${c.grade}</td><td>${c.lastVisit || '-'}</td><td>${c.marketing_consent ? '동의' : '-'}</td></tr>`)}
    ${list.length ? '' : html`<tr><td colspan="5" class="muted">고객이 없습니다.</td></tr>`}</table></div>`.s;
  const search = () => { custQ = $('#cq').value; render(); };
  $('#cs').onclick = search; $('#cq').onkeydown = (e) => e.key === 'Enter' && search();
  $('#ca').onclick = () => custForm();
  $('#cx')?.addEventListener('click', guard(async () => {
    const res = await fetch('/api/customers/export.csv', { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '내보내기 실패');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: 'customers.csv' });
    a.click(); URL.revokeObjectURL(a.href);
  }));
  $('#ci')?.addEventListener('click', () => $('#cf').click());
  $('#cf')?.addEventListener('change', guard(async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const r = await post('/api/customers/import', { csv: await file.text() });
    const NL = String.fromCharCode(10);
    const errs = r.errors.map((x) => `${x.line}행: ${x.error}`).join(NL);
    alert([`가져오기 완료: 생성 ${r.created}건 / 중복 건너뜀 ${r.skipped}건 / 오류 ${r.errors.length}건`, errs, '※ 수신동의 열이 없거나 N이면 마케팅 미동의로 저장됩니다.'].filter(Boolean).join(NL + NL));
    e.target.value = '';
    render();
  }));
  el.onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) custDetail(tr.dataset.id); };
}
const fmtPhone = (p) => (p || '').replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');

function custForm(c = {}) {
  modal(html`<h2>${c.id ? '고객 수정' : '고객 등록'}</h2><form id="f">
    <label>이름<input name="name" required value="${c.name}"></label>
    <div class="row"><label>연락처<input name="phone" value="${fmtPhone(c.phone)}" placeholder="010-0000-0000"></label>
    <label>생일 (YYYY-MM-DD)<input name="birth" value="${c.birth}" placeholder="1990-05-01"></label></div>
    <div class="row"><label>등급<select name="grade">${['normal', 'vip', 'vvip'].map((g) => html`<option ${g === c.grade ? raw('selected') : ''}>${g}</option>`)}</select></label>
    <label>담당 디자이너<select name="staffId"><option value="">-</option>${opt(activeStaff(), c.staff_id)}</select></label></div>
    <label>태그 (쉼표 구분)<input name="tags" value="${c.tags}"></label>
    <label>메모<textarea name="memo">${c.memo}</textarea></label>
    <label class="chk"><input type="checkbox" name="marketingConsent" ${c.marketing_consent ? raw('checked') : ''}> 마케팅 문자 수신 동의</label>
    <button class="primary">저장</button> <button type="button" class="link" data-close>닫기</button></form>`,
  (m) => { $('#f', m).onsubmit = guard(async (e) => { e.preventDefault(); const b = fd(e.target);
    b.marketingConsent = e.target.marketingConsent.checked; b.staffId = b.staffId ? +b.staffId : null;
    c.id ? await patch(`/api/customers/${c.id}`, b) : await post('/api/customers', b);
    closeModal(); toast('저장되었습니다.'); render(); }); });
}

const custDetail = guard(async (id) => {
  const c = await get(`/api/customers/${id}`);
  modal(html`<h2>${c.name} <span class="badge">${c.grade}</span></h2>
    <p>${fmtPhone(c.phone)} · 생일 ${c.birth || '-'} · 수신 ${c.marketing_consent ? '동의' : '미동의'}</p>
    <p class="muted">${c.tags ? `태그: ${c.tags} · ` : ''}${c.memo}</p>
    <div class="stat">선불권 잔액<b>${won(c.prepaidBalance)}</b></div>
    <div class="row" style="margin-top:8px"><label>선불권 충전액<input type="number" id="chg" min="1"></label>
      <div class="fit"><button class="sec" id="chgb">충전</button> <button class="sec" id="ed">수정</button> <button class="primary" id="rs">예약</button></div></div>
    <h3>방문·결제 이력</h3>
    <div class="tablewrap"><table>${c.visits.map((v) => html`<tr><td>${v.paid_at.slice(0, 10)}</td><td>${v.items}<div class="muted">${v.staff}</div></td><td>${won(v.total)} <span class="badge ${v.status}">${v.status === 'paid' ? '결제' : '환불'}</span></td></tr>`)}
    ${c.visits.length ? '' : html`<tr><td class="muted">이력이 없습니다.</td></tr>`}</table></div>
    <button class="link" data-close>닫기</button>`,
  (m) => {
    $('#chgb', m).onclick = guard(async () => { await post(`/api/customers/${id}/prepaid`, { amount: +$('#chg', m).value }); toast('충전되었습니다.'); custDetail(id); });
    $('#ed', m).onclick = () => custForm(c);
    $('#rs', m).onclick = () => resvForm(c.id);
  });
});

// ---------- 문자 ----------
async function vMsg(el) {
  const [tpls, rules, logs, custs] = await Promise.all([get('/api/templates'), get('/api/automation'), get('/api/messages/log'), get('/api/customers')]);
  el.innerHTML = html`
    <div class="card"><h2>문자 발송</h2><form id="sf">
      <label>템플릿<select name="templateId"><option value="">직접 입력</option>${tpls.map((t) => html`<option value="${t.id}">${t.name}${t.is_ad ? ' (광고)' : ''}</option>`)}</select></label>
      <label>내용 ({{name}}, {{shop}} 사용 가능)<textarea name="body"></textarea></label>
      <label class="chk"><input type="checkbox" name="isAd"> 광고성 문자 (수신동의 고객만, 21~08시 발송 불가, 문구 자동 삽입)</label>
      <label>대상 고객</label><div style="max-height:160px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:6px">
        ${custs.map((c) => html`<label class="chk"><input type="checkbox" name="cid" value="${c.id}">${c.name} ${fmtPhone(c.phone)} ${c.marketing_consent ? '' : raw('<span class="muted">(미동의)</span>')}</label>`)}</div>
      <p><button class="primary">발송</button></p></form></div>
    <div class="card"><h2>자동 발송 규칙</h2>
      <table>${rules.map((r) => html`<tr><td>${r.name}</td><td>${TRIGGER[r.trigger]}${r.trigger === 'inactive' ? ` (${r.param}일)` : ''}</td><td>${r.template_name}</td>
        <td><button class="sec sm" data-tg="${r.id}:${r.active ? 0 : 1}">${r.active ? '사용중' : '중지됨'}</button></td></tr>`)}</table>
      <form id="rf" class="row" style="margin-top:10px"><label>이름<input name="name" required></label>
        <label>트리거<select name="trigger">${Object.entries(TRIGGER).map(([k, n]) => html`<option value="${k}">${n}</option>`)}</select></label>
        <label>N일<input name="param" type="number" value="0"></label>
        <label>템플릿<select name="templateId">${opt(tpls)}</select></label><div class="fit"><button class="primary">규칙 추가</button> <button type="button" class="sec" id="run">지금 실행</button></div></form></div>
    <div class="card"><h2>템플릿</h2>
      <form id="tf" class="row"><label>이름<input name="name" required></label><label>내용<input name="body" required></label>
      <label class="chk"><input type="checkbox" name="isAd">광고</label><div class="fit"><button class="primary">추가</button></div></form></div>
    <div class="card tablewrap"><h2>발송 내역</h2><table><tr><th>시각</th><th>고객</th><th>내용</th><th>상태</th></tr>
      ${logs.map((l) => html`<tr><td>${l.sent_at}</td><td>${l.customer_name || '-'}</td><td>${l.body}</td><td><span class="badge ${l.status}">${l.status}</span>${l.reason ? html`<div class="muted">${l.reason}</div>` : ''}</td></tr>`)}</table></div>`.s;
  $('#sf').onsubmit = guard(async (e) => { e.preventDefault(); const f = e.target; const b = fd(f);
    const r = await post('/api/messages/send', { templateId: b.templateId ? +b.templateId : undefined, body: b.body, isAd: f.isAd.checked, customerIds: [...f.querySelectorAll('[name=cid]:checked')].map((c) => +c.value) });
    toast(`발송 ${r.sent}, 실패 ${r.failed}, 건너뜀 ${r.skipped}`); await refreshMe(); render(); });
  $('#tf').onsubmit = guard(async (e) => { e.preventDefault(); const b = fd(e.target); await post('/api/templates', { name: b.name, body: b.body, isAd: e.target.isAd.checked }); render(); });
  $('#rf').onsubmit = guard(async (e) => { e.preventDefault(); const b = fd(e.target); await post('/api/automation', { name: b.name, trigger: b.trigger, param: +b.param, templateId: +b.templateId }); render(); });
  $('#run').onclick = guard(async () => { const r = await post('/api/automation/run'); toast(`자동 발송: ${r.sent}건 발송, ${r.skipped}건 제외`); await refreshMe(); render(); });
  el.onclick = guard(async (e) => { const t = e.target.dataset.tg; if (t) { const [id, a] = t.split(':'); await patch(`/api/automation/${id}`, { active: a === '1' }); render(); } });
}

// ---------- 통계 ----------
let stFrom = ymd().slice(0, 8) + '01', stTo = ymd();
async function vStats(el) {
  const s = await get(`/api/stats/summary?from=${stFrom}&to=${stTo}`);
  const bars = (rows, key, val, fmt = won) => { const max = Math.max(1, ...rows.map((r) => r[val])); return html`<table>${rows.map((r) => html`<tr><td style="width:30%">${r[key]}</td><td><div class="bar" style="width:${Math.round((r[val] / max) * 100)}%"></div></td><td style="text-align:right;width:28%">${fmt(r[val])}</td></tr>`)}${rows.length ? '' : html`<tr><td class="muted">데이터 없음</td></tr>`}</table>`; };
  el.innerHTML = html`
    <div class="card"><div class="row"><label>시작<input type="date" id="sf" value="${stFrom}"></label><label>종료<input type="date" id="st" value="${stTo}"></label></div></div>
    <div class="grid">
      <div class="stat"><span class="muted">총 매출</span><b>${won(s.sales)}</b></div>
      <div class="stat"><span class="muted">결제 건수</span><b>${s.count}건</b></div>
      <div class="stat"><span class="muted">객단가</span><b>${won(s.average)}</b></div>
      <div class="stat"><span class="muted">신규 / 재방문</span><b>${s.customers.new} / ${s.customers.returning}</b></div>
      <div class="stat"><span class="muted">선불권 충전액</span><b>${won(s.prepaidCharged)}</b></div>
    </div>
    <div class="card"><h2>일별 매출</h2>${bars(s.byDay, 'day', 'sales')}</div>
    <div class="card"><h2>직원별 매출 · 인센티브</h2><table><tr><th>직원</th><th>건수</th><th>매출</th><th>인센티브</th></tr>${s.byStaff.map((r) => html`<tr><td>${r.name}</td><td>${r.count}</td><td>${won(r.sales)}</td><td>${won(r.commission)}</td></tr>`)}</table></div>
    <div class="card"><h2>시술별 매출</h2>${bars(s.byService, 'name', 'sales')}</div>
    <div class="card"><h2>결제수단별</h2>${bars(s.byMethod.map((m) => ({ ...m, label: METHOD[m.method] || m.method })), 'label', 'amount')}</div>`.s;
  $('#sf').onchange = (e) => { stFrom = e.target.value; render(); };
  $('#st').onchange = (e) => { stTo = e.target.value; render(); };
}

// ---------- 설정 ----------
async function vSet(el) {
  await refreshCache();
  const owner = me.staff.role === 'owner';
  el.innerHTML = html`
    <div class="card"><h2>시술 메뉴</h2><table><tr><th>이름</th><th>분류</th><th>가격</th><th>소요</th><th></th></tr>
      ${cache.services.map((s) => html`<tr><td>${s.name}</td><td>${s.category}</td><td>${won(s.price)}</td><td>${s.duration_min}분</td><td><button class="sec sm" data-sv="${s.id}:${s.active ? 0 : 1}">${s.active ? '판매중' : '중지'}</button></td></tr>`)}</table>
      <form id="svf" class="row" style="margin-top:10px"><label>이름<input name="name" required></label><label>분류<input name="category"></label>
      <label>가격<input name="price" type="number" required min="0"></label><label>소요(분)<input name="durationMin" type="number" value="60"></label><div class="fit"><button class="primary">추가</button></div></form></div>
    <div class="card"><h2>직원</h2><table><tr><th>이름</th><th>계정</th><th>인센티브율</th><th></th></tr>
      ${cache.staff.map((s) => html`<tr><td>${s.name}</td><td>${s.login_id || '-'}</td><td>${s.commission_rate}%</td><td>${owner && s.role !== 'owner' ? html`<button class="sec sm" data-sf="${s.id}:${s.active ? 0 : 1}">${s.active ? '재직' : '퇴사'}</button>` : ''}</td></tr>`)}</table>
      ${owner ? html`<form id="stf" class="row" style="margin-top:10px"><label>이름<input name="name" required></label><label>로그인ID(선택)<input name="loginId"></label>
      <label>비밀번호(8자+)<input name="password" type="password"></label><label>인센티브(%)<input name="commissionRate" type="number" value="0" step="0.5"></label><div class="fit"><button class="primary">추가</button></div></form>` : ''}</div>
    <div class="card"><h2>내 비밀번호 변경</h2><form id="pwf" class="row"><label>현재 비밀번호<input type="password" name="current" required autocomplete="current-password"></label>
      <label>새 비밀번호 (8자 이상)<input type="password" name="next" required minlength="8" autocomplete="new-password"></label><div class="fit"><button class="primary">변경</button></div></form></div>
    ${owner ? html`<div class="card"><h2>문자 충전</h2><p class="muted">데모: 결제 없이 즉시 충전됩니다. 실제 서비스는 PG 결제 후 승인 처리로 교체하세요.</p><button class="sec" id="chg">1,000P 충전</button></div>` : ''}`.s;
  $('#svf').onsubmit = guard(async (e) => { e.preventDefault(); const b = fd(e.target); await post('/api/services', { name: b.name, category: b.category, price: +b.price, durationMin: +b.durationMin }); render(); });
  $('#stf')?.addEventListener('submit', guard(async (e) => { e.preventDefault(); const b = fd(e.target); await post('/api/staff', { name: b.name, loginId: b.loginId || undefined, password: b.password || undefined, commissionRate: +b.commissionRate }); render(); }));
  $('#pwf').onsubmit = guard(async (e) => { e.preventDefault(); await post('/api/me/password', fd(e.target)); e.target.reset(); toast('비밀번호가 변경되었습니다.'); });
  $('#chg')?.addEventListener('click', guard(async () => { await post('/api/messages/charge', { amount: 1000 }); await refreshMe(); toast('충전되었습니다.'); }));
  el.onclick = guard(async (e) => {
    const sv = e.target.dataset.sv, sf = e.target.dataset.sf;
    if (sv) { const [id, a] = sv.split(':'); await patch(`/api/services/${id}`, { active: a === '1' }); render(); }
    if (sf) { const [id, a] = sf.split(':'); await patch(`/api/staff/${id}`, { active: a === '1' }); render(); }
  });
}

boot();
