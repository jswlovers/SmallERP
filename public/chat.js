// AI 예약 도우미(Claude API) 채팅 위젯. 로그인은 대화 중 봇이 직접 처리한다(휴대폰 인증).
// 세션은 이 브라우저 탭에만 남고(sessionStorage), 서버도 메모리에만 30분 보관한다.
import { $ } from './core.js';

const code = new URLSearchParams(location.search).get('s');
const SKEY = `chat_session_${code}`;
let sessionId = sessionStorage.getItem(SKEY) || null;
let sending = false;

$('#toForm').href = `book.html?s=${encodeURIComponent(code ?? '')}`;

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text; // textContent만 사용 — 사용자/모델 텍스트를 그대로 넣어도 HTML로 해석되지 않는다.
  $('#log').appendChild(div);
  $('#log').scrollTop = $('#log').scrollHeight;
  return div;
}

function disable(on) {
  $('#input').disabled = on;
  $('#f').querySelector('button').disabled = on;
}

async function send(text) {
  if (sending) return;
  sending = true;
  disable(true);
  addMsg('user', text);
  const typing = addMsg('bot typing', '…');
  try {
    const res = await fetch(`/api/public/${code}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, message: text }) });
    const data = await res.json().catch(() => ({}));
    typing.remove();
    if (!res.ok) { addMsg('bot', data.error || '오류가 발생했어요. 잠시 후 다시 시도해 주세요.'); return; }
    sessionId = data.sessionId;
    sessionStorage.setItem(SKEY, sessionId);
    addMsg('bot', data.reply);
  } catch {
    typing.remove();
    addMsg('bot', '연결에 문제가 있어요. 잠시 후 다시 시도해 주세요.');
  } finally {
    sending = false;
    disable(false);
    $('#input').focus();
  }
}

$('#f').onsubmit = (e) => {
  e.preventDefault();
  const v = $('#input').value.trim();
  if (!v) return;
  $('#input').value = '';
  send(v);
};

(async () => {
  if (!code) { addMsg('bot', '예약 링크가 올바르지 않습니다. 매장에서 안내받은 링크로 다시 접속해 주세요.'); disable(true); return; }
  try {
    const res = await fetch(`/api/public/${code}/info`);
    const info = await res.json();
    if (!res.ok) { addMsg('bot', info.error || '매장 정보를 불러오지 못했어요.'); disable(true); return; }
    $('#title').textContent = `${info.shopName} · AI 예약 도우미`;
    addMsg('bot', `안녕하세요! ${info.shopName} 예약을 도와드릴게요. 원하시는 시술과 날짜를 말씀해 주세요.`);
  } catch {
    addMsg('bot', '매장 정보를 불러오지 못했어요. 링크를 다시 확인해 주세요.');
    disable(true);
  }
})();
