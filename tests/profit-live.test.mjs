import './helpers/test-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildLiveProfit, summarizeDays, createLiveProfit } from '../server/profit-live.mjs';
import { roleOf, createSkuRoles } from '../server/sku-roles.mjs';
import { createApp } from '../server/index.mjs';

const period = { start: '2026-11-02', end: '2026-11-08', timeZone: 'Asia/Kuala_Lumpur', dates: ['02-11-2026', '03-11-2026', '04-11-2026', '05-11-2026', '06-11-2026', '07-11-2026', '08-11-2026'] };
const at = date => Date.parse(`${date}T12:00:00+08:00`) / 1000;
const catalog = {
  costs: { SHOE: [{ value: 40, row: 2 }], BOW: [{ value: 0.5, row: 3 }], ODD: [{ value: 9, row: 4 }], NEWSHOE: [{ value: 20, row: 5 }] },
  combos: { 'SHOE+BOW': [{ sku: 'SHOE', quantity: '1.0000' }, { sku: 'BOW', quantity: '2.0000' }] },
  single: { SHOE: { spu: 'SHX001' }, BOW: { spu: 'ACC-DP-0023' }, ODD: { spu: 'ZZ259QQ' }, NEWSHOE: { spu: 'SHX999' } }
};
const roles = { 'SHX001': 'shoe_pair', 'ACC-DP-0023': 'accessory' };
const rates = { MYR: { cnyPerUnit: 1.6, date: '2026-11-07', label: 'ECB 参考汇率', url: 'https://example.test/fx', status: 'ok' } };
const item = (itemId, sku, quantity = 1, price = 100) => ({ itemId, modelId: itemId * 10, name: `商品${itemId}`, sku, quantity, price, originalPrice: price });
const order = (orderSn, items, extra = {}) => ({ orderSn, status: 'COMPLETED', currency: 'MYR', totalAmount: 120, createTime: at('2026-11-03'), fulfillment: 'overseas_warehouse', items, ...extra });
const income = (orderSn, net, compound = 2, extra = {}) => ({ orderSn, income: { net, commission: 10, service: 3, transaction: 2, fields: { escrow_amount: net, ads_escrow_top_up_fee_or_technical_support_fee: compound, ...extra } }, error: '' });
function shop(orders, fees, ads = {}) {
  return { shopId: 1, name: 'demo.my', region: 'MY', currency: 'MYR', orders: { rows: orders, period, updatedAt: '2026-11-09T01:00:00.000Z' }, fees: { rows: fees, period, updatedAt: '2026-11-09T01:05:00.000Z' },
    ads: { daily: period.dates.map(date => ({ date, expense: 2 })), total: 14, campaigns: [{ campaignId: 7, expense: 10, itemIds: [11] }], gmsItems: [], warnings: [], reconciliation: { gap: 4 }, period, updatedAt: '2026-11-09T01:06:00.000Z', ...ads } };
}
const build = (shops, extra = {}) => buildLiveProfit({ shops, catalog, roles, rates, now: Date.parse('2026-11-09T02:00:00Z'), ...extra });

test('海外仓逐单毛利沿用原试算公式，广告在同商品有效订单间均摊，链接合计与整单一致', () => {
  const s = shop([order('A1', [item(11, 'SHOE')]), order('A2', [item(11, 'SHOE+BOW', 2)]), order('A3', [item(11, 'SHOE')], { status: 'CANCELLED' })], [income('A1', 100), income('A2', 150, 0)]);
  const value = build([s]), [a1, a2] = value.orders;
  assert.equal(value.mode, 'live'); assert.deepEqual(value.period, { start: '2026-11-02', end: '2026-11-08' }); assert.equal(value.orders.length, 2);
  assert.deepEqual([a1.incomeCny, a1.goodsCny, a1.packingCny, a1.transportCny, a1.adsSource, a1.adsCny, a1.compoundCny, a1.profitA, a1.profitB], [160, 40, 4, 2, 5, 8, 3.2, 106, 109.2]);
  // 组合装：鞋 1 + 配件 2，买 2 件 → 2 双鞋；配件不计双数。
  assert.deepEqual([a2.shoePairs, a2.goodsCny, a2.transportCny, a2.profitA], [2, 82, 4, 240 - 82 - 4 - 4 - 8]);
  assert.equal(a2.lines[0].components.length, 2);
  for (const row of value.orders) { assert.equal(row.links.length, 1); assert.equal(row.links[0].profitA, row.profitA); assert.equal(row.date, '2026-11-03'); }
  const meta = value.shops[0];
  assert.deepEqual([meta.overseas, meta.incomplete, meta.adTotal, meta.adAttributed, meta.adGap, meta.noOrderAd, meta.adUnattributed, meta.adUnattributedCny], [2, 0, 14, 10, 4, 0, 4, 6.4]);
  assert.equal(meta.fxRate, 1.6); assert.equal(meta.packingPerOrder, 4);
});

test('成本、鞋双数、汇率、收入或广告缺项时毛利保持 null 并写明原因，不按 0 计算', () => {
  const rows = [order('B1', [item(11, 'MISSING')]), order('B2', [item(11, 'BOW')]), order('B3', [item(11, 'ODD')]), order('B4', [item(11, 'SHOE')])];
  const value = build([shop(rows, [income('B1', 50), income('B2', 50), income('B3', 50)])]);
  const by = Object.fromEntries(value.orders.map(row => [row.orderSn, row]));
  assert.equal(by.B1.profitA, null); assert.equal(by.B1.goodsCny, null); assert.match(by.B1.missing.join(), /未找到成本：MISSING/);
  assert.equal(by.B2.profitA, null); assert.equal(by.B2.packingCny, null); assert.match(by.B2.missing.join(), /纯配件订单运输规则待补/);
  assert.equal(by.B3.profitA, null); assert.match(by.B3.missing.join(), /部件鞋双数待核：ODD \/ ZZ259QQ/);
  assert.equal(by.B4.profitA, null); assert.equal(by.B4.incomeCny, null); assert.match(by.B4.missing.join(), /结算净收入待补/);
  assert.equal(value.shops[0].incomplete, 4); assert.deepEqual(value.shops[0].pendingParts.sort(), ['未找到成本：MISSING', '部件鞋双数待核：ODD / ZZ259QQ']);

  const noFx = build([shop([order('C1', [item(11, 'SHOE')])], [income('C1', 100)])], { rates: {} }).orders[0];
  assert.equal(noFx.profitA, null); assert.equal(noFx.incomeCny, null); assert.match(noFx.missing.join(), /汇率待取/);
  const noPlan = build([shop([order('C2', [item(11, 'SHOE')])], [income('C2', 100)], { reconciliation: null, warnings: ['Shopee 请求频率受限'] })]);
  assert.equal(noPlan.orders[0].profitA, null); assert.equal(noPlan.orders[0].adsCny, null); assert.match(noPlan.orders[0].missing.join(), /广告计划明细未取得（Shopee 请求频率受限）/); assert.equal(noPlan.shops[0].adTotal, null);
  const stale = shop([order('C3', [item(11, 'SHOE')])], [income('C3', 100)]); stale.fees.period = { ...period, end: '2026-11-07' };
  assert.match(build([stale]).orders[0].missing.join(), /平台扣费待与订单同期同步/);
});

test('未核对 SPU 按前缀推定并标记，已核对清单优先；多商品计划的广告费不强摊', () => {
  assert.deepEqual(roleOf('SHX999', roles), { role: 'shoe_pair', basis: 'prefix' });
  assert.deepEqual(roleOf('ACC-zuhe-0099', roles), { role: 'accessory', basis: 'prefix' });
  assert.deepEqual(roleOf('SHX999', { 'SHX999': 'accessory' }), { role: 'accessory', basis: 'reviewed' });
  assert.deepEqual(roleOf('ZZ259QQ', roles), { role: null, basis: null });
  const s = shop([order('D1', [item(12, 'NEWSHOE')])], [income('D1', 100)], { total: 30, campaigns: [{ campaignId: 8, expense: 6, itemIds: [12] }, { campaignId: 9, expense: 20, itemIds: [] }, { campaignId: 10, expense: 4, itemIds: [77] }] });
  const value = build([s]), row = value.orders[0], meta = value.shops[0];
  assert.equal(row.inferred, true); assert.equal(row.shoePairs, 1); assert.equal(row.adsSource, 6); assert.equal(row.profitA, 160 - 20 - 4 - 2 - 9.6);
  assert.deepEqual([meta.inferredOrders, meta.adAttributed, meta.adGap, meta.noOrderAd, meta.adUnattributed], [1, 10, 20, 4, 24]);
});

test('跨境订单：头程即每双处理费（测试配置 0.5 元），没有额外运费；巴西等无规则站点不纳入', () => {
  const cross = order('E1', [item(11, 'SHOE+BOW')], { fulfillment: 'cross_border' }), unknown = order('E2', [item(11, 'SHOE')], { fulfillment: 'unknown' });
  const br = { ...shop([order('BR1', [item(11, 'SHOE')])], []), shopId: 2, region: 'BR', currency: 'BRL' };
  const value = build([shop([cross, unknown], [income('E1', 100, 2, { escrow_amount_after_adjustment: 90 })]), br]);
  assert.equal(value.orders.length, 1);
  const row = value.orders[0];
  assert.deepEqual([row.sourceNet, row.incomeCny, row.goodsCny, row.packingCny, row.transportCny, row.adsCny, row.preFreightA, row.preFreightB, row.profitA, row.profitB], [90, 144, 41, 0.5, 0, 8, 94.5, 97.7, null, null]);
  assert.deepEqual(row.missing, []); assert.deepEqual(row.links, []);
  assert.deepEqual([value.shops[0].crossBorder, value.shops[0].unknownFulfillment], [1, 1]);
  assert.deepEqual(value.excluded, [{ region: 'BR', reason: '履约费用尚未设置（config/business.json）' }]);
});

test('按天记录：窗口内日期随重算覆盖，更早日期保留；损坏文件不覆盖；HTTP 默认返回滚动毛利', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'shopee-live-')), historyFile = path.join(dir, 'profit-daily.json'), rolesFile = path.join(dir, 'sku-roles.json');
  await writeFile(rolesFile, JSON.stringify({ version: 1, roles: { ...roles, BAD: 'whatever' } }));
  const state = { shops: [shop([order('F1', [item(11, 'SHOE')]), order('F2', [item(11, 'SHOE')], { createTime: at('2026-11-05') })], [income('F1', 100), income('F2', 100)])] };
  const operations = { snapshot: async () => ({ shops: state.shops }), sync: async () => ({ running: true }), wait: async () => {} };
  const skuCosts = { catalog: async () => ({ available: true, name: 'product-cost-catalog-2026-10-20.json', date: '2026-10-20', catalog }) };
  const fx = { snapshot: async () => ({ rates }) };
  const live = createLiveProfit({ operations, skuCosts, fx, roles: createSkuRoles({ file: rolesFile }), historyFile, now: () => Date.parse('2026-11-09T02:00:00Z') });
  const first = await live.snapshot();
  assert.equal(first.rolesReviewed, 2); assert.equal(first.costCatalogDate, '2026-10-20'); assert.equal(await live.snapshot(), first, '数据未变时复用上次结果');
  const days = summarizeDays(first, state.shops).MY;
  assert.deepEqual(Object.keys(days), ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
  assert.deepEqual([days['2026-11-03'].validOrders, days['2026-11-03'].included, days['2026-11-03'].incomeCny, days['2026-11-03'].profitA, days['2026-11-03'].adSpendSource, days['2026-11-03'].adSpendCny], [1, 1, 160, 106, 2, 3.2]);
  assert.equal(days['2026-11-04'].validOrders, 0);
  await writeFile(historyFile, JSON.stringify({ version: 1, updatedAt: null, days: { MY: { '2026-10-01': { profitA: 1 }, '2026-11-03': { profitA: -999 } } } }));
  await live.record();
  const saved = JSON.parse(await readFile(historyFile, 'utf8'));
  assert.equal(saved.days.MY['2026-10-01'].profitA, 1); assert.equal(saved.days.MY['2026-11-03'].profitA, 106); assert.equal(saved.days.MY['2026-11-03'].recordedAt, '2026-11-09T02:00:00.000Z');

  const app = createApp({ operations, skuCosts: { lookup: async () => ({}) }, liveProfit: live, profitSnapshot: async () => ({ available: true, period: { start: '2026-10-13', end: '2026-10-19' }, shops: [], orders: [] }) });
  const server = await new Promise(resolve => { const started = app.listen(0, '127.0.0.1', () => resolve(started)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const liveResponse = await (await fetch(`${base}/api/profit-estimates`)).json(), archive = await (await fetch(`${base}/api/profit-estimates?source=archive`)).json();
  assert.equal(liveResponse.mode, 'live'); assert.equal(liveResponse.orders.length, 2); assert.equal(archive.mode, 'archive'); assert.equal(archive.period.start, '2026-10-13');
  assert.deepEqual(Object.keys((await (await fetch(`${base}/api/profit-history`)).json()).days), ['MY']);
  assert(!/buyer|access_token|partner_key|recipient/i.test(JSON.stringify(liveResponse)));

  const broken = path.join(dir, 'broken.json'); await writeFile(broken, '{oops');
  const other = createLiveProfit({ operations, skuCosts, fx, roles: createSkuRoles({ file: rolesFile }), historyFile: broken });
  await assert.rejects(() => other.record(), /毛利日记录读取失败/); assert.equal(await readFile(broken, 'utf8'), '{oops');
  const noCatalog = createLiveProfit({ operations, skuCosts: { catalog: async () => ({ available: false }) }, fx, roles: createSkuRoles({ file: rolesFile }), historyFile });
  assert.equal((await noCatalog.snapshot()).available, false);
});
