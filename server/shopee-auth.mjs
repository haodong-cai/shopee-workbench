import { createHmac } from 'node:crypto';

const tokenPath = '/api/v2/auth/token/get';
const tokenHost = 'https://partner.shopeemobile.com';

function positiveId(value) {
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function exchangeError(message, payload, secrets) {
  const error = new Error(message);
  const hidden = [...secrets, payload?.access_token, payload?.refresh_token].filter(value => typeof value === 'string' && value.length > 0);
  for (const [source, target] of [['error', 'code'], ['request_id', 'requestId']]) {
    const value = payload?.[source];
    if (typeof value === 'string' && /^[\w.-]{1,100}$/.test(value) && !hidden.some(secret => value.includes(secret))) error[target] = value;
  }
  return error;
}

// 授权码换令牌：主账号授权传 mainAccountId（一次覆盖多个店铺），单店授权传 shopId。
export async function exchangeAuthorizationCode({ code, mainAccountId, shopId } = {}, env = process.env, { fetchImpl = fetch, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const partnerId = positiveId(env.SHOPEE_PARTNER_ID);
  const partnerKey = env.SHOPEE_PARTNER_KEY;
  if (!partnerId || typeof partnerKey !== 'string' || !partnerKey.trim()) throw new Error('应用凭据未配置或无效。');
  const singleShop = shopId !== undefined && shopId !== null && shopId !== '' ? positiveId(shopId) : null;
  if ((shopId !== undefined && shopId !== null && shopId !== '') && !singleShop) throw new Error('店铺 ID 无效。');
  const mainId = singleShop ? null : positiveId(mainAccountId);
  if (!singleShop && !mainId) throw new Error('主账号 ID 无效。');
  if (typeof code !== 'string' || !code.trim()) throw new Error('授权码为空。');
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error('签名时间无效。');
  const sign = createHmac('sha256', partnerKey).update(`${partnerId}${tokenPath}${timestamp}`).digest('hex');
  const url = new URL(tokenPath, tokenHost);
  url.search = new URLSearchParams({ partner_id: String(partnerId), timestamp: String(timestamp), sign }).toString();
  const secrets = [partnerKey, code];
  const signal = AbortSignal.timeout(20_000);
  let response;
  let payload;
  try {
    response = await fetchImpl(url.href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(singleShop ? { code, partner_id: partnerId, shop_id: singleShop } : { code, partner_id: partnerId, main_account_id: mainId }),
      redirect: 'error',
      signal,
    });
    payload = await response.json();
  } catch (error) {
    throw new Error(signal.aborted || ['TimeoutError', 'AbortError'].includes(error?.name) ? '授权交换超时，未自动重试。' : '授权交换请求失败，未自动重试。');
  }
  if (!response.ok || (payload?.error !== undefined && payload.error !== null && payload.error !== '' && payload.error !== 0)) {
    throw exchangeError('虾皮拒绝授权交换。', payload, secrets);
  }
  if (!payload || Array.isArray(payload) || typeof payload !== 'object' ||
      typeof payload.access_token !== 'string' || !payload.access_token.trim() ||
      typeof payload.refresh_token !== 'string' || !payload.refresh_token.trim() ||
      !Number.isSafeInteger(payload.expire_in) || payload.expire_in <= 0) {
    throw exchangeError('授权响应缺少有效令牌或过期时间。', payload, secrets);
  }
  const result = { access_token: payload.access_token, refresh_token: payload.refresh_token, expire_in: payload.expire_in };
  for (const field of ['shop_id_list', 'merchant_id_list']) {
    if (Object.hasOwn(payload, field)) result[field] = payload[field];
  }
  return result;
}
