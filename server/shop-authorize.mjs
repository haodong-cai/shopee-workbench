import { createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exchangeAuthorizationCode } from './shopee-auth.mjs';

// 店铺授权：生成授权链接 → 卖家在虾皮页面确认 → 回跳地址带 code + shop_id（或 main_account_id）→ 换取令牌并写入 .local/shopee-auth.json。
// 令牌只保存在本机 .local（已被 .gitignore 排除），不会出现在页面、日志或仓库里。
const AUTH_PATH = '/api/v2/shop/auth_partner';
const HOSTS = { live: 'https://partner.shopeemobile.com', sandbox: 'https://partner.test-stable.shopeemobile.com' };
export const DEFAULT_REDIRECT = 'http://127.0.0.1:8787/auth/callback';
const defaultFile = fileURLToPath(new URL('../.local/shopee-auth.json', import.meta.url));

function credentials(env) {
  const partnerId = Number(env.SHOPEE_PARTNER_ID), partnerKey = env.SHOPEE_PARTNER_KEY;
  if (!Number.isSafeInteger(partnerId) || partnerId <= 0 || typeof partnerKey !== 'string' || !partnerKey.trim()) throw new Error('请先在 .env 里填写 SHOPEE_PARTNER_ID 和 SHOPEE_PARTNER_KEY，并重启工作台。');
  return { partnerId, partnerKey: partnerKey.trim() };
}

/** 生成授权链接（有效期约 5 分钟，过期重新生成即可）。 */
export function buildAuthLink({ redirect = process.env.SHOPEE_REDIRECT_URL || DEFAULT_REDIRECT, env = process.env, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const { partnerId, partnerKey } = credentials(env);
  const sign = createHmac('sha256', partnerKey).update(`${partnerId}${AUTH_PATH}${timestamp}`).digest('hex');
  const url = new URL(AUTH_PATH, HOSTS[env.SHOPEE_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'live']);
  url.search = new URLSearchParams({ partner_id: String(partnerId), timestamp: String(timestamp), sign, redirect }).toString();
  return url.href;
}

/** 从回跳地址（或其查询串）里取出 code、shop_id、main_account_id。 */
export function parseCallback(input) {
  const text = String(input || '').trim();
  let params;
  try { params = new URL(text).searchParams; } catch { params = new URLSearchParams(text.replace(/^\?/, '')); }
  const code = params.get('code'), shopId = params.get('shop_id'), mainAccountId = params.get('main_account_id');
  if (!code) throw new Error('回跳地址里没有 code，请确认复制的是授权完成后浏览器地址栏里的完整地址。');
  if (!shopId && !mainAccountId) throw new Error('回跳地址里没有 shop_id 或 main_account_id。');
  return { code, shopId: shopId || null, mainAccountId: mainAccountId || null };
}

/** 换取令牌并合并写入授权文件；返回本次新增 / 更新的店铺 ID。 */
export async function saveAuthorization({ code, shopId, mainAccountId }, { env = process.env, file = defaultFile, fetchImpl = fetch, now = Date.now } = {}) {
  const { partnerId } = credentials(env);
  const tokens = await exchangeAuthorizationCode({ code, shopId: shopId || undefined, mainAccountId: mainAccountId || undefined }, env, { fetchImpl });
  let data = null;
  try { data = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('现有授权文件损坏，请先备份并删除 .local/shopee-auth.json 后重试。'); }
  if (!data || data.partner_id !== partnerId) data = { partner_id: partnerId, shop_id_list: [], shop_tokens: {} };
  data.shop_tokens ||= {}; data.shop_id_list ||= [];
  const t = now(), expiresAt = new Date(t + tokens.expire_in * 1000).toISOString();
  let shops;
  if (shopId) {
    shops = [Number(shopId)];
    data.shop_tokens[Number(shopId)] = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: expiresAt };
  } else {
    shops = (tokens.shop_id_list || []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
    if (!shops.length) throw new Error('主账号授权没有返回任何店铺，请在授权页面勾选店铺后重试。');
    Object.assign(data, { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expire_in: tokens.expire_in, main_account_id: Number(mainAccountId), merchant_id_list: tokens.merchant_id_list || [], acquired_at: new Date(t).toISOString(), expires_at: expiresAt });
    for (const id of shops) delete data.shop_tokens[id]; // 主账号令牌覆盖这些店铺，首次使用时按店铺刷新
  }
  data.shop_id_list = [...new Set([...data.shop_id_list, ...shops])];
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
  return { shops, total: data.shop_id_list.length };
}
