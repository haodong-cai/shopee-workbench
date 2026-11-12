import './helpers/test-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createLanAccess, loginPage } from '../server/lan.mjs';
import { createApp } from '../server/index.mjs';

// 测试里所有连接都来自 127.0.0.1，用请求头 x-test-ip 模拟局域网里的其他电脑。
async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'shopee-lan-')), file = path.join(dir, 'lan.json');
  const clock = { now: Date.parse('2026-11-11T08:00:00Z') };
  const lan = createLanAccess({ file, port: 8787, now: () => clock.now, addressOf: req => req.headers['x-test-ip'] || req.socket.remoteAddress,
    interfaces: () => new Set(['127.0.0.1', '::1', '192.168.1.20']), urls: () => [{ name: 'WLAN', url: 'http://192.168.1.20:8787' }], hostname: 'WIN-HOST', ...options });
  const operations = { snapshot: async () => ({ shops: [], job: { running: false } }), sync: async () => ({ running: true }), wait: async () => {} };
  const server = await new Promise(resolve => { const started = createApp({ operations, lan }).listen(0, '127.0.0.1', () => resolve(started)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  // fetch 会忽略自定义 Host，这里用 http.request 才能模拟“用局域网地址 / 陌生域名访问”。
  const port = server.address().port;
  const call = (pathName, { ip, host = '192.168.1.20:8787', cookie, method = 'GET', body, origin } = {}) => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method, setHost: false, headers: { host, ...(ip ? { 'x-test-ip': ip } : {}), ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: { get: name => { const v = res.headers[name.toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v ?? null; } }, text: async () => text, json: async () => JSON.parse(text) }); });
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
  return { file, clock, lan, call };
}
const colleague = '192.168.1.35';

test('本机始终可用；首次启动默认开启、不需要访问码，同事直接可用', async t => {
  const { call, file } = await setup(t);
  const local = await (await call('/api/lan', { host: '127.0.0.1:8787' })).json();
  assert.deepEqual([local.local, local.enabled, local.requireCode, local.urls[0].url, local.devices], [true, true, false, 'http://192.168.1.20:8787', 0]);
  assert.equal((await call('/api/operations', { ip: colleague })).status, 200, '默认同事打开地址直接可用');
  assert.equal((await call('/', { ip: colleague })).status, 200);
  assert.match(local.code, /^\d{6}$/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).code, local.code);
  assert.equal((await call('/api/operations', { host: 'localhost:8787' })).status, 200);
  assert.equal((await call('/api/operations', { host: 'win-host:8787' })).status, 200, '用本机名访问也算本机');
});

test('勾选访问码后：没登录时页面给出访问码输入页、接口 401；输错锁定；输对后记住 30 天', async t => {
  const { call, clock } = await setup(t);
  await call('/api/lan', { host: '127.0.0.1:8787', method: 'PUT', body: { requireCode: true } });
  const code = (await (await call('/api/lan', { host: '127.0.0.1:8787' })).json()).code;
  const page = await call('/', { ip: colleague });
  assert.equal(page.status, 401); assert.match(await page.text(), /输入访问码/);
  const api = await call('/api/operations', { ip: colleague });
  assert.equal(api.status, 401); assert.equal((await api.json()).needCode, true);
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal((await call('/api/lan/login', { ip: colleague, method: 'POST', body: { code: wrong } })).status, 401);
  assert.equal((await call('/api/lan/login', { ip: colleague, method: 'POST', body: { code }, origin: 'http://evil.example' })).status, 403, '跨站登录请求拒绝');
  const ok = await call('/api/lan/login', { ip: colleague, method: 'POST', body: { code }, origin: 'http://192.168.1.20:8787' });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=2592000/);
  assert.equal((await call('/api/operations', { ip: colleague, cookie })).status, 200);
  const seen = await (await call('/api/lan', { ip: colleague, cookie })).json();
  assert.deepEqual([seen.local, seen.code, seen.devices], [false, undefined, undefined], '同事看不到访问码');
  clock.now += 31 * 86400000;
  assert.equal((await call('/api/operations', { ip: colleague, cookie })).status, 401, '30 天未使用后失效');
  for (let i = 0; i < 8; i++) await call('/api/lan/login', { ip: '192.168.1.99', method: 'POST', body: { code: wrong } });
  assert.equal((await call('/api/lan/login', { ip: '192.168.1.99', method: 'POST', body: { code } })).status, 429);
});

test('只有主机能改开关、换访问码；关闭后同事无法访问；换码后旧登录失效；免访问码模式', async t => {
  const { call } = await setup(t);
  await call('/api/lan', { host: '127.0.0.1:8787', method: 'PUT', body: { requireCode: true } });
  const code = (await (await call('/api/lan', { host: '127.0.0.1:8787' })).json()).code;
  const cookie = (await call('/api/lan/login', { ip: colleague, method: 'POST', body: { code } })).headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/api/lan', { ip: colleague, cookie, method: 'PUT', body: { enabled: false } })).status, 403);
  assert.equal((await call('/api/lan/regenerate', { ip: colleague, cookie, method: 'POST', body: {} })).status, 403);
  assert.equal((await call('/api/lan', { host: '127.0.0.1:8787', method: 'PUT', body: { enabled: 'no' } })).status, 400);
  assert.equal((await (await call('/api/lan', { host: '127.0.0.1:8787', method: 'PUT', body: { enabled: false } })).json()).enabled, false);
  const blocked = await call('/api/operations', { ip: colleague, cookie });
  assert.equal(blocked.status, 403); assert.match((await blocked.json()).error, /未开启局域网访问/);
  assert.equal((await call('/api/operations', { host: '127.0.0.1:8787' })).status, 200, '关闭后本机照常使用');
  await call('/api/lan', { host: '127.0.0.1:8787', method: 'PUT', body: { enabled: true } });
  const fresh = await (await call('/api/lan/regenerate', { host: '127.0.0.1:8787', method: 'POST', body: {} })).json();
  assert.notEqual(fresh.code, undefined); assert.equal(fresh.devices, 0);
  assert.equal((await call('/api/operations', { ip: colleague, cookie })).status, 401, '换码后需重新输入');
  await call('/api/lan', { host: '127.0.0.1:8787', method: 'PUT', body: { requireCode: false } });
  assert.equal((await call('/api/operations', { ip: colleague })).status, 200, '关闭访问码后同网络直接可用');
});

test('陌生域名一律拒绝（防 DNS 重绑定）；写操作校验来源；损坏设置不覆盖', async t => {
  const { call, file } = await setup(t);
  assert.equal((await call('/api/lan', { host: 'evil.example:8787' })).status, 403);
  assert.equal((await call('/', { host: 'evil.example' })).status, 403);
  assert.equal((await call('/api/operations/sync', { host: '127.0.0.1:8787', method: 'POST', body: {}, origin: 'http://evil.example' })).status, 403);
  assert.equal((await call('/api/operations/sync', { host: '192.168.1.20:8787', method: 'POST', body: {}, origin: 'http://192.168.1.20:8787' })).status, 202, '用局域网地址打开的页面也能发起同步');
  await writeFile(file, '{broken');
  const other = createLanAccess({ file, interfaces: () => new Set(['127.0.0.1']), hostname: 'x' });
  await assert.rejects(() => other.status({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), /局域网访问设置读取失败/);
  assert.equal(await readFile(file, 'utf8'), '{broken');
  assert.match(loginPage(), /访问码/);
});
