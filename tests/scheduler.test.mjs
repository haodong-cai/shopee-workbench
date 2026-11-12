import './helpers/test-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createScheduler, latestSlot, minuteOfDay, neededKinds, FULL_KINDS } from '../server/scheduler.mjs';
import { periodFor } from '../server/operations.mjs';
import { createApp } from '../server/index.mjs';

const bj = text => Date.parse(`${text}+08:00`);
const hour = 3600000;
const block = (region, now, extra = {}) => ({ updatedAt: new Date(now).toISOString(), period: periodFor(region, now), error: '', ...extra });
const healthy = (shopId, region, now) => ({ shopId, region, ...Object.fromEntries(FULL_KINDS.map(kind => [kind, block(region, now)])) });
function fakeOperations(shops, { onSync = () => {} } = {}) {
  const calls = [], job = { running: false, error: '' };
  return { calls, shops, job, async snapshot() { return { shops: structuredClone(shops), job: { ...job } }; },
    async sync(kinds, shopIds) { calls.push({ kinds, shopIds }); await onSync(kinds, shopIds); return { running: true, error: '' }; }, async wait() {} };
}
async function setup(shops, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'shopee-schedule-')), file = path.join(dir, 'schedule.json');
  const clock = { now: options.now ?? bj('2026-11-10T09:00:00') }, finished = [];
  const operations = fakeOperations(shops, options);
  const scheduler = createScheduler({ file, operations, now: () => clock.now, onFinished: async run => { finished.push(run.type); } });
  return { file, clock, operations, scheduler, finished };
}

test('每日时间点按北京时间计算', () => {
  assert.equal(minuteOfDay(bj('2026-11-10T08:30:00')), 510);
  assert.equal(latestSlot(bj('2026-11-10T09:10:20'), '08:30'), bj('2026-11-10T08:30:00'));
  assert.equal(latestSlot(bj('2026-11-10T07:00:00'), '08:30'), bj('2026-11-09T08:30:00'));
  assert.equal(latestSlot(bj('2026-11-10T08:30:00'), '08:30'), bj('2026-11-10T08:30:00'));
});

test('启动后补跑一次全量同步，同一天不重复；到点后再次全量', async () => {
  const now = bj('2026-11-10T09:00:00');
  const { scheduler, operations, clock, finished, file } = await setup([healthy(1, 'MY', now)], { now });
  const run = await scheduler.tick();
  assert.equal(run.type, 'catchup'); assert.deepEqual(operations.calls, [{ kinds: FULL_KINDS, shopIds: undefined }]); assert.deepEqual(run.failures, []); assert.deepEqual(finished, ['catchup']);
  assert.equal(await scheduler.tick(), null);
  clock.now = bj('2026-11-10T10:00:00'); assert.equal(await scheduler.tick(), null);
  let view = await scheduler.snapshot();
  assert.equal(view.nextFullAt, new Date(bj('2026-11-11T08:30:00')).toISOString()); assert.equal(view.nextIntervalAt, new Date(bj('2026-11-10T13:00:00')).toISOString()); assert.equal(view.runs.length, 1);
  clock.now = bj('2026-11-11T08:30:30');
  assert.equal((await scheduler.tick()).type, 'daily'); assert.equal(operations.calls.length, 2);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).runs.length, 2);
});

test('增量同步只刷新订单与退货；统计期已滚动或上次失败的店铺补齐全部数据块；午夜后不做增量', async () => {
  const start = bj('2026-11-10T09:00:00');
  const shops = [healthy(1, 'MY', start), healthy(2, 'BR', start), healthy(3, 'TH', start)];
  const ref = {};
  // 模拟真实同步：成功后该数据块更新为当前统计期并清除错误。
  const onSync = (kinds, ids) => { for (const shop of shops) if (!ids || ids.includes(shop.shopId)) for (const kind of kinds) shop[kind] = block(shop.region, ref.clock.now); };
  const { scheduler, operations, clock } = await setup(shops, { now: start, onSync });
  ref.clock = clock;
  await scheduler.tick(); operations.calls.length = 0;
  shops[2].ads.error = 'Shopee 请求频率受限';
  clock.now = bj('2026-11-10T13:00:00'); // 巴西当地已过午夜，近 7 天窗口滚动
  assert.deepEqual(neededKinds(shops[0], ['orders', 'returns'], clock.now), ['orders', 'returns']);
  assert.deepEqual(neededKinds(shops[1], ['orders', 'returns'], clock.now), FULL_KINDS);
  assert.deepEqual(neededKinds(shops[2], [], clock.now), ['ads']);
  const legacy = { ...shops[0], fees: { ...shops[0].fees, period: { ...shops[0].fees.period, start: '2026-11-04' } } };
  assert.deepEqual(neededKinds(legacy, ['orders', 'returns'], clock.now), ['orders', 'fees', 'returns'], '旧的 7 天数据视为需重读');
  const run = await scheduler.tick();
  assert.equal(run.type, 'interval');
  assert.deepEqual(operations.calls, [{ kinds: ['orders', 'returns'], shopIds: [1] }, { kinds: FULL_KINDS, shopIds: [2] }, { kinds: ['orders', 'ads', 'returns'], shopIds: [3] }]);
  assert.deepEqual(run.failures, []); assert.equal((await scheduler.snapshot()).retryAt, null);
  operations.calls.length = 0;
  clock.now = bj('2026-11-10T16:59:00'); assert.equal(await scheduler.tick(), null, '未到间隔');
  clock.now = bj('2026-11-11T02:00:00'); assert.equal(await scheduler.tick(), null, '午夜到每日时间之间不执行增量');
  assert.equal((await scheduler.snapshot()).nextIntervalAt, null);
  assert.deepEqual(operations.calls, []);
});

test('有失败时 20 分钟后只重试失败的数据块一次；重试仍失败不再连环重试', async () => {
  const start = bj('2026-11-10T09:00:00');
  const shops = [healthy(1, 'MY', start), healthy(2, 'PH', start)];
  const { scheduler, operations, clock, finished } = await setup(shops, { now: start, onSync: () => { shops[1].ads.error = 'Shopee 请求频率受限（ads_rate_limit_total_api）'; } });
  const run = await scheduler.tick();
  assert.deepEqual(run.failures, [{ region: 'PH', kind: 'ads', error: 'Shopee 请求频率受限（ads_rate_limit_total_api）' }]);
  assert.equal((await scheduler.snapshot()).retryAt, new Date(start + 20 * 60000).toISOString());
  clock.now = start + 10 * 60000; assert.equal(await scheduler.tick(), null);
  clock.now = start + 21 * 60000; operations.calls.length = 0;
  const retry = await scheduler.tick();
  assert.equal(retry.type, 'retry'); assert.deepEqual(operations.calls, [{ kinds: ['ads'], shopIds: [2] }]); assert.equal(retry.failures.length, 1);
  assert.equal((await scheduler.snapshot()).retryAt, null); assert.deepEqual(finished, ['catchup', 'retry']);
  clock.now = start + 60 * 60000; assert.equal(await scheduler.tick(), null);
});

test('关闭后不运行；手动同步进行中让路；设置校验并持久化；损坏配置不覆盖', async t => {
  const start = bj('2026-11-10T09:00:00');
  const { scheduler, operations, file } = await setup([healthy(1, 'MY', start)], { now: start });
  operations.job.running = true; assert.equal(await scheduler.tick(), null, '手动同步进行中');
  operations.job.running = false;
  const off = await scheduler.configure({ enabled: false });
  assert.equal(off.config.enabled, false); assert.equal(off.nextFullAt, null); assert.equal(await scheduler.tick(), null); assert.deepEqual(operations.calls, []);
  for (const bad of [{ dailyTime: '8:30' }, { dailyTime: '24:00' }, { lightEveryHours: 5 }, { enabled: 'yes' }, null, []]) await assert.rejects(() => scheduler.configure(bad));
  const on = await scheduler.configure({ enabled: true, dailyTime: '07:15', lightEveryHours: 0 });
  assert.deepEqual(on.config, { enabled: true, dailyTime: '07:15', lightEveryHours: 0 });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).config, on.config);

  const app = createApp({ scheduler });
  const server = await new Promise(resolve => { const started = app.listen(0, '127.0.0.1', () => resolve(started)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/schedule`;
  assert.equal((await (await fetch(url)).json()).config.dailyTime, '07:15');
  const put = body => fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await (await put({ lightEveryHours: 6 })).json()).config.lightEveryHours, 6);
  assert.equal((await put({ lightEveryHours: 7 })).status, 400);
  assert.equal((await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"enabled":false}' })).status, 403);

  await writeFile(file, '{broken');
  const fresh = createScheduler({ file, operations, now: () => start });
  await assert.rejects(() => fresh.tick(), /定时同步配置读取失败/); assert.equal(await readFile(file, 'utf8'), '{broken');
});
