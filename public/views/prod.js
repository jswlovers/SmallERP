import { $, WEEKDAY, get, guard, html, isOwner, num, opt, page, post, put, raw, state, table, toast, won } from '../core.js';
import { crudCard } from './crud.js';

/** 카드 여러 개를 한 화면에 배치: cards = [cfg...] */
async function cards(el, redraw, list) {
  el.innerHTML = list.map((_, i) => `<div id="c${i}"></div>`).join('');
  await Promise.all(list.map((cfg, i) => (typeof cfg === 'function' ? cfg($(`#c${i}`, el), redraw) : crudCard($(`#c${i}`, el), redraw, cfg))));
}

const menus = async (el, redraw) => {
  await state.refreshCache();
  const cats = state.cache.categories;
  await cards(el, redraw, [
    { title: '1차 시술 대분류', path: '/api/categories', ownerOnly: true, note: '시술 메뉴를 묶는 분류입니다(예: 커트, 펌, 염색, 클리닉).',
      cols: [['분류명', (r) => html`<span class="pill" style="background:${r.color}22;color:${r.color}">${r.name}</span>`], ['색상', (r) => r.color]],
      fields: [{ k: 'name', label: '분류명', req: true }, { k: 'color', label: '색상', type: 'color', def: '#5b5bd6' }] },
    { title: '2차 시술 상세 메뉴', path: '/api/services', ownerOnly: false, noDelete: true,
      note: '분류를 선택하고 기본 단가·소요시간을 등록합니다. 예약 시간 계산에 소요시간이 쓰입니다.',
      cols: [['분류', (r) => r.category || '-'], ['시술명', (r) => r.name], ['단가', (r) => won(r.price)], ['소요', (r) => `${r.duration_min}분`]],
      fields: [{ k: 'categoryId', label: '분류', type: 'select', num: true, options: html`<option value="">-</option>${opt(cats.filter((c) => c.active))}` }, { k: 'name', label: '시술명', req: true },
        { k: 'price', label: '기본 단가', type: 'number', req: true }, { k: 'durationMin', label: '소요(분)', type: 'number', def: 60 }] },
  ]);
};

const passes = async (el, redraw) => {
  await state.refreshCache();
  const svcs = state.cache.services.filter((s) => s.active);
  await cards(el, redraw, [
    { title: '회원권(횟수권) 상품', path: '/api/pass-products', ownerOnly: true, note: '판매 시 횟수가 채워지고, 결제할 때 시술 1건당 1회 차감됩니다. 시술을 지정하면 그 시술에만 쓸 수 있습니다.',
      cols: [['상품', (r) => r.name], ['판매가', (r) => won(r.price)], ['횟수', (r) => `${r.total_count}회`], ['유효기간', (r) => (r.valid_days ? `${r.valid_days}일` : '무제한')], ['대상 시술', (r) => svcs.find((s) => s.id === r.service_id)?.name ?? '전체']],
      fields: [{ k: 'name', label: '상품명', req: true }, { k: 'price', label: '판매가', type: 'number', req: true }, { k: 'totalCount', label: '횟수', type: 'number', req: true },
        { k: 'validDays', label: '유효(일, 0=무제한)', type: 'number', def: 0 }, { k: 'serviceId', label: '대상 시술', type: 'select', num: true, options: html`<option value="">전체</option>${opt(svcs)}` }] },
    { title: '정액권(예치금) 상품', path: '/api/stored-products', ownerOnly: true, note: '결제금액보다 큰 사용가능금액을 설정하면 보너스가 됩니다(예: 50만원 결제 → 55만원 사용).',
      cols: [['상품', (r) => r.name], ['결제금액', (r) => won(r.pay_amount)], ['사용가능금액', (r) => won(r.credit_amount)], ['보너스', (r) => won(r.credit_amount - r.pay_amount)], ['유효기간', (r) => (r.valid_days ? `${r.valid_days}일` : '무제한')]],
      fields: [{ k: 'name', label: '상품명', req: true }, { k: 'payAmount', label: '결제금액', type: 'number', req: true }, { k: 'creditAmount', label: '사용가능금액', type: 'number', req: true }, { k: 'validDays', label: '유효(일)', type: 'number', def: 0 }] },
  ]);
};

const rateCard = async (el, redraw) => {
  const s = await get('/api/settings');
  const r = s.point_rates;
  el.innerHTML = html`<div class="card"><h2>포인트 적립률 (결제수단별 %)</h2><p class="muted">서비스 결제금액 × 적립률이 자동 적립됩니다. 정액권·포인트·외상 결제분은 적립하지 않습니다.</p>
    <form id="rf" class="row">${[['cash', '현금'], ['card', '카드'], ['naverpay', '네이버페이'], ['etc', '기타']].map(([k, n]) => html`<label>${n} %<input type="number" step="0.1" min="0" name="${k}" value="${r[k] ?? 0}"></label>`)}
    ${isOwner() ? html`<div class="fit"><button class="primary">저장</button></div>` : ''}</form></div>`.s;
  $('#rf', el).onsubmit = guard(async (e) => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target));
    await put('/api/settings/point_rates', { value: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Number(v)])) });
    toast('저장되었습니다.');
  });
};

const points = async (el, redraw) => cards(el, redraw, [
  rateCard,
  { title: '고객 등급 자동 승급 규칙', path: '/api/grades', ownerOnly: true, noActive: true, note: '방문 횟수와 누적 결제액을 모두 만족하면 결제 시 자동 승급합니다(강등 없음). 순위가 높을수록 상위 등급입니다.',
    cols: [['등급명', (r) => r.name], ['순위', (r) => r.rank], ['방문 ≥', (r) => `${r.min_visits}회`], ['누적 결제 ≥', (r) => won(r.min_spent)]],
    fields: [{ k: 'name', label: '등급명', req: true }, { k: 'rank', label: '순위', type: 'number', req: true }, { k: 'minVisits', label: '최소 방문', type: 'number', def: 0 }, { k: 'minSpent', label: '최소 누적 결제', type: 'number', def: 0 }] },
  { title: '할인율(금액) 프리셋', path: '/api/discounts', ownerOnly: true, note: '결제 화면에서 선택해 적용합니다.',
    cols: [['이름', (r) => r.name], ['종류', (r) => (r.kind === 'percent' ? '정률(%)' : '정액(원)')], ['값', (r) => (r.kind === 'percent' ? `${r.value}%` : won(r.value))]],
    fields: [{ k: 'name', label: '이름', req: true }, { k: 'kind', label: '종류', type: 'select', options: raw('<option value="percent">정률(%)</option><option value="amount">정액(원)</option>') }, { k: 'value', label: '값', type: 'number', req: true }] },
]);

const goods = async (el, redraw) => {
  const sups = await get('/api/suppliers');
  const moves = await get('/api/goods-moves');
  await cards(el, redraw, [
    { title: '1차 매입처', path: '/api/suppliers', ownerOnly: true, cols: [['매입처', (r) => r.name], ['연락처', (r) => r.contact], ['메모', (r) => r.memo]],
      fields: [{ k: 'name', label: '매입처명', req: true }, { k: 'contact', label: '연락처' }, { k: 'memo', label: '메모' }] },
    { title: '2차 제품 등록 · 재고', path: '/api/goods', ownerOnly: true, note: '결제 화면에서 제품을 판매하면 재고가 차감됩니다. 재고가 최소재고 이하면 빨간색으로 표시됩니다.',
      cols: [['제품', (r) => r.name], ['매입처', (r) => sups.find((s) => s.id === r.supplier_id)?.name ?? ''], ['매입가', (r) => won(r.cost)], ['판매가', (r) => won(r.price)],
        ['재고', (r) => html`<span class="${r.stock <= r.min_stock ? 'flag' : ''}">${num(r.stock)}</span> / 최소 ${r.min_stock}`]],
      extraActions: (r) => html`<button class="sec sm" data-stock="${r.id}">입고/조정</button> `,
      fields: [{ k: 'supplierId', label: '매입처', type: 'select', num: true, options: html`<option value="">-</option>${opt(sups.filter((s) => s.active))}` }, { k: 'name', label: '제품명', req: true },
        { k: 'cost', label: '매입가', type: 'number', def: 0 }, { k: 'price', label: '판매가', type: 'number', def: 0 }, { k: 'stock', label: '초기 재고', type: 'number', def: 0 }, { k: 'minStock', label: '최소 재고', type: 'number', def: 0 }],
      onClick: guard(async (e, rd) => {
        const id = e.target.dataset.stock; if (!id) return;
        const v = prompt('재고 증감 수량 (입고 +10, 출고/차감 -2)', '10'); if (!v || !+v) return;
        await post(`/api/goods/${id}/stock`, { delta: +v, memo: prompt('메모(선택)') || '' }); toast('반영되었습니다.'); rd();
      }) },
    (box) => { box.innerHTML = html`<div class="card"><h2>입출고 이력</h2>${table([['일시', (m) => m.created_at], ['제품', (m) => m.goods_name], ['구분', (m) => ({ in: '입고', out: '출고', sale: '판매', adjust: '조정' }[m.kind] ?? m.kind)], ['수량', (m) => (m.delta > 0 ? `+${m.delta}` : m.delta)], ['메모', (m) => m.memo]], moves.slice(0, 50), '이력이 없습니다.')}</div>`.s; },
  ]);
};

export async function vProd(el) {
  page(el, 'prod', [['menu', '시술 메뉴', menus], ['pass', '회원권·정액권 상품', passes], ['pt', '포인트·등급·할인', points], ['goods', '제품·재고', goods]]);
}
