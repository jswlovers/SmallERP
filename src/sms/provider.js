// 문자 발송 어댑터. 실제 에이전시(알리고/솔라피/NHN 등)는 같은 인터페이스로 구현해 교체한다.
//   send({ to, body, isAd }) => Promise<{ ok: boolean, error?: string }>
export const SMS_COST = { sms: 20, lms: 50 };

/** 한글 2byte 기준 90byte 초과 시 LMS */
export function smsType(body) {
  let n = 0;
  for (const ch of body) n += ch.charCodeAt(0) > 127 ? 2 : 1;
  return n > 90 ? 'lms' : 'sms';
}

export const mockProvider = {
  name: 'mock',
  sent: [],
  async send({ to, body, isAd }) {
    this.sent.push({ to, body, isAd });
    if (process.env.SMS_LOG !== '0') console.log(`[SMS mock] -> ${to}: ${body}`);
    return { ok: true };
  },
};
