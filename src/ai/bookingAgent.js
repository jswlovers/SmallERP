import { HttpError } from '../util.js';
import * as svc from '../public-service.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const MAX_TOKENS = 1024;
const MAX_TOOL_ROUNDS = 6; // 도구 호출이 무한 반복되지 않도록 안전장치
const MAX_HISTORY = 24; // 세션당 보관하는 메시지 수 상한(비용/메모리 보호)

export const isConfigured = () => !!process.env.ANTHROPIC_API_KEY;

const AUTH_TOOLS = ['requestOtp', 'verifyOtp'];
const BOOKING_TOOLS = ['listMyReservations', 'createReservation', 'cancelReservation'];

const TOOLS = [
  { name: 'getShopInfo', description: '매장 이름, 예약 가능한 시술 목록(이름/가격/소요시간), 담당 직원 목록, 온라인 예약 정책을 조회한다. 대화 시작 시 한 번 호출해 시술명을 정확히 파악하라.', input_schema: { type: 'object', properties: {} } },
  { name: 'getAvailability', description: '특정 날짜에 예약 가능한 시간 목록을 조회한다.', input_schema: {
    type: 'object', required: ['date', 'serviceIds'],
    properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, serviceIds: { type: 'array', items: { type: 'integer' }, description: 'getShopInfo로 확인한 시술 ID 목록' }, staffId: { type: 'integer', description: '특정 담당자만 보고 싶을 때(선택)' } },
  } },
  { name: 'requestOtp', description: '고객 휴대폰으로 6자리 인증번호를 보낸다. 예약을 만들거나 조회/취소하기 전, 아직 인증되지 않은 고객에게 반드시 먼저 호출한다.', input_schema: {
    type: 'object', required: ['phone'], properties: { phone: { type: 'string', description: '010-0000-0000 형식' } },
  } },
  { name: 'verifyOtp', description: '고객이 불러준 인증번호를 확인한다. 성공하면 그 대화 동안 로그인 상태가 된다. 처음 가입하는 번호면 이름도 함께 받아 전달한다.', input_schema: {
    type: 'object', required: ['phone', 'code'], properties: { phone: { type: 'string' }, code: { type: 'string' }, name: { type: 'string', description: '선택: 신규 고객일 때만 사용됨' } },
  } },
  { name: 'listMyReservations', description: '인증된 고객 본인의 예약 목록을 조회한다.', input_schema: { type: 'object', properties: {} } },
  { name: 'createReservation', description: '예약을 생성한다. 인증된 고객만 가능하다. 담당자를 지정하지 않으면 그 시간에 가능한 직원이 자동 배정된다.', input_schema: {
    type: 'object', required: ['startAt', 'serviceIds'],
    properties: { startAt: { type: 'string', description: 'YYYY-MM-DDTHH:mm' }, serviceIds: { type: 'array', items: { type: 'integer' } }, staffId: { type: 'integer' } },
  } },
  { name: 'cancelReservation', description: '인증된 고객 본인의 예약을 취소한다.', input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } },
];

function systemPrompt(shop, session) {
  const base = `당신은 "${shop.name}"의 예약 도우미입니다. 한국어로 짧고 친절하게 답하세요.
규칙:
- 예약하려는 시술과 원하는 날짜를 먼저 확인하고, getAvailability로 실제 가능한 시간을 확인한 뒤 안내하세요. 시간을 지어내지 마세요.
- 시술 ID·담당자 ID 같은 내부 값은 고객에게 보여주지 말고 이름으로만 이야기하세요.
- createReservation·listMyReservations·cancelReservation은 반드시 인증(로그인)된 뒤에만 호출할 수 있습니다.
- 대화는 이 매장 예약 안내로만 한정합니다.`;
  if (session.customerId) return `${base}\n- 이 고객은 이미 인증되었고 이름은 "${session.customerName}"입니다. 다시 인증을 요구하지 마세요.`;
  return `${base}\n- 아직 인증되지 않았습니다. 예약/조회/취소 전에는 휴대폰 번호를 물어 requestOtp를 호출하고, 문자로 받은 인증번호를 받아 verifyOtp를 호출해 먼저 로그인시키세요.`;
}

function toolsFor(session) {
  return session.customerId ? TOOLS.filter((t) => !AUTH_TOOLS.includes(t.name)) : TOOLS;
}

const need = (session) => { if (!session.customerId) throw new HttpError(401, '예약 조회/생성/취소 전에 먼저 휴대폰 인증(requestOtp, verifyOtp)을 진행해야 합니다.'); };

async function execTool(ctx, shop, session, name, input) {
  switch (name) {
    case 'getShopInfo': return svc.getInfo(ctx.db, shop);
    case 'getAvailability': return svc.getAvailability(ctx.db, shop, { date: input.date, serviceIds: (input.serviceIds ?? []).join(','), staffId: input.staffId });
    case 'requestOtp': return await svc.requestOtp(ctx, shop, input);
    case 'verifyOtp': {
      const { customer, created } = await svc.verifyOtp(ctx, shop, input);
      session.customerId = customer.id;
      session.customerName = customer.name;
      return { ok: true, created, name: customer.name };
    }
    case 'listMyReservations': need(session); return svc.listMyReservations(ctx.db, shop, session.customerId);
    case 'createReservation': need(session); return await svc.createReservation(ctx, shop, session.customerId, input);
    case 'cancelReservation': need(session); return await svc.cancelReservation(ctx, shop, session.customerId, input.id);
    default: throw new Error(`알 수 없는 도구: ${name}`);
  }
}

/** 기본 Anthropic 호출기. 테스트에서는 다른 함수로 주입해 실제 네트워크 호출 없이 검증한다. */
export async function callAnthropicApi({ system, messages, tools }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, messages, tools }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Anthropic API 오류 (${res.status})`);
  return data;
}

/**
 * 대화 한 턴 실행: 사용자 메시지를 넣고, 필요하면 도구를 여러 번 실행한 뒤 최종 답변을 만든다.
 * session 은 호출자가 보관하는 { history, customerId, customerName } 객체를 그대로 변형(mutate)한다.
 */
export async function runTurn(ctx, shop, session, userMessage, callAnthropic = callAnthropicApi) {
  if (!isConfigured()) throw new HttpError(503, 'AI 예약 도우미가 아직 설정되지 않았습니다. 서버에 ANTHROPIC_API_KEY를 설정해 주세요.');
  session.history ??= [];
  session.history.push({ role: 'user', content: userMessage });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await callAnthropic({ system: systemPrompt(shop, session), messages: session.history, tools: toolsFor(session) });
    session.history.push({ role: 'assistant', content: res.content });
    if (res.stop_reason !== 'tool_use') {
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      trimHistory(session);
      return text || '죄송해요, 답변을 만들지 못했어요. 다시 말씀해 주시겠어요?';
    }
    const results = [];
    for (const block of res.content.filter((b) => b.type === 'tool_use')) {
      try {
        const out = await execTool(ctx, shop, session, block.name, block.input ?? {});
        results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: block.id, content: e.message || String(e), is_error: true });
      }
    }
    session.history.push({ role: 'user', content: results });
  }
  trimHistory(session);
  return '요청을 처리하는 데 시간이 걸리고 있어요. 잠시 후 다시 시도해 주세요.';
}

/**
 * 세션 대화가 무한히 길어져 비용이 커지지 않도록 최근 대화만 남긴다.
 * tool_use(assistant) 블록과 그 결과인 tool_result(user) 블록은 반드시 붙어 있어야 하므로,
 * 아무 지점이나 자르지 않고 "사용자가 직접 입력한 텍스트 턴"이 시작하는 지점에서만 자른다.
 */
function trimHistory(session) {
  if (session.history.length <= MAX_HISTORY) return;
  for (let i = session.history.length - MAX_HISTORY; i < session.history.length; i++) {
    const m = session.history[i];
    if (m.role === 'user' && typeof m.content === 'string') { session.history = session.history.slice(i); return; }
  }
  // 안전하게 자를 지점을 못 찾으면 이번엔 자르지 않는다(다음 턴에 다시 시도).
}
