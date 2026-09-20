# 살롱 CRM (SmallERP)

미용실·네일샵용 CRM. 고객 · 예약 · 결제/선불권 · 문자 자동화 · 매출 통계를 제공하는 멀티테넌트(매장 단위) 웹 서비스.

## 실행

```bash
npm install
npm run seed       # 테스트 매장 + 관리자 계정 + 샘플 데이터 생성 (멱등, 운영 환경에서는 거부)
npm start          # https://localhost:3001  (Node 24+ 필요: 내장 node:sqlite 사용, .env 자동 로드)
npm test           # API 통합 테스트
node test/e2e.mjs  # 브라우저 E2E (설치된 Chrome/Edge 사용)
```

| 구분 | 주소 | 계정 (개발용) |
|---|---|---|
| 매장 화면 | https://localhost:3001/ | `test` / `test1234` |
| 관리자 화면 | https://localhost:3001/admin.html | `admin` / (최초 시드 시 `admin12345!`, 이후 변경됨) |
| 공개 주소 | https://smallerp.sean2022.one:3001/ | (위와 동일 DB) |

> 위 계정은 개발용입니다. `test` 계정은 공개 주소에서도 로그인되므로 외부 공개 전 비밀번호 변경(설정 > 내 비밀번호 변경) 또는 삭제하세요. 관리자 비밀번호는 관리자 화면 > 비밀번호 변경 또는 `ADMIN_LOGIN`/`ADMIN_PASSWORD` 환경 변수로 관리합니다.

### HTTPS / 도메인
- 서버가 TLS를 직접 처리하며 접속 호스트명(SNI)으로 인증서를 고릅니다.
  - `localhost`/IP → `certs/cert.pem`, `certs/key.pem` (mkcert 발급, git 제외)
  - `*.sean2022.one` → `.env`의 `HTTPS_CERT_PATH`/`HTTPS_KEY_PATH` (포레스트클럽의 와일드카드 인증서를 경로로 참조, 만료 **2026-10-26**)
- DNS: Porkbun A레코드 `smallerp.sean2022.one` → forest와 같은 공인 IP. 공인 IP가 바뀌면 forest 레코드와 함께 갱신 필요.
- 공유기에서 **3001 포트 포워딩**과 Windows 방화벽 인바운드 허용이 필요합니다.
- 리버스 프록시 뒤에서 TLS를 종료한다면 `HTTP_ONLY=1`.


첫 화면에서 "신규 매장 등록"으로 매장과 사장 계정을 만들면 기본 시술 메뉴와 문자 템플릿이 생성됩니다.

환경 변수(운영 시 반드시 변경): `JWT_SECRET`, `APP_KEY`(연락처 암호화 키), `NAVER_WEBHOOK_SECRET`, `DB_FILE`, `PORT`, `AD_OPT_OUT`(광고 문자 수신거부 문구).

## 구현 범위 (MVP + 2단계 일부)

| 영역 | 구현 |
|---|---|
| 인증/권한 | 매장 등록, 로그인(JWT), 사장/직원 역할, 모든 쿼리 `shop_id` 격리 |
| 고객 | 등록·검색(이름/연락처)·수정, 연락처 AES-GCM 암호화 + HMAC 해시 검색, 방문 이력, 수신동의 기록 |
| 예약 | 일별 타임테이블, 시술 소요시간 기반 종료시각 계산, 담당자 시간 충돌 방지, 상태 관리 |
| 결제 | 시술 항목(가격 조정), 결제수단 분할, 선불권 충전/차감/환불 복원, 예약 연동, 환불(사장) |
| 문자 | 템플릿, 수동 발송, 광고 정책(수신동의·야간 제한·(광고)/수신거부 문구), 잔액 차감, 발송 로그 |
| 자동화 | 예약 전날 안내 · 생일 · N일 미방문 규칙, 10분 주기 실행, 중복 발송 방지 |
| 통계 | 일별/직원별(인센티브)/시술별/결제수단별 매출, 객단가, 신규·재방문, 오늘 대시보드 |
| 관리자 | `/admin.html`: 매장 목록·플랜·문자 충전/차감·이용 정지/해제·사장 비밀번호 초기화·감사 로그 (매장 토큰과 분리된 별도 계정) |
| 보안 | 로그인 5회 실패 15분 잠금, 퇴사·정지 즉시 반영, 보안 헤더/CSP, 감사 로그, 관리자는 고객 개인정보 조회 불가 |
| 데이터 이전 | 고객 CSV 가져오기/내보내기(사장 전용, 엑셀 수식 주입 방지, 중복·오류 행 보고) |
| 네이버 예약 | `POST /api/webhooks/naver/:shopId` 수신(시크릿 헤더, 멱등, 충돌 시 "확인필요") |

## 구조

```
src/app.js          Fastify 조립, 인증 훅, 에러 처리
src/db.js           SQLite 스키마 (표준 SQL 위주 → PostgreSQL 이전 용이)
src/messaging.js    문자 정책/발송/자동화 엔진
src/sms/provider.js 문자 에이전시 어댑터 (현재 mock)
src/routes/*.js     도메인별 API
public/             빌드 없는 SPA (index.html, app.js, style.css)
test/api.test.js    통합 테스트
```

날짜/시각은 매장 로컬 시간의 `YYYY-MM-DDTHH:mm` 문자열로 저장합니다.

## 아직 연결되지 않은 부분 (실서비스 전 필요)

1. **문자 에이전시 실연동**: `src/sms/provider.js`의 `send({to, body, isAd})` 를 알리고/솔라피/NHN 등으로 구현. 발신번호 사전등록 필요. 광고 수신거부 080 번호는 `AD_OPT_OUT` 로 설정.
2. **네이버 예약**: 웹훅 수신부만 구현. 공식 제휴/API 권한 확보 후 실제 페이로드에 맞게 매핑 조정.
3. **카드 단말(POS/VAN) 연동**: 현재 결제수단 금액은 수동 입력.
4. **구독 결제/플랜 한도**, 슈퍼관리자 콘솔, 모바일 앱(FCM/APNs), 알림톡.
5. **PostgreSQL 이전**: 운영에서는 SQLite → PostgreSQL + RLS 권장 (`node:sqlite` 호출부만 교체).
6. 로그인 시도 제한, 비밀번호 재설정, 감사 로그 등 운영 보안 항목.
