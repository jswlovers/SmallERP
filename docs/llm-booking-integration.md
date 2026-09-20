# Claude / ChatGPT로 고객 예약받기

질문: "claude나 chatgpt로 예약을 하려고 하면 뭘 제공해야 하나? ① 예약일을 알려주면 가능 시간을 알려주고 ② 예약일과 시간을 정해서 알려주면 예약을 한다."

## 결론부터

이미 만들어진 [고객 온라인 예약 API](booking-api-openapi.json)(`/api/public/:code/...`)가 정확히 이 두 가지를 제공합니다. LLM(Claude·ChatGPT)에게 "도구(tool)"로 이 API를 쥐여주기만 하면 됩니다. 다만 요청하신 2단계 앞에 **본인 확인 단계가 하나 더 필요**합니다.

| 요청하신 기능 | 대응 API | 로그인 필요 |
|---|---|---|
| ① 날짜를 주면 가능한 시간 알려주기 | `GET /api/public/{code}/availability?date=&serviceIds=` | 아니오(공개) |
| ② 날짜·시간을 정하면 예약 | `POST /api/public/{code}/reservations` | **예** |
| (추가로 필요) 본인 확인 | `POST /api/public/{code}/otp/request` → `POST /api/public/{code}/otp/verify` | 아니오(로그인 자체가 이 과정) |

예약은 반드시 "누구의" 예약인지 매장 고객 기록에 연결돼야 하므로, ②를 하기 전에 휴대폰 인증(OTP) 한 번으로 로그인·가입을 먼저 해야 합니다. 다행히 이 인증도 문자 한 번 주고받는 것뿐이라 대화 흐름 안에서 자연스럽게 처리됩니다:

```
고객: 이번 주 토요일 오후에 커트 예약하고 싶어요
봇:   (getAvailability 호출) 토요일에는 14:00, 14:40, 15:30이 비어 있어요. 어느 시간이 좋으세요?
고객: 14:40이요
봇:   예약을 위해 휴대폰 번호를 알려주세요
고객: 010-1234-5678
봇:   (requestOtp 호출) 방금 보내드린 인증번호 6자리를 알려주세요
고객: 482913
봇:   (verifyOtp 호출 → 토큰 획득, 대화 중에만 기억) (createReservation 호출) 토요일 14:40 커트 예약을 접수했어요. 매장에서 확인 후 확정돼요.
```

## 준비된 것 / 아직 없는 것

- **API는 이미 동작합니다.** [docs/booking-api-openapi.json](booking-api-openapi.json)이 OpenAPI 3.1 스펙이고, 지금 서버(`https://smallerp.sean2022.one:3001`)에 그대로 요청할 수 있습니다.
- **실제 SMS 인증문자는 아직 안 나갑니다.** 문자 에이전시 연동 전이라 `otp/request` 응답의 `devCode`로만 테스트할 수 있습니다(운영 환경에서는 이 필드가 사라집니다). 실제 고객에게 이 봇을 노출하려면 [README의 "문자 에이전시 실연동"](../README.md) 항목이 먼저 필요합니다.
- **공유기 포트포워딩**도 아직 안 되어 있다면 외부(OpenAI/Anthropic 서버)에서 우리 서버로 접근이 안 됩니다. ChatGPT Actions·Claude API는 모두 인터넷에서 우리 서버로 직접 HTTPS 요청을 보내야 합니다.
- 매장별 예약 코드(`code`, 예: 설정 > 솔루션 간편설정의 예약 링크에 있는 `?s=` 값)를 미리 알아야 합니다. 챗봇 하나를 특정 매장 전용으로 만든다면 시스템 프롬프트에 이 코드를 고정해 두세요.

## 방법 A. ChatGPT (Custom GPT의 Actions)

1. ChatGPT에서 "GPT 만들기" → Configure → Actions → "Import from URL" 또는 스키마 붙여넣기에 [docs/booking-api-openapi.json](booking-api-openapi.json) 내용을 그대로 넣습니다.
2. 인증(Authentication)은 "None"으로 둡니다. 토큰은 매 대화마다 `otp/verify`가 돌려주는 값을 모델이 직접 기억했다가 다음 호출의 Authorization 헤더로 넘기는 방식이라, GPT가 대화 맥락 안에서 알아서 처리합니다(OpenAPI에 `security: bearer`로 명시돼 있어 모델이 이 규칙을 인지합니다).
3. Instructions(시스템 프롬프트)에 매장 코드를 박아 두세요. 예: "이 매장의 예약 코드(code 파라미터)는 항상 `ackk-3Z`이다. 고객에게 코드를 묻지 마라."
4. 예약 확정 여부(`status: pending`/`confirmed`)를 사용자에게 그대로 알려주도록 지시해 두면, 매장이 "확인필요" 정책을 쓰고 있을 때 혼선이 없습니다.

## 방법 B. Claude API로 직접 챗봇을 만드는 경우

Claude API의 `tools` 파라미터는 OpenAPI operation과 거의 1:1로 대응하는 JSON Schema입니다. 예시(핵심 두 개만):

```json
[
  {
    "name": "getAvailability",
    "description": "특정 날짜에 예약 가능한 시간을 조회한다",
    "input_schema": {
      "type": "object",
      "required": ["date", "serviceIds"],
      "properties": {
        "date": { "type": "string", "description": "YYYY-MM-DD" },
        "serviceIds": { "type": "string", "description": "쉼표로 구분된 시술 ID" }
      }
    }
  },
  {
    "name": "createReservation",
    "description": "본인 인증(토큰)이 끝난 고객의 예약을 생성한다",
    "input_schema": {
      "type": "object",
      "required": ["startAt", "serviceIds", "customerToken"],
      "properties": {
        "startAt": { "type": "string", "description": "YYYY-MM-DDTHH:mm" },
        "serviceIds": { "type": "array", "items": { "type": "integer" } },
        "customerToken": { "type": "string", "description": "otp/verify 로 받은 토큰" }
      }
    }
  }
]
```

나머지 5개 도구(`getShopInfo`, `requestOtp`, `verifyOtp`, `listMyReservations`, `cancelReservation`)도 [docs/booking-api-openapi.json](booking-api-openapi.json)의 각 `operationId`·`requestBody`를 그대로 옮기면 됩니다. 실행부(tool 호출을 실제 HTTP 요청으로 바꾸는 코드)는 여러분의 서버(백엔드)에서 이 문서의 매장 코드를 고정 값으로 채워 `fetch`하면 됩니다 — Claude 자체는 HTTP를 직접 호출하지 못하므로, 여러분 쪽 코드가 "Claude가 요청한 tool 호출 → 우리 API 호출 → 결과를 다시 Claude에 전달"을 중계해야 합니다(Claude API의 표준 tool_use 루프).

## 방법 C. Claude Desktop/Code용 MCP 서버 (개발자용, 참고)

Claude Desktop이나 Claude Code에 이 API를 "커넥터"로 붙이고 싶다면 위 7개 엔드포인트를 감싸는 작은 MCP 서버를 만들 수 있습니다. 다만 이건 개발자가 자기 PC에 설정하는 방식이라, 미용실 손님이 직접 설정할 만한 경로는 아닙니다 — 손님용으로는 방법 A(카카오톡 채널·웹 채팅 등에 얹는 ChatGPT/Claude 챗봇)가 더 현실적입니다. 필요하시면 별도로 만들어 드리겠습니다.

## 보안 참고

- `otp/request`는 번호당 하루 8회, 60초 재발송 간격으로 이미 제한돼 있어 챗봇을 공개해도 한 사람에게 문자 폭탄을 보내는 것은 막혀 있습니다.
- 예약 생성·조회·취소는 전부 `otp/verify`로 받은 토큰 소유자 본인 것만 가능합니다(서버가 강제).
- 매장이 "확인필요(pending)" 정책을 쓰면 챗봇이 만든 예약도 사장이 직접 확정해야 최종 확정됩니다. 챗봇에 예약을 전부 맡기고 싶다면 설정 > 솔루션 간편설정에서 "접수 즉시 자동 확정"을 켜세요.
