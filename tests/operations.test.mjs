import './helpers/test-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOperations, periodFor, normalizeIncome, normalizeReturn, mapLimited, timeChunks } from '../server/operations.mjs';
import { collectAdvertising } from '../server/operations-ads.mjs';
import { summarizeSpend } from '../server/ads-monitor.mjs';
import { createApp } from '../server/index.mjs';
import { createAdsClient } from '../server/shopee-ads.mjs';

const now = Date.parse('2026-11-09T02:35:00Z');
const temp = async () => path.join(await mkdtemp(path.join(tmpdir(), 'shopee-ops-')), 'snapshot.json');
function fixture() {
  const calls = []; let broken = false, feeFailure = false;
  return { calls, breakOrders() { broken = true; }, failFee() { feeFailure = true; }, async shops() { return [123]; },
    async get(kind, shopId, params = {}) {
      calls.push({ kind, shopId, params });
      if (kind === 'shop') return { shop_name: 'test', region: 'MY' };
      if (kind === 'warehouse') return { response: [{ location_id: 'A', region: 'MY' }] };
      if (kind === 'orderList') { if (params.time_to !== periodFor('MY', now).to) return { response: { order_list: [], more: false } }; return { response: { order_list: params.cursor ? [{ order_sn: 'B' }] : [{ order_sn: 'A' }], more: broken || !params.cursor, next_cursor: 'cursor-2' } }; }
      if (kind === 'orderDetail') return { response: { order_list: params.order_sn_list.split(',').map(id => ({ order_sn: id, order_status: id === 'B' ? 'CANCELLED' : 'COMPLETED', currency: 'MYR', total_amount: id === 'A' ? 12.34 : 50, create_time: 1, item_list: [{ model_sku: 'S-01', item_id: 9, model_quantity_purchased: 2, product_location_id: ['A'] }], buyer_username: 'private' })) } };
      if (kind === 'escrow') { if (feeFailure) throw new Error('income failed'); return { response: { order_sn: params.order_sn, buyer_user_name: 'private', order_income: { escrow_amount: 10, commission_fee: 1, service_fee: 0, seller_transaction_fee: 0.3, buyer_email: 'private' } } }; }
      if (kind === 'returnList') return { response: { more: false, return: params.page_no === 0 && params.update_time_to === Math.floor(now / 1000) ? [{ return_sn: 'R1', order_sn: 'A', currency: 'MYR', status: 'REQUESTED', refund_amount: 12.34, item: [{ variation_sku: 'S-01', amount: 1 }], user: { email: 'private' } }] : [] } };
      if (kind === 'returnDetail') throw new Error('detail unavailable');
      throw new Error(`unexpected ${kind}`);
    }
  };
}
test('完整自然日按站点时区计算（默认近 30 天），巴西不混用亚洲日期；订单查询按 14 天切段', () => {
  const my = periodFor('MY', now), br = periodFor('BR', now);
  assert.equal(my.start, '2026-10-10'); assert.equal(my.end, '2026-11-08'); assert.equal(my.dates.length, 30);
  assert.equal(br.start, '2026-10-09'); assert.equal(br.end, '2026-11-07');
  assert.equal(my.to - my.from + 1, 30 * 86400); assert.equal(br.to - br.from + 1, 30 * 86400);
  const seven = periodFor('MY', now, 7); assert.equal(seven.start, '2026-11-02');
  const chunks = timeChunks(my.from, my.to);
  assert.deepEqual(chunks.map(c => (c.to - c.from + 1) / 86400), [14, 14, 2]); assert.equal(chunks[0].from, my.from); assert.equal(chunks.at(-1).to, my.to);
});
test('订单完整分页、取消排除、金额汇总与费用覆盖可对齐，保存不含买家资料', async () => {
  const client = fixture(), file = await temp(), ops = createOperations({ client, file, now: () => now });
  await ops.sync(['orders', 'fees', 'returns']); await ops.wait();
  const d = await ops.snapshot(), s = d.shops[0];
  assert.equal(d.job.error, ''); assert.equal(s.orders.summary.count, 2); assert.equal(s.orders.summary.totalAmount, 62.34);
  assert.equal(s.orders.summary.validAmount, 12.34); assert.equal(s.orders.summary.validCount, 1);
  assert.equal(s.orders.summary.skuLines, 2); assert.equal(s.orders.summary.missingSku, 0);
  assert.equal(s.orders.rows[0].fulfillment, 'overseas_warehouse');
  assert.equal(s.fees.expected, 1); assert.equal(s.fees.received, 1); assert.equal(s.fees.rows[0].income.service, 0);
  assert.equal(s.fees.rows[0].items, undefined, '扣费行不重复保存商品'); assert.equal(s.orders.rows[0].items[0].sku, 'S-01');
  assert.equal(s.returns.rows.length, 1); assert.equal(s.returns.detailsReceived, 0);
  assert.equal(s.returns.rows[0].detailError, 'detail unavailable');
  assert.equal(client.calls.filter(c => c.kind === 'orderList').length, 4, '30 天切 3 段，最后一段翻 2 页');
  const requests = client.calls.filter(c => c.kind === 'returnList').map(c => c.params);
  assert.deepEqual(requests.map(r => r.page_no), [0, 0, 0], '近 30 天切成 14 + 14 + 2 天三段，页码从 0 开始');
  assert.equal(requests[0].update_time_to, Math.floor(now / 1000)); assert.equal(requests.at(-1).update_time_from, Math.floor(now / 1000) - 30 * 86400 + 1);
  assert(requests.every(r => r.update_time_to - r.update_time_from < 15 * 86400));
  assert.deepEqual(s.returns.window, { from: Math.floor(now / 1000) - 30 * 86400 + 1, to: Math.floor(now / 1000), days: 30 });
  const saved = await readFile(file, 'utf8'); assert.ok(!saved.includes('private')); assert.ok(!saved.includes('buyer_username'));
  assert.equal((await createOperations({ client, file }).snapshot()).shops[0].orders.summary.count, 2);
});
test('分页重复游标时保留上次成功快照，不保存部分订单', async () => {
  const client = fixture(), ops = createOperations({ client, file: await temp(), now: () => now });
  await ops.sync(['orders']); await ops.wait(); const before = (await ops.snapshot()).shops[0].orders.updatedAt;
  client.breakOrders(); await ops.sync(['orders']); await ops.wait();
  const result = (await ops.snapshot()).shops[0].orders;
  assert.match(result.error, /分页未完成/); assert.equal(result.rows.length, 2); assert.equal(result.updatedAt, before);
});
test('费用读取失败留空并计覆盖缺口，不生成零收入', async () => {
  const client = fixture(); client.failFee();
  const ops = createOperations({ client, file: await temp(), now: () => now });
  await ops.sync(['fees']); await ops.wait(); const fees = (await ops.snapshot()).shops[0].fees;
  assert.equal(fees.expected, 1); assert.equal(fees.received, 0); assert.equal(fees.rows[0].income, null); assert.match(fees.rows[0].error, /income failed/);
});
test('收入缺失拒绝；未返回手续费保留null，真实零保留0', () => {
  assert.throws(() => normalizeIncome({ order_income: {} }), /缺少/);
  const income = normalizeIncome({ order_income: { escrow_amount: 0, service_fee: 0 } });
  assert.equal(income.net, 0); assert.equal(income.service, 0); assert.equal(income.transaction, null);
});
test('退货退款 / 仅退款：优先 return_solution，缺失时按是否需要退回商品判断', () => {
  const base = { return_sn: 'R', order_sn: 'O', status: 'PROCESSING' };
  assert.deepEqual([0, 1].map(v => normalizeReturn({ ...base, return_solution: v, needs_logistics: v === 1 }).solution), ['return_refund', 'refund_only']);
  assert.equal(normalizeReturn({ ...base, return_solution: 1 }).solutionBasis, 'return_solution');
  assert.deepEqual([true, false].map(v => normalizeReturn({ ...base, needs_logistics: v })).map(r => [r.solution, r.solutionBasis]), [['return_refund', 'needs_logistics'], ['refund_only', 'needs_logistics']]);
  assert.deepEqual([normalizeReturn(base).solution, normalizeReturn(base).solutionBasis], [null, null]);
  const full = normalizeReturn({ ...base, return_solution: 0, reason: 'WRONG_SIZE', reassessed_request_reason: 'NONE', text_reason: ' 尺码偏小 ', image: ['a', 'b'], buyer_videos: [{}], return_refund_request_type: 1, validation_type: 'warehouse_validation', is_arrived_at_warehouse: 3,
    negotiation: { negotiation_status: 'PENDING_RESPOND', latest_solution: 'REFUND', latest_offer_amount: 5, offer_due_date: 99 }, seller_compensation: { seller_compensation_status: 'PENDING_REQUEST', seller_compensation_due_date: 77, compensation_amount: 3 },
    return_pickup_address: { name: 'private', phone: 'private' }, user: { email: 'private' }, tracking_number: 'TH123', reverse_logistics_status: 'LOGISTICS_PICKUP_DONE', item: [{ item_id: 1, model_id: 2, variation_sku: 'S', amount: 1, item_price: 9.5 }] });
  assert.deepEqual([full.reason, full.textReason, full.imageCount, full.videoCount, full.requestType, full.validationType, full.warehouseStatus, full.negotiationStatus, full.latestOfferAmount, full.compensationStatus, full.compensationDueDate, full.trackingNumber, full.logisticsStatus, full.items[0].price],
    ['WRONG_SIZE', '尺码偏小', 2, 1, 1, 'warehouse_validation', 3, 'PENDING_RESPOND', 5, 'PENDING_REQUEST', 77, 'TH123', 'LOGISTICS_PICKUP_DONE', 9.5]);
  assert.ok(!JSON.stringify(full).includes('private'));
});
test('退货列表：同页重复返回去重继续，连续无新记录判定分页异常', async () => {
  const pages = { 0: ['R1', 'R2'], 1: ['R1', 'R2'], 2: ['R3'] };
  const make = loop => ({ async shops() { return [123]; }, async get(kind, shopId, params = {}) {
    if (kind === 'shop') return { shop_name: 'test', region: 'MY' };
    if (kind === 'returnList') { const first = params.update_time_to === Math.floor(now / 1000); const list = first ? (loop ? ['R1'] : pages[params.page_no] || []) : [];
      return { response: { more: first && (loop || params.page_no < 2), return: list.map(sn => ({ return_sn: sn, order_sn: `O-${sn}`, status: 'CLOSED', currency: 'MYR' })) } }; }
    if (kind === 'returnDetail') return { response: { return_sn: params.return_sn, order_sn: `O-${params.return_sn}`, status: 'CLOSED', return_solution: 1 } };
    throw new Error(kind); } });
  const ops = createOperations({ client: make(false), file: await temp(), now: () => now });
  await ops.sync(['returns']); await ops.wait();
  const ok = (await ops.snapshot()).shops[0].returns;
  assert.deepEqual(ok.rows.map(r => r.returnSn).sort(), ['R1', 'R2', 'R3']); assert.equal(ok.detailsReceived, 3); assert.equal(ok.rows[0].solution, 'refund_only');
  const bad = createOperations({ client: make(true), file: await temp(), now: () => now });
  await bad.sync(['returns']); await bad.wait();
  assert.match((await bad.snapshot()).shops[0].returns.error, /退货分页未完成/);
});
test('退货规格、平台期限保留，买家地址剔除', () => {
  const row = normalizeReturn({ return_sn: 'R', order_sn: 'O', status: 'REQUESTED', refund_amount: 0, return_seller_due_date: 55, seller_proof: { seller_evidence_deadline: 60 }, return_pickup_address: { phone: 'private' }, item: [{ variation_sku: 'SKU', amount: 3 }] });
  assert.equal(row.refundAmount, 0); assert.equal(row.sellerDueDate, 55); assert.equal(row.proofDueDate, 60); assert.equal(row.items[0].quantity, 3); assert.ok(!JSON.stringify(row).includes('private'));
});
test('损坏的已有快照不被覆盖', async () => {
  const file = await temp(); await writeFile(file, 'not json'); const ops = createOperations({ client: fixture(), file });
  await assert.rejects(ops.sync(), /快照损坏/); assert.equal(await readFile(file, 'utf8'), 'not json');
});
test('受控并发保持输入顺序，重复同步只启动一轮', async () => {
  let active = 0, max = 0;
  const result = await mapLimited([1, 2, 3, 4], 2, async x => { max = Math.max(max, ++active); await new Promise(r => setTimeout(r, 5)); active--; return x * 2; });
  assert.deepEqual(result, [2, 4, 6, 8]); assert.equal(max, 2);
  const client = fixture(), ops = createOperations({ client, file: await temp(), now: () => now });
  await ops.sync(['orders']); await ops.sync(['orders']); await ops.wait(); assert.equal(client.calls.filter(c => c.kind === 'shop').length, 1);
});
const inRange = (dates, p) => dates.slice(dates.indexOf(p.start_date), dates.indexOf(p.end_date) + 1);
test('广告计划缺失时保留店铺 30 日总额并声明覆盖待核；日表现按 15 天分段读取', async () => {
  const period = periodFor('VN', now), calls = [];
  const client = { async get(kind, shopId, params) {
    calls.push(kind);
    if (kind === 'daily') return { response: inRange(period.dates, params).map(date => ({ date, expense: 10 })) };
    throw new Error('not permitted');
  } };
  const result = await collectAdvertising(client, { shopId: 1, region: 'VN' }, period);
  assert.equal(result.total, 300); assert.equal(result.daily.length, 30); assert.equal(result.reconciliation, null); assert.equal(result.warnings.length, 1);
  assert.equal(calls.filter(k => k === 'daily').length, 2);
});
test('广告未满统计期不当作零消耗或完整数据', async () => {
  const client = { async get() { return { response: [] }; } };
  await assert.rejects(collectAdvertising(client, { shopId: 1, region: 'MY' }, periodFor('MY', now)), /不完整/);
});
test('广告组：30 天日表现、设置（名称 / 状态 / 预算 / 商品）、GMV Max 分周期查询、广告商品的规格 SKU', async () => {
  const period = periodFor('TH', now), dates = period.dates, gmsCalls = [];
  const shop = { shopId: 1, region: 'TH', orders: { rows: [{ items: [{ itemId: 11, name: '订单里的商品', sku: 'demo18-hei24-25' }] }] } };
  const client = { async get(kind, shopId, params = {}) {
    if (kind === 'daily') return { response: inRange(dates, params).map(date => ({ date, expense: 10, impression: 100, clicks: 5, broad_order: 1, broad_gmv: 40 })) };
    if (kind === 'campaignIndex') return { response: { campaign_list: [{ campaign_id: 7 }], has_next_page: false } };
    if (kind === 'campaignDaily') return { response: [{ campaign_list: params.campaign_id_list.split(',').map(id => ({ campaign_id: Number(id), ad_name: `计划${id}`, ad_type: 'manual', metrics_list: inRange(dates, params).map(date => ({ date, expense: id === '7' ? 2 : 1, clicks: 1, impression: 10, broad_order: 0, broad_gmv: 0 })) })) }] };
    if (kind === 'campaignSettings') return { response: { campaign_list: [{ campaign_id: 7, common_info: { ad_name: '鞋子组', ad_type: 'manual', campaign_status: 'ongoing', campaign_budget: 100, item_id_list: [11, 12] } }] } };
    if (kind === 'gmsItems') { gmsCalls.push(`${params.start_date}~${params.end_date}`); const days = inRange(dates, params).length; return { response: { campaign_id: 99, result_list: [{ item_id: 13, report: { expense: days * 3, broad_gmv: days * 9 } }], total: 1, has_next_page: false } }; }
    if (kind === 'gmsCampaign') { const days = inRange(dates, params).length; return { response: { report: { expense: days * 3, broad_gmv: days * 9, broad_order: days } } }; }
    if (kind === 'itemBase') return { response: { item_list: params.item_id_list.split(',').map(Number).map(id => ({ item_id: id, item_name: `商品${id}`, item_sku: `P${id}`, has_model: id !== 13 })) } };
    if (kind === 'modelList') return { response: { model: [{ model_sku: `S${params.item_id}-a` }, { model_sku: `S${params.item_id}-b` }] } };
    throw new Error(kind);
  } };
  const result = await collectAdvertising(client, shop, period);
  const plan = result.campaigns.find(c => c.campaignId === 7);
  assert.deepEqual([plan.name, plan.status, plan.budget, plan.itemIds, plan.expense, plan.daily.length], ['鞋子组', 'ongoing', 100, [11, 12], 60, 30]);
  assert.equal(result.campaigns.find(c => c.campaignId === 9000002).expense, 30, '已知但不在列表里的计划也补查');
  assert.deepEqual(Object.keys(result.gms.windows).map(Number), [1, 3, 7, 30]); assert.deepEqual([result.gms.windows[1].report.expense, result.gms.windows[7].items[0].expense], [3, 21]);
  assert.equal(gmsCalls.length, 4); assert.equal(gmsCalls[0], `${dates[29]}~${dates[29]}`);
  assert.deepEqual(result.reconciliation.gap, 300 - 60 - 30 - 30 - 90, '泰国两个已知广告组也计入');
  assert.deepEqual(result.items[11].skus, ['demo18-hei24-25'], '订单里见过的规格直接用'); assert.equal(result.items[11].name, '商品11');
  assert.deepEqual(result.items[12].skus, ['S12-a', 'S12-b']); assert.deepEqual(result.items[13].skus, ['P13'], '无规格商品用商品 SKU');
  const again = await collectAdvertising({ ...client, async get(kind, ...rest) { if (kind === 'itemBase' || kind === 'modelList') throw new Error('不应重复读取'); return client.get(kind, ...rest); } }, shop, period, result);
  assert.deepEqual(again.items[12].skus, ['S12-a', 'S12-b'], '7 天内复用上次读到的商品资料'); assert.equal(again.warnings.length, 0);
});
test('平台扣费：上次已取到且仍是已完成的订单沿用，其余重新读取；快照带 rev，未变化只回任务状态', async () => {
  const client = fixture(), ops = createOperations({ client, file: await temp(), now: () => now });
  await ops.sync(['orders', 'fees']); await ops.wait();
  const first = await ops.snapshot();
  assert.equal(first.shops[0].fees.reused, 0);
  const s = first.shops[0]; s.fees.rows[0].status = 'COMPLETED';
  const before = client.calls.filter(c => c.kind === 'escrow').length;
  await ops.sync(['fees']); await ops.wait();
  const second = await ops.snapshot();
  assert.equal(second.shops[0].fees.reused, 1); assert.equal(client.calls.filter(c => c.kind === 'escrow').length, before, '已完成订单不再重复读取结算');
  assert.ok(second.rev > first.rev);
  const same = await ops.snapshot(second.rev);
  assert.deepEqual([same.unchanged, same.shops, same.rev], [true, undefined, second.rev]);
  assert.ok((await ops.snapshot(second.rev - 1)).shops);
});
test('经营HTTP读取只读，指定店铺同步返回202，来源和参数校验有效', async t => {
  const client = fixture(), operations = createOperations({ client, file: await temp(), now: () => now });
  const server = createApp({ operations }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); t.after(() => server.close());
  const address = `http://127.0.0.1:${server.address().port}`;
  const before = await (await fetch(`${address}/api/operations`)).json();
  assert.equal(before.shops.length, 0); assert.equal(client.calls.length, 0);
  const forbidden = await fetch(`${address}/api/operations/sync`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://unrelated.example' }, body: '{}' });
  assert.equal(forbidden.status, 403); assert.equal(client.calls.length, 0);
  const invalid = await fetch(`${address}/api/operations/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"kinds":["write"]}' });
  assert.equal(invalid.status, 400);
  const sync = await fetch(`${address}/api/operations/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"kinds":["orders"],"shopIds":[123]}' });
  assert.equal(sync.status, 202); await operations.wait();
  const response = await fetch(`${address}/api/operations`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).shops[0].orders.summary.count, 2);
});
test('广告限流与授权错误区分，原始报错和凭据不回传', async () => {
  const file = await temp(); await writeFile(file, JSON.stringify({ partner_id: 99, shop_id_list: [123], access_token: 'test-access-secret', refresh_token: 'test-refresh-secret', expires_at: new Date(now + 3600000).toISOString() }));
  const client = createAdsClient({ file, env: { SHOPEE_PARTNER_ID: '99', SHOPEE_PARTNER_KEY: 'test-partner-secret' }, now: () => now,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ error: 'ads_rate_limit_total_api', message: 'test-access-secret' }) }) });
  await assert.rejects(client.get('balance', 123), error => /频率受限/.test(error.message) && !/test-access-secret|test-partner-secret/.test(error.message));
});
test('同步进行中只回任务状态', async () => {
  const client = fixture(), ops = createOperations({ client, file: await temp(), now: () => now });
  await ops.sync(['orders']); await ops.wait();
  const quick = await ops.snapshot(undefined, { jobOnly: true });
  assert.deepEqual([quick.unchanged, quick.shops, typeof quick.rev], [true, undefined, 'number']);
});
