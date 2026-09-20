// 고객 셀프 온라인 예약 페이지. 매장 직원 화면(app.js)과 완전히 분리된 별도 로그인(휴대폰 인증)을 쓴다.
// 접속: /book.html?s=<매장 공개 코드> (설정 > 솔루션 간편설정 화면에서 매장이 발급받은 링크)
import { $, STATUS, addDays, closeModal, esc, fd, fmtPhone, guard, html, modal, raw, toast, won, ymd } from './core.js';

const code = new URLSearchParams(location.search).get('s');
const TOKEN_KEY = 'cust_token';
let token = localStorage.getItem(TOKEN_KEY);
let info = null;
let me = null;

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `오류 (${res.status})`);
  return data;
}
const get = (u) => api('GET', u);
const post = (u, b) => api('POST', u, b ?? {});

function logout() { token = null; me = null; localStorage.removeItem(TOKEN_KEY); render(); }

const root = () => $('#root');

async function render() {
  // 서버가 book.html 응답에 미리 넣어준 텍스트 기반 요약(#ssr, 검색엔진·기본 웹브라우징용)은
  // 실제 앱이 정상적으로 뜨면 더 이상 필요 없으므로 제거한다.
  document.getElementById('ssr')?.remove();
  if (!code) { root().innerHTML = '<div class="bhead"><h1>예약 링크가 올바르지 않습니다</h1><p class="muted">매장에서 안내받은 예약 링크로 다시 접속해 주세요.</p></div>'; return; }
  try { info = await get(`/api/public/${code}/info`); }
  catch (e) { root().innerHTML = `<div class="bhead"><h1>${esc(e.message)}</h1></div>`; return; }
  if (!token) return renderLogin();
  try { me = await get(`/api/public/${code}/me`); }
  catch { logout(); return; }
  renderApp();
}

// ---------- 로그인 (휴대폰 인증만으로 가입/로그인) ----------
function renderLogin() {
  root().innerHTML = html`<div class="bhead"><h1>${info.shopName}</h1><p class="muted">온라인 예약</p></div>
    <div class="card"><h2>휴대폰 번호로 시작하기</h2><p class="muted">비밀번호 없이 인증번호로 간편하게 예약할 수 있어요.</p>
      <form id="pf"><label>휴대폰 번호<input name="phone" type="tel" inputmode="numeric" placeholder="010-0000-0000" required autofocus></label>
      <button class="primary" style="width:100%;margin-top:8px">인증번호 받기</button></form>
      <p style="text-align:center;margin-top:10px"><a class="link" href="chat.html?s=${encodeURIComponent(code ?? '')}">💬 AI에게 대화로 예약 부탁하기</a></p></div>`.s;
  $('#pf').onsubmit = guard(async (e) => {
    e.preventDefault();
    const phone = fd(e.target).phone;
    const r = await post(`/api/public/${code}/otp/request`, { phone });
    renderOtp(phone, r.devCode);
  });
}

function renderOtp(phone, devCode) {
  root().innerHTML = html`<div class="bhead"><h1>${info.shopName}</h1></div>
    <div class="card"><h2>인증번호 입력</h2><p class="muted">${fmtPhone(phone)}로 보낸 6자리 번호를 입력해 주세요. (5분 이내)</p>
      <form id="vf"><div class="otpbox"><input name="code" inputmode="numeric" maxlength="6" placeholder="000000" required autofocus></div>
      <label>이름 (선택, 처음 가입 시에만 사용돼요)<input name="name" placeholder="예: 홍길동" maxlength="30"></label>
      <button class="primary" style="width:100%;margin-top:8px">확인</button></form>
      ${devCode ? html`<p class="devcode">테스트 모드: 실제 발급된 번호는 <b>${devCode}</b> 이고, <b>000000</b>도 항상 통과돼요. (실제 문자 연동 전에만 표시됩니다)</p>` : ''}
      <p><button type="button" class="link" id="back">번호 다시 입력</button> <button type="button" class="link" id="resend">인증번호 재발송</button></p></div>`.s;
  $('#back').onclick = renderLogin;
  $('#resend').onclick = guard(async () => { const r = await post(`/api/public/${code}/otp/request`, { phone }); toast('인증번호를 다시 보냈어요.'); renderOtp(phone, r.devCode); });
  $('#vf').onsubmit = guard(async (e) => {
    e.preventDefault();
    const b = fd(e.target);
    const r = await post(`/api/public/${code}/otp/verify`, { phone, code: b.code, name: b.name });
    token = r.token; localStorage.setItem(TOKEN_KEY, token);
    toast(r.created ? '가입되었습니다. 환영해요!' : '로그인되었습니다.');
    render();
  });
}

// ---------- 예약 화면 ----------
let picked = { serviceIds: new Set(), staffId: '', date: ymd(), time: '' };

async function renderApp() {
  const upcoming = await get(`/api/public/${code}/my-reservations`);
  root().innerHTML = html`<div class="bhead"><h1>${info.shopName}</h1><p>${me.name}님 <button class="link" id="logout">로그아웃</button></p></div>
    ${info.booking.enabled ? bookingForm() : html`<div class="notice">지금은 온라인 예약을 받지 않는 매장입니다. 전화로 문의해 주세요.</div>`}
    <div class="card"><h2>내 예약</h2>${renderReservations(upcoming)}</div>
    <div class="card"><h2>내 정보</h2><form id="nf" class="row"><label>이름<input name="name" value="${me.name}" maxlength="30" required></label><div class="fit"><button class="sec">저장</button></div></form></div>`.s;
  $('#logout').onclick = logout;
  $('#nf').onsubmit = guard(async (e) => { e.preventDefault(); await api('PATCH', `/api/public/${code}/me`, fd(e.target)); toast('저장되었습니다.'); render(); });
  bindBookingForm();
  bindReservationActions();
}

function bookingForm() {
  const maxDate = addDays(ymd(), info.booking.maxDays);
  return html`<div class="card"><h2>새 예약</h2>
    <label>시술 선택 (복수 선택 가능)</label>
    ${info.services.length ? info.services.map((s) => html`<label class="svcopt"><input type="checkbox" data-svc="${s.id}" ${picked.serviceIds.has(s.id) ? raw('checked') : ''}>
        <span style="flex:1">${s.category ? `[${s.category}] ` : ''}${s.name}</span><span class="muted">${won(s.price)} · ${s.duration_min}분</span></label>`) : html`<p class="muted">예약 가능한 시술이 없습니다.</p>`}
    <div class="row" style="margin-top:10px"><label>담당자 (필수)<select id="staffSel" required><option value="" disabled ${picked.staffId ? '' : raw('selected')}>담당자를 선택하세요</option>${info.staff.map((s) => html`<option value="${s.id}" ${String(s.id) === picked.staffId ? raw('selected') : ''}>${s.name}</option>`)}</select></label>
      <label>날짜<input type="date" id="dateSel" value="${picked.date}" min="${ymd()}" max="${maxDate}"></label></div>
    <p><button type="button" class="sec" id="findSlots">가능한 시간 보기</button></p>
    <div id="slots"></div>
    <p><button type="button" class="primary" id="submitResv" disabled style="width:100%">예약하기</button></p></div>`;
}

function bindBookingForm() {
  const el = root();
  // 매 렌더마다 새로 대입해 이전 렌더의 델리게이트 핸들러를 교체한다(addEventListener 누적 방지).
  el.onchange = (e) => {
    if (e.target.dataset.svc) { const id = +e.target.dataset.svc; e.target.checked ? picked.serviceIds.add(id) : picked.serviceIds.delete(id); }
    if (e.target.id === 'staffSel') picked.staffId = e.target.value;
    if (e.target.id === 'dateSel') picked.date = e.target.value;
  };
  $('#findSlots').onclick = guard(async () => {
    if (!picked.serviceIds.size) throw new Error('시술을 1개 이상 선택해 주세요.');
    if (!picked.staffId) throw new Error('담당자를 선택해 주세요.');
    const q = new URLSearchParams({ date: picked.date, serviceIds: [...picked.serviceIds].join(','), staffId: picked.staffId });
    const r = await get(`/api/public/${code}/availability?${q}`);
    $('#slots').innerHTML = r.slots.length
      ? html`<div class="slotwrap">${r.slots.map((t) => html`<span class="slot ${t === picked.time ? 'on' : ''}" data-t="${t}">${t}</span>`)}</div>`.s
      : '<p class="muted">선택한 날짜에 가능한 시간이 없습니다. 다른 날짜를 선택해 주세요.</p>';
    $('#slots').onclick = (e) => {
      const t = e.target.dataset.t; if (!t) return;
      picked.time = t;
      [...$('#slots').children[0].children].forEach((s) => s.classList.toggle('on', s.dataset.t === t));
      $('#submitResv').disabled = false;
    };
  });
  $('#submitResv').onclick = guard(async () => {
    if (!picked.time || !picked.staffId) return;
    const body = { startAt: `${picked.date}T${picked.time}`, serviceIds: [...picked.serviceIds], staffId: +picked.staffId };
    const r = await post(`/api/public/${code}/reservations`, body);
    toast(r.status === 'confirmed' ? '예약이 확정되었습니다!' : '예약을 접수했습니다. 매장에서 확인 후 확정됩니다.');
    picked = { serviceIds: new Set(), staffId: '', date: ymd(), time: '' };
    render();
  });
}

function renderReservations(rows) {
  // 이 함수의 반환값은 renderApp()의 바깥쪽 html`` 템플릿에 다시 끼워 넣으므로,
  // 여기서 .s 로 문자열을 꺼내면 바깥 템플릿이 그 문자열을 다시 이스케이프해 태그가 그대로 화면에 찍힌다.
  // Raw 인스턴스(html``의 결과, 또는 raw())를 그대로 반환해야 한다.
  if (!rows.length) return raw('<p class="muted">예약 내역이 없습니다.</p>');
  const cancellable = (r) => ['pending', 'confirmed', 'waiting'].includes(r.status);
  return html`<table>${rows.map((r) => html`<tr><td>${r.start_at.replace('T', ' ')}</td><td>${r.items}<div class="muted">${r.staff_name}</div></td>
    <td><span class="badge ${r.status}">${STATUS[r.status] ?? r.status}</span></td>
    <td>${cancellable(r) ? html`<button class="danger sm" data-cancel="${r.id}">취소</button>` : ''}</td></tr>`)}</table>`;
}

function bindReservationActions() {
  root().onclick = guard(async (e) => {
    const id = e.target.dataset.cancel;
    if (id && confirm('예약을 취소할까요?')) { await post(`/api/public/${code}/reservations/${id}/cancel`, {}); toast('예약이 취소되었습니다.'); render(); }
  });
}

render();
