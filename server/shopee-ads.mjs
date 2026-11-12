import { createHmac } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const authFile = fileURLToPath(new URL('../.local/shopee-auth.json', import.meta.url));
const paths = { shop: '/api/v2/shop/get_shop_info', balance: '/api/v2/ads/get_total_balance', daily: '/api/v2/ads/get_all_cpc_ads_daily_performance',
  campaignIndex: '/api/v2/ads/get_product_level_campaign_id_list', campaignSettings: '/api/v2/ads/get_product_level_campaign_setting_info', campaignDaily: '/api/v2/ads/get_product_campaign_daily_performance', gmsItems: '/api/v2/ads/get_gms_item_performance', gmsCampaign: '/api/v2/ads/get_gms_campaign_performance',
  orderList: '/api/v2/order/get_order_list', orderDetail: '/api/v2/order/get_order_detail', escrow: '/api/v2/payment/get_escrow_detail', warehouse: '/api/v2/shop/get_warehouse_detail',
  returnList: '/api/v2/returns/get_return_list', returnDetail: '/api/v2/returns/get_return_detail',
  itemList: '/api/v2/product/get_item_list', itemBase: '/api/v2/product/get_item_base_info', modelList: '/api/v2/product/get_model_list' };
export function createAdsClient({ file = authFile, env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  let queue = Promise.resolve();
  async function auth() {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (Number(env.SHOPEE_PARTNER_ID) !== value.partner_id || !env.SHOPEE_PARTNER_KEY || !Array.isArray(value.shop_id_list) || !value.shop_id_list.every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('授权文件与当前应用不一致，请重新授权。');
    return value;
  }
  // 商品类接口常带非致命的 warning（如个别字段说明），不应让整次库存同步失败；余额、广告等金额接口仍然严格。
  const tolerant = new Set(['itemList', 'itemBase', 'modelList']);
  async function request(path, params, body, { allowWarning = false } = {}) {
    const timestamp = Math.floor(now() / 1000), partner = Number(env.SHOPEE_PARTNER_ID);
    const suffix = params.access_token && params.shop_id ? `${params.access_token}${params.shop_id}` : '';
    const sign = createHmac('sha256', env.SHOPEE_PARTNER_KEY).update(`${partner}${path}${timestamp}${suffix}`).digest('hex');
    const url = new URL(path, 'https://partner.shopeemobile.com');
    url.search = new URLSearchParams({ partner_id: String(partner), timestamp: String(timestamp), sign, ...params });
    let response, payload;
    try {
      response = await fetchImpl(url.href, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(20000) });
      payload = await response.json();
    } catch { throw new Error('Shopee 请求未完成，请检查网络；未自动重试。'); }
    if (!response.ok || (payload.error && payload.error !== 0)) {
      const secrets = [env.SHOPEE_PARTNER_KEY, params.access_token, body?.refresh_token].filter(Boolean);
      const code = typeof payload.error === 'string' && /^[\w.\-]{1,60}$/.test(payload.error) && !secrets.some(value => payload.error.includes(value)) ? payload.error : 'request_rejected';
      if (/rate_limit/.test(code) || response.status === 429) throw new Error(`Shopee 请求频率受限（${code}），请稍后重试；不能据此判断授权失效。`);
      throw new Error(`Shopee 接口拒绝请求（${code}），请核对授权和该模块的接口权限。`);
    }
    if (payload.warning && !allowWarning) throw new Error('Shopee 返回数据警告，本次数据不用于余额估算。');
    return payload;
  }
  async function token(shopId) {
    const work = queue.then(async () => {
      const data = await auth();
      if (!data.shop_id_list.includes(shopId)) throw new Error('店铺不在当前授权范围内。');
      const saved = data.shop_tokens?.[shopId] || data;
      if (Date.parse(saved.expires_at) > now() + 60000 && saved.access_token) return saved.access_token;
      if (saved.refresh_pending || !saved.refresh_token) throw new Error('令牌刷新状态待核对，请重新授权后检查。');
      data.shop_tokens ||= {};
      data.shop_tokens[shopId] = { ...saved, shop_id_list: undefined, shop_tokens: undefined, refresh_pending: true };
      async function persist() { await writeFile(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 }); await rename(`${file}.tmp`, file); }
      await persist();
      const result = await request('/api/v2/auth/access_token/get', {}, { refresh_token: saved.refresh_token, partner_id: data.partner_id, shop_id: shopId });
      if (!result.access_token || !result.refresh_token || !Number.isSafeInteger(result.expire_in) || result.expire_in <= 0 || Number(result.shop_id) !== shopId) throw new Error('令牌刷新响应不完整，请重新授权；未重复使用刷新令牌。');
      data.shop_tokens[shopId] = { access_token: result.access_token, refresh_token: result.refresh_token, expires_at: new Date(now() + result.expire_in * 1000).toISOString() };
      await persist();
      return result.access_token;
    });
    queue = work.catch(() => {});
    return work;
  }
  return {
    async shops() { return (await auth()).shop_id_list; },
    async get(kind, shopId, params = {}) {
      if (!Object.hasOwn(paths, kind)) throw new Error('不支持的读取接口。');
      const access = await token(shopId);
      if (['gmsItems', 'gmsCampaign'].includes(kind)) return request(paths[kind], { access_token: access, shop_id: String(shopId) }, params);
      return request(paths[kind], { ...params, access_token: access, shop_id: String(shopId) }, undefined, { allowWarning: tolerant.has(kind) });
    }
  };
}
