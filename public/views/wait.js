import { $, activeStaff, fd, get, guard, html, opt, page, patch, post, state, toast, ymd } from '../core.js';

const LABEL = { waiting: '대기중', in_service: '시술중', done: '완료', cancelled: '취소' };

/** 우측 "매장 현황판" 패널: 예약중/대기중/시술중 (대시보드와 대기 화면에서 재사용) */
export async function boardPanel(el, date = ymd()) {
  const b = await get(`/api/board?date=${date}`);
  const tabs = [['all', '전체'], ['reserved', '예약중'], ['waiting', '대기중'], ['in_service', '시술중']];
  const cur = state.sub.board ?? 'all';
  const rows = b.rows.filter((r) => cur === 'all' || r.group === cur);
  el.innerHTML = html`<div class="card board"><h2>매장 현황판 <span class="muted">${b.date}</span></h2>
    <div class="subtabs">${tabs.map(([k, n]) => html`<button data-bt="${k}" class="${k === cur ? 'on' : ''}">${n}(${k === 'all' ? b.counts.all : b.counts[k]})</button>`)}</div>
    <div class="tablewrap"><table><tr><th>구분</th><th>고객</th><th>메뉴</th><th>담당</th><th>시간</th></tr>
    ${rows.map((r) => html`<tr><td>${r.type === 'standby' ? `대기#${r.number}` : '예약'}</td><td>${r.customer}</td><td>${r.menu}</td><td>${r.staff ?? ''}</td><td>${r.time}</td></tr>`)}
    ${rows.length ? '' : html`<tr><td colspan="5" class="muted">없습니다.</td></tr>`}</table></div>
    <p class="muted">${b.days.map((d) => html`<span class="pill">${d.date.slice(5)} ${d.count}건</span>`)}</p></div>`.s;
  el.onclick = (e) => { const k = e.target.dataset.bt; if (k) { state.sub.board = k; boardPanel(el, date); } };
}

async function standby(el, redraw) {
  const [list, customers] = await Promise.all([get('/api/standby'), get('/api/customers')]);
  el.innerHTML = html`<div class="two-col"><div>
    <div class="card"><h2>대기 접수 (간편 접수)</h2><form id="wf" class="row">
      <label>고객(선택)<select name="customerId"><option value="">회원 아님</option>${opt(customers, '', (c) => `${c.name} ${c.no ?? ''}`)}</select></label>
      <label>이름(비회원)<input name="name" placeholder="비회원이면 이름 입력"></label>
      <label>담당<select name="staffId"><option value="">지정 안 함</option>${opt(activeStaff())}</select></label>
      <label>메모<input name="memo"></label><div class="fit"><button class="primary">접수</button> <a class="link" href="/kiosk.html" target="_blank">키오스크 화면 열기</a></div></form></div>
    <div class="card"><h2>오늘 대기 현황</h2><div class="tablewrap"><table><tr><th>번호</th><th>고객</th><th>담당</th><th>상태</th><th></th></tr>
    ${list.map((w) => html`<tr><td>#${w.number}</td><td>${w.name}<div class="muted">${w.memo}</div></td><td>${w.staff_name ?? ''}</td><td><span class="badge ${w.status === 'done' ? 'visited' : w.status === 'cancelled' ? 'cancelled' : 'pending'}">${LABEL[w.status]}</span></td>
      <td>${['waiting', 'in_service'].includes(w.status) ? html`${w.status === 'waiting' ? html`<button class="sec sm" data-w="${w.id}:in_service">시술 시작</button>` : ''} <button class="primary sm" data-w="${w.id}:done">완료</button> <button class="danger sm" data-w="${w.id}:cancelled">취소</button>` : ''}</td></tr>`)}
    ${list.length ? '' : html`<tr><td colspan="5" class="muted">대기가 없습니다.</td></tr>`}</table></div></div></div><div id="bp"></div></div>`.s;
  $('#wf', el).onsubmit = guard(async (e) => {
    e.preventDefault(); const b = fd(e.target);
    await post('/api/standby', { customerId: b.customerId ? +b.customerId : undefined, name: b.name || undefined, staffId: b.staffId ? +b.staffId : undefined, memo: b.memo });
    toast('접수되었습니다.'); redraw();
  });
  el.onclick = guard(async (e) => { const w = e.target.dataset.w; if (w) { const [id, s] = w.split(':'); await patch(`/api/standby/${id}`, { status: s }); redraw(); } });
  boardPanel($('#bp', el));
}

export async function vWait(el) {
  page(el, 'wait', [['s', '대기 관리', standby]]);
}
