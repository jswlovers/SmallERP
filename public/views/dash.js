import { $, get, html, num, state, table, won } from '../core.js';
import { boardPanel } from './wait.js';

export async function vDash(el) {
  const [t, x, trend] = await Promise.all([get('/api/stats/today'), get('/api/insight/dashboard'), get('/api/insight/customer-trend')]);
  const r = t.reservations;
  const total = Object.values(r).reduce((a, b) => a + b, 0);
  const card = (label, val, cls = '') => html`<div class="stat"><span class="muted">${label}</span><b class="${cls}">${val}</b></div>`;
  el.innerHTML = html`<div class="two-col"><div>
    <div class="grid">${card('오늘 예약', `${total}건`)}${card('방문 완료', `${r.visited || 0}건`)}${card('오늘 매출', won(t.sales))}${card('결제 건수', `${t.count}건`)}</div>
    <div class="grid">${card('대기중', `${x.standbyWaiting}명`)}${card('미수금 합계', won(x.receivable), x.receivable ? 'flag' : '')}${card('재고 부족 제품', `${x.lowStock}개`, x.lowStock ? 'flag' : '')}${card('만료 임박 회원권(30일)', `${x.passesExpiring}건`)}</div>
    <div class="card"><h2>남은 예약 (${t.date})</h2>
      ${t.upcoming.length ? html`<table>${t.upcoming.map((u) => html`<tr><td>${u.start_at.slice(11)}</td><td>${u.customer_name}</td><td>${u.staff_name}</td></tr>`)}</table>` : html`<p class="muted">남은 예약이 없습니다.</p>`}
    </div>
    <div class="card"><h2>고객 동향 분석</h2><div class="grid">${card('시술 2년내 고객', `${num(trend.within2y)}명`)}${card('30일내 방문', `${num(trend.d30)}명`)}${card('31~60일 미방문', `${num(trend.d31_60)}명`)}
      ${card('61~90일', `${num(trend.d61_90)}명`)}${card('91~120일', `${num(trend.d91_120)}명`)}${card('121~180일', `${num(trend.d121_180)}명`)}${card('180일 초과(휴면)', `${num(trend.over180)}명`)}</div>
      <p class="muted">고객 > 고객 동향·휴면에서 미방문 고객에게 바로 문자를 보낼 수 있습니다.</p></div>
    ${x.birthdays.length ? html`<div class="card"><h2>🎂 오늘 생일</h2>${x.birthdays.map((b) => html`<span class="pill">${b.name}</span>`)}</div>` : ''}
    </div><div id="bp"></div></div>`.s;
  boardPanel($('#bp', el));
}
