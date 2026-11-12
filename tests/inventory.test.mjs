import './helpers/test-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectPrefix, normalizeSku, siteOf, parseCreated, parseStock, parseTransit, detectKind, explodeSku, projectSku, actionFor, forecastInventory, createInventory, DEFAULT_SETTINGS } from '../server/inventory.mjs';
import { createApp } from '../server/index.mjs';

const day = 86400000, now = Date.parse('2026-11-11T04:00:00Z');
const table = (labels, lines) => ({ columns: labels.map((label, i) => ({ key: String.fromCharCode(65 + i), label })), rows: lines.map((cells, i) => ({ line: i + 2, values: Object.fromEntries(cells.map((value, j) => [String.fromCharCode(65 + j), value])) })) });
const period = { start: '2026-11-04', end: '2026-11-10', timeZone: 'Asia/Bangkok', dates: ['04-11-2026', '05-11-2026', '06-11-2026', '07-11-2026', '08-11-2026', '09-11-2026', '10-11-2026'] };
const order = (orderSn, items, extra = {}) => ({ orderSn, status: 'COMPLETED', fulfillment: 'overseas_warehouse', createTime: Date.parse('2026-11-08T05:00:00Z') / 1000, items: items.map(([itemId, sku, quantity]) => ({ itemId, name: `商品${itemId}`, sku, quantity })), ...extra });
const shop = (rows, ads = {}) => ({ shopId: 9, name: 'demo.th', region: 'TH', currency: 'THB', orders: { rows, period, updatedAt: '2026-11-11T00:31:00.000Z' },
  ads: { daily: [], total: 0, campaigns: [], gmsItems: [], reconciliation: { gmsCampaignId: 555 }, period, ...ads } });
const stockOf = (rows, importedAt = new Date(now).toISOString()) => ({ importedAt, rows: rows.map(([sku, qty, warehouse = 'TH-06']) => ({ site: siteOf(warehouse), warehouse, sku, qty })) });
const catalog = { costs: { SHOE: [{ value: 1 }], BOW: [{ value: 1 }] }, combos: { 'SHOE+2BOW': [{ sku: 'SHOE', quantity: '1.0000' }, { sku: 'BOW', quantity: '2.0000' }] } };

test('SKU 去掉仓库系统的客户代码前缀（含重复前缀），仓库代码对应站点，创建时间按北京时间', () => {
  assert.equal(detectPrefix(['88888-A', '88888-88888-B', '88888-C', 'demo18-hei']), '');
  assert.equal(detectPrefix(['88888-A', '88888-88888-B', '88888-C', '88888-D', '88888-demo18-hei']), '88888');
  assert.equal(normalizeSku(' 88888-88888-demo20bow-fen26-27 ', '88888'), 'demo20bow-fen26-27');
  assert.equal(normalizeSku('demo18-hei24-25', '88888'), 'demo18-hei24-25'); assert.equal(normalizeSku('208-abc', ''), '208-abc');
  assert.deepEqual(['MY-01', 'th-06', 'VN11', 'PH 13', 'CN-01', '', 'MYX'].map(siteOf), ['MY', 'TH', 'VN', 'PH', null, null, null]);
  assert.equal(parseCreated('2026-10-14 14:40:34'), '2026-10-14T06:40:34.000Z'); assert.equal(parseCreated('2026/11/1'), '2026-10-31T16:00:00.000Z');
  assert.equal(parseCreated('46309.5'), '2026-10-14T04:00:00.000Z'); assert.equal(parseCreated('昨天'), null);
});

test('在库表：同仓同 SKU 合并，无仓库的 0 库存行忽略，异常行跳过并报告行号', () => {
  const t = table(['SKU', '可用库存', '仓库'], [['88888-A', '5', 'TH-06'], ['88888-A', '2', 'TH-06'], ['88888-A', '7', 'VN-11'], ['88888-A', '1', 'VN-04'], ['88888-B', '0', ''], ['88888-C', '3', ''], ['88888-D', '1.5', 'MY-01'], ['88888-E', '4', 'CN-02'], ['88888-88888-F', '1,200', 'PH-13']]);
  assert.equal(detectKind(t.columns), 'stock');
  const result = parseStock(t);
  assert.equal(result.prefix, '88888');
  assert.deepEqual(result.rows, [{ site: 'TH', warehouse: 'TH-06', sku: 'A', qty: 7 }, { site: 'VN', warehouse: 'VN-11', sku: 'A', qty: 7 }, { site: 'VN', warehouse: 'VN-04', sku: 'A', qty: 1 }, { site: 'PH', warehouse: 'PH-13', sku: 'F', qty: 1200 }]);
  assert.equal(result.stats.emptyRows, 1); assert.deepEqual(result.stats.bySite.VN, { skus: 2, units: 8, warehouses: ['VN-11', 'VN-04'] });
  assert.equal(result.skipped.count, 3); assert.deepEqual(result.skipped.rows.map(row => row.line), [7, 8, 9]);
  assert.throws(() => parseStock(table(['SKU', '数量'], [['A', '1']])), /缺少必要的列/);
  assert.throws(() => detectKind(table(['名称', '备注'], []).columns), /无法识别表格/);
});

test('在途表：单号、仓库、创建时间向下沿用，同单重复 SKU 合并，无法识别的单整张跳过', () => {
  const t = table(['入库单号', '仓库', '创建时间', 'SKU数量', 'SKU', '预约数量'], [['RK1', 'PH-13', '2026-10-14 14:40:34', '2', '88888-A', '30'], ['', '', '', '', '88888-B', '5'], ['', '', '', '3', '88888-A', '10'], ['RK2', 'XX-01', '2026-10-15 10:00:00', '1', '88888-C', '9'], ['', '', '', '', '88888-D', '9'], ['RK3', 'MY-01', '2026-10-15 14:32:31', '1', '88888-E', '0'], ['', '', '', '', '88888-F', 'x']]);
  assert.equal(detectKind(t.columns), 'transit');
  const result = parseTransit(t);
  assert.deepEqual(result.orders, [{ no: 'RK1', warehouse: 'PH-13', site: 'PH', createdAt: '2026-10-14T06:40:34.000Z', lines: [{ sku: 'A', qty: 40 }, { sku: 'B', qty: 5 }], units: 45 }]);
  assert.deepEqual(result.stats, { orders: 1, lines: 2, units: 45 }); assert.equal(result.skipped.count, 3);
});

test('单品推演：已断货 / 到货前断货 / 来不及 / 紧张 / 该补货 / 正常，以及需要压低的销量', () => {
  const run = (stock, rate, arrivals = []) => projectSku({ stock, rate, arrivals: arrivals.map(([days, qty]) => ({ etaMs: now + days * day, qty })), leadDays: 20, safetyDays: 3, now });
  const gap = run(10, 2, [[10, 100]]);
  assert.equal(gap.state, 'gap'); assert.equal(gap.gapDays, 5); assert.equal(gap.outAt, now + 5 * day); assert.equal(Math.round(gap.cutPct * 1000), Math.round((1 - 10 / 26) * 1000)); assert.equal(actionFor(gap.cutPct), 'pause');
  const tight = run(22, 2, [[10, 100]]);
  assert.equal(tight.state, 'tight'); assert.equal(tight.gapDays, 0); assert.equal(tight.marginDays, 1); assert.equal(actionFor(tight.cutPct), 'watch');
  assert.equal(run(30, 2, [[10, 100]]).state, 'ok'); assert.equal(run(30, 2, [[10, 100]]).cutPct, 0);
  assert.equal(run(30, 2, [[10, 10]]).state, 'reorder', '到货后仍撑不到下一个补货周期');
  const out = run(0, 1, [[4, 50]]);
  assert.equal(out.state, 'out'); assert.equal(out.cutPct, 1); assert.equal(out.outAt, now); assert.equal(out.gapDays, 4);
  const late = run(10, 1); assert.equal(late.state, 'late'); assert.equal(late.outAt, now + 10 * day); assert.equal(Math.round(late.cutPct * 1000), Math.round((1 - 10 / 23) * 1000));
  assert.equal(run(21, 1).state, 'tight'); assert.equal(run(25, 1).state, 'reorder'); assert.equal(run(31, 1).state, 'ok'); assert.equal(run(31, 1).cutPct, 0);
  assert.equal(run(5, 0).state, 'ok'); assert.equal(run(5, 0).coverDays, null);
  // 第二批之间出现断档也算到货前断货；已超期的在途按“随时到仓”计。
  const second = run(20, 2, [[5, 10], [20, 100]]); assert.equal(second.state, 'gap'); assert.equal(second.gapDays, 5); assert.equal(second.outAt, now + 15 * day);
  const overdue = run(0, 1, [[-2, 50]]); assert.equal(overdue.state, 'out'); assert.equal(overdue.gapDays, 0);
  assert.deepEqual([0.5, 0.49, 0.2, 0.19, 0].map(actionFor), ['pause', 'reduce', 'reduce', 'watch', 'ok']);
});

test('预测：组合装拆单品、跨境与取消单不计、导入后按销量扣减、广告建议按链接加权', () => {
  assert.deepEqual([...explodeSku('SHOE+2BOW', catalog)], [['SHOE', 1], ['BOW', 2]]); assert.deepEqual([...explodeSku('UNKNOWN', catalog)], [['UNKNOWN', 1]]);
  const rows = [order('O1', [[11, 'SHOE+2BOW', 7]]), order('O2', [[11, 'SHOE', 7]]), order('O3', [[12, 'LONELY', 7]]), order('O4', [[13, 'GHOST', 1]]),
    order('X1', [[11, 'SHOE', 70]], { fulfillment: 'cross_border' }), order('X2', [[11, 'SHOE', 70]], { status: 'CANCELLED' })];
  const ads = { campaigns: [{ campaignId: 7, expense: 40, itemIds: [11] }, { campaignId: 8, expense: 99, itemIds: [11, 12] }], gmsItems: [{ itemId: 11, expense: 60 }, { itemId: 12, expense: 5 }] };
  const stock = stockOf([['SHOE', 20], ['BOW', 500], ['LONELY', 3], ['IDLE', 9]], new Date(now - 2 * day).toISOString());
  const transit = { orders: [{ no: 'RK9', warehouse: 'TH-06', site: 'TH', createdAt: new Date(now - 10 * day).toISOString(), lines: [{ sku: 'SHOE', qty: 200 }], units: 200 }] };
  const f = forecastInventory({ stock, transit, settings: DEFAULT_SETTINGS, shops: [shop(rows, ads), { region: 'BR', shopId: 1, orders: { rows: [], period } }], catalog, now });
  assert.equal(f.available, true);
  const by = Object.fromEntries(f.rows.map(row => [row.sku, row]));
  // SHOE：7（组合装）+ 7（单卖）= 14 件 / 7 天 = 2/天；导入 2 天前 20 件 → 现约 16；在途 10 天后到（头程 20 天）。
  assert.deepEqual([by.SHOE.units, by.SHOE.rate, by.SHOE.onHand, by.SHOE.estimate, by.SHOE.coverDays, by.SHOE.transitQty, by.SHOE.daysToNext, by.SHOE.gapDays, by.SHOE.state, by.SHOE.action], [14, 2, 20, 16, 8, 200, 10, 2, 'gap', 'reduce']);
  assert.equal(by.SHOE.outAt, new Date(now + 8 * day).toISOString()); assert.equal(by.SHOE.targetRate, 1.23);
  assert.deepEqual([by.BOW.units, by.BOW.state, by.BOW.cutPct], [14, 'ok', 0]);
  assert.deepEqual([by.LONELY.rate, by.LONELY.estimate, by.LONELY.state, by.LONELY.transitQty], [1, 1, 'late', 0]);
  assert.deepEqual([by.GHOST.state, by.GHOST.hasRecord, by.GHOST.onHand, by.GHOST.action], ['norecord', false, null, 'check']);
  assert.equal(by.IDLE, undefined); assert.equal(f.summary.idleSkus, 1);
  assert.deepEqual(f.transitOrders.map(o => [o.no, o.eta, o.overdueDays, o.units]), [['RK9', new Date(now + 10 * day).toISOString(), 0, 200]]);
  const [first, second, third] = f.listings;
  assert.deepEqual([first.itemId, first.action, first.units, first.riskShare, first.ads.total, first.ads.gms], [12, 'pause', 7, 1, 5, 5]);
  assert.deepEqual([second.itemId, second.action, second.units, second.riskUnits, second.ads.total, second.ads.manual, second.ads.gmsCampaignId], [11, 'reduce', 14, 14, 100, [{ campaignId: 7, expense: 40 }], 555]);
  assert.equal(second.variants[0].limiting, 'SHOE'); assert.equal(second.cutPct, by.SHOE.cutPct);
  assert.deepEqual([third.itemId, third.cutPct, third.unknownUnits, third.variants[0].state], [13, 0, 1, 'norecord']);
  assert.deepEqual([f.summary.gap, f.summary.late, f.summary.norecord, f.summary.pauseListings, f.summary.pauseWithAds, f.summary.reduceListings], [1, 1, 1, 1, 1, 1]);
  assert.equal(forecastInventory({ stock: null, shops: [shop(rows)] }).available, false);
  const stale = forecastInventory({ stock: stockOf([['SHOE', 20]], new Date(now - 4 * day).toISOString()), shops: [shop(rows)], catalog, now });
  assert.match(stale.notes.join(), /已 4 天没有更新/); assert.equal(stale.rows.find(r => r.sku === 'SHOE').estimate, 12);
});

test('导入、设置与持久化：CSV 自动识别在库 / 在途，整表覆盖；设置校验；损坏文件不覆盖', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'shopee-inv-')), file = path.join(dir, 'inventory.json');
  const operations = { snapshot: async () => ({ shops: [shop([order('O1', [[11, 'SHOE', 14]])])] }) };
  const inventory = createInventory({ file, operations, skuCosts: { catalog: async () => ({ available: true, date: '2026-10-20', catalog }) }, now: () => now });
  const app = createApp({ inventory });
  const server = await new Promise(resolve => { const started = app.listen(0, '127.0.0.1', () => resolve(started)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const upload = (name, text, headers = {}) => { const body = new FormData(); body.append('file', new Blob([text]), name); return fetch(`${base}/api/inventory/import`, { method: 'POST', body, headers }); };
  assert.equal((await (await fetch(`${base}/api/inventory`)).json()).forecast.available, false);
  const s1 = await (await upload('在库.csv', 'SKU,可用库存,仓库\n88888-SHOE,6,TH-06\n88888-BOW,90,TH-06\n88888-SHOE,1,MY-01\n88888-X,2,VN-11\n88888-Y,2,PH-13\n')).json();
  assert.deepEqual([s1.kind, s1.fileName, s1.stats.rows, s1.prefix], ['stock', '在库.csv', 5, '88888']);
  const t1 = await (await upload('在途.csv', '入库单号,仓库,创建时间,SKU数量,SKU,预约数量\nRK1,TH-06,2026-11-10 10:50:40,1,88888-SHOE,50\n')).json();
  assert.deepEqual([t1.kind, t1.stats.orders, t1.stats.units], ['transit', 1, 50]);
  assert.equal((await upload('别的.csv', '名称,备注\na,b\n')).status, 400);
  assert.equal((await upload('表.xls', 'x')).status, 400);
  assert.equal((await upload('在库.csv', 'SKU,可用库存,仓库\nA,1,TH-06\n', { origin: 'https://evil.example' })).status, 403);
  const view = await (await fetch(`${base}/api/inventory`)).json(), row = view.forecast.rows[0];
  assert.deepEqual([view.stock.stats.rows, view.stock.stats.skus, view.transit.stats.orders, view.catalogDate, view.settings.leadDays.TH], [5, 4, 1, '2026-10-20', 20]);
  assert.deepEqual([row.sku, row.onHand, row.rate, row.coverDays, row.state, row.transitQty], ['SHOE', 6, 2, 3, 'gap', 50]);
  assert.equal(view.stock.rows, undefined, '快照不回传整张库存表');
  const put = body => fetch(`${base}/api/inventory/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const bad of [{ leadDays: { TH: 0 } }, { leadDays: { BR: 9 } }, { leadDays: { TH: 2.5 } }, { safetyDays: 31 }, { safetyDays: '3' }]) assert.equal((await put(bad)).status, 400);
  const changed = await (await put({ leadDays: { TH: 2 }, safetyDays: 0 })).json();
  assert.deepEqual([changed.settings.leadDays.TH, changed.settings.leadDays.MY, changed.settings.safetyDays, changed.forecast.rows[0].state], [2, 25, 0, 'ok']);
  // 重新导入在库表 = 整表覆盖
  await upload('在库2.csv', 'SKU,可用库存,仓库\n88888-SHOE,0,TH-06\n');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual([saved.stock.rows.length, saved.stock.fileName, saved.transit.orders.length, saved.settings.leadDays.TH], [1, '在库2.csv', 1, 2]);
  assert.equal((await (await fetch(`${base}/api/inventory`)).json()).forecast.rows[0].state, 'out');
  await writeFile(file, '{broken');
  const fresh = createInventory({ file, operations, skuCosts: { catalog: async () => ({ available: false }) }, now: () => now });
  await assert.rejects(() => fresh.snapshot(), /库存预警数据读取失败/); assert.equal(await readFile(file, 'utf8'), '{broken');
});
