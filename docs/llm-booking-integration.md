# Claude / ChatGPT로 고객 예약받기

질문: "claude나 chatgpt로 예약을 하려고 하면 뭘 제공해야 하나? ① 예약일을 알려주면 가능 시간을 알려주고 ② 예약일과 시간을 정해서 알려주면 예약을 한다."

## 결론부터

**Claude API 기반 챗봇은 이미 구현되어 바로 쓸 수 있습니다.** `.env`에 `ANTHROPIC_API_KEY`만 넣으면 `/chat.html?s=<매장코드>`에서 고객이 바로 대화로 예약할 수 있습니다. **ChatGPT는 여러분의 OpenAI 계정에서 직접 "GPT 만들기"로 설정해야 하는 부분이라 제가 대신 만들어 드릴 수 없지만, 바로 붙여넣을 수 있는 스펙([docs/booking-api-openapi.json](booking-api-openapi.json))은 준비해 뒀습니다.**

| 요청하신 기능 | 대응 API | 로그인 필요 |
|---|---|---|
| ① 날짜를 주면 가능한 시간 알려주기 | `GET /api/public/{code}/availability?date=&serviceIds=` | 아니오(공개) |
| ② 날짜·시간을 정하면 예약 | `POST /api/public/{code}/reservations` | **예** |
| (추가로 필요) 본인 확인 | `POST /api/public/{code}/otp/request` → `POST /api/public/{code}/otp/verify` | 아니오(로그인 자체가 이 과정) |

예약은 반드시 "누구의" 예약인지 매장 고객 기록에 연결돼야 하므로, ②를 하기 전에 휴대폰 인증(OTP) 한 번으로 로그인·가입을 먼저 해야 합니다. 다행히 두 구현(Claude 챗봇, ChatGPT Action) 모두 이 인증을 대화 흐름 안에서 자연스럽게 처리합니다:

```
고객: 이번 주 토요일 오후에 커트 예약하고 싶어요
봇:   (getAvailability 호출) 토요일에는 14:00, 14:40, 15:30이 비어 있어요. 어느 시간이 좋으세요?
고객: 14:40이요
봇:   예약을 위해 휴대폰 번호를 알려주세요
고객: 010-1234-5678
봇:   (requestOtp 호출) 방금 보내드린 인증번호 6자리를 알려주세요
고객: 482913
봇:   (verifyOtp 호출 → 로그인 완료, 대화 동안 기억) (createReservation 호출) 토요일 14:40 커트 예약을 접수했어요. 매장에서 확인 후 확정돼요.
```

## 방법 A. 자체 Claude 챗봇 (구현 완료, 바로 사용 가능)

1. [console.anthropic.com](https://console.anthropic.com)에서 API 키를 발급받아 `.env`에 `ANTHROPIC_API_KEY=sk-ant-...`를 넣습니다. 필요하면 `ANTHROPIC_MODEL`도 바꿀 수 있습니다(기본값 `claude-sonnet-5`).
2. 서버를 재시작하면 끝입니다. 고객은 `/book.html`의 "💬 AI에게 대화로 예약 부탁하기" 링크나 `/chat.html?s=<매장코드>`로 바로 접속해 대화로 예약할 수 있습니다.
3. 동작 방식: `src/routes/aiChat.js`가 세션(대화 기록, 인증 상태)을 서버 메모리에 30분간 보관하고, `src/ai/bookingAgent.js`가 Claude의 tool_use 루프를 돌립니다. 실제 예약 생성·조회·취소는 `src/public-service.js`의 같은 함수를 호출하므로, `/book.html` 폼으로 만든 예약과 정책(확인필요/자동확정, 최소 리드타임 등)이 완전히 동일합니다.
4. 비용/오남용 보호: 세션당 분당 12건 메시지 제한, 메시지 500자 제한, 대화 기록은 24개 메시지로 자동 정리(툴 호출 쌍은 안전하게 유지), 도구 호출은 한 턴에 최대 6회까지만 허용합니다.
5. `ANTHROPIC_API_KEY`가 없으면 `/chat.html`은 503("AI 예약 도우미가 아직 설정되지 않았습니다")만 보여주고, 나머지 기능(폼 예약, 매장 화면 등)에는 전혀 영향이 없습니다.

## 방법 B. ChatGPT (Custom GPT의 Actions) — 여러분이 설정해야 함

1. ChatGPT에서 "GPT 만들기" → Configure → Actions → 스키마 가져오기에 [docs/booking-api-openapi.json](booking-api-openapi.json) 내용을 그대로 붙여넣습니다.
2. **Authentication은 "None"으로 둡니다.** 인증이 필요한 4개 작업(`listMyReservations`/`createReservation`/`cancelReservation`)은 스펙에 `Authorization` 헤더를 **명시적인 파라미터**로 정의해 뒀습니다 — ChatGPT Actions의 전역 인증 설정(API 전체에 고정 키/OAuth 하나만 적용되는 방식)은 대화 중 동적으로 발급되는 토큰과 맞지 않기 때문입니다. 모델이 `verifyOtp` 응답의 `token` 값을 기억했다가 이후 호출마다 `Authorization: Bearer <token>` 형태로 직접 채워 넣습니다.
3. Instructions(시스템 프롬프트)에 매장 코드를 박아 두세요. 예: "이 매장의 예약 코드(code 파라미터)는 항상 `ackk-3Z`이다. 고객에게 코드를 묻지 마라."
4. 예약 확정 여부(`status: pending`/`confirmed`)를 사용자에게 그대로 알려주도록 지시해 두면, 매장이 "확인필요" 정책을 쓰고 있을 때 혼선이 없습니다.

## 방법 C. Claude Desktop/Code용 MCP 서버 (개발자용, 참고)

Claude Desktop이나 Claude Code에 이 API를 "커넥터"로 붙이고 싶다면 같은 엔드포인트를 감싸는 작은 MCP 서버를 만들 수 있습니다. 다만 이건 개발자가 자기 PC에 설정하는 방식이라, 손님이 직접 설정할 경로는 아닙니다 — 손님용으로는 방법 A(자체 챗봇)나 방법 B(카카오톡 채널·웹 등에 얹는 ChatGPT)가 현실적입니다. 필요하시면 별도로 만들어 드리겠습니다.

## 테스트하기 (실제 SMS 연동 전)

방법 A·B 모두 `requestOtp`가 실제 문자를 보내지 않는 지금 상태에서도 테스트할 수 있습니다:
- 인증번호로 **`000000`**을 입력하면 항상 통과됩니다(Solapi 등 실제 연동 전 임시 조치, `NODE_ENV=production`이면 자동으로 꺼집니다).
- 또는 `requestOtp` 응답의 `devCode` 필드(운영 환경이 아닐 때만 내려옴)에 실제 발급된 코드가 그대로 들어 있습니다.

## 보안 참고

- `otp/request`는 번호당 하루 8회, 60초 재발송 간격으로 이미 제한돼 있어 챗봇을 공개해도 한 사람에게 문자 폭탄을 보내는 것은 막혀 있습니다.
- 예약 생성·조회·취소는 전부 `otp/verify`로 받은 토큰(또는 방법 A에서는 서버 내부 세션) 소유자 본인 것만 가능합니다(서버가 강제).
- 매장이 "확인필요(pending)" 정책을 쓰면 챗봇이 만든 예약도 사장이 직접 확정해야 최종 확정됩니다. 챗봇에 예약을 전부 맡기고 싶다면 설정 > 솔루션 간편설정에서 "접수 즉시 자동 확정"을 켜세요.
- `000000` 임시 우회가 켜져 있는 동안은(운영 환경이 아닐 때) 휴대폰 번호만 알면 그 번호로 로그인해 다른 사람 행세를 할 수 있습니다. 실제 고객에게 링크를 공개하기 전에는 반드시 Solapi 등 실제 SMS를 연동하거나 `NODE_ENV=production`으로 배포해 이 우회를 꺼두세요.
