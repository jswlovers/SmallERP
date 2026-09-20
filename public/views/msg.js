import { $, addDays, fd, fmtPhone, get, guard, html, isOwner, num, opt, page, patch, post, raw, state, table, toast, won, ymd } from '../core.js';

async function send(el) {
  const [tpls, custs] = await Promise.all([get('/api/templates'), get('/api/customers')]);
  el.innerHTML = html`<div class="card"><h2>문자 발송</h2><form id="sf">
      <label>템플릿<select name="templateId"><option value="">직접 입력</option>${tpls.map((t) => html`<option value="${t.id}">${t.name}${t.is_ad ? ' (광고)' : ''}</option>`)}</select></label>
      <label>내용 ({{name}}, {{shop}} 사용 가능)<textarea name="body"></textarea></label>
      <label class="chk"><input type="checkbox" name="isAd"> 광고성 문자 (수신동의 고객만, 21~08시 발송 불가, 문구 자동 삽입)</label>
      <label>대상 고객</label><div style="max-height:200px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:6px">
        ${custs.map((c) => html`<label class="chk"><input type="checkbox" name="cid" value="${c.id}">${c.name} ${fmtPhone(c.phone)} ${c.marketing_consent ? '' : raw('<span class="muted">(미동의)</span>')}</label>`)}</div>
      <p><button class="primary">발송</button></p></form></div>`.s;
  $('#sf', el).onsubmit = guard(async (e) => {
    e.preventDefault(); const f = e.target; const b = fd(f);
    const r = await post('/api/messages/send', { templateId: b.templateId ? +b.templateId : undefined, body: b.body, isAd: f.isAd.checked, customerIds: [...f.querySelectorAll('[name=cid]:checked')].map((c) => +c.value) });
    toast(`발송 ${r.sent}, 실패 ${r.failed}, 건너뜀 ${r.skipped}`); await state.refreshMe?.(); state.rerender();
  });
}

async function auto(el, redraw) {
  const [rules, tpls, trig] = await Promise.all([get('/api/automation'), get('/api/templates'), get('/api/automation/triggers')]);
  const group = (kind) => Object.entries(trig).filter(([, v]) => v.kind === kind).map(([k, v]) => html`<option value="${k}">${v.label}${v.param ? ` (${v.param})` : ''}</option>`);
  el.innerHTML = html`<div class="card"><h2>자동 발송 규칙 (${Object.keys(trig).length}종 트리거)</h2>
    <p class="muted">이벤트형은 해당 업무가 일어나는 즉시, 주기형은 10분마다 점검해 발송합니다. 같은 대상에게 같은 건은 한 번만 발송됩니다.</p>
    ${table([['규칙', (r) => r.name], ['트리거', (r) => `${trig[r.trigger]?.label ?? r.trigger}${r.param ? ` (${num(r.param)})` : ''}`], ['템플릿', (r) => r.template_name], ['', (r) => html`<button class="sec sm" data-tg="${r.id}:${r.active ? 0 : 1}">${r.active ? '사용중' : '중지됨'}</button>`]], rules, '등록된 규칙이 없습니다.')}
    <form id="rf" class="row" style="margin-top:10px"><label>이름<input name="name" required></label>
      <label>트리거<select name="trigger"><optgroup label="이벤트 발생 시">${group('event')}</optgroup><optgroup label="주기 점검">${group('schedule')}</optgroup></select></label>
      <label>값(N일/N원)<input name="param" type="number" value="0"></label>
      <label>템플릿<select name="templateId">${opt(tpls)}</select></label>
      <div class="fit"><button class="primary">규칙 추가</button> <button type="button" class="sec" id="run">지금 실행</button></div></form>
    <p class="muted">템플릿 변수: {{name}} {{shop}} · 예약 {{date}} {{time}} · 회원권 {{pass}} {{remain}} · 정액권 {{balance}} {{used}} · 포인트 {{point}} · 소개 {{referrer}} {{referred}} · 직원 알림 {{customer}} · 일마감 {{sales}} {{count}}</p></div>`.s;
  $('#rf', el).onsubmit = guard(async (e) => { e.preventDefault(); const b = fd(e.target); await post('/api/automation', { name: b.name, trigger: b.trigger, param: +b.param, templateId: +b.templateId }); redraw(); });
  $('#run', el).onclick = guard(async () => { const r = await post('/api/automation/run'); toast(`자동 발송: ${r.sent}건 발송, ${r.skipped}건 제외`); await state.refreshMe?.(); redraw(); });
  el.onclick = guard(async (e) => { const t = e.target.dataset.tg; if (t) { const [id, a] = t.split(':'); await patch(`/api/automation/${id}`, { active: a === '1' }); redraw(); } });
}

async function templates(el, redraw) {
  const tpls = await get('/api/templates');
  el.innerHTML = html`<div class="card"><h2>템플릿</h2>${table([['이름', (t) => t.name], ['내용', (t) => t.body], ['광고', (t) => (t.is_ad ? '광고' : '')]], tpls)}
    <form id="tf" class="row" style="margin-top:10px"><label>이름<input name="name" required></label><label>내용<input name="body" required></label>
    <label class="chk"><input type="checkbox" name="isAd">광고</label><div class="fit"><button class="primary">추가</button></div></form></div>`.s;
  $('#tf', el).onsubmit = guard(async (e) => { e.preventDefault(); const b = fd(e.target); await post('/api/templates', { name: b.name, body: b.body, isAd: e.target.isAd.checked }); redraw(); });
}

async function logs(el, redraw) {
  const from = state.sub.mvFrom ?? addDays(ymd(), -29), to = state.sub.mvTo ?? ymd();
  const [rows, v] = await Promise.all([get('/api/messages/log'), get(`/api/insight/sms-visits?from=${from}&to=${to}`)]);
  el.innerHTML = html`<div class="card"><div class="row"><label>방문율 시작<input type="date" id="f1" value="${from}"></label><label>종료<input type="date" id="f2" value="${to}"></label></div>
    <div class="grid" style="margin-top:8px"><div class="stat"><span class="muted">발송 대상(고객·일)</span><b>${v.sent}</b></div><div class="stat"><span class="muted">7일 내 방문</span><b>${v.visited}</b></div><div class="stat"><span class="muted">문자 방문율</span><b>${v.rate}%</b></div></div></div>
    <div class="card tablewrap"><h2>발송 내역</h2><table><tr><th>시각</th><th>고객</th><th>내용</th><th>상태</th></tr>
    ${rows.map((l) => html`<tr><td>${l.sent_at}</td><td>${l.customer_name || '-'}</td><td>${l.body}</td><td><span class="badge ${l.status}">${l.status}</span>${l.reason ? html`<div class="muted">${l.reason}</div>` : ''}</td></tr>`)}</table></div>`.s;
  for (const [id, k] of [['#f1', 'mvFrom'], ['#f2', 'mvTo']]) $(id, el).onchange = (e) => { state.sub[k] = e.target.value; redraw(); };
}

async function birthdays(el) {
  const list = await get('/api/customers');
  const md = ymd().slice(5), mm = ymd().slice(5, 7);
  const today = list.filter((c) => c.birth && c.birth.slice(-5) === md);
  const month = list.filter((c) => c.birth && c.birth.slice(-5, -3) === mm).sort((a, b) => a.birth.slice(-2).localeCompare(b.birth.slice(-2)));
  el.innerHTML = html`<div class="grid two"><div class="card"><h2>오늘 생일 (${today.length}명)</h2>${table([['고객', (c) => c.name], ['생일', (c) => c.birth]], today, '없습니다.')}</div>
    <div class="card"><h2>이번 달 생일 (${month.length}명)</h2>${table([['고객', (c) => c.name], ['생일', (c) => c.birth]], month, '없습니다.')}</div></div>`.s;
}

async function charge(el) {
  const me = await get('/api/me');
  el.innerHTML = html`<div class="card"><h2>문자 잔액</h2><p>현재 잔액 <b>${num(me.shop.sms_balance)}P</b> (단문 20P, 장문 50P)</p>
    ${isOwner() ? html`<p class="muted">데모: 결제 없이 즉시 충전됩니다. 실제 서비스는 PG 결제 후 승인 처리로 교체하세요.</p><button class="sec" id="chg">1,000P 충전</button>` : ''}</div>`.s;
  $('#chg', el)?.addEventListener('click', guard(async () => { await post('/api/messages/charge', { amount: 1000 }); await state.refreshMe?.(); toast('충전되었습니다.'); state.rerender(); }));
}

export async function vMsg(el) {
  page(el, 'msg', [['send', '문자 발송', send], ['auto', '자동 발송 설정', auto], ['tpl', '템플릿', templates], ['bd', '생일 고객', birthdays], ['log', '발송 내역·방문율', logs], ['chg', '충전', charge]]);
}
