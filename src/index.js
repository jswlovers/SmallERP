import { existsSync, readFileSync } from 'node:fs';
import { createSecureContext } from 'node:tls';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { mockProvider } from './sms/provider.js';
import { runAutomationAllShops } from './messaging.js';
import { ensureAdmin } from './bootstrap.js';

const db = openDb();

// HTTPS: 인증서가 있으면 직접 TLS 서비스한다. 호스트명(SNI)에 따라 인증서를 고른다.
//  - 로컬(localhost/IP): certs/cert.pem, certs/key.pem  (mkcert 발급: mkcert -cert-file certs/cert.pem -key-file certs/key.pem localhost 127.0.0.1 <LAN IP>)
//  - 공개 도메인(*.sean2022.one): HTTPS_CERT_PATH / HTTPS_KEY_PATH (와일드카드 인증서 경로를 참조; 키 파일은 복사하지 않는다)
// HTTP_ONLY=1 이면 인증서가 있어도 HTTP로 띄운다(리버스 프록시 뒤에서 TLS 종료할 때).
const localCert = { cert: 'certs/cert.pem', key: 'certs/key.pem' };
const publicCert = { cert: process.env.HTTPS_CERT_PATH, key: process.env.HTTPS_KEY_PATH, suffix: process.env.PUBLIC_DOMAIN_SUFFIX || '.sean2022.one' };
const readPair = (p) => (p.cert && p.key && existsSync(p.cert) && existsSync(p.key) ? { cert: readFileSync(p.cert), key: readFileSync(p.key) } : null);
const local = readPair(localCert);
let pub = readPair(publicCert);
const useHttps = process.env.HTTP_ONLY !== '1' && !!(local || pub);
const localCtx = local && createSecureContext(local);
let pubCtx = pub && createSecureContext(pub);
const https = useHttps
  ? {
      ...(local ?? pub),
      SNICallback: (servername, cb) => {
        cb(null, pubCtx && servername.endsWith(publicCert.suffix) ? pubCtx : (localCtx ?? pubCtx));
      },
    }
  : undefined;

// 공개 인증서 파일이 바뀌면 재시작 없이 새 인증서를 적용한다(1시간마다 확인). 인증서는 포레스트클럽의
// Windows 작업 스케줄러(PorkbunCertRenew)가 매일 Porkbun에서 받아 교체한다.
if (useHttps && pub) {
  setInterval(() => {
    try {
      const next = readPair(publicCert);
      if (!next || next.cert.equals(pub.cert)) return;
      pubCtx = createSecureContext(next);
      pub = next;
      console.log('[cert] 새 공개 인증서를 재시작 없이 적용했어요');
    } catch (err) {
      console.error(`[cert] 새 인증서 적용 실패 (기존 인증서로 계속 서비스): ${err.message}`);
    }
  }, 60 * 60 * 1000).unref();
}

// 공개 인증서(도메인)로 서비스하거나 production 이면 코드에 공개된 기본 비밀키로는 시작하지 않는다.
if ((process.env.NODE_ENV === 'production' || pub) && (!process.env.JWT_SECRET || !process.env.APP_KEY)) {
  console.error('공개/운영 모드에서는 JWT_SECRET 과 APP_KEY 환경 변수를 반드시 설정해야 합니다. (.env.example 참고)');
  process.exit(1);
}

const app = buildApp({ db, sms: mockProvider, logger: true, https });
ensureAdmin(db);

// 자동 문자 규칙: 10분 간격 확인. 중복 발송은 message_log 유니크 키로 방지된다.
const timer = setInterval(() => runAutomationAllShops({ db, sms: mockProvider }).catch((e) => app.log.error(e)), 10 * 60 * 1000);
timer.unref();

const port = Number(process.env.PORT || 3001);
app.listen({ port, host: process.env.HOST || '0.0.0.0' }).then(() => console.log(`${useHttps ? 'https' : 'http'}://localhost:${port}`));
