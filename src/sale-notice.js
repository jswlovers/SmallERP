import { sendToCustomer } from './messaging.js';

/** 결제된 상품의 실제 만료일을 사용해 안내한다. 문자 오류로 결제를 실패시키지 않는다. */
export async function saleNotice(ctx, shopId, customer, { kind, name, amount, expiresAt, paymentId }) {
  const shop = ctx.db.prepare('SELECT name FROM shop WHERE id = ?').get(shopId);
  const validity = expiresAt ? `유효기간은 ${expiresAt}까지입니다. 해당 날짜까지 이용해 주세요.` : '유효기간 제한 없이 이용하실 수 있습니다.';
  const body = `[${shop.name}] ${customer.name}님, ${name} ${kind} 결제가 완료되었습니다.\n${amount}\n${validity}\n이용 관련 문의는 매장으로 연락해 주세요.`;
  let result;
  try {
    result = await sendToCustomer(ctx, shopId, customer, { body, isAd: false, refKey: `sale-validity:${paymentId}` });
  } catch (e) {
    result = { status: 'failed', reason: '문자 처리 오류' };
  }
  return { body, ...result, simulated: ctx.sms.name === 'mock' };
}
