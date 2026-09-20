import { randomBytes } from 'node:crypto';
import { HttpError, bad, required } from '../util.js';
import * as svc from '../public-service.js';

const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_MSG_LEN = 500;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 12; // 세션당 분당 메시지 수 상한(비용 보호)

/**
 * 고객이 대화형으로 예약할 수 있는 AI 도우미(Claude API). 실제 실행은 ctx.runAiTurn(기본값은
 * src/ai/bookingAgent.js의 runTurn)에 위임한다 — ANTHROPIC_API_KEY가 없으면 그 안에서 503을
 * 던진다(다른 선택적 연동과 같은 방식). 테스트에서는 buildApp({ runAiTurn: stub })으로 실제
 * Anthropic 네트워크 호출 없이 이 라우트 전체(세션·요율제한)를 검증한다.
 * 세션은 서버 메모리에만 있고(재시작 시 소실), 고객 로그인 토큰은 세션 밖으로 노출하지 않는다.
 */
export default function (app, ctx) {
  const { db } = ctx;
  const sessions = new Map(); // sessionId -> { shopId, history, customerId, customerName, lastActive }
  const rate = new Map(); // sessionId -> [timestamps]

  const freshSession = (shopId) => ({ shopId, history: [], customerId: null, customerName: null, lastActive: Date.now() });

  app.post('/api/public/:code/chat', async (req) => {
    const shop = svc.shopByCode(db, req.params.code);
    required(req.body, 'message');
    const message = String(req.body.message).slice(0, MAX_MSG_LEN);
    if (!message.trim()) throw bad('메시지를 입력해 주세요.');

    let sessionId = req.body.sessionId;
    let session = sessionId ? sessions.get(sessionId) : null;
    if (!session || session.shopId !== shop.id || Date.now() - session.lastActive > SESSION_TTL_MS) {
      sessionId = randomBytes(12).toString('base64url');
      session = freshSession(shop.id);
      sessions.set(sessionId, session);
    }

    const hits = (rate.get(sessionId) ?? []).filter((t) => Date.now() - t < RATE_WINDOW_MS);
    if (hits.length >= RATE_MAX) throw new HttpError(429, '메시지를 너무 빨리 보내고 있어요. 잠시 후 다시 시도해 주세요.');
    hits.push(Date.now());
    rate.set(sessionId, hits);

    const reply = await ctx.runAiTurn(ctx, shop, session, message);
    session.lastActive = Date.now();
    return { sessionId, reply, authenticated: !!session.customerId };
  });
}
