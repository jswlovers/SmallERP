// 공통 헬퍼: 이스케이프 템플릿, API 호출, 토스트/모달, 상태. 모든 동적 값은 html`` 태그가 자동 이스케이프한다.
export const $ = (s, el = document) => el.querySelector(s);
export class Raw { constructor(s) { this.s = s; } }
export const raw = (s) => new Raw(s);
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const one = (v) => (v instanceof Raw ? v.s : esc(v));
export const html = (strs, ...vals) => new Raw(strs.reduce((out, s, i) => out + s + (i < vals.length ? (Array.isArray(vals[i]) ? vals[i].map(one).join('') : one(vals[i])) : ''), ''));

export const won = (n) => `${Number(n || 0).toLocaleString('ko-KR')}원`;
export const num = (n) => Number(n || 0).toLocaleString('ko-KR');
const p2 = (n) => String(n).padStart(2, '0');
export const ymd = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export const addDays = (s, n) => { const d = new Date(`${s}T00:00:00`); d.setDate(d.getDate() + n); return ymd(d); };
export const monthOf = (d = new Date()) => ymd(d).slice(0, 7);
export const fmtPhone = (p) => (p || '').replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
export const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

export const STATUS = { pending: '확인필요', confirmed: '예약확정', waiting: '대기중', in_service: '시술중', visited: '방문완료', noshow: '노쇼', cancelled: '취소' };
export const METHOD = { cash: '현금', card: '카드', prepaid: '정액권', naverpay: '네이버페이', etc: '기타', point: '포인트', credit: '외상' };

// 전역 상태: 로그인 토큰, 내 정보, 자주 쓰는 목록 캐시, 서브탭 기억
export const state = { token: localStorage.getItem('token'), me: null, cache: { staff: [], services: [], categories: [] }, sub: {}, onLogout: () => {}, rerender: () => {} };

export async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) { state.onLogout(); throw new Error('세션이 만료되었습니다.'); }
  if (!res.ok) throw new Error(data.error || `오류 (${res.status})`);
  return data;
}
export const get = (u) => api('GET', u);
export const post = (u, b) => api('POST', u, b ?? {});
export const patch = (u, b) => api('PATCH', u, b ?? {});
export const put = (u, b) => api('PUT', u, b ?? {});
export const del = (u) => api('DELETE', u);

let toastTimer;
export function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2500); }
export const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

export function modal(content, onMount) { $('#modalBody').innerHTML = content.s; const m = $('#modal'); if (!m.open) m.showModal(); onMount?.($('#modalBody')); }
export const closeModal = () => $('#modal').close();
// CSP(script-src 'self') 때문에 인라인 onclick 을 쓰지 않고 data-close 로 위임 처리
$('#modal')?.addEventListener('click', (e) => { if (e.target.id === 'modal' || e.target.dataset.close !== undefined) closeModal(); });
export const fd = (form) => Object.fromEntries(new FormData(form));
export const opt = (list, sel, label = (o) => o.name) => list.map((o) => html`<option value="${o.id}" ${o.id == sel ? raw('selected') : ''}>${label(o)}</option>`);
export const activeStaff = () => state.cache.staff.filter((s) => s.active);
export const activeServices = () => state.cache.services.filter((s) => s.active);
export const isOwner = () => state.me?.staff.role === 'owner';

export async function refreshCache() {
  [state.cache.staff, state.cache.services, state.cache.categories] = await Promise.all([get('/api/staff'), get('/api/services'), get('/api/categories')]);
}

/**
 * 서브탭 화면: items = [[key, label, draw(body, redraw)]]. 선택 상태는 key(storeKey)별로 기억한다.
 */
export function page(el, storeKey, items) {
  const cur = items.find((i) => i[0] === state.sub[storeKey]) ?? items[0];
  el.innerHTML = html`<div class="subtabs">${items.map(([k, n]) => html`<button data-sub="${k}" class="${k === cur[0] ? 'on' : ''}">${n}</button>`)}</div><div class="subbody"></div>`.s;
  const body = $('.subbody', el);
  const redraw = () => page(el, storeKey, items);
  $('.subtabs', el).onclick = (e) => { const k = e.target.dataset.sub; if (k) { state.sub[storeKey] = k; redraw(); } };
  guard(() => cur[2](body, redraw))();
}

/** 간단 표. cols: [[헤더, (row)=>셀(Raw|string)]] */
export const table = (cols, rows, empty = '데이터가 없습니다.') => html`<div class="tablewrap"><table><tr>${cols.map(([h]) => html`<th>${h}</th>`)}</tr>
  ${rows.map((r) => html`<tr>${cols.map(([, f]) => html`<td>${f(r)}</td>`)}</tr>`)}
  ${rows.length ? '' : html`<tr><td colspan="${cols.length}" class="muted">${empty}</td></tr>`}</table></div>`;

/** 막대 목록 */
export const bars = (rows, key, val, fmt = won) => {
  const max = Math.max(1, ...rows.map((r) => r[val]));
  return html`<table>${rows.map((r) => html`<tr><td style="width:30%">${r[key]}</td><td><div class="bar" style="width:${Math.round((r[val] / max) * 100)}%"></div></td><td style="text-align:right;width:28%">${fmt(r[val])}</td></tr>`)}${rows.length ? '' : html`<tr><td class="muted">데이터 없음</td></tr>`}</table>`;
};

/** 폼 필드 목록으로 입력 폼 HTML 생성. fields: [{k, label, type, value, options, req, ph}] */
export const fields = (list) => list.map((f) => f.type === 'select'
  ? html`<label>${f.label}<select name="${f.k}">${f.options}</select></label>`
  : f.type === 'check'
    ? html`<label class="chk"><input type="checkbox" name="${f.k}" ${f.value ? raw('checked') : ''}>${f.label}</label>`
    : html`<label>${f.label}<input name="${f.k}" type="${f.type ?? 'text'}" value="${f.value ?? ''}" ${f.req ? raw('required') : ''} placeholder="${f.ph ?? ''}" ${f.step ? raw(`step="${f.step}"`) : ''}></label>`);
