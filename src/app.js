import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './db.js';
import { mockProvider } from './sms/provider.js';
import { HttpError } from './util.js';
import authRoutes from './routes/auth.js';
import staffRoutes from './routes/staff.js';
import customerRoutes from './routes/customers.js';
import serviceRoutes from './routes/services.js';
import reservationRoutes from './routes/reservations.js';
import paymentRoutes from './routes/payments.js';
import statsRoutes from './routes/stats.js';
import messageRoutes from './routes/messages.js';
import adminRoutes from './routes/admin.js';
import catalogRoutes from './routes/catalog.js';
import walletRoutes from './routes/wallet.js';
import scheduleRoutes from './routes/schedule.js';
import opsRoutes from './routes/ops.js';
import insightRoutes from './routes/insight.js';
import publicRoutes from './routes/public.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildApp({ db = openDb(), sms = mockProvider, logger = false, https } = {}) {
  const app = Fastify({ logger, ...(https ? { https } : {}) });
  const ctx = { db, sms };

  app.register(fastifyJwt, { secret: process.env.JWT_SECRET || 'dev-jwt-secret-change-me', sign: { expiresIn: '12h' } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err.validation || err.statusCode) return reply.code(err.statusCode || 400).send({ error: err.message });
    if (String(err.message).includes('UNIQUE constraint')) return reply.code(409).send({ error: '이미 존재하는 값입니다.' });
    if (String(err.message).includes('FOREIGN KEY')) return reply.code(400).send({ error: '참조 대상이 올바르지 않습니다.' });
    req.log.error(err);
    return reply.code(500).send({ error: '서버 오류가 발생했습니다.' });
  });

  // /api/auth/* 를 제외한 모든 API는 JWT 필요. req.user = { sid(staff), shop, role }
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/auth/') || req.url.startsWith('/api/webhooks/') || req.url.startsWith('/api/admin/') || req.url.startsWith('/api/public/') || req.url === '/api/health') return;
    try {
      await req.jwtVerify();
    } catch {
      throw new HttpError(401, '로그인이 필요합니다.');
    }
    // 토큰 발급 이후 퇴사/권한 변경이 즉시 반영되도록 매 요청 DB 기준으로 재확인
    if (!Number.isInteger(req.user.sid)) throw new HttpError(401, '로그인이 필요합니다.'); // 관리자 토큰 등 매장 직원 토큰이 아닌 경우
    const s = db.prepare('SELECT role, active, shop_id FROM staff WHERE id = ?').get(req.user.sid);
    if (!s || !s.active || s.shop_id !== req.user.shop) throw new HttpError(401, '로그인이 필요합니다.');
    req.user.role = s.role;
    if (!db.prepare('SELECT active FROM shop WHERE id = ?').get(s.shop_id)?.active) throw new HttpError(403, '이용이 정지된 매장입니다. 관리자에게 문의하세요.');
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'");
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (process.env.NODE_ENV === 'production') reply.header('Strict-Transport-Security', 'max-age=15552000');
  });

  app.get('/api/health', async () => ({ ok: true }));

  for (const r of [authRoutes, staffRoutes, customerRoutes, serviceRoutes, reservationRoutes, paymentRoutes, statsRoutes, messageRoutes, adminRoutes, catalogRoutes, walletRoutes, scheduleRoutes, opsRoutes, insightRoutes, publicRoutes]) {
    r(app, ctx);
  }

  app.register(fastifyStatic, { root: join(__dirname, '..', 'public') });
  return app;
}
