import { HttpError, required } from '../util.js';
import * as svc from '../public-service.js';

/**
 * 고객 셀프 예약(전화번호 인증 가입) 공개 API. 매장 직원 로그인과는 완전히 분리된 흐름이며
 * 이 라우트는 전역 인증 훅에서 제외되어(app.js) 자체적으로 인증을 처리한다.
 * 실제 도메인 로직은 src/public-service.js 에 있고, AI 예약봇(src/ai/bookingAgent.js)도 같은 함수를 쓴다.
 *   GET  /api/public/:code/info            매장/시술/직원 목록, 예약 정책 (공개)
 *   GET  /api/public/:code/availability     빈 시간 조회 (공개)
 *   POST /api/public/:code/otp/request      인증번호 발송
 *   POST /api/public/:code/otp/verify       인증번호 확인 → 로그인 토큰 발급(없으면 가입)
 *   GET  /api/public/:code/me               내 정보 (로그인 필요)
 *   PATCH /api/public/:code/me              이름 수정 (로그인 필요)
 *   GET  /api/public/:code/my-reservations  내 예약 목록 (로그인 필요)
 *   POST /api/public/:code/reservations     예약 생성 (로그인 필요)
 *   POST /api/public/:code/reservations/:id/cancel  내 예약 취소 (로그인 필요)
 *   POST /api/public/:code/chat             AI 예약 도우미(Claude API, ANTHROPIC_API_KEY 필요) — src/routes/aiChat.js
 */
export default function (app, ctx) {
  const { db } = ctx;

  /** 고객 로그인 토큰(req.user.cust) 검증. 매장 직원/관리자 토큰은 cust 필드가 없어 자동으로 거부된다. */
  const custAuth = async (req) => {
    try { await req.jwtVerify(); } catch { throw new HttpError(401, '로그인이 필요합니다.'); }
    const shop = svc.shopByCode(db, req.params.code);
    if (!Number.isInteger(req.user.cust) || req.user.shop !== shop.id) throw new HttpError(401, '로그인이 필요합니다.');
    req.shop = shop;
    req.customer = svc.custOf(db, shop, req.user.cust);
  };

  app.get('/api/public/:code/info', async (req) => svc.getInfo(db, svc.shopByCode(db, req.params.code)));

  app.get('/api/public/:code/availability', async (req) => svc.getAvailability(db, svc.shopByCode(db, req.params.code), req.query));

  app.post('/api/public/:code/otp/request', async (req) => {
    const shop = svc.shopByCode(db, req.params.code);
    required(req.body, 'phone');
    return svc.requestOtp(ctx, shop, req.body);
  });

  app.post('/api/public/:code/otp/verify', async (req) => {
    const shop = svc.shopByCode(db, req.params.code);
    required(req.body, 'phone', 'code');
    const { customer, created } = await svc.verifyOtp(ctx, shop, req.body);
    const token = app.jwt.sign({ cust: customer.id, shop: shop.id }, { expiresIn: '90d' });
    return { token, created, name: customer.name };
  });

  app.get('/api/public/:code/me', { onRequest: custAuth }, async (req) => ({ id: req.customer.id, name: req.customer.name }));

  app.patch('/api/public/:code/me', { onRequest: custAuth }, async (req) => svc.updateCustomerName(db, req.customer.id, req.body?.name));

  app.get('/api/public/:code/my-reservations', { onRequest: custAuth }, async (req) => svc.listMyReservations(db, req.shop, req.customer.id));

  app.post('/api/public/:code/reservations', { onRequest: custAuth }, async (req) =>
    svc.createReservation(ctx, req.shop, req.customer.id, req.body ?? {}),
  );

  app.post('/api/public/:code/reservations/:id/cancel', { onRequest: custAuth }, async (req) =>
    svc.cancelReservation(ctx, req.shop, req.customer.id, req.params.id),
  );
}
