import './helpers/test-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createControlStatus, credentialFields, loadLocalEnvironment } from '../server/control.mjs';
import { createApp } from '../server/index.mjs';

test('缺项和空白凭据显示未配置，未知数据保持 null', () => {
  const status = createControlStatus({ SHOPEE_PARTNER_ID: '  ' });
  assert.equal(status.connection.status, 'not_configured');
  assert.equal(status.connection.configured, false);
  assert.equal(status.connection.verified, false);
  assert.deepEqual(status.connection.missing, credentialFields);
  assert.ok(Object.values(status.connection.fields).every(present => present === false));
  for (const dataset of Object.values(status.datasets)) {
    assert.equal(dataset.status, 'pending_sync');
    assert.equal(dataset.count, null);
    assert.equal(dataset.lastSyncedAt, null);
  }
  assert.equal(status.datasets.metrics.amount, null);
  assert.equal(status.datasets.metrics.currency, null);
});

test('完整配置仍待验证，状态仅包含字段存在性', () => {
  const env = Object.fromEntries(credentialFields.map((field, index) => [field, `credential-secret-${index}`]));
  const status = createControlStatus({ ...env, SHOPEE_ENVIRONMENT: 'sandbox' });
  assert.equal(status.connection.status, 'pending_validation');
  assert.equal(status.connection.configured, true);
  assert.equal(status.connection.verified, false);
  assert.deepEqual(status.connection.missing, []);
  assert.ok(Object.values(status.connection.fields).every(present => present === true));
  assert.equal(status.system.environment, 'sandbox');
  assert.equal(status.system.externalApi, 'not_verified');
  assert.equal(status.features.data_center.status, 'pending_connection');
  for (const secret of Object.values(env)) assert.ok(!JSON.stringify(status).includes(secret));
  assert.equal(createControlStatus({ SHOPEE_ENVIRONMENT: 'unknown-secret' }).system.environment, 'invalid');
  assert.ok(!JSON.stringify(createControlStatus({ SHOPEE_ENVIRONMENT: 'unknown-secret' })).includes('unknown-secret'));
});

test('不存在的本地凭据文件不会导致启动异常', () => {
  assert.ok(['absent', 'unsupported'].includes(loadLocalEnvironment(path.join(tmpdir(), `missing-shopee-${process.pid}`, '.env'))));
  assert.doesNotThrow(() => createControlStatus({}));
});

test('本地 .env 被读取且已有环境变量保持优先，无凭据日志', async t => {
  if (typeof process.loadEnvFile !== 'function') return t.skip('当前 Node.js 不支持 loadEnvFile');
  const directory = await mkdtemp(path.join(tmpdir(), 'shopee-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = path.join(directory, '.env');
  await writeFile(envFile, 'SHOPEE_PARTNER_KEY=file-secret\nSHOPEE_ACCESS_TOKEN=local-token\n', 'utf8');
  const childEnv = { ...process.env, SHOPEE_PARTNER_KEY: 'existing-secret' };
  delete childEnv.SHOPEE_ACCESS_TOKEN;
  const script = `import { loadLocalEnvironment } from ${JSON.stringify(new URL('../server/control.mjs', import.meta.url).href)};
    const result = loadLocalEnvironment(${JSON.stringify(envFile)});
    console.log(JSON.stringify({ loaded: result === 'loaded', preserved: process.env.SHOPEE_PARTNER_KEY === 'existing-secret', imported: process.env.SHOPEE_ACCESS_TOKEN === 'local-token' }));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: childEnv, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { loaded: true, preserved: true, imported: true });
  assert.equal(child.stderr, '');
  for (const secret of ['file-secret', 'existing-secret', 'local-token']) assert.ok(!`${child.stdout}${child.stderr}`.includes(secret));
});

test('状态 HTTP 接口脱敏且旧健康、商品导入、校验 API 可用', async t => {
  const originalEnv = Object.fromEntries(credentialFields.map(field => [field, process.env[field]]));
  credentialFields.forEach((field, index) => { process.env[field] = `http-credential-secret-${index}`; });
  t.after(() => credentialFields.forEach(field => {
    if (originalEnv[field] === undefined) delete process.env[field];
    else process.env[field] = originalEnv[field];
  }));
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/control/status`);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.connection.status, 'pending_validation');
  assert.equal(status.datasets.orders.count, null);
  assert.ok(!JSON.stringify(status).includes('http-credential-secret'));
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  const source = new FormData();
  source.append('file', new Blob(['SKU,库存\r\n001,3\r\n002,5\r\n']), 'source.csv');
  const imported = await (await fetch(`${base}/api/source`, { method: 'POST', body: source })).json();
  assert.equal(imported.rows.length, 2);
  const validated = await (await fetch(`${base}/api/validate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rows: imported.rows, mappings: [{ label: 'SKU', source: 'A', target: 'A', required: true, type: 'sku' }, { label: '库存', source: 'B', target: 'B', required: true, type: 'stock' }] }),
  })).json();
  assert.equal(validated.count, 2);
  assert.equal(validated.passed, 2);
  assert.equal(validated.totals.B.sum, 8);
});
