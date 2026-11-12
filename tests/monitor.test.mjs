import './helpers/test-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMonitorStore, permissionCatalog } from '../server/monitor.mjs';
import { createApp } from '../server/index.mjs';

const connection = () => ({ configured: false, verified: false, fields: { APP: true, KEY: true, SHOP: false, ACCESS: false, REFRESH: false }, missing: ['SHOP', 'ACCESS', 'REFRESH'] });
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'shopee-monitor-'));
  const file = path.join(dir, 'monitor.json');
  return { file, store: createMonitorStore(file, connection) };
}

test('9 项权限人工记录可持久化，确认不冒充 API 验证', async () => {
  const { file, store } = await fixture();
  const before = await store.snapshot();
  assert.equal(before.permissions.length, 9);
  assert.equal(before.totals.tasks, 0);
  await store.setPermission('order', { status: 'confirmed' });
  const after = await createMonitorStore(file, connection).snapshot();
  const order = after.permissions.find(item => item.id === 'order');
  assert.equal(order.status, 'confirmed');
  assert.equal(order.source, 'manual');
  assert.equal(order.apiVerified, false);
  assert.equal(after.connection.verified, false);
  assert.equal(after.permissions.length, permissionCatalog.length);
});

test('任务 0→2 行，检查完成但未连接，计划等待及取消均不产生金额或记录数', async () => {
  const { file, store } = await fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('禁止远程请求'); };
  try {
    const check = await store.addTask({ kind: 'check' });
    assert.equal(check.status, 'completed');
    assert.equal(check.outcome, 'needs_attention');
    assert.ok(check.detail.includes('2/5'));
    const plan = await store.addTask({ kind: 'sync', dataset: 'orders' });
    let snapshot = await store.snapshot();
    assert.deepEqual(snapshot.totals, { tasks: 2, waiting: 1, completed: 1, cancelled: 0 });
    assert.ok(snapshot.alerts.some(item => item.code === 'PLANS_WAITING'));
    for (const task of snapshot.tasks) { assert.equal(task.records, null); assert.equal(task.amount, null); }
    await store.cancelTask(plan.id);
    snapshot = await createMonitorStore(file, connection).snapshot();
    assert.deepEqual(snapshot.totals, { tasks: 2, waiting: 0, completed: 1, cancelled: 1 });
    assert.equal(snapshot.tasks.find(item => item.id === plan.id).status, 'cancelled');
    assert.equal(snapshot.alerts.some(item => item.code === 'PLANS_WAITING'), false);
    await assert.rejects(store.cancelTask(check.id), /未找到可取消/);
  } finally { globalThis.fetch = originalFetch; }
});

test('并发保存不丢任务或权限记录，无效和夹带字段不落盘', async () => {
  const { store } = await fixture();
  await Promise.all([store.setPermission('order', { status: 'planned' }), store.setPermission('product', { status: 'excluded' }), ...Array.from({ length: 8 }, () => store.addTask({ kind: 'check' }))]);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.totals.tasks, 8);
  assert.equal(new Set(snapshot.tasks.map(item => item.id)).size, 8);
  assert.equal(snapshot.permissions.find(item => item.id === 'product').status, 'excluded');
  assert.throws(() => store.setPermission('__proto__', { status: 'confirmed' }), /参数无效/);
  assert.throws(() => store.setPermission('order', { status: 'confirmed', key: 'do-not-store-secret' }), /参数无效/);
  assert.throws(() => store.addTask({ kind: 'sync', dataset: 'unknown' }), /参数无效/);
  assert.throws(() => store.addTask({ kind: 'check', token: 'do-not-store-secret' }), /参数无效/);
  assert.equal((await store.snapshot()).totals.tasks, 8);
});

test('记录损坏时明确报错，不覆盖原数据', async () => {
  const { file, store } = await fixture();
  await writeFile(file, '{broken', 'utf8');
  await assert.rejects(store.snapshot(), /原文件未改写/);
  await assert.rejects(store.addTask({ kind: 'check' }), /原文件未改写/);
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('HTTP 保存、刷新、取消及脱敏报告链路', async t => {
  const { store } = await fixture();
  const server = createApp({ monitorStore: store }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (url, method, body) => fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await send('/api/monitor/permissions/order', 'PATCH', { status: 'planned' })).status, 200);
  const response = await send('/api/monitor/tasks', 'POST', { kind: 'sync', dataset: 'inventory' });
  assert.equal(response.status, 201);
  const plan = await response.json();
  assert.equal(plan.status, 'waiting');
  assert.equal((await send(`/api/monitor/tasks/${plan.id}/cancel`, 'POST', {})).status, 200);
  assert.equal((await send('/api/monitor/tasks', 'POST', { kind: 'sync', dataset: 'orders', secret: 'do-not-store-secret' })).status, 400);
  const reportResponse = await fetch(base + '/api/monitor');
  assert.equal(reportResponse.headers.get('cache-control'), 'no-store');
  const report = await reportResponse.json();
  assert.equal(report.totals.tasks, 1);
  assert.equal(report.totals.cancelled, 1);
  assert.equal(report.connection.configuredFields, 2);
  assert.ok(!JSON.stringify(report).includes('do-not-store-secret'));
  assert.ok(!Object.hasOwn(report.connection, 'fields'));
});
