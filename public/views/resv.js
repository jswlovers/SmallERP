import { $, STATUS, WEEKDAY, activeServices, activeStaff, addDays, bars, closeModal, del, fd, fields, get, guard, html, isOwner, modal, opt, page, patch, post, put, raw, state, table, toast, won, ymd } from '../core.js';
import { payForm } from './pay.js';

let resvDate = ymd(), resvStaff = '';

// ---------- 예약 등록 ----------
export async function resvForm(prefillCustomer, preset = {}) {
  const customers = await get('/api/customers');
  const date = preset.date ?? resvDate;
  modal(html`<h2>예약 추가</h2><form id="f">
    <label>고객<select name="customerId" required>${opt(customers, prefillCustomer, (c) => `${c.name} ${c.no ?? ''}`)}</select></label>
    <div class="row"><label>담당<select name="staffId">${opt(activeStaff(), preset.staffId)}</select></label>
    <label>일시<input type="datetime-local" name="startAt" required value="${date}T${preset.time ?? '10:00'}"></label></div>
    <label>시술</label>${activeServices().map((s) => html`<label class="chk"><input type="checkbox" name="svc" value="${s.id}">${s.name} · ${won(s.price)} · ${s.duration_min}분</label>`)}
    <label>상태<select name="status"><option value="confirmed">예약확정</option><option value="pending">확인필요(예약대기)</option><option value="waiting">대기중</option></select></label>
    <label>메모<input name="memo"></label>
    <div id="slots" class="muted"></div>
    <button class="primary">저장</button> <button type="button" class="sec" id="fs">빈 시간 보기</button> <button type="button" class="link" data-close>닫기</button></form>`,
  (m) => {
    const f = $('#f', m);
    $('#fs', m).onclick = guard(async () => {
      const ids = [...f.querySelectorAll('[name=svc]:checked')].map((c) => c.value).join(',');
      const d = f.startAt.value.slice(0, 10);
      const r = await get(`/api/availability?date=${d}&staffId=${f.staffId.value}${ids ? `&serviceIds=${ids}` : ''}`);
      const slots = r.staff[0]?.slots ?? [];
      $('#slots', m).innerHTML = slots.length ? html`가능한 시간: ${slots.map((s) => html`<span class="slot" data-t="${s}">${s}</span>`)}`.s : '가능한 시간이 없습니다.';
      $('#slots', m).onclick = (e) => { if (e.target.dataset.t) f.startAt.value = `${d}T${e.target.dataset.t}`; };
    });
    f.onsubmit = guard(async (e) => {
      e.preventDefault();
      const b = fd(f);
      await post('/api/reservations', { customerId: +b.customerId, staffId: +b.staffId, startAt: b.startAt, memo: b.memo, status: b.status, serviceIds: [...f.querySelectorAll('[name=svc]:checked')].map((c) => +c.value) });
      closeModal(); toast('예약이 등록되었습니다.'); state.rerender();
    });
  });
}

const statusButtons = (r) => ['pending', 'confirmed', 'waiting', 'in_service'].includes(r.status) ? html`
  <button class="primary sm" data-pay="${r.id}">결제</button>
  ${r.status === 'pending' ? html`<button class="sec sm" data-st="${r.id}:confirmed">확정</button>` : ''}
  ${r.status !== 'waiting' ? html`<button class="sec sm" data-st="${r.id}:waiting">대기</button>` : ''}
  ${r.status !== 'in_service' ? html`<button class="sec sm" data-st="${r.id}:in_service">시술중</button>` : ''}
  <button class="sec sm" data-st="${r.id}:noshow">노쇼</button>
  <button class="danger sm" data-st="${r.id}:cancelled">취소</button>` : '';

function bindStatus(el, listRef, redraw) {
  el.onclick = guard(async (e) => {
    const st = e.target.dataset.st, pay = e.target.dataset.pay;
    if (st) { const [id, s] = st.split(':'); if (['noshow', 'cancelled'].includes(s) && !confirm(`${STATUS[s]} 처리할까요?`)) return; await patch(`/api/reservations/${id}`, { status: s }); redraw(); }
    if (pay) payForm(listRef().find((r) => r.id == pay));
  });
}

// ---------- 일별 목록 ----------
async function dayList(el, redraw) {
  const q = `from=${resvDate}&to=${resvDate}${resvStaff ? `&staffId=${resvStaff}` : ''}`;
  const list = await get(`/api/reservations?${q}`);
  el.innerHTML = html`
    <div class="card"><div class="row">
      <label>날짜<input type="date" id="rd" value="${resvDate}"></label>
      <label>담당<select id="rs"><option value="">전체</option>${opt(activeStaff(), resvStaff)}</select></label>
      <div class="fit"><button class="sec" id="prev">◀</button> <button class="sec" id="next">▶</button> <button class="primary" id="addResv">예약 추가</button></div>
    </div></div>
    <div class="card tablewrap"><table>
      <tr><th>시간</th><th>고객</th><th>시술</th><th>담당</th><th>상태</th><th></th></tr>
      ${list.map((r) => html`<tr>
        <td>${r.start_at.slice(11)}~${r.end_at.slice(11)}</td>
        <td>${r.customer_name}${r.customer_noshow ? raw(' <span class="flag" title="노쇼 주의 고객">⚠</span>') : ''}${r.source === 'naver' ? raw(' <span class="badge">네이버</span>') : ''}</td>
        <td>${r.items}<div class="muted">${won(r.total)}</div></td><td>${r.staff_name}</td>
        <td><span class="badge ${r.status}">${STATUS[r.status]}</span>${r.memo ? html`<div class="muted">${r.memo}</div>` : ''}</td>
        <td>${statusButtons(r)}</td></tr>`)}
      ${list.length ? '' : html`<tr><td colspan="6" class="muted">예약이 없습니다.</td></tr>`}
    </table></div>`.s;
  $('#rd', el).onchange = (e) => { resvDate = e.target.value; redraw(); };
  $('#rs', el).onchange = (e) => { resvStaff = e.target.value; redraw(); };
  $('#prev', el).onclick = () => { resvDate = addDays(resvDate, -1); redraw(); };
  $('#next', el).onclick = () => { resvDate = addDays(resvDate, 1); redraw(); };
  $('#addResv', el).onclick = () => resvForm();
  bindStatus(el, () => list, redraw);
}

// ---------- 타임테이블 (일: 담당자별 열 / 주: 요일별 열) ----------
let ttMode = 'day';
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

async function timetable(el, redraw) {
  const cfg = (await get('/api/settings')).reservation;
  const open = toMin(cfg.openTime), close = toMin(cfg.closeTime), step = Number(cfg.unit) || 30;
  const staff = activeStaff();
  const focus = resvStaff || staff[0]?.id;
  let dates, cols;
  if (ttMode === 'day') { dates = [resvDate]; cols = staff.map((s) => ({ label: s.name, staffId: s.id, date: resvDate })); }
  else {
    const mon = addDays(resvDate, -((new Date(`${resvDate}T00:00:00`).getDay() + 6) % 7));
    dates = Array.from({ length: 7 }, (_, i) => addDays(mon, i));
    cols = dates.map((d) => ({ label: `${d.slice(5)}(${WEEKDAY[new Date(`${d}T00:00:00`).getDay()]})`, staffId: focus, date: d }));
  }
  const from = dates[0], to = dates[dates.length - 1];
  const [resv, blocks, breaks, offs, scheds] = await Promise.all([
    get(`/api/reservations?from=${from}&to=${to}`), get('/api/blocks'), get('/api/breaks'), get('/api/days-off'),
    Promise.all(staff.map(async (s) => [s.id, await get(`/api/staff/${s.id}/schedule`)])).then(Object.fromEntries.bind(Object)),
  ]);
  const blockedReason = (c, t) => {
    const wd = new Date(`${c.date}T00:00:00`).getDay();
    const off = offs.find((o) => o.date === c.date && (o.staff_id == null || o.staff_id === c.staffId));
    if (off) return `휴무${off.reason ? `:${off.reason}` : ''}`;
    const sch = (scheds[c.staffId] ?? []).find((x) => x.weekday === wd);
    if (sch?.off) return '휴무';
    const m = toMin(t);
    if (sch && (m < toMin(sch.start_time) || m >= toMin(sch.end_time))) return '근무외';
    const br = breaks.find((b) => b.staff_id === c.staffId && (b.weekday == null || b.weekday === wd) && m >= toMin(b.start_time) && m < toMin(b.end_time));
    if (br) return br.label;
    const bl = blocks.find((b) => (b.staff_id == null || b.staff_id === c.staffId) && `${c.date}T${t}` >= b.start_at && `${c.date}T${t}` < b.end_at);
    return bl ? `금지${bl.reason ? `:${bl.reason}` : ''}` : '';
  };
  const rows = [];
  for (let m = open; m < close; m += step) rows.push(hhmm(m));
  const covered = new Set();
  const cell = (c, t) => {
    const startsHere = resv.filter((r) => r.staff_id === c.staffId && r.start_at.slice(0, 10) === c.date && toMin(r.start_at.slice(11)) >= toMin(t) && toMin(r.start_at.slice(11)) < toMin(t) + step);
    const evs = startsHere.map((r) => { for (let x = toMin(t) + step; x < toMin(r.end_at.slice(11)); x += step) covered.add(`${c.staffId}|${c.date}|${hhmm(x)}`); return html`<span class="ev ${r.status} ${r.source === 'naver' ? 'naver' : ''}" data-ev="${r.id}">${r.start_at.slice(11)} ${r.customer_name} ${r.items ?? ''}</span>`; });
    const why = blockedReason(c, t);
    if (evs.length) return html`<td>${evs}</td>`;
    if (covered.has(`${c.staffId}|${c.date}|${t}`)) return html`<td style="background:#f3f4ff"></td>`;
    if (why) return html`<td class="blk">${why}</td>`;
    return html`<td data-new="${c.staffId}|${c.date}|${t}" style="cursor:pointer"></td>`;
  };
  el.innerHTML = html`
    <div class="card"><div class="row">
      <label>기준일<input type="date" id="rd" value="${resvDate}"></label>
      ${ttMode === 'week' ? html`<label>담당<select id="rs">${opt(staff, focus)}</select></label>` : ''}
      <div class="fit"><button class="${ttMode === 'day' ? 'primary' : 'sec'}" id="m-day">일</button> <button class="${ttMode === 'week' ? 'primary' : 'sec'}" id="m-week">주</button>
        <button class="sec" id="prev">◀</button> <button class="sec" id="next">▶</button> <button class="primary" id="addResv">예약 추가</button></div>
    </div><p class="muted">빈 칸을 누르면 그 시간으로 예약 등록, 예약을 누르면 상태 변경/결제. 사선 칸은 휴무·브레이크·예약금지, 옅은 보라는 진행 중인 예약입니다.</p></div>
    <div class="card tablewrap"><table class="tt"><tr><th style="width:52px"></th>${cols.map((c) => html`<th>${c.label}</th>`)}</tr>
      ${rows.map((t) => html`<tr><td class="hr">${t}</td>${cols.map((c) => cell(c, t))}</tr>`)}</table></div>`.s;
  $('#rd', el).onchange = (e) => { resvDate = e.target.value; redraw(); };
  $('#rs', el)?.addEventListener('change', (e) => { resvStaff = e.target.value; redraw(); });
  $('#m-day', el).onclick = () => { ttMode = 'day'; redraw(); };
  $('#m-week', el).onclick = () => { ttMode = 'week'; redraw(); };
  const stepDate = ttMode === 'week' ? 7 : 1;
  $('#prev', el).onclick = () => { resvDate = addDays(resvDate, -stepDate); redraw(); };
  $('#next', el).onclick = () => { resvDate = addDays(resvDate, stepDate); redraw(); };
  $('#addResv', el).onclick = () => resvForm();
  el.onclick = guard(async (e) => {
    const n = e.target.dataset.new, ev = e.target.dataset.ev;
    if (n) { const [sid, d, t] = n.split('|'); resvForm(undefined, { staffId: +sid, date: d, time: t }); }
    if (ev) {
      const r = resv.find((x) => x.id == ev);
      modal(html`<h2>${r.customer_name} <span class="badge ${r.status}">${STATUS[r.status]}</span></h2><p>${r.start_at.replace('T', ' ')}~${r.end_at.slice(11)} · ${r.staff_name}<br>${r.items}</p>
        <div>${statusButtons(r)}</div><p><button class="link" data-close>닫기</button></p>`, (m) => bindStatus(m, () => resv, () => { closeModal(); redraw(); }));
    }
  });
}

// ---------- 스케줄·휴무·브레이크·예약금지 설정 ----------
async function scheduleSettings(el, redraw) {
  const staff = activeStaff();
  const sid = +(state.sub.schedStaff ?? staff[0]?.id);
  const [sch, breaks, offs, blocks] = await Promise.all([get(`/api/staff/${sid}/schedule`), get('/api/breaks'), get('/api/days-off'), get('/api/blocks')]);
  const by = Object.fromEntries(sch.map((d) => [d.weekday, d]));
  const owner = isOwner();
  el.innerHTML = html`
    <div class="card"><h2>요일별 근무시간</h2><div class="row"><label>직원<select id="ss">${opt(staff, sid)}</select></label></div>
      <form id="sf"><table><tr><th>요일</th><th>휴무</th><th>시작</th><th>종료</th></tr>
      ${WEEKDAY.map((n, i) => html`<tr><td>${n}</td><td><input type="checkbox" name="off${i}" ${by[i]?.off ? raw('checked') : ''} ${owner ? '' : raw('disabled')}></td>
        <td><input type="time" name="s${i}" value="${by[i]?.start_time ?? '09:00'}"></td><td><input type="time" name="e${i}" value="${by[i]?.end_time ?? '21:00'}"></td></tr>`)}</table>
      ${owner ? html`<p><button class="primary">근무시간 저장</button></p>` : ''}<p class="muted">설정이 없는 요일은 매장 기본 영업시간(설정 > 솔루션 설정)을 따릅니다.</p></form></div>
    <div class="grid two">
      <div class="card"><h2>브레이크 타임</h2>${table([['직원', (b) => staff.find((s) => s.id === b.staff_id)?.name ?? b.staff_id], ['요일', (b) => (b.weekday == null ? '매일' : WEEKDAY[b.weekday])], ['시간', (b) => `${b.start_time}~${b.end_time}`], ['', (b) => (owner ? html`<button class="danger sm" data-db="${b.id}">삭제</button>` : '')]], breaks.filter((b) => b.staff_id === sid))}
        ${owner ? html`<form id="bf" class="row"><label>요일<select name="weekday"><option value="">매일</option>${WEEKDAY.map((n, i) => html`<option value="${i}">${n}</option>`)}</select></label><label>시작<input type="time" name="startTime" required value="12:00"></label><label>종료<input type="time" name="endTime" required value="13:00"></label><label>이름<input name="label" value="점심"></label><div class="fit"><button class="primary">추가</button></div></form>` : ''}</div>
      <div class="card"><h2>휴무일 / 당직</h2>${table([['날짜', (o) => o.date], ['대상', (o) => (o.staff_id ? staff.find((s) => s.id === o.staff_id)?.name : '매장 전체')], ['사유', (o) => o.reason], ['', (o) => (owner ? html`<button class="danger sm" data-do="${o.id}">삭제</button>` : '')]], offs.slice(0, 30))}
        ${owner ? html`<form id="of" class="row"><label>날짜<input type="date" name="date" required></label><label>대상<select name="staffId"><option value="">매장 전체</option>${opt(staff)}</select></label><label>사유<input name="reason"></label><div class="fit"><button class="primary">추가</button></div></form>` : ''}</div>
    </div>
    <div class="card"><h2>예약금지 시간대</h2>${table([['시작', (b) => b.start_at.replace('T', ' ')], ['종료', (b) => b.end_at.replace('T', ' ')], ['대상', (b) => (b.staff_id ? staff.find((s) => s.id === b.staff_id)?.name : '전체')], ['사유', (b) => b.reason], ['', (b) => html`<button class="danger sm" data-bl="${b.id}">삭제</button>`]], blocks.slice(0, 30))}
      <form id="blf" class="row"><label>시작<input type="datetime-local" name="startAt" required></label><label>종료<input type="datetime-local" name="endAt" required></label><label>대상<select name="staffId"><option value="">전체</option>${opt(staff)}</select></label><label>사유<input name="reason" placeholder="교육, 외출 등"></label><div class="fit"><button class="primary">추가</button></div></form></div>`.s;
  $('#ss', el).onchange = (e) => { state.sub.schedStaff = e.target.value; redraw(); };
  $('#sf', el).onsubmit = guard(async (e) => {
    e.preventDefault(); const b = fd(e.target);
    await put(`/api/staff/${sid}/schedule`, { days: WEEKDAY.map((_, i) => ({ weekday: i, off: !!b[`off${i}`], start: b[`s${i}`], end: b[`e${i}`] })) });
    toast('근무시간이 저장되었습니다.'); redraw();
  });
  const add = (id, url, map) => $(id, el)?.addEventListener('submit', guard(async (e) => { e.preventDefault(); await post(url, map(fd(e.target))); redraw(); }));
  add('#bf', '/api/breaks', (b) => ({ staffId: sid, weekday: b.weekday === '' ? undefined : +b.weekday, startTime: b.startTime, endTime: b.endTime, label: b.label }));
  add('#of', '/api/days-off', (b) => ({ date: b.date, staffId: b.staffId ? +b.staffId : undefined, reason: b.reason }));
  add('#blf', '/api/blocks', (b) => ({ startAt: b.startAt, endAt: b.endAt, staffId: b.staffId ? +b.staffId : undefined, reason: b.reason }));
  el.onclick = guard(async (e) => {
    const d = e.target.dataset;
    const url = d.db ? `/api/breaks/${d.db}` : d.do ? `/api/days-off/${d.do}` : d.bl ? `/api/blocks/${d.bl}` : null;
    if (url && confirm('삭제할까요?')) { await del(url); redraw(); }
  });
}

// ---------- 예약 동향 ----------
async function resvStats(el, redraw) {
  const from = state.sub.rsFrom ?? addDays(ymd(), -29), to = state.sub.rsTo ?? ymd();
  const r = await get(`/api/insight/reservations?from=${from}&to=${to}`);
  const label = { pending: '확인필요', confirmed: '예약확정', waiting: '대기중', in_service: '시술중', visited: '방문완료', noshow: '노쇼', cancelled: '취소' };
  const hours = r.byHour.map((n, h) => ({ h: `${h}시`, n })).filter((x) => x.n > 0);
  el.innerHTML = html`
    <div class="card"><div class="row"><label>시작<input type="date" id="f1" value="${from}"></label><label>종료<input type="date" id="f2" value="${to}"></label></div></div>
    <div class="grid"><div class="stat"><span class="muted">전체 예약</span><b>${r.total}건</b></div><div class="stat"><span class="muted">노쇼율</span><b>${r.noshowRate}%</b></div>
      <div class="stat"><span class="muted">네이버 예약</span><b>${r.bySource.naver ?? 0}건</b></div><div class="stat"><span class="muted">직접 예약</span><b>${r.bySource.internal ?? 0}건</b></div></div>
    <div class="grid two"><div class="card"><h2>상태별</h2>${bars(Object.entries(r.byStatus).map(([k, n]) => ({ k: label[k] ?? k, n })), 'k', 'n', (n) => `${n}건`)}</div>
      <div class="card"><h2>요일별</h2>${bars(r.byWeekday.map((n, i) => ({ k: WEEKDAY[i], n })), 'k', 'n', (n) => `${n}건`)}</div></div>
    <div class="card"><h2>시간대별</h2>${bars(hours, 'h', 'n', (n) => `${n}건`)}</div>`.s;
  for (const [id, k] of [['#f1', 'rsFrom'], ['#f2', 'rsTo']]) $(id, el).onchange = (e) => { state.sub[k] = e.target.value; redraw(); };
}

export async function vResv(el) {
  page(el, 'resv', [['day', '일별 목록', dayList], ['tt', '타임테이블(일/주)', timetable], ['sched', '근무·휴무·예약금지', scheduleSettings], ['stats', '예약 동향', resvStats]]);
}
