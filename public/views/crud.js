import { del, fd, get, guard, html, isOwner, patch, post, raw, table, toast } from '../core.js';

/**
 * 목록 + 추가 폼 카드. cfg:
 *  title, path, cols[[헤더, row=>셀]], fields[{k,label,type:'text'|'number'|'select'|'date',options,req,def,num}],
 *  ownerOnly(쓰기를 사장만), noDelete, noActive, note, extraActions(row)=>Raw, rowsFilter
 */
export async function crudCard(el, redraw, cfg) {
  let rows = await get(cfg.path);
  if (cfg.rowsFilter) rows = rows.filter(cfg.rowsFilter);
  const canWrite = !cfg.ownerOnly || isOwner();
  const actions = (r) => (canWrite ? html`${cfg.extraActions ? cfg.extraActions(r) : ''}${cfg.noActive ? '' : html`<button class="sec sm" data-t="${r.id}:${r.active ? 0 : 1}">${r.active ? '사용' : '중지'}</button> `}${cfg.noDelete ? '' : html`<button class="danger sm" data-x="${r.id}">삭제</button>`}` : '');
  const form = cfg.fields.map((f) => f.type === 'select'
    ? html`<label>${f.label}<select name="${f.k}">${f.options}</select></label>`
    : html`<label>${f.label}<input name="${f.k}" type="${f.type ?? 'text'}" value="${f.def ?? ''}" ${f.req ? raw('required') : ''} ${f.type === 'number' ? raw('step="any"') : ''}></label>`);
  el.innerHTML = html`<div class="card"><h2>${cfg.title}</h2>${cfg.note ? html`<p class="muted">${cfg.note}</p>` : ''}
    ${table([...cfg.cols, ['', actions]], rows, '등록된 항목이 없습니다.')}
    ${canWrite ? html`<form class="row" style="margin-top:10px">${form}<div class="fit"><button class="primary">추가</button></div></form>` : ''}</div>`.s;
  el.querySelector('form')?.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const b = fd(e.target); const body = {};
    for (const f of cfg.fields) {
      const v = b[f.k];
      if (v === '' || v === undefined) continue;
      body[f.k] = f.type === 'number' || f.num ? Number(v) : v;
    }
    await post(cfg.path, body); toast('추가되었습니다.'); redraw();
  }));
  el.onclick = guard(async (e) => {
    const d = e.target.dataset;
    if (d.t) { const [id, a] = d.t.split(':'); await patch(`${cfg.path}/${id}`, { active: a === '1' }); redraw(); }
    if (d.x && confirm('삭제할까요?')) { await del(`${cfg.path}/${d.x}`); redraw(); }
    cfg.onClick?.(e, redraw);
  });
}
