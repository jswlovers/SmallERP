import { $, activeStaff, closeModal, fd, fmtPhone, get, guard, html, isOwner, modal, num, opt, page, patch, post, del, raw, state, table, toast, won, ymd } from '../core.js';
import { payForm } from './pay.js';
import { resvForm } from './resv.js';

let custQ = '', custGrade = '', custNoshow = false;

// ---------- 등록/수정 폼 ----------
export async function custForm(c = {}) {
  const [customers, grades] = await Promise.all([get('/api/customers'), get('/api/grades')]);
  const others = customers.filter((x) => x.id !== c.id);
  const gradeNames = [...new Set(['normal', ...grades.map((g) => g.name), c.grade].filter(Boolean))];
  const cfg = await get('/api/settings');
  modal(html`<h2>${c.id ? `고객 수정 ${c.no ? `(${c.no})` : ''}` : '고객 등록'}</h2><form id="f">
    <label>이름<input name="name" required value="${c.name}"></label>
    <div class="row"><label>연락처<input name="phone" value="${fmtPhone(c.phone)}" placeholder="010-0000-0000"></label>
    <label>성별<select name="gender"><option value="">-</option>${['F', 'M'].map((g) => html`<option value="${g}" ${(c.gender ?? cfg.defaults.gender) === g ? raw('selected') : ''}>${g === 'F' ? '여' : '남'}</option>`)}</select></label></div>
    <div class="row"><label>생일 (YYYY-MM-DD)<input name="birth" value="${c.birth}" placeholder="1990-05-01"></label><label>기념일 (MM-DD)<input name="anniversary" value="${c.anniversary}" placeholder="03-15"></label></div>
    <div class="row"><label>등급<select name="grade">${gradeNames.map((g) => html`<option ${g === (c.grade ?? 'normal') ? raw('selected') : ''}>${g}</option>`)}</select></label>
    <label>담당 디자이너<select name="staffId"><option value="">-</option>${opt(activeStaff(), c.staff_id)}</select></label></div>
    <div class="row"><label>소개자<select name="referrerId"><option value="">-</option>${opt(others, c.referrer_id, (x) => `${x.name} ${x.no ?? ''}`)}</select></label>
    <label>가족 대표<select name="familyHeadId"><option value="">-</option>${opt(others, c.family_head_id, (x) => `${x.name} ${x.no ?? ''}`)}</select></label></div>
    <label>태그 (쉼표 구분)<input name="tags" value="${c.tags}"></label>
    <label>메모<textarea name="memo">${c.memo}</textarea></label>
    <label class="chk"><input type="checkbox" name="marketingConsent" ${c.marketing_consent ? raw('checked') : ''}> 마케팅 문자 수신 동의</label>
    ${c.id ? html`<label class="chk"><input type="checkbox" name="noshowFlag" ${c.noshow_flag ? raw('checked') : ''}> 노쇼 주의 고객(예약 시 강조 표시)</label>` : ''}
    <button class="primary">저장</button> <button type="button" class="link" data-close>닫기</button></form>`,
  (m) => { $('#f', m).onsubmit = guard(async (e) => {
    e.preventDefault(); const b = fd(e.target);
    b.marketingConsent = e.target.marketingConsent.checked;
    if (c.id) b.noshowFlag = e.target.noshowFlag.checked;
    for (const k of ['staffId', 'referrerId', 'familyHeadId']) b[k] = b[k] ? +b[k] : null;
    c.id ? await patch(`/api/customers/${c.id}`, b) : await post('/api/customers', b);
    closeModal(); toast('저장되었습니다.'); state.rerender();
  }); });
}

// ---------- 상세 ----------
export const custDetail = guard(async (id) => {
  const [c, w] = await Promise.all([get(`/api/customers/${id}`), get(`/api/customers/${id}/wallet`)]);
  modal(html`<h2>${c.name} <span class="badge">${c.grade}</span> ${c.noshow_flag ? raw('<span class="flag">⚠ 노쇼 주의</span>') : ''}</h2>
    <p>${c.no ? `No.${c.no} · ` : ''}${fmtPhone(c.phone)} · 생일 ${c.birth || '-'} · 수신 ${c.marketing_consent ? '동의' : '미동의'}${c.referrer ? ` · 소개자 ${c.referrer.name}` : ''}${c.family.length ? ` · 가족 ${c.family.map((x) => x.name).join(', ')}` : ''}</p>
    <p class="muted">${c.tags ? `태그: ${c.tags} · ` : ''}${c.memo} ${c.noshowCount ? `· 노쇼 ${c.noshowCount}회` : ''} ${c.lastVisit ? `· 최근 방문 ${c.lastVisit}` : ''}</p>
    <div class="grid"><div class="stat">정액권<b>${won(w.prepaid)}</b>${w.prepaidExpiresAt ? html`<span class="muted">~${w.prepaidExpiresAt}</span>` : ''}</div>
      <div class="stat">포인트<b>${num(w.points)}P</b></div><div class="stat">외상<b>${won(w.credit)}</b></div></div>
    ${w.passes.length ? html`<h3>회원권</h3>${w.passes.map((p) => html`<span class="pill">${p.name} ${p.remaining}/${p.total_count}회${p.expires_at ? ` ~${p.expires_at}` : ''}</span>`)}` : ''}
    <div class="row" style="margin-top:8px"><div class="fit"><button class="primary" id="rs">예약</button> <button class="primary" id="py">결제</button> <button class="sec" id="ed">수정</button>
      ${isOwner() ? html`<button class="sec" id="pt">포인트 조정</button> <button class="danger" id="dl">삭제</button>` : ''}</div></div>
    <h3>방문·결제 이력</h3>
    ${table([['일자', (v) => v.paid_at.slice(0, 10)], ['내역', (v) => html`${v.items}<div class="muted">${v.staff}</div>`], ['금액', (v) => html`${won(v.total)} <span class="badge ${v.status}">${v.status === 'paid' ? '결제' : '환불'}</span>`]], c.visits, '이력이 없습니다.')}
    <button class="link" data-close>닫기</button>`,
  (m) => {
    $('#ed', m).onclick = () => custForm(c);
    $('#rs', m).onclick = () => resvForm(c.id);
    $('#py', m).onclick = () => payForm(null, c.id);
    $('#pt', m)?.addEventListener('click', guard(async () => { const v = prompt('포인트 증감(예: 500 또는 -500)', '0'); if (v && +v) { await post(`/api/customers/${id}/points`, { delta: +v }); toast('조정되었습니다.'); custDetail(id); } }));
    $('#dl', m)?.addEventListener('click', guard(async () => { if (confirm('고객을 삭제할까요? (삭제 고객 복구에서 되살릴 수 있습니다)')) { await del(`/api/customers/${id}`); closeModal(); state.rerender(); } }));
  });
});

// ---------- 목록 ----------
async function list(el, redraw) {
  const rows = await get(`/api/customers?q=${encodeURIComponent(custQ)}${custGrade ? `&grade=${encodeURIComponent(custGrade)}` : ''}${custNoshow ? '&flag=noshow' : ''}`);
  const grades = await get('/api/grades');
  el.innerHTML = html`
    <div class="card"><div class="row"><label>이름 / 고객번호 / 연락처<input id="cq" value="${custQ}" placeholder="이름, 000001, 010-0000-0000"></label>
      <label>등급<select id="cg"><option value="">전체</option>${['normal', ...grades.map((g) => g.name)].map((g) => html`<option ${g === custGrade ? raw('selected') : ''}>${g}</option>`)}</select></label>
      <label class="chk"><input type="checkbox" id="cn" ${custNoshow ? raw('checked') : ''}> 노쇼 주의만</label>
      <div class="fit"><button class="sec" id="cs">검색</button> <button class="primary" id="ca">고객 등록</button>
      ${isOwner() ? html` <button class="sec" id="cx">CSV 내보내기</button> <button class="sec" id="ci">CSV 가져오기</button><input type="file" id="cf" accept=".csv,text/csv" class="hidden">` : ''}</div></div></div>
    <div class="card tablewrap"><table><tr><th>번호</th><th>이름</th><th>연락처</th><th>등급</th><th>최근 방문</th><th>수신동의</th></tr>
    ${rows.map((c) => html`<tr style="cursor:pointer" data-id="${c.id}"><td>${c.no ?? ''}</td><td>${c.name}${c.noshow_flag ? raw(' <span class="flag">⚠</span>') : ''}</td><td>${fmtPhone(c.phone)}</td><td>${c.grade}</td><td>${c.lastVisit || '-'}</td><td>${c.marketing_consent ? '동의' : '-'}</td></tr>`)}
    ${rows.length ? '' : html`<tr><td colspan="6" class="muted">고객이 없습니다.</td></tr>`}</table></div>`.s;
  const search = () => { custQ = $('#cq', el).value; custGrade = $('#cg', el).value; custNoshow = $('#cn', el).checked; redraw(); };
  $('#cs', el).onclick = search; $('#cq', el).onkeydown = (e) => e.key === 'Enter' && search();
  $('#cg', el).onchange = search; $('#cn', el).onchange = search;
  $('#ca', el).onclick = () => custForm();
  $('#cx', el)?.addEventListener('click', guard(async () => {
    const res = await fetch('/api/customers/export.csv', { headers: { authorization: `Bearer ${state.token}` } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '내보내기 실패');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: 'customers.csv' });
    a.click(); URL.revokeObjectURL(a.href);
  }));
  $('#ci', el)?.addEventListener('click', () => $('#cf', el).click());
  $('#cf', el)?.addEventListener('change', guard(async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const r = await post('/api/customers/import', { csv: await file.text() });
    const NL = String.fromCharCode(10);
    alert([`가져오기 완료: 생성 ${r.created}건 / 중복 건너뜀 ${r.skipped}건 / 오류 ${r.errors.length}건`, r.errors.map((x) => `${x.line}행: ${x.error}`).join(NL), '※ 수신동의 열이 없거나 N이면 마케팅 미동의로 저장됩니다.'].filter(Boolean).join(NL + NL));
    e.target.value = ''; redraw();
  }));
  el.onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) custDetail(tr.dataset.id); };
}

// ---------- 삭제 고객 복구 ----------
async function deleted(el, redraw) {
  const rows = await get('/api/customers/deleted');
  el.innerHTML = html`<div class="card"><h2>삭제된 고객</h2>${table([['번호', (c) => c.no ?? ''], ['이름', (c) => c.name], ['삭제일', (c) => c.deleted_at.replace('T', ' ')], ['', (c) => (isOwner() ? html`<button class="primary sm" data-r="${c.id}">복구</button>` : '')]], rows, '삭제된 고객이 없습니다.')}</div>`.s;
  el.onclick = guard(async (e) => { const id = e.target.dataset.r; if (id) { await post(`/api/customers/${id}/restore`); toast('복구되었습니다.'); redraw(); } });
}

// ---------- 중복 병합 · 임시 고객 ----------
async function duplicates(el, redraw) {
  const [dups, guests] = await Promise.all([get('/api/customers/duplicates'), get('/api/insight/guests')]);
  el.innerHTML = html`<div class="card"><h2>동명 고객 (중복 후보)</h2>
    ${dups.length ? dups.map((g) => html`<h3>${g.name}</h3>${table([['번호', (c) => c.no ?? ''], ['연락처', (c) => fmtPhone(c.phone)], ['생일', (c) => c.birth ?? ''], ['최근 방문', (c) => c.lastVisit ?? '-'], ['병합', (c) => (isOwner() ? html`<button class="sec sm" data-keep="${c.id}" data-group="${g.customers.map((x) => x.id).join(',')}">이 고객으로 병합</button>` : '')]], g.customers)}`) : html`<p class="muted">중복 후보가 없습니다.</p>`}</div>
    <div class="card"><h2>전화번호 없는 임시 고객 ("손님")</h2>${table([['번호', (c) => c.no ?? ''], ['이름', (c) => c.name], ['결제', (c) => `${c.payments}건`]], guests, '없습니다.')}
    <p class="muted">위 "동명 고객"에서 병합하거나, 고객 상세에서 정보를 수정해 실제 고객으로 바꿀 수 있습니다.</p></div>`.s;
  el.onclick = guard(async (e) => {
    const keep = e.target.dataset.keep; if (!keep) return;
    const others = e.target.dataset.group.split(',').filter((x) => x !== keep);
    if (!confirm(`선택한 고객으로 ${others.length}명의 이력을 합치고 나머지는 삭제합니다. 진행할까요?`)) return;
    for (const s of others) await post('/api/customers/merge', { targetId: +keep, sourceId: +s });
    toast('병합되었습니다.'); redraw();
  });
}

// ---------- 가족 ----------
async function families(el) {
  const fams = await get('/api/families');
  el.innerHTML = html`<div class="card"><h2>가족 고객 현황</h2>${fams.length ? fams.map((f) => html`<p><b>${f.head.name}</b> ${f.head.no ?? ''} → ${f.members.map((m) => html`<span class="pill">${m.name}</span>`)}</p>`) : html`<p class="muted">가족으로 묶인 고객이 없습니다. 고객 수정에서 "가족 대표"를 지정하세요.</p>`}</div>`.s;
}

// ---------- 고객 동향·휴면 ----------
async function trend(el, redraw) {
  const days = Number(state.sub.dormDays ?? 90);
  const [t, dormant, tpls] = await Promise.all([get('/api/insight/customer-trend'), get(`/api/insight/dormant?days=${days}`), get('/api/templates')]);
  const card = (label, n) => html`<div class="stat"><span class="muted">${label}</span><b>${num(n)}명</b></div>`;
  el.innerHTML = html`
    <div class="grid">${card('시술 2년내 고객', t.within2y)}${card('30일내 방문', t.d30)}${card('31~60일 미방문', t.d31_60)}${card('61~90일', t.d61_90)}${card('91~120일', t.d91_120)}${card('121~180일', t.d121_180)}${card('180일 초과(휴면)', t.over180)}${card('방문 이력 없음', t.never)}</div>
    <div class="card"><h2>미방문 고객 목록</h2>
      <div class="row"><label>미방문 ${days}일 이상<select id="dd">${[30, 60, 90, 120, 180, 365].map((d) => html`<option ${d === days ? raw('selected') : ''}>${d}</option>`)}</select></label>
      <label>템플릿<select id="dt">${opt(tpls, '', (t2) => `${t2.name}${t2.is_ad ? ' (광고)' : ''}`)}</select></label><div class="fit"><button class="primary" id="ds">선택 고객에게 문자 발송</button></div></div>
      ${table([['', (c) => html`<input type="checkbox" data-d="${c.id}" ${c.marketing_consent ? raw('checked') : ''}>`], ['고객', (c) => `${c.name} ${c.no ?? ''}`], ['연락처', (c) => fmtPhone(c.phone)], ['최근 방문', (c) => c.last_visit], ['경과', (c) => `${c.daysSince}일`], ['방문/누적', (c) => `${c.visits}회 / ${won(c.spent)}`], ['수신', (c) => (c.marketing_consent ? '동의' : '-')]], dormant, '해당 고객이 없습니다.')}</div>`.s;
  $('#dd', el).onchange = (e) => { state.sub.dormDays = e.target.value; redraw(); };
  $('#ds', el).onclick = guard(async () => {
    const ids = [...el.querySelectorAll('[data-d]:checked')].map((c) => +c.dataset.d);
    if (!ids.length) throw new Error('발송할 고객을 선택하세요.');
    const r = await post('/api/messages/send', { templateId: +$('#dt', el).value, customerIds: ids });
    toast(`발송 ${r.sent}, 실패 ${r.failed}, 건너뜀 ${r.skipped}`); await state.refreshMe?.();
  });
}

export async function vCust(el) {
  page(el, 'cust', [['list', '고객 목록', list], ['trend', '고객 동향·휴면', trend], ['dup', '중복·임시 고객', duplicates], ['fam', '가족 고객', families], ['del', '삭제 고객 복구', deleted]]);
}
