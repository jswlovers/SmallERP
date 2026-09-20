// 셀프 접수 키오스크: 매장 계정으로 로그인된 브라우저(같은 사이트)에서 사용. 회원 검색/신규 등록/간편 접수 → 대기 번호표.
import { $, fd, fmtPhone, get, guard, html, post, state, toast, won } from './core.js';

const root = $('#k');
let phone = '', mode = 'home', picked = null, staffId = '', svcIds = new Set(), services = [], staff = [];
const reset = () => { phone = ''; picked = null; staffId = ''; svcIds = new Set(); };
const go = (m) => { mode = m; draw(); };

async function ticket(name, memo) {
  const r = await post('/api/standby', { customerId: picked?.id, name: picked ? undefined : name || '고객', staffId: staffId ? +staffId : undefined, memo });
  root.innerHTML = html`<h1>접수되었습니다</h1><div class="num">#${r.number}</div><p style="font-size:22px">${picked?.name ?? name ?? '고객'}님, 번호표를 확인해 주세요.<br>순서가 되면 안내해 드리겠습니다.</p><button class="kbtn" id="ok">처음으로</button>`.s;
  $('#ok').onclick = () => { reset(); go('home'); };
  setTimeout(() => { if (mode === 'done') { reset(); go('home'); } }, 15000); mode = 'done';
}

function pad(onDone, label = '확인') {
  root.innerHTML += html`<div id="disp">${fmtPhone(phone) || '휴대폰 번호'}</div><div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '←', 0, 'C'].map((k) => html`<button data-k="${k}">${k}</button>`)}</div><button class="kbtn" id="go">${label}</button><button class="kbtn sec" id="back">처음으로</button>`.s;
  root.onclick = (e) => {
    const k = e.target.dataset.k;
    if (k !== undefined) { phone = k === 'C' ? '' : k === '←' ? phone.slice(0, -1) : (phone + k).slice(0, 11); $('#disp').textContent = fmtPhone(phone) || '휴대폰 번호'; }
  };
  $('#go').onclick = guard(onDone);
  $('#back').onclick = () => { reset(); go('home'); };
}

async function draw() {
  if (!state.token) { root.innerHTML = '<h1>로그인이 필요합니다</h1><p><a href="/">매장 화면에서 로그인</a> 후 이 화면을 다시 여세요.</p>'; return; }
  root.onclick = null;
  if (mode === 'home') {
    const me = await get('/api/me');
    root.innerHTML = html`<h1>${me.shop.name}</h1><p style="font-size:20px">방문해 주셔서 감사합니다</p><button class="kbtn" id="m1">회원 검색 · 접수</button><button class="kbtn sec" id="m2">신규 회원 등록</button><button class="kbtn sec" id="m3">간편 접수 (회원 등록 없이)</button>`.s;
    $('#m1').onclick = () => go('search'); $('#m2').onclick = () => go('register'); $('#m3').onclick = () => go('quick');
  } else if (mode === 'search') {
    root.innerHTML = '<h1>회원 검색</h1>';
    pad(async () => {
      if (phone.length < 8) throw new Error('휴대폰 번호를 입력해 주세요.');
      const found = await get(`/api/customers?q=${phone}`);
      if (!found.length) throw new Error('등록된 회원이 없습니다. 신규 회원 등록을 이용해 주세요.');
      picked = found[0]; go('menu');
    }, '검색');
  } else if (mode === 'menu') {
    [services, staff] = await Promise.all([get('/api/services'), get('/api/staff')]);
    root.innerHTML = html`<h1>${picked.name}님, 어떤 시술을 받으시나요?</h1>
      <div>${staff.filter((s) => s.active).map((s) => html`<span class="opt ${String(s.id) === String(staffId) ? 'on' : ''}" data-s="${s.id}">${s.name}</span>`)}</div>
      <div>${services.filter((s) => s.active).map((s) => html`<span class="opt ${svcIds.has(s.id) ? 'on' : ''}" data-v="${s.id}">${s.name}<br><small>${won(s.price)}</small></span>`)}</div>
      <button class="kbtn" id="ok">접수하기</button><button class="kbtn sec" id="bk">처음으로</button>`.s;
    root.onclick = (e) => {
      if (e.target.closest('[data-s]')) { staffId = e.target.closest('[data-s]').dataset.s; draw(); }
      const v = e.target.closest('[data-v]'); if (v) { const id = +v.dataset.v; svcIds.has(id) ? svcIds.delete(id) : svcIds.add(id); draw(); }
    };
    $('#ok').onclick = guard(async () => ticket(null, [...svcIds].map((id) => services.find((s) => s.id === id)?.name).join(', ') ? `키오스크: ${[...svcIds].map((id) => services.find((s) => s.id === id)?.name).join(', ')}` : '키오스크 접수'));
    $('#bk').onclick = () => { reset(); go('home'); };
  } else if (mode === 'register') {
    root.innerHTML = html`<h1>신규 회원 등록</h1><form id="rf" style="text-align:left"><label>이름<input name="name" required style="font-size:22px"></label>
      <label>휴대폰<input name="phone" required inputmode="numeric" style="font-size:22px" value="${phone}"></label>
      <label>성별<select name="gender" style="font-size:22px"><option value="F">여</option><option value="M">남</option></select></label>
      <label class="chk" style="font-size:18px"><input type="checkbox" name="agree" required> 개인정보 수집·이용에 동의합니다 (필수)</label>
      <label class="chk" style="font-size:18px"><input type="checkbox" name="mk"> 이벤트·소식 문자 수신에 동의합니다 (선택)</label>
      <button class="kbtn">등록하고 접수</button></form><button class="kbtn sec" id="bk">처음으로</button>`.s;
    $('#bk').onclick = () => { reset(); go('home'); };
    $('#rf').onsubmit = guard(async (e) => {
      e.preventDefault(); const b = fd(e.target);
      const r = await post('/api/customers', { name: b.name, phone: b.phone, gender: b.gender, marketingConsent: !!e.target.mk.checked });
      picked = { id: r.id, name: b.name }; go('menu');
    });
  } else if (mode === 'quick') {
    root.innerHTML = html`<h1>간편 접수</h1><form id="qf"><label>이름 (선택)<input name="name" style="font-size:22px" placeholder="성함"></label><button class="kbtn">접수하기</button></form><button class="kbtn sec" id="bk">처음으로</button>`.s;
    $('#bk').onclick = () => { reset(); go('home'); };
    $('#qf').onsubmit = guard(async (e) => { e.preventDefault(); picked = null; await ticket(fd(e.target).name, '키오스크 간편 접수'); });
  }
}
draw();
