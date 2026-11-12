import './helpers/test-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { exchangeAuthorizationCode } from '../server/shopee-auth.mjs';

const env = { SHOPEE_PARTNER_ID: '12345', SHOPEE_PARTNER_KEY: 'fixture-key raw ' };
const input = { code: 'fixture-code', mainAccountId: '67890' };
const timestamp = 1792345678;
const success = { access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expire_in: 14400 };

test('主账号交换使用官方 host、原始 key 签名和主账号正文，只发一次请求', async () => {
  let calls = 0;
  const result = await exchangeAuthorizationCode(input, env, { timestamp, fetchImpl: async (address, options) => {
    calls += 1;
    const url = new URL(address);
    assert.equal(url.origin, 'https://partner.shopeemobile.com');
    assert.equal(url.pathname, '/api/v2/auth/token/get');
    assert.deepEqual([...url.searchParams.keys()].sort(), ['partner_id', 'sign', 'timestamp']);
    assert.equal(url.searchParams.get('partner_id'), '12345');
    assert.equal(url.searchParams.get('timestamp'), String(timestamp));
    assert.equal(url.searchParams.get('sign'), createHmac('sha256', 'fixture-key raw ').update('12345/api/v2/auth/token/get1792345678').digest('hex'));
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['content-type'], 'application/json');
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), { code: 'fixture-code', partner_id: 12345, main_account_id: 67890 });
    return { ok: true, json: async () => ({ ...success, shop_id_list: [987], merchant_id_list: [654] }) };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { ...success, shop_id_list: [987], merchant_id_list: [654] });
  const withoutLists = await exchangeAuthorizationCode(input, env, { timestamp, fetchImpl: async () => ({ ok: true, json: async () => success }) });
  assert.deepEqual(withoutLists, success);
  assert.ok(!Object.hasOwn(withoutLists, 'shop_id'));
});

test('缺少凭据、无效主账号 ID 或空授权码不发请求', async () => {
  let calls = 0;
  const options = { timestamp, fetchImpl: async () => { calls += 1; } };
  await assert.rejects(exchangeAuthorizationCode(input, {}, options), /应用凭据/);
  await assert.rejects(exchangeAuthorizationCode(input, { ...env, SHOPEE_PARTNER_KEY: '  ' }, options), /应用凭据/);
  for (const mainAccountId of [undefined, '', 0, -1, 1.5, '1e3', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(exchangeAuthorizationCode({ ...input, mainAccountId }, env, options), /主账号 ID/);
  }
  await assert.rejects(exchangeAuthorizationCode({ ...input, code: ' ' }, env, options), /授权码为空/);
  assert.equal(calls, 0);
});

test('HTTP/API 错误不重试且不抛出消息、密钥、授权码或令牌响应', async () => {
  for (const ok of [true, false]) {
    let calls = 0;
    await assert.rejects(exchangeAuthorizationCode(input, env, { timestamp, fetchImpl: async () => {
      calls += 1;
      return { ok, json: async () => ({ ...success, error: 'error_auth', request_id: 'request-123', message: `${env.SHOPEE_PARTNER_KEY}${input.code}${success.access_token}` }) };
    } }), error => {
      assert.equal(error.code, 'error_auth');
      assert.equal(error.requestId, 'request-123');
      const visible = `${error.stack}${JSON.stringify(error)}`;
      for (const secret of [env.SHOPEE_PARTNER_KEY, input.code, success.access_token, success.refresh_token]) assert.ok(!visible.includes(secret));
      return true;
    });
    assert.equal(calls, 1);
  }
  await assert.rejects(exchangeAuthorizationCode(input, env, { timestamp, fetchImpl: async () => ({
    ok: false, json: async () => ({ ...success, error: input.code, request_id: success.access_token }),
  }) }), error => error.code === undefined && error.requestId === undefined);
});

test('网络异常和非法 JSON 仅返回脱敏错误，不重试', async () => {
  for (const badJson of [false, true]) {
    let calls = 0;
    await assert.rejects(exchangeAuthorizationCode(input, env, { timestamp, fetchImpl: async () => {
      calls += 1;
      if (!badJson) throw new Error(`${env.SHOPEE_PARTNER_KEY}${input.code}`);
      return { ok: true, json: async () => { throw new SyntaxError(success.access_token); } };
    } }), error => error.message === '授权交换请求失败，未自动重试。');
    assert.equal(calls, 1);
  }
});

test('20 秒截止信号终止请求且不重试', async t => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', duration => {
    assert.equal(duration, 20_000);
    return controller.signal;
  });
  let calls = 0;
  await assert.rejects(exchangeAuthorizationCode(input, env, { timestamp, fetchImpl: async (address, options) => {
    calls += 1;
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      controller.abort(new DOMException('fixture timeout', 'TimeoutError'));
    });
  } }), /授权交换超时，未自动重试/);
  assert.equal(calls, 1);
});

test('成功响应必需包含非空双令牌和有效过期秒数', async () => {
  for (const payload of [{}, { ...success, access_token: ' ' }, { ...success, refresh_token: null }, { ...success, expire_in: 0 }, { ...success, expire_in: '14400' }]) {
    await assert.rejects(exchangeAuthorizationCode(input, env, { timestamp, fetchImpl: async () => ({ ok: true, json: async () => payload }) }), /授权响应缺少有效令牌或过期时间/);
  }
});
