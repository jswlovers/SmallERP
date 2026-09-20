import { $, addDays, fd, get, guard, html, isOwner, page, patch, post, state, table, toast, ymd } from '../core.js';
import { crudCard } from './crud.js';

async function attendance(el, redraw) {
  const from = state.sub.atF ?? addDays(ymd(), -13), to = state.sub.atT ?? ymd();
  const rows = await get(`/api/attendance?from=${from}&to=${to}`);
  el.innerHTML = html`<div class="card"><div class="row"><div class="fit"><button class="primary" id="clock">내 출근/퇴근 기록</button></div>
    <label>시작<input type="date" id="f1" value="${from}"></label><label>종료<input type="date" id="f2" value="${to}"></label></div></div>
    <div class="card"><h2>출퇴근 현황</h2>${table([['일자', (a) => a.date], ['직원', (a) => a.staff_name], ['출근', (a) => a.clock_in ?? '-'], ['퇴근', (a) => a.clock_out ?? '-'], ['근무(시간)', (a) => a.hours ?? '-'],
      ['', (a) => (isOwner() ? html`<button class="sec sm" data-e="${a.id}:${a.clock_in ?? ''}:${a.clock_out ?? ''}">수정</button>` : '')]], rows, '기록이 없습니다.')}</div>`.s;
  for (const [id, k] of [['#f1', 'atF'], ['#f2', 'atT']]) $(id, el).onchange = (e) => { state.sub[k] = e.target.value; redraw(); };
  $('#clock', el).onclick = guard(async () => { const r = await post('/api/attendance/clock', {}); toast(`${r.action === 'clock_in' ? '출근' : '퇴근'} 처리 ${r.time}`); redraw(); });
  el.onclick = guard(async (e) => {
    const d = e.target.dataset.e; if (!d) return;
    const [id, cin, cout] = d.split(':');
    const nin = prompt('출근 시각(HH:MM)', cin); if (nin === null) return;
    const nout = prompt('퇴근 시각(HH:MM, 비우면 그대로)', cout);
    await patch(`/api/attendance/${id}`, { clockIn: nin || undefined, clockOut: nout || undefined }); redraw();
  });
}

const events = (el, redraw) => crudCard(el, redraw, {
  title: '매장 일정', path: '/api/events', noActive: true, note: '매출 캘린더와 대시보드에 표시됩니다(예: 직원 회식, 재고 입고, 교육).',
  cols: [['일자', (r) => r.date], ['일정', (r) => r.title], ['메모', (r) => r.memo]],
  fields: [{ k: 'date', label: '일자', type: 'date', req: true, def: ymd() }, { k: 'title', label: '일정', req: true }, { k: 'memo', label: '메모' }],
});

export async function vShop(el) {
  page(el, 'shop', [['att', '출퇴근', attendance], ['ev', '매장 일정', events]]);
}
