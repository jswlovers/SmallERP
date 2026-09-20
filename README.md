# 살롱 CRM (SmallERP)

미용실·네일샵용 CRM. 핸드SOS(HandSOS)의 공개 메뉴 구조를 조사해([docs/handsos-menu-tree.md](docs/handsos-menu-tree.md)) 대응 기능을 구현한 멀티테넌트(매장 단위) 웹 서비스입니다.

## 실행

```bash
npm install
npm run seed       # 테스트 매장 + 관리자 계정 + 샘플 데이터 생성 (멱등, 운영 환경에서는 거부)
npm start          # https://localhost:3001  (Node 24+ 필요: 내장 node:sqlite 사용, .env 자동 로드)
npm test           # API 통합 테스트 (35건)
node test/e2e.mjs      # 브라우저 E2E (설치된 Chrome/Edge 사용)
node test/ui-smoke.mjs # 모든 탭/서브탭을 열어 콘솔 오류·빈 화면을 검사
```

| 구분 | 주소 | 계정 (개발용) |
|---|---|---|
| 매장 화면 | https://localhost:3001/ | `test` / `test1234` |
| 셀프 접수 키오스크 | https://localhost:3001/kiosk.html | 매장 화면 로그인 세션 공유 |
| 관리자 화면 | https://localhost:3001/admin.html | `admin` / (`.env`의 `ADMIN_PASSWORD`, 없으면 시드가 `admin12345!` 생성) |
| 공개 주소 | https://smallerp.sean2022.one:3001/ | (위와 동일 DB) |

> 위 계정은 개발용입니다. `test` 계정은 공개 주소에서도 로그인되므로 외부 공개 전 비밀번호를 바꾸거나(설정 > 내 계정) 삭제하세요.

### HTTPS / 도메인
- 서버가 TLS를 직접 처리하며 접속 호스트명(SNI)으로 인증서를 고릅니다.
  - `localhost`/IP → `certs/cert.pem`, `certs/key.pem` (mkcert 발급, git 제외)
  - `*.sean2022.one` → `.env`의 `HTTPS_CERT_PATH`/`HTTPS_KEY_PATH` (포레스트클럽의 와일드카드 인증서를 경로로 참조, 만료 **2026-10-26**)
- DNS: Porkbun A레코드 `smallerp.sean2022.one` → forest와 같은 공인 IP. 공인 IP가 바뀌면 forest 레코드와 함께 갱신 필요.
- 공유기에서 **3001 포트 포워딩**과 Windows 방화벽 인바운드 허용이 필요합니다.
- 공개 인증서로 뜨거나 `NODE_ENV=production`이면 `JWT_SECRET`/`APP_KEY` 없이는 서버가 시작되지 않습니다(`.env.example` 참고).
- 리버스 프록시 뒤에서 TLS를 종료한다면 `HTTP_ONLY=1`.

첫 화면에서 "신규 매장 등록"으로 매장과 사장 계정을 만들면 기본 시술 메뉴와 문자 템플릿이 생성됩니다.

## 구현 범위

| 영역 | 구현 |
|---|---|
| 인증/권한 | 매장 등록, 로그인(JWT), 사장/직원 역할, 로그인 5회 실패 잠금, 퇴사·매장정지 즉시 반영, `shop_id` 격리 |
| 관리자 | `/admin.html`: 매장 목록·플랜·문자 충전/차감·정지/해제·사장 비번 초기화·감사 로그 (매장과 분리된 별도 계정, 고객 개인정보 조회 불가) |
| 고객 | 고객번호 자동 부여, 검색(번호/이름/연락처), 연락처 암호화, 노쇼 주의 표시, 소개자·가족, 삭제/복구, 중복 병합, CSV 가져오기/내보내기 |
| 기초등록 | 시술 1차 분류·2차 상세 메뉴, 회원권(횟수권), 정액권(보너스·유효기간), 할인 프리셋, 고객등급 자동 승급, 포인트 적립률, 제품·매입처·재고, 솔루션 간편설정 |
| 예약 | 일별 목록 + 일/주 타임테이블, 근무시간·브레이크타임·휴무일·예약금지 시간대 검증, 빈 시간 조회, 상태 7종(확인필요~노쇼), 담당자 알림 문자, 네이버 예약 웹훅(멱등) |
| 결제 | 시술·제품 혼합 결제, 할인 적용, 회원권 차감, 정액권/포인트/외상 결제, 환불 시 재고·횟수·잔액 전부 복원, 등급 자동 승급 |
| 대기·현황판 | 셀프 접수 키오스크, 대기 번호표, 매장 현황판(예약중/대기중/시술중 실시간) |
| 운영 | 입출금 관리(계정 항목), 일마감(현금 시재 차이), 출퇴근, 매장 일정 |
| 분석 | 고객 동향(미방문 구간별), 휴면 고객→즉시 문자, 예약 동향(노쇼율/요일/시간대), 기간 비교, 월별 성장률, 매출 캘린더, 목표 대비 달성률, 급여(기본급+인센티브), 문자 방문율 |
| 문자 | 이벤트 13종 + 주기 8종, 총 25종 자동 발송 트리거, 광고 정책(수신동의·야간 제한), 수동 발송, 발송 로그 |
| 데이터 이전 | 고객 CSV 가져오기/내보내기(엑셀 수식 주입 방지, 중복·오류 행 보고) |

핸드SOS 조사 대비 남은 항목(외부 계약·하드웨어 필요)은 [docs/handsos-menu-tree.md §3](docs/handsos-menu-tree.md)에 정리했습니다: 카드 단말(VAN) 결제, 네이버 예약 공식 API 제휴, 알림톡/실제 문자 발송, 080 ARS, 전화 수신 팝업(CID), 전용 모바일 앱.

## 구조

```
src/app.js            Fastify 조립, 인증 훅, 보안 헤더, 에러 처리
src/db.js             SQLite 스키마 + 마이그레이션 (표준 SQL 위주 → PostgreSQL 이전 용이)
src/wallet.js          선불권/포인트/외상 잔액, 등급 승급, 상품 판매 결제 공통 로직
src/schedule.js        근무시간/브레이크/휴무/예약금지 검증, 빈 시간 계산
src/messaging.js        문자 정책/발송/자동화 엔진, 트리거 카탈로그(TRIGGERS)
src/settings.js         매장별 키-값 설정(JSON)
src/sms/provider.js     문자 에이전시 어댑터 (현재 mock)
src/routes/*.js         도메인별 API (auth/customers/reservations/payments/catalog/wallet/schedule/ops/insight/messages/admin/...)
public/core.js          프런트 공통: API 호출, 모달/토스트, 서브탭 페이지네이션, 표/막대 헬퍼
public/app.js           로그인, 탭 라우팅
public/views/*.js       탭별 화면 모듈
public/kiosk.html·js    셀프 접수 키오스크
public/admin.html·js    플랫폼 관리자 콘솔
test/*.test.js          단위/통합 테스트 (35건)
test/e2e.mjs            브라우저 E2E
test/ui-smoke.mjs       전체 탭/서브탭 콘솔 오류 검사
```

날짜/시각은 매장 로컬 시간의 `YYYY-MM-DDTHH:mm` 문자열로 저장합니다.

## 환경 변수

`.env.example`을 복사해 `.env`로 사용하세요.

| 변수 | 설명 |
|---|---|
| `JWT_SECRET`, `APP_KEY` | 필수(공개/운영). 무작위 문자열. `APP_KEY`는 고객 연락처 암호화 키라서 운영 중 바꾸면 기존 데이터를 못 읽습니다. |
| `NAVER_WEBHOOK_SECRET` | 네이버 예약 웹훅 인증 헤더 값 |
| `ADMIN_LOGIN`, `ADMIN_PASSWORD` | 플랫폼 관리자 계정(서버 시작 시 생성/갱신) |
| `HTTPS_CERT_PATH`, `HTTPS_KEY_PATH` | 공개 도메인용 인증서 경로 (없으면 `certs/`의 로컬 mkcert 인증서 사용) |
| `PORT`, `HOST`, `HTTP_ONLY`, `DB_FILE`, `AD_OPT_OUT` | 그 외 서버/광고 문자 설정 |

## 아직 연결되지 않은 부분 (외부 계약·인프라 필요)

1. **문자 에이전시 실연동**: `src/sms/provider.js`의 `send({to, body, isAd})`를 알리고/솔라피/NHN 등으로 구현. 발신번호 사전등록 필요.
2. **네이버 예약 공식 연동**: 웹훅 수신·멱등 처리만 구현됨. 공식 제휴/API 권한 확보 후 실제 페이로드에 맞게 매핑 조정.
3. **카드 단말(POS/VAN) 연동**: 결제수단 금액은 현재 수동 입력.
4. **알림톡, 080 ARS, 전화 수신 팝업(CID)**: 통신사·카카오 심사, 전화 장비 연동이 필요해 범위 밖으로 남겨둠.
5. **구독 결제/플랜 한도 강제**, 전용 모바일 앱(현재는 반응형 웹).
6. **PostgreSQL 이전**: 운영 규모가 커지면 SQLite → PostgreSQL + RLS 권장 (`src/db.js`의 `node:sqlite` 호출부만 교체).
