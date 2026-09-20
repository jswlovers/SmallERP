import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getInfo, shopByCode } from '../public-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOOK_TEMPLATE = readFileSync(join(__dirname, '..', '..', 'public', 'book.html'), 'utf8');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = (n) => `${Number(n || 0).toLocaleString('ko-KR')}원`;

/**
 * ChatGPT/Claude의 기본 웹 브라우징(자바스크립트를 실행하지 않고 HTML을 텍스트로 읽는 방식)이나
 * 검색엔진이 이 페이지를 읽어도 매장 정보를 답할 수 있도록, 시술·담당자·예약 정책을 서버에서
 * 미리 HTML로 그려 넣는다. 실제 예약(가입·시간조회·제출)은 여전히 book.js(클라이언트 JS)가 처리하며,
 * 정상적으로 뜨면 이 섹션은 자동으로 사라진다(#ssr 참고). 빈 시간 같은 실시간 값은 날짜별로 달라
 * 정적으로 렌더링하지 않는다 — 실제 조회는 페이지를 열거나 도구(tool)로 호출해야 한다.
 */
function renderSsr({ shopName, services, staff, booking }, error) {
  if (error) return `<section id="ssr"><h1>온라인 예약</h1><p>${esc(error)}</p></section>`;
  const svcList = services.map((s) => `<li>${esc(s.category ? `[${s.category}] ` : '')}${esc(s.name)} — ${won(s.price)} (${s.duration_min}분)</li>`).join('');
  const staffList = staff.map((s) => `<li>${esc(s.name)}</li>`).join('');
  return `<section id="ssr">
<h1>${esc(shopName)} 온라인 예약</h1>
<p>휴대폰 인증번호만으로 가입해 예약할 수 있는 페이지입니다(비밀번호 없음). 예약하려면 이 페이지를 웹 브라우저로 열어 진행해 주세요.</p>
<h2>이용 가능한 시술</h2><ul>${svcList || '<li>등록된 시술이 없습니다.</li>'}</ul>
<h2>담당 디자이너</h2><ul>${staffList || '<li>등록된 담당자가 없습니다.</li>'}</ul>
<h2>예약 안내</h2><ul>
<li>온라인 예약: ${booking.enabled ? '받고 있습니다' : '지금은 받지 않습니다(전화 문의)'}</li>
<li>예약은 최소 ${booking.minLeadMinutes}분 전, 최대 ${booking.maxDays}일 이내까지 가능합니다.</li>
<li>접수 후 상태: ${booking.autoConfirm ? '접수 즉시 확정' : '사장 확인 후 확정(확인필요)'}</li>
<li>실제 예약 가능 시간은 날짜마다 달라 이 페이지에 없습니다 — API로는 GET /api/public/&lt;code&gt;/availability?date=YYYY-MM-DD&amp;serviceIds=... 로 조회할 수 있습니다.</li>
</ul></section>`;
}

export default function (app, { db }) {
  app.get('/book.html', async (req, reply) => {
    const code = req.query?.s;
    let ssr, title, status = 200;
    if (!code) {
      ssr = renderSsr({}, '예약 링크가 올바르지 않습니다. 매장에서 안내받은 링크로 다시 접속해 주세요.');
      title = '온라인 예약';
      status = 400;
    } else {
      try {
        const info = getInfo(db, shopByCode(db, code));
        ssr = renderSsr(info);
        title = `${info.shopName} 온라인 예약`;
      } catch (e) {
        ssr = renderSsr({}, e.message || '매장 정보를 불러오지 못했습니다.');
        title = '온라인 예약';
        status = e.status || 404;
      }
    }
    const html = BOOK_TEMPLATE
      .replace('<title>온라인 예약</title>', `<title>${esc(title)}</title>`)
      .replace('<div id="root"></div>', `${ssr}\n<div id="root"></div>`);
    reply.code(status).type('text/html; charset=utf-8').send(html);
  });
}
