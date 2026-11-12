import './helpers/test-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildAuthLink, parseCallback, saveAuthorization } from '../server/shop-authorize.mjs';
import { parseBusinessConfig } from '../server/business-config.mjs';

const env = { SHOPEE_PARTNER_ID: '1000001', SHOPEE_PARTNER_KEY: 'fixture-key' };

test('授权链接：按官方规则签名，带回跳地址；缺凭据时给出提示', () => {
  const url = new URL(buildAuthLink({ env, timestamp: 1700000000, redirect: 'http://127.0.0.1:8787/auth/callback' }));
  assert.equal(url.origin + url.pathname, 'https://partner.shopeemobile.com/api/v2/shop/auth_partner');
  assert.equal(url.searchParams.get('sign'), createHmac('sha256', 'fixture-key').update('1000001/api/v2/shop/auth_partner1700000000').digest('hex'));
  assert.equal(url.searchParams.get('redirect'), 'http://127.0.0.1:8787/auth/callback');
  assert.match(new URL(buildAuthLink({ env: { ...env, SHOPEE_ENVIRONMENT: 'sandbox' } })).host, /test-stable/);
  assert.throws(() => buildAuthLink({ env: {} }), /SHOPEE_PARTNER_ID/);
});

test('回跳地址解析：完整地址或查询串都可以；缺 code 报错', () => {
  assert.deepEqual(parseCallback('http://127.0.0.1:8787/auth/callback?code=abc&shop_id=123'), { code: 'abc', shopId: '123', mainAccountId: null });
  assert.deepEqual(parseCallback('code=abc&main_account_id=9'), { code: 'abc', shopId: null, mainAccountId: '9' });
  assert.throws(() => parseCallback('https://x.test/?shop_id=1'), /没有 code/);
});

test('保存授权：单店逐个合并，主账号授权写入店铺列表；令牌不外泄', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'shopee-authz-')), file = path.join(dir, 'shopee-auth.json');
  const bodies = [];
  const fetchImpl = async (url, init) => { const body = JSON.parse(init.body); bodies.push(body);
    return { ok: true, json: async () => body.shop_id ? { access_token: `at-${body.shop_id}`, refresh_token: `rt-${body.shop_id}`, expire_in: 14400 } : { access_token: 'at-main', refresh_token: 'rt-main', expire_in: 14400, shop_id_list: [7, 8], merchant_id_list: [] } }; };
  const now = () => Date.parse('2026-11-11T00:00:00Z');
  assert.deepEqual(await saveAuthorization({ code: 'c1', shopId: '5' }, { env, file, fetchImpl, now }), { shops: [5], total: 1 });
  assert.deepEqual(await saveAuthorization({ code: 'c2', shopId: '6' }, { env, file, fetchImpl, now }), { shops: [6], total: 2 });
  assert.deepEqual(await saveAuthorization({ code: 'c3', mainAccountId: '9' }, { env, file, fetchImpl, now }), { shops: [7, 8], total: 4 });
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual([saved.partner_id, saved.shop_id_list, saved.shop_tokens[5].access_token, saved.shop_tokens[6].expires_at, saved.access_token, saved.main_account_id], [1000001, [5, 6, 7, 8], 'at-5', '2026-11-11T04:00:00.000Z', 'at-main', 9]);
  assert.deepEqual([bodies[0].shop_id, bodies[0].main_account_id, bodies[2].main_account_id], [5, undefined, 9]);
});

test('经营参数：空白一律视为未设置，不按 0 计算', () => {
  const blank = parseBusinessConfig({ overseasFees: { MY: { packingPerOrder: null, transportPerPair: 1 } }, crossBorderPerPair: null, leadDays: { TH: null }, skuPrefixes: { shoe: '', accessory: '(' } });
  assert.deepEqual([blank.overseasFees, blank.crossBorderPerPair, blank.leadDays, blank.safetyDays, blank.skuPrefixes.shoe, blank.skuPrefixes.accessory], [{}, null, {}, 3, null, null]);
  const filled = parseBusinessConfig({ overseasFees: { TH: { packingPerOrder: 2, transportPerPair: 1 } }, crossBorderPerPair: 0.5, leadDays: { TH: 15 }, knownAdCampaignIds: { TH: [1, 'x'] } });
  assert.deepEqual([filled.overseasFees.TH.packingPerOrder, filled.crossBorderPerPair, filled.leadDays.TH, filled.knownAdCampaignIds.TH], [2, 0.5, 15, [1]]);
});
