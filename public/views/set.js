import { $, fd, get, guard, html, isOwner, modal, closeModal, page, patch, post, put, raw, state, table, toast, won } from '../core.js';

// ---------- 솔루션 간편설정 ----------
async function solution(el, redraw) {
  const s = await get('/api/settings');
  const owner = isOwner();
  el.innerHTML = html`<form id="sf"><div class="card"><h2>고객 관련</h2><div class="row">
      <label class="chk"><input type="checkbox" name="noAuto" ${s.customer_no.auto ? raw('checked') : ''}> 고객번호 자동 부여</label>
      <label>접두어<input name="prefix" value="${s.customer_no.prefix}" maxlength="4"></label><label>자릿수<input type="number" name="digits" min="3" max="10" value="${s.customer_no.digits}"></label>
      <label>기본 성별<select name="gender"><option value="F" ${s.defaults.gender === 'F' ? raw('selected') : ''}>여</option><option value="M" ${s.defaults.gender === 'M' ? raw('selected') : ''}>남</option></select></label></div>
      <label class="chk"><input type="checkbox" name="standbyOnCreate" ${s.defaults.standbyOnCreate ? raw('checked') : ''}> 고객 등록 시 자동으로 대기자 등록</label></div>
    <div class="card"><h2>예약 관련</h2><div class="row"><label>예약 시간 단위(분)<select name="unit">${[15, 30, 60].map((n) => html`<option ${n === Number(s.reservation.unit) ? raw('selected') : ''}>${n}</option>`)}</select></label>
      <label>영업 시작<input type="time" name="openTime" value="${s.reservation.openTime}"></label><label>영업 종료<input type="time" name="closeTime" value="${s.reservation.closeTime}"></label></div>
      <p class="muted">직원별 근무시간·휴무는 예약 > 근무·휴무·예약금지에서 설정합니다. 설정이 없는 요일은 위 영업시간을 따릅니다.</p></div>
    <div class="card"><h2>기타</h2><label>사장 휴대폰 (일마감 매출 문자 수신)<input name="ownerPhone" value="${s.owner_phone ?? ''}" placeholder="010-0000-0000"></label>
      ${owner ? html`<p><button class="primary">설정 저장</button></p>` : html`<p class="muted">설정 변경은 사장만 가능합니다.</p>`}</div></form>
    <div class="card"><h2>온라인 예약(고객용)</h2>
      <p class="muted">고객이 휴대폰 번호 인증만으로 가입해 직접 예약할 수 있는 링크입니다. 인스타그램/네이버 프로필, 카카오톡 채널 등에 붙여넣어 공유하세요.</p>
      <div class="row"><label>예약 링크<input id="bookLink" readonly value="${location.origin}/book.html?s=${state.me.shop.public_code}"></label><div class="fit"><button type="button" class="sec" id="copyLink">링크 복사</button> <a class="link" href="/book.html?s=${state.me.shop.public_code}" target="_blank">미리보기</a></div></div>
      <form id="pbf" class="row" style="margin-top:8px">
        <label class="chk"><input type="checkbox" name="enabled" ${s.public_booking.enabled ? raw('checked') : ''}> 온라인 예약 받기</label>
        <label class="chk"><input type="checkbox" name="autoConfirm" ${s.public_booking.autoConfirm ? raw('checked') : ''}> 접수 즉시 자동 확정(끄면 "확인필요" 상태로 들어와 사장이 확정)</label>
        <label>최소 N분 전까지만 예약 가능<input type="number" name="minLeadMinutes" min="0" value="${s.public_booking.minLeadMinutes}"></label>
        <label>최대 며칠 뒤까지 예약 가능<input type="number" name="maxDays" min="1" value="${s.public_booking.maxDays}"></label>
        ${owner ? html`<div class="fit"><button class="primary">온라인 예약 설정 저장</button></div>` : ''}</form></div>`.s;
  $('#copyLink', el).onclick = guard(async () => { await navigator.clipboard.writeText($('#bookLink', el).value); toast('링크를 복사했습니다.'); });
  $('#sf', el).onsubmit = guard(async (e) => {
    e.preventDefault(); const f = e.target; const b = fd(f);
    await put('/api/settings/customer_no', { value: { auto: f.noAuto.checked, prefix: b.prefix, digits: +b.digits } });
    await put('/api/settings/defaults', { value: { ...s.defaults, gender: b.gender, standbyOnCreate: f.standbyOnCreate.checked } });
    await put('/api/settings/reservation', { value: { ...s.reservation, unit: +b.unit, openTime: b.openTime, closeTime: b.closeTime } });
    await put('/api/settings/owner_phone', { value: b.ownerPhone });
    toast('설정이 저장되었습니다.');
  });
  $('#pbf', el)?.addEventListener('submit', guard(async (e) => {
    e.preventDefault(); const f = e.target; const b = fd(f);
    await put('/api/settings/public_booking', { value: { enabled: f.enabled.checked, autoConfirm: f.autoConfirm.checked, minLeadMinutes: +b.minLeadMinutes, maxDays: +b.maxDays } });
    toast('온라인 예약 설정이 저장되었습니다.');
  }));
}

// ---------- 직원 ----------
function staffForm(s = {}) {
  modal(html`<h2>${s.id ? '직원 수정' : '직원 등록'}</h2><form id="f">
    <label>이름<input name="name" required value="${s.name}"></label>
    <div class="row"><label>휴대폰(예약 알림 문자)<input name="phone" value="${s.phone ?? ''}"></label><label>인센티브율(%)<input type="number" step="0.5" name="commissionRate" value="${s.commission_rate ?? 0}"></label></div>
    <label>기본급(월)<input type="number" name="basePay" value="${s.base_pay ?? 0}"></label>
    ${s.id ? '' : html`<div class="row"><label>로그인ID(선택)<input name="loginId"></label><label>비밀번호(8자+)<input type="password" name="password"></label></div>`}
    <button class="primary">저장</button> <button type="button" class="link" data-close>닫기</button></form>`,
  (m) => { $('#f', m).onsubmit = guard(async (e) => {
    e.preventDefault(); const b = fd(e.target);
    const body = { name: b.name, phone: b.phone, commissionRate: +b.commissionRate, basePay: +b.basePay };
    if (s.id) await patch(`/api/staff/${s.id}`, body); else await post('/api/staff', { ...body, loginId: b.loginId || undefined, password: b.password || undefined });
    closeModal(); toast('저장되었습니다.'); await state.refreshCache(); state.rerender();
  }); });
}

async function staff(el, redraw) {
  await state.refreshCache();
  const owner = isOwner();
  el.innerHTML = html`<div class="card"><h2>직원</h2>${owner ? html`<p><button class="primary" id="ns">직원 등록</button></p>` : ''}
    ${table([['이름', (s) => s.name], ['계정', (s) => s.login_id || '-'], ['휴대폰', (s) => s.phone || '-'], ['인센티브', (s) => `${s.commission_rate}%`], ['기본급', (s) => won(s.base_pay)],
      ['', (s) => (owner ? html`<button class="sec sm" data-e="${s.id}">수정</button> ${s.role !== 'owner' ? html`<button class="sec sm" data-a="${s.id}:${s.active ? 0 : 1}">${s.active ? '재직' : '퇴사'}</button>` : ''}` : '')]], state.cache.staff)}</div>`.s;
  $('#ns', el)?.addEventListener('click', () => staffForm());
  el.onclick = guard(async (e) => {
    const d = e.target.dataset;
    if (d.e) staffForm(state.cache.staff.find((s) => s.id == d.e));
    if (d.a) { const [id, a] = d.a.split(':'); await patch(`/api/staff/${id}`, { active: a === '1' }); redraw(); }
  });
}

// ---------- 내 계정 · 감사 로그 ----------
async function account(el) {
  const me = state.me;
  el.innerHTML = html`<div class="card"><h2>내 정보</h2><p>${me.staff.name} (${me.staff.role === 'owner' ? '사장' : '직원'}) · ${me.shop.name} · 플랜 ${me.shop.plan}</p></div>
    <div class="card"><h2>내 비밀번호 변경</h2><form id="pwf" class="row"><label>현재 비밀번호<input type="password" name="current" required autocomplete="current-password"></label>
      <label>새 비밀번호 (8자 이상)<input type="password" name="next" required minlength="8" autocomplete="new-password"></label><div class="fit"><button class="primary">변경</button></div></form></div>`.s;
  $('#pwf', el).onsubmit = guard(async (e) => { e.preventDefault(); await post('/api/me/password', fd(e.target)); e.target.reset(); toast('비밀번호가 변경되었습니다.'); });
}

async function audit(el) {
  const rows = await get('/api/audit');
  el.innerHTML = html`<div class="card"><h2>감사 로그 (최근 200건)</h2>${table([['시각(UTC)', (r) => r.created_at], ['작업자', (r) => r.staff_name ?? '관리자'], ['작업', (r) => r.action], ['내용', (r) => r.detail], ['IP', (r) => r.ip]], rows, '기록이 없습니다.')}</div>`.s;
}

export async function vSet(el) {
  const items = [['sol', '솔루션 간편설정', solution], ['staff', '직원 관리', staff], ['acc', '내 계정', account]];
  if (isOwner()) items.push(['aud', '감사 로그', audit]);
  page(el, 'set', items);
}
