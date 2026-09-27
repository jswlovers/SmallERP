import { $, METHOD, activeServices, activeStaff, addDays, closeModal, fd, get, guard, html, isOwner, modal, num, opt, page, post, raw, state, table, toast, won, ymd, table as tbl } from '../core.js';

const SALE_KIND = { service: '', pass_sale: '회원권 판매', stored_sale: '정액권 판매' };

// ---------- 결제 등록 ----------
export async function payForm(resv, presetCustomer) {
  const customers = resv ? [] : await get('/api/customers');
  const [goods, discounts] = await Promise.all([get('/api/goods'), get('/api/discounts')]);
  const staffSel = resv?.staff_id;
  modal(html`<h2>결제 ${resv ? html`- ${resv.customer_name}` : ''}</h2><form id="f">
    ${resv ? '' : html`<label>고객<select name="customerId" id="pc">${opt(customers, presetCustomer, (c) => `${c.name} ${c.no ?? ''}`)}</select></label>`}
    <label>담당<select name="staffId">${opt(activeStaff(), staffSel)}</select></label>
    <div id="wallet" class="muted"></div>
    <label>시술 (가격 수정 가능 · 회원권 사용 선택)</label>
    ${activeServices().map((s) => html`<div class="chk"><input type="checkbox" data-svc="${s.id}" ${resv && (resv.items || '').split(', ').includes(s.name) ? raw('checked') : ''}> <span style="flex:1">${s.name}</span>
      <select data-pass="${s.id}" style="width:130px;margin:0" class="hidden"><option value="">현금성 결제</option></select>
      <input type="number" data-price="${s.id}" value="${s.price}" style="width:110px;margin:0"></div>`)}
    ${goods.length ? html`<label>제품 판매</label>${goods.filter((g) => g.active).map((g) => html`<div class="chk"><input type="checkbox" data-gd="${g.id}"> <span style="flex:1">${g.name} (재고 ${g.stock})</span><input type="number" min="1" value="1" data-gq="${g.id}" style="width:60px;margin:0"><input type="number" data-gp="${g.id}" value="${g.price}" style="width:100px;margin:0"></div>`)}` : ''}
    <div class="row"><label>할인 프리셋<select name="discountPresetId" id="dp"><option value="">없음</option>${opt(discounts.filter((d) => d.active), '', (d) => `${d.name} (${d.kind === 'percent' ? `${d.value}%` : won(d.value)})`)}</select></label>
      <label>직접 할인(원)<input type="number" min="0" name="discount" id="dm" value="0"></label></div>
    <h3>결제 수단 <span class="muted" id="sum"></span></h3>
    ${Object.entries(METHOD).map(([k, n]) => html`<div class="chk"><span style="width:90px">${n}</span><input type="number" min="0" data-m="${k}" placeholder="0" style="margin:0"></div>`)}
    <div id="bal" class="muted"></div>
    <label>메모<input name="memo"></label>
    <button class="primary">결제 완료</button> <button type="button" class="link" data-close>닫기</button></form>`,
  (m) => {
    const f = $('#f', m);
    let wallet = null;
    const subtotal = () => {
      const s = [...f.querySelectorAll('[data-svc]:checked')].reduce((a, c) => a + (f.querySelector(`[data-pass="${c.dataset.svc}"]`).value ? 0 : Number(f.querySelector(`[data-price="${c.dataset.svc}"]`).value || 0)), 0);
      const g = [...f.querySelectorAll('[data-gd]:checked')].reduce((a, c) => a + Number(f.querySelector(`[data-gp="${c.dataset.gd}"]`).value || 0), 0);
      return s + g;
    };
    const discount = () => {
      const sub = subtotal(); const id = $('#dp', m).value;
      if (id) { const d = discounts.find((x) => x.id == id); return d.kind === 'percent' ? Math.floor((sub * d.value) / 100) : Math.min(d.value, sub); }
      return Math.min(Number($('#dm', m).value || 0), sub);
    };
    const total = () => subtotal() - discount();
    const paid = () => [...f.querySelectorAll('[data-m]')].reduce((a, i) => a + Number(i.value || 0), 0);
    const upd = () => { $('#sum', m).textContent = `합계 ${won(total())} / 입력 ${won(paid())}${discount() ? ` (할인 ${won(discount())})` : ''}`; };
    f.oninput = upd; f.onchange = upd; upd();
    const cid = () => (resv ? resv.customer_id : +f.customerId.value);
    const showWallet = guard(async () => {
      wallet = await get(`/api/customers/${cid()}/wallet`);
      $('#bal', m).textContent = `정액권 ${won(wallet.prepaid)} · 포인트 ${num(wallet.points)}P · 외상 ${won(wallet.credit)}`;
      for (const sel of f.querySelectorAll('[data-pass]')) {
        const svcId = +sel.dataset.pass;
        const ps = wallet.passes.filter((p) => !p.service_id || p.service_id === svcId);
        sel.innerHTML = `<option value="">현금성 결제</option>${ps.map((p) => `<option value="${p.id}">${p.name} (${p.remaining}회)</option>`).join('')}`;
        sel.classList.toggle('hidden', !ps.length);
      }
      upd();
    });
    showWallet(); $('#pc', m)?.addEventListener('change', showWallet);
    f.onsubmit = guard(async (e) => {
      e.preventDefault();
      const items = [
        ...[...f.querySelectorAll('[data-svc]:checked')].map((c) => {
          const pass = f.querySelector(`[data-pass="${c.dataset.svc}"]`).value;
          return { serviceId: +c.dataset.svc, price: +f.querySelector(`[data-price="${c.dataset.svc}"]`).value, ...(pass ? { usePassId: +pass } : {}) };
        }),
        ...[...f.querySelectorAll('[data-gd]:checked')].map((c) => ({ goodsId: +c.dataset.gd, qty: +f.querySelector(`[data-gq="${c.dataset.gd}"]`).value, price: +f.querySelector(`[data-gp="${c.dataset.gd}"]`).value })),
      ];
      const lines = [...f.querySelectorAll('[data-m]')].filter((i) => +i.value > 0).map((i) => ({ method: i.dataset.m, amount: +i.value }));
      const body = { customerId: cid(), staffId: +f.staffId.value, reservationId: resv?.id, items, lines, memo: f.memo.value };
      if ($('#dp', m).value) body.discountPresetId = +$('#dp', m).value; else if (+$('#dm', m).value) body.discount = +$('#dm', m).value;
      const r = await post('/api/payments', body);
      closeModal(); toast(`결제가 완료되었습니다.${r.earned ? ` (포인트 ${num(r.earned)}P 적립)` : ''}${r.gradeUp ? ` 🎉 등급 승급: ${r.gradeUp}` : ''}`);
      await state.refreshMe?.(); state.rerender();
    });
  });
}

// ---------- 결제 내역 ----------
let payFrom = ymd(), payTo = ymd();
async function history(el, redraw) {
  const list = await get(`/api/payments?from=${payFrom}&to=${payTo}`);
  const sum = list.filter((p) => p.status === 'paid' && p.kind === 'service').reduce((a, p) => a + p.total, 0);
  const dep = list.filter((p) => p.status === 'paid' && p.kind !== 'service').reduce((a, p) => a + p.total, 0);
  el.innerHTML = html`
    <div class="card"><div class="row">
      <label>시작<input type="date" id="pf" value="${payFrom}"></label><label>종료<input type="date" id="pt" value="${payTo}"></label>
      <div class="fit"><button class="primary" id="np">결제 등록</button></div></div>
      <p class="muted">기간 매출(환불 제외): <b>${won(sum)}</b> · 회원권/정액권 판매 입금: <b>${won(dep)}</b></p></div>
    <div class="card tablewrap"><table><tr><th>일시</th><th>고객</th><th>내역</th><th>수단</th><th>금액</th><th></th></tr>
    ${list.map((p) => html`<tr><td>${p.paid_at.replace('T', ' ')}</td><td>${p.customer_name}</td><td>${p.items}<div class="muted">${p.staff_name}${p.discount ? ` · 할인 ${won(p.discount)}` : ''}</div></td>
      <td>${(p.lines || '').split(' ').filter(Boolean).map((l) => { const [mm, a] = l.split(':'); return `${METHOD[mm] || mm} ${Number(a).toLocaleString()}`; }).join(', ')}</td>
      <td>${won(p.total)} <span class="badge ${p.status}">${p.status === 'paid' ? SALE_KIND[p.kind] || '결제' : '환불'}</span></td>
      <td>${p.status === 'paid' && isOwner() ? html`<button class="danger sm" data-rf="${p.id}">환불</button>` : ''}</td></tr>`)}
    ${list.length ? '' : html`<tr><td colspan="6" class="muted">내역이 없습니다.</td></tr>`}</table></div>`.s;
  $('#pf', el).onchange = (e) => { payFrom = e.target.value; redraw(); };
  $('#pt', el).onchange = (e) => { payTo = e.target.value; redraw(); };
  $('#np', el).onclick = () => payForm();
  el.onclick = guard(async (e) => { const id = e.target.dataset.rf; if (id && confirm('환불 처리할까요? (정액권·포인트·회원권 횟수·재고가 복원됩니다)')) { await post(`/api/payments/${id}/refund`); toast('환불되었습니다.'); redraw(); } });
}

// ---------- 회원권/정액권 판매 ----------
async function sell(el, redraw) {
  const [customers, passes, stored] = await Promise.all([get('/api/customers'), get('/api/pass-products'), get('/api/stored-products')]);
  const cs = (id) => html`<label>고객<select name="cid" ${id ? raw(`id="${id}"`) : ''}>${opt(customers, '', (c) => `${c.name} ${c.no ?? ''}`)}</select></label>`;
  const lineFields = html`<div class="row"><label>현금<input type="number" name="cash" min="0"></label><label>카드<input type="number" name="card" min="0"></label><label>네이버페이<input type="number" name="naverpay" min="0"></label><label>외상<input type="number" name="credit" min="0"></label></div>`;
  const lines = (b) => ['cash', 'card', 'naverpay', 'credit'].filter((k) => +b[k] > 0).map((k) => ({ method: k, amount: +b[k] }));
  el.innerHTML = html`<div class="grid two">
    <div class="card"><h2>회원권(횟수권) 판매</h2><form id="pf1">${cs()}
      <label>상품<select name="productId">${opt(passes.filter((p) => p.active), '', (p) => `${p.name} · ${won(p.price)} · ${p.total_count}회${p.valid_days ? ` · ${p.valid_days}일` : ''}`)}</select></label>${lineFields}
      <p class="muted">결제 완료 시 유효기간 안내문을 표시하고 고객 연락처로 안내 문자를 자동 발송합니다. 테스트 환경에서는 발송 내역만 기록됩니다.</p>
      <button class="primary">판매</button> <span class="muted">결제 합계는 상품 가격과 같아야 합니다.</span></form></div>
    <div class="card"><h2>정액권(예치금) 판매</h2><form id="pf2">${cs()}
      <label>상품<select name="productId">${opt(stored.filter((p) => p.active), '', (p) => `${p.name} · 결제 ${won(p.pay_amount)} → 사용 ${won(p.credit_amount)}${p.valid_days ? ` · ${p.valid_days}일` : ''}`)}</select></label>${lineFields}
      <p class="muted">결제 완료 시 고객 잔액에 적용된 유효기간을 안내하고 문자를 자동 발송합니다. 테스트 환경에서는 발송 내역만 기록됩니다.</p>
      <button class="primary">판매</button></form></div></div>`.s;
  const sub = (id, path) => $(id, el).addEventListener('submit', guard(async (e) => {
    e.preventDefault(); const b = fd(e.target);
    if (!b.productId) throw new Error('상품을 선택하세요.');
    const button = e.target.querySelector('button.primary');
    button.disabled = true;
    try {
      const result = await post(`/api/customers/${b.cid}/${path}`, { productId: +b.productId, lines: lines(b) });
      const n = result.notice;
      const status = n.status === 'sent' ? (n.simulated ? '테스트 문자 기록 완료 (실제 문자 미발송)' : '안내 문자 발송 완료') : `안내 문자 미발송: ${n.reason || '발송 실패'}`;
      await redraw();
      modal(html`<h2>판매 완료 · 유효기간 안내</h2><p style="white-space:pre-wrap">${n.body}</p><p role="status">${status}</p><p class="muted">결제가 완료되었습니다. 문자 미발송 시 결제를 다시 하지 말고 문자 메뉴에서 발송해 주세요.</p>`);
    } finally { button.disabled = false; }
  }));
  sub('#pf1', 'passes'); sub('#pf2', 'stored');
}

// ---------- 미수금(외상) ----------
async function receivables(el, redraw) {
  const list = await get('/api/receivables');
  el.innerHTML = html`<div class="card"><h2>외상 고객 목록</h2>${tbl([['고객', (r) => `${r.name} ${r.no ?? ''}`], ['미수금', (r) => won(r.balance)], ['', (r) => html`<button class="primary sm" data-c="${r.id}:${r.balance}">수금</button>`]], list, '미수금이 없습니다.')}</div>`.s;
  el.onclick = guard(async (e) => {
    const c = e.target.dataset.c; if (!c) return;
    const [id, bal] = c.split(':');
    const v = prompt(`수금액 (미수금 ${won(bal)})`, bal);
    if (v) { await post(`/api/customers/${id}/credit/pay`, { amount: +v }); toast('수금되었습니다.'); redraw(); }
  });
}

// ---------- 정액권·회원권 사용 현황 / 만료 임박 ----------
async function replacement(el, redraw) {
  const from = state.sub.rpFrom ?? addDays(ymd(), -29), to = state.sub.rpTo ?? ymd();
  const [r, exp] = await Promise.all([get(`/api/insight/replacement?from=${from}&to=${to}`), get('/api/expiring?days=30')]);
  el.innerHTML = html`<div class="card"><div class="row"><label>시작<input type="date" id="f1" value="${from}"></label><label>종료<input type="date" id="f2" value="${to}"></label></div></div>
    <div class="grid two"><div class="card"><h2>정액권 사용 <span class="muted">합계 ${won(r.prepaidTotal)}</span></h2>${tbl([['일시', (x) => x.paid_at.replace('T', ' ')], ['고객', (x) => x.customer], ['금액', (x) => won(x.amount)]], r.prepaid)}</div>
    <div class="card"><h2>회원권 사용 <span class="muted">${r.passUses}회</span></h2>${tbl([['일시', (x) => x.created_at], ['고객', (x) => x.customer], ['회원권', (x) => x.pass], ['횟수', (x) => x.used]], r.passes)}</div></div>
    <div class="grid two"><div class="card"><h2>만료 임박 회원권 (30일)</h2>${tbl([['고객', (x) => x.customer_name], ['회원권', (x) => x.name], ['잔여', (x) => `${x.remaining}회`], ['만료', (x) => x.expires_at]], exp.passes)}</div>
    <div class="card"><h2>만료 임박 정액권 (30일)</h2>${tbl([['고객', (x) => x.name], ['잔액', (x) => won(x.balance)], ['만료', (x) => x.expires_at]], exp.stored)}</div></div>`.s;
  for (const [id, k] of [['#f1', 'rpFrom'], ['#f2', 'rpTo']]) $(id, el).onchange = (e) => { state.sub[k] = e.target.value; redraw(); };
}

export async function vPay(el) {
  page(el, 'pay', [['hist', '결제 내역', history], ['sell', '회원권·정액권 판매', sell], ['recv', '미수금(외상)', receivables], ['repl', '사용 현황·만료 임박', replacement]]);
}
