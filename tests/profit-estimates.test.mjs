import './helpers/test-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink, rmdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.mjs';
import { readProfitEstimates } from '../server/profit-estimates.mjs';
import { filterProfitOrders, summarizeProfitOrders } from '../src/profit-model.mjs';

const base = { kind: 'order', region: 'MY', status: 'COMPLETED', fulfillment: 'overseas_warehouse', sourceCurrency: 'MYR', sourceNet: 60, shoePairs: 1, incomeCny: 100, goodsCny: 40, packingCny: 3, transportCny: 1.5, adsCny: 5.25, adsSource: 3.2, compoundCny: 2, profitA: 50.25, profitB: 52.25, missing: [], lines: [{ sku: '001', itemId: 11, quantity: 1, unitCostCny: 40, components: [] }] };
const link = { itemId: 11, name: '示例商品', skus: ['001'], quantity: 1, saleAmount: 60, shoePairs: 1, adSource: 3.2, incomeCny: 100, goodsCny: 40, packingCny: 3, transportCny: 1.5, adsCny: 5.25, compoundCny: 2, profitA: 50.25, profitB: 52.25, basis: 'single_link', access_token: 'private-token' };
function fixture() {
  return [{ kind: 'meta', version: 1, period: { start: '2026-10-13', end: '2026-10-19' }, sourceDate: '2026-10-20', count: 3, access_token: 'private-token', shops: [{ region: 'MY', name: 'shop', currency: 'MYR', overseas: 2, crossBorder: 1, expectedProfitA: 50.25, expectedProfitB: 52.25, partner_key: 'private-key' }] },
    { ...base, orderSn: '001A', links: [{ ...link }], access_token: 'private-token' },
    { ...base, orderSn: '002B', status: 'TO_RETURN', profitA: null, profitB: null, packingCny: null, transportCny: null, missing: ['运输规则待补'] },
    { ...base, orderSn: '003C', fulfillment: 'cross_border', profitA: null, profitB: null, incomeCny: null, goodsCny: null, packingCny: null, transportCny: null, missing: ['跨境公式待补'] }];
}
async function source(t, records = fixture()) {
  const dir = await mkdtemp(path.join(tmpdir(), 'shopee-profit-')), file = path.join(dir, 'snapshot.ndjson');
  await writeFile(file, records.map(row => JSON.stringify(row)).join('\n'));
  t.after(async () => { await unlink(file); await rmdir(dir); });
  return file;
}
test('试算快照只返回订单白名单字段，缺项保持null，GET无远程调用', async t => {
  const file = await source(t), app = createApp({ profitSnapshot: () => readProfitEstimates(file) });
  const server = await new Promise(resolve => { const started = app.listen(0, '127.0.0.1', () => resolve(started)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/profit-estimates`), value = await response.json();
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.status, 200);
  assert.equal(value.orders.length, 3); assert.equal(value.orders[0].links[0].profitA, 50.25); assert.equal(value.orders[1].packingCny, null); assert.equal(value.orders[2].profitA, null);
  assert(!JSON.stringify(value).includes('private-')); assert(!JSON.stringify(value).includes('access_token')); assert(!JSON.stringify(value).includes('partner_key'));
});
test('缺快照返回不可用，损坏/重单/错误笔数/跨境误算均拒绝且不改文件', async t => {
  const file = await source(t);
  assert.equal((await readProfitEstimates(`${file}.missing`)).available, false);
  for (const mutate of [rows => { rows[0].count = 9; }, rows => { rows[2].orderSn = rows[1].orderSn; }, rows => { rows[3].profitA = 2; }, rows => { rows[3].preFreightA = 999; }, rows => { rows[0].shops[0].expectedProfitA = 99; }, rows => { rows[1].incomeCny = 101; }, rows => { rows[1].links[0].profitA = 999; }]) {
    const rows = fixture(); mutate(rows); const text = rows.map(row => JSON.stringify(row)).join('\n'); await writeFile(file, text);
    await assert.rejects(() => readProfitEstimates(file), /^Error: 试算快照校验失败/); assert.equal(await readFile(file, 'utf8'), text);
  }
});
test('跨境只汇总未扣运费毛利，完整毛利和运输仍为空', async t => {
  const records = fixture();
  Object.assign(records[3], { incomeCny: 100, goodsCny: 40, packingCny: 0.5, transportCny: null, compoundCny: 2, preFreightA: 54.25, preFreightB: 56.25 });
  const loaded = await readProfitEstimates(await source(t, records));
  const cross = filterProfitOrders(loaded.orders, { fulfillment: 'cross_border', result: 'ready' });
  assert.equal(cross.length, 1);
  assert.equal(cross[0].profitA, null);
  assert.equal(cross[0].transportCny, null);
  assert.deepEqual(summarizeProfitOrders(cross), { orders: 1, included: 1, pending: 0, losses: 0, income: 100, cost: 45.75, profit: 54.25 });
});
test('站点/履约/状态/SKU筛选；待补和跨境不计入毛利合计', () => {
  const orders = fixture().slice(1), overseas = filterProfitOrders(orders);
  assert.equal(overseas.length, 2); assert.equal(filterProfitOrders(orders, { search: '001' }).length, 2);
  assert.equal(filterProfitOrders(orders, { region: 'VN' }).length, 0);
  assert.equal(filterProfitOrders(orders, { excludeReturns: true }).length, 1);
  assert.equal(filterProfitOrders(orders, { result: 'pending' }).length, 1);
  assert.deepEqual(summarizeProfitOrders(overseas), { orders: 2, included: 1, pending: 1, losses: 0, income: 100, cost: 49.75, profit: 50.25 });
  assert.equal(summarizeProfitOrders(filterProfitOrders(orders, { fulfillment: 'cross_border' })).profit, null);
});
test('情景B只加回复合项，亏损筛选跟随情景，零毛利与空结果分开', () => {
  const orders = [{ ...base, orderSn: 'loss', profitA: -1, profitB: 1 }, { ...base, orderSn: 'zero', profitA: 0, profitB: 0 }];
  assert.equal(filterProfitOrders(orders, { result: 'loss' }).length, 1);
  assert.equal(filterProfitOrders(orders, { result: 'loss', scenario: 'B' }).length, 0);
  assert.equal(summarizeProfitOrders([{ ...base }], 'B').income, 102);
  assert.equal(summarizeProfitOrders([{ ...base, profitA: 0 }]).profit, 0);
  assert.equal(summarizeProfitOrders([]).profit, null);
});
