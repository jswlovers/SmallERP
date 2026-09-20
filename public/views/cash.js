import { $, METHOD, addDays, del, fd, get, guard, html, isOwner, num, opt, page, post, raw, state, table, toast, won, ymd } from '../core.js';
import { crudCard } from './crud.js';

async function ledger(el, redraw) {
  const from = state.sub.cxF ?? `${ymd().slice(0, 7)}-01`, to = state.sub.cxT ?? ymd();
  const [r, cats] = await Promise.all([get(`/api/cash?from=${from}&to=${to}`), get('/api/cash-categories')]);
  el.innerHTML = html`<div class="card"><div class="row"><label>시작<input type="date" id="f1" value="${from}"></label><label>종료<input type="date" id="f2" value="${to}"></label></div></div>
    <div class="grid"><div class="stat"><span class="muted">입금</span><b>${won(r.totalIn)}</b></div><div class="stat"><span class="muted">출금</span><b>${won(r.totalOut)}</b></div><div class="stat"><span class="muted">순액</span><b class="${r.net < 0 ? 'flag' : ''}">${won(r.net)}</b></div></div>
    <div class="card"><h2>입출금 등록</h2><form id="cf" class="row">
      <label>구분<select name="kind"><option value="out">출금(지출)</option><option value="in">입금</option></select></label>
      <label>계정<select name="categoryId"><option value="">-</option>${opt(cats.filter((c) => c.active), '', (c) => `${c.kind === 'in' ? '입금' : '출금'} · ${c.name}`)}</select></label>
      <label>금액<input type="number" name="amount" min="1" required></label><label>일자<input type="date" name="date" value="${ymd()}"></label><label>메모<input name="memo"></label>
      <div class="fit"><button class="primary">등록</button></div></form></div>
    <div class="card"><h2>입출금 내역</h2>${table([['일자', (e) => e.date], ['구분', (e) => html`<span class="badge ${e.kind === 'in' ? 'visited' : 'cancelled'}">${e.kind === 'in' ? '입금' : '출금'}</span>`], ['계정', (e) => e.category ?? '-'], ['금액', (e) => won(e.amount)], ['메모', (e) => e.memo], ['', (e) => (isOwner() ? html`<button class="danger sm" data-d="${e.id}">삭제</button>` : '')]], r.entries, '내역이 없습니다.')}</div>`.s;
  for (const [id, k] of [['#f1', 'cxF'], ['#f2', 'cxT']]) $(id, el).onchange = (e) => { state.sub[k] = e.target.value; redraw(); };
  $('#cf', el).onsubmit = guard(async (e) => { e.preventDefault(); const b = fd(e.target); await post('/api/cash', { kind: b.kind, categoryId: b.categoryId ? +b.categoryId : undefined, amount: +b.amount, date: b.date, memo: b.memo }); toast('등록되었습니다.'); redraw(); });
  el.onclick = guard(async (e) => { const id = e.target.dataset.d; if (id && confirm('삭제할까요?')) { await del(`/api/cash/${id}`); redraw(); } });
}

const categories = (el, redraw) => crudCard(el, redraw, {
  title: '계정 항목 (1차 계정 · 2차 적요)', path: '/api/cash-categories', ownerOnly: true, note: '입금/출금 등록 시 선택하는 계정 항목입니다(예: 소모품비, 임대료, 재료비).',
  cols: [['구분', (r) => (r.kind === 'in' ? '입금' : '출금')], ['항목', (r) => r.name]],
  fields: [{ k: 'kind', label: '구분', type: 'select', options: raw('<option value="out">출금</option><option value="in">입금</option>') }, { k: 'name', label: '항목명', req: true }],
});

// ---------- 일마감 ----------
async function close(el, redraw) {
  const date = state.sub.clDate ?? ymd();
  const [{ summary: s, record }, list] = await Promise.all([get(`/api/close?date=${date}`), get(`/api/close/list?from=${addDays(date, -30)}&to=${date}`)]);
  el.innerHTML = html`<div class="card"><div class="row"><label>마감 일자<input type="date" id="cd" value="${date}"></label></div></div>
    <div class="grid"><div class="stat"><span class="muted">매출</span><b>${won(s.sales)}</b><span class="muted">${s.count}건</span></div>
      <div class="stat"><span class="muted">상품 판매 입금</span><b>${won(s.deposits)}</b></div><div class="stat"><span class="muted">환불</span><b>${won(s.refunds)}</b></div>
      <div class="stat"><span class="muted">현금 입금/출금</span><b>${won(s.cashIn)} / ${won(s.cashOut)}</b></div><div class="stat"><span class="muted">예상 시재(현금)</span><b>${won(s.expectedCash)}</b></div></div>
    <div class="card"><h2>결제수단별</h2>${table([['수단', (m) => METHOD[m.method] ?? m.method], ['금액', (m) => won(m.amount)]], s.byMethod, '결제가 없습니다.')}</div>
    ${isOwner() ? html`<div class="card"><h2>일마감 저장</h2>${record ? html`<p class="muted">이미 마감됨: ${record.closed_at} · 실사 ${record.cash_counted == null ? '-' : won(record.cash_counted)} (다시 저장하면 갱신됩니다)</p>` : ''}
      <form id="clf" class="row"><label>현금 실사액<input type="number" name="cashCounted" value="${record?.cash_counted ?? ''}" placeholder="세어본 현금"></label><label>메모<input name="note" value="${record?.note ?? ''}"></label>
      <div class="fit"><button class="primary">마감 저장</button></div></form><p class="muted">설정에 사장 휴대폰이 있고 "일마감 매출 발송" 자동 규칙이 있으면 마감 시 문자로 발송됩니다.</p></div>` : ''}
    <div class="card"><h2>최근 마감 내역</h2>${table([['일자', (r) => r.date], ['매출', (r) => won(r.sales)], ['예상 시재', (r) => won(r.expectedCash)], ['실사', (r) => (r.cashCounted == null ? '-' : won(r.cashCounted))], ['차이', (r) => (r.diff == null ? '-' : html`<span class="${r.diff ? 'flag' : ''}">${num(r.diff)}원</span>`)]], list, '마감 내역이 없습니다.')}</div>`.s;
  $('#cd', el).onchange = (e) => { state.sub.clDate = e.target.value; redraw(); };
  $('#clf', el)?.addEventListener('submit', guard(async (e) => {
    e.preventDefault(); const b = fd(e.target);
    const r = await post('/api/close', { date, cashCounted: b.cashCounted === '' ? null : +b.cashCounted, note: b.note });
    toast(r.diff == null ? '마감되었습니다.' : `마감되었습니다. 시재 차이 ${num(r.diff)}원`); redraw();
  }));
}

export async function vCash(el) {
  page(el, 'cash', [['led', '입출금', ledger], ['cat', '계정 항목', categories], ['close', '일마감', close]]);
}
