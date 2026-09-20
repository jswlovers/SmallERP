import { $, WEEKDAY, METHOD, addDays, bars, fd, get, guard, html, isOwner, monthOf, num, opt, page, put, raw, state, table, toast, won, ymd, activeStaff } from '../core.js';

const range = (key, defFrom, defTo) => ({ from: state.sub[`${key}F`] ?? defFrom, to: state.sub[`${key}T`] ?? defTo });
const rangeBar = (from, to) => html`<div class="card"><div class="row"><label>시작<input type="date" id="f1" value="${from}"></label><label>종료<input type="date" id="f2" value="${to}"></label></div></div>`;
const bindRange = (el, key, redraw) => { for (const [id, k] of [['#f1', 'F'], ['#f2', 'T']]) $(id, el).onchange = (e) => { state.sub[key + k] = e.target.value; redraw(); }; };
const delta = (v) => (v == null ? '-' : html`<span class="${v >= 0 ? '' : 'flag'}">${v > 0 ? '+' : ''}${v}%</span>`);

// ---------- 매출 요약 ----------
async function sales(el, redraw) {
  const { from, to } = range('st', `${monthOf()}-01`, ymd());
  const s = await get(`/api/stats/summary?from=${from}&to=${to}`);
  el.innerHTML = html`${rangeBar(from, to)}
    <div class="grid">
      <div class="stat"><span class="muted">총 매출</span><b>${won(s.sales)}</b></div>
      <div class="stat"><span class="muted">결제 건수</span><b>${s.count}건</b></div>
      <div class="stat"><span class="muted">객단가</span><b>${won(s.average)}</b></div>
      <div class="stat"><span class="muted">신규 / 재방문</span><b>${s.customers.new} / ${s.customers.returning}</b></div>
      <div class="stat"><span class="muted">회원권·정액권 판매 입금</span><b>${won(s.deposits)}</b></div>
      <div class="stat"><span class="muted">정액권 수동 충전</span><b>${won(s.prepaidCharged)}</b></div>
    </div>
    <div class="card"><h2>일별 매출</h2>${bars(s.byDay, 'day', 'sales')}</div>
    <div class="card"><h2>직원별 매출 · 인센티브</h2>${table([['직원', (r) => r.name], ['건수', (r) => r.count], ['매출', (r) => won(r.sales)], ['인센티브', (r) => won(r.commission)]], s.byStaff)}</div>
    <div class="card"><h2>시술·제품별 매출</h2>${bars(s.byService, 'name', 'sales')}</div>
    <div class="card"><h2>결제수단별</h2>${bars(s.byMethod.map((m) => ({ ...m, label: METHOD[m.method] || m.method })), 'label', 'amount')}</div>`.s;
  bindRange(el, 'st', redraw);
}

// ---------- 기간 비교 ----------
async function compare(el, redraw) {
  const { from, to } = range('cp', addDays(ymd(), -29), ymd());
  const c = await get(`/api/insight/compare?from=${from}&to=${to}`);
  const row = (label, k, f = num) => html`<tr><td>${label}</td><td>${f(c.current[k])}</td><td>${f(c.previous[k])}</td><td>${delta(c.delta[k])}</td></tr>`;
  el.innerHTML = html`${rangeBar(from, to)}<div class="card"><h2>직전 동일 기간과 비교</h2>
    <p class="muted">현재 ${c.current.from} ~ ${c.current.to} · 이전 ${c.previous.from} ~ ${c.previous.to}</p>
    <table><tr><th>지표</th><th>현재</th><th>이전</th><th>증감</th></tr>${row('매출', 'sales', won)}${row('결제 건수', 'count')}${row('객단가', 'average', won)}${row('방문 고객 수', 'customers')}</table></div>`.s;
  bindRange(el, 'cp', redraw);
}

// ---------- 월별 성장률 ----------
async function growth(el, redraw) {
  const year = Number(state.sub.gYear ?? ymd().slice(0, 4));
  const g = await get(`/api/insight/growth?year=${year}`);
  el.innerHTML = html`<div class="card"><div class="row"><label>연도<input type="number" id="gy" value="${year}"></label></div></div>
    <div class="card"><h2>${year}년 월별 매출</h2>${bars(g.map((r) => ({ m: r.month, sales: r.sales })), 'm', 'sales')}</div>
    <div class="card"><h2>성장률</h2>${table([['월', (r) => r.month], ['매출', (r) => won(r.sales)], ['건수', (r) => r.count], ['전월 대비', (r) => delta(r.mom)], ['전년 동월', (r) => won(r.prevYearSales)], ['전년 대비', (r) => delta(r.yoy)]], g)}</div>`.s;
  $('#gy', el).onchange = (e) => { state.sub.gYear = e.target.value; redraw(); };
}

// ---------- 매출 캘린더 ----------
async function calendar(el, redraw) {
  const month = state.sub.cMonth ?? monthOf();
  const days = await get(`/api/insight/calendar?month=${month}`);
  const first = new Date(`${month}-01T00:00:00`).getDay();
  el.innerHTML = html`<div class="card"><div class="row"><label>월<input type="month" id="cm" value="${month}"></label></div></div>
    <div class="card"><div class="cal">${WEEKDAY.map((n) => html`<div class="h">${n}</div>`)}${Array.from({ length: first }, () => html`<div></div>`)}
    ${days.map((d) => html`<div class="d"><b>${d.date.slice(8)}</b>${d.sales ? html`<div>${won(d.sales)}<span class="muted"> (${d.count})</span></div>` : ''}${d.reservations ? html`<div class="muted">예약 ${d.reservations}</div>` : ''}${d.daysOff ? html`<div class="flag">휴무</div>` : ''}${d.events.map((t) => html`<div class="pill">${t}</div>`)}</div>`)}</div></div>`.s;
  $('#cm', el).onchange = (e) => { state.sub.cMonth = e.target.value; redraw(); };
}

// ---------- 목표 달성 · 급여 ----------
async function goals(el, redraw) {
  const month = state.sub.gmMonth ?? monthOf();
  const [g, pay] = await Promise.all([get(`/api/goals?month=${month}`), isOwner() ? get(`/api/insight/payroll?month=${month}`) : []]);
  el.innerHTML = html`<div class="card"><div class="row"><label>월<input type="month" id="gm" value="${month}"></label></div></div>
    <div class="card"><h2>목표 대비 달성률</h2>${table([['직원', (r) => r.name], ['목표', (r) => (isOwner() ? html`<input type="number" data-goal="${r.staffId}" value="${r.goal}" style="width:140px;margin:0">` : won(r.goal))], ['실적', (r) => won(r.actual)],
      ['달성률', (r) => (r.rate == null ? '-' : html`<div class="bar" style="width:${Math.min(100, r.rate)}%;display:inline-block;width:${Math.min(100, r.rate)}px"></div> ${r.rate}%`)]], g)}
      ${isOwner() ? html`<p><button class="primary" id="sg">목표 저장</button></p>` : ''}</div>
    ${isOwner() ? html`<div class="card"><h2>급여 계산 (기본급 + 매출 × 인센티브율)</h2>${table([['직원', (r) => r.name], ['기본급', (r) => won(r.basePay)], ['매출', (r) => won(r.sales)], ['인센티브율', (r) => `${r.rate}%`], ['인센티브', (r) => won(r.commission)], ['출근일', (r) => `${r.workDays}일`], ['지급액', (r) => html`<b>${won(r.total)}</b>`]], pay)}</div>` : ''}`.s;
  $('#gm', el).onchange = (e) => { state.sub.gmMonth = e.target.value; redraw(); };
  $('#sg', el)?.addEventListener('click', guard(async () => {
    for (const i of el.querySelectorAll('[data-goal]')) await put('/api/goals', { staffId: +i.dataset.goal, month, amount: +i.value || 0 });
    toast('저장되었습니다.'); redraw();
  }));
}

export async function vStats(el) {
  page(el, 'stats', [['sales', '매출 현황', sales], ['cmp', '기간 비교', compare], ['gr', '월별 성장률', growth], ['cal', '매출 캘린더', calendar], ['goal', '목표·급여', goals]]);
}
