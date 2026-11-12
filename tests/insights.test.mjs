import './helpers/test-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectStock, stockOf, createOperations } from '../server/operations.mjs';
import { createSkuCosts } from '../server/sku-costs.mjs';

const shop = { shopId: 1, region: 'MY' };
function productClient({ failModel = false } = {}) {
  const calls = [];
  return { calls, async get(kind, shopId, params) {
    calls.push({ kind, params });
    if (kind === 'itemList') return params.offset === 0
      ? { response: { item: [{ item_id: 11, item_status: 'NORMAL' }, { item_id: 12, item_status: 'NORMAL' }], has_next_page: true, next_offset: 2 } }
      : { response: { item: [{ item_id: 13, item_status: 'NORMAL' }], has_next_page: false, next_offset: 3 } };
    if (kind === 'itemBase') return { response: { item_list: params.item_id_list.split(',').map(Number).map(id => ({ item_id: id, item_name: `鞋 ${id}`, item_sku: `SPU${id}`, has_model: id !== 13,
      stock_info_v2: id === 13 ? { summary_info: { total_available_stock: 5, total_reserved_stock: 1 } } : undefined, price_info: [{ current_price: 20 }], description: 'ignored' })) } };
    if (kind === 'modelList') {
      if (failModel && params.item_id === 12) throw new Error('error_permission');
      return { response: { tier_variation: [{ name: '颜色', option_list: [{ option: '黑' }, { option: '白' }] }, { name: '尺码', option_list: [{ option: '38' }] }],
        model: [{ model_id: 101, model_sku: `S${params.item_id}-hei38`, tier_index: [0, 0], stock_info_v2: { seller_stock: [{ location_id: 'MYZ', stock: 3 }, { location_id: 'MYA', stock: 2 }] }, price_info: [{ current_price: 19.9 }] },
          { model_id: 102, model_sku: `S${params.item_id}-bai38`, tier_index: [1, 0], stock_info_v2: {} }] } };
    }
    throw new Error(`unexpected ${kind}`);
  } };
}

test('库存：分页读取商品、展开规格，缺字段为 null 而不是 0', async () => {
  const client = productClient(), progress = [];
  const result = await collectStock(client, shop, m => progress.push(m));
  assert.equal(result.items, 3);
  assert.equal(result.rows.length, 5);
  const black = result.rows.find(r => r.modelSku === 'S11-hei38');
  assert.equal(black.available, 5); assert.equal(black.modelName, '黑 / 38'); assert.equal(black.price, 19.9);
  assert.equal(result.rows.find(r => r.modelSku === 'S11-bai38').available, null);
  const single = result.rows.find(r => r.itemId === 13);
  assert.equal(single.modelId, 0); assert.equal(single.available, 5); assert.equal(single.reserved, 1);
  assert.equal(result.unknownStock, 2);
  assert.ok(!JSON.stringify(result).includes('ignored'));
  assert.ok(progress.length > 0);
  assert.deepEqual(client.calls.filter(c => c.kind === 'itemList').map(c => c.params.item_status), ['NORMAL', 'NORMAL']);
});

test('库存：单个商品规格失败只标该商品待补，并给出警告', async () => {
  const result = await collectStock(productClient({ failModel: true }), shop);
  const failed = result.rows.filter(r => r.itemId === 12);
  assert.equal(failed.length, 1); assert.equal(failed[0].available, null); assert.match(failed[0].error, /permission/);
  assert.match(result.warnings.join(), /1 个商品/);
});

test('stockOf 汇总优先，其次按仓位求和', () => {
  assert.deepEqual(stockOf({ summary_info: { total_available_stock: 0, total_reserved_stock: 2 } }), { available: 0, reserved: 2 });
  assert.deepEqual(stockOf({ seller_stock: [{ stock: 1 }], shopee_stock: [{ stock: 4 }] }), { available: 5, reserved: null });
  assert.deepEqual(stockOf({ seller_stock: [{ stock: 'x' }] }), { available: null, reserved: null });
  assert.deepEqual(stockOf(undefined), { available: null, reserved: null });
});

test('订单保存发货期限、取消原因与成交单价，不保存买家资料', async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'ops-ins-')), 'ops.json');
  const client = { async shops() { return [1]; }, async get(kind, id, params) {
    if (kind === 'shop') return { shop_name: 't', region: 'MY' };
    if (kind === 'warehouse') return { response: [] };
    if (kind === 'orderList') { const first = !this.listed; this.listed = true; return { response: { order_list: first ? [{ order_sn: 'A' }, { order_sn: 'B' }] : [], more: false } }; }
    if (kind === 'orderDetail') {
      assert.match(params.response_optional_fields, /cancel_reason/);
      return { response: { order_list: [
        { order_sn: 'A', order_status: 'READY_TO_SHIP', currency: 'MYR', total_amount: 20, create_time: 1, ship_by_date: 1700000000, days_to_ship: 2, pay_time: 5, item_list: [{ item_id: 9, model_id: 3, model_sku: 'S', model_quantity_purchased: 1, model_discounted_price: 18.5, model_original_price: 30 }], buyer_username: 'private' },
        { order_sn: 'B', order_status: 'CANCELLED', currency: 'MYR', total_amount: 20, create_time: 1, ship_by_date: 0, cancel_by: 'buyer', cancel_reason: 'Out of Stock', buyer_cancel_reason: 'Change of mind', item_list: [{ item_id: 9, model_id: 3, model_sku: 'S', model_quantity_purchased: 1, model_discounted_price: 0 }] }] } };
    }
    throw new Error(kind);
  } };
  const ops = createOperations({ client, file, now: () => Date.parse('2026-11-09T02:35:00Z') });
  await ops.sync(['orders']); await ops.wait();
  const rows = (await ops.snapshot()).shops[0].orders.rows, a = rows.find(r => r.orderSn === 'A'), b = rows.find(r => r.orderSn === 'B');
  assert.equal(a.shipByDate, 1700000000); assert.equal(a.daysToShip, 2); assert.equal(a.items[0].price, 18.5);
  assert.equal(b.shipByDate, null); assert.equal(b.cancelBy, 'buyer'); assert.equal(b.cancelReason, 'Out of Stock'); assert.equal(b.items[0].price, null);
  assert.ok(!(await readFile(file, 'utf8')).includes('private'));
});

test('采购成本：读取最新档案，组合装展开，缺失返回原因', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cost-'));
  await writeFile(path.join(dir, 'product-cost-catalog-2026-10-01.json'), JSON.stringify({ currency: 'CNY', sources: {}, costs: { OLD: [{ value: 1, row: 1 }] }, combos: {} }));
  await writeFile(path.join(dir, 'product-cost-catalog-2026-10-20.json'), JSON.stringify({ currency: 'CNY', sources: { 'a.xlsx': {} }, costs: { A: [{ value: 10, row: 2 }], B: [{ value: 0.5, row: 3 }] }, combos: { 'A+B': [{ sku: 'A', quantity: '1.0000' }, { sku: 'B', quantity: '2.0000' }] } }));
  const result = await createSkuCosts({ dir }).lookup(['A', 'A+B', 'OLD', 'X']);
  assert.equal(result.date, '2026-10-20');
  assert.equal(result.costs.A.unitCost, 10); assert.equal(result.costs['A+B'].unitCost, 11); assert.equal(result.costs['A+B'].combo, true);
  assert.equal(result.costs.OLD.unitCost, null); assert.match(result.costs.X.missing[0], /未找到/);
  assert.equal((await createSkuCosts({ dir: path.join(dir, 'none') }).lookup(['A'])).available, false);
  await assert.rejects(createSkuCosts({ dir }).lookup('A'), /无效/);
});
test('SKU 映射 SPU：组合装拆成单品各自的 SPU，鞋 / 配件按核对清单或前缀判断', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spu-'));
  await writeFile(path.join(dir, 'product-cost-catalog-2026-10-20.json'), JSON.stringify({ currency: 'CNY', sources: {}, costs: { 'SHOE-hei30': [{ value: 10, row: 2 }], BOW: [{ value: 0.5, row: 3 }] },
    combos: { 'SHOE+BOW-hei30': [{ sku: 'SHOE-hei30', quantity: '1.0000' }, { sku: 'BOW', quantity: '2.0000' }] },
    single: { 'SHOE-hei30': { spu: 'SHX048', spuName: '2026马卡龙' }, BOW: { spu: 'ACC-DP-0013', spuName: 'ACC055波点蝴蝶结' } } }));
  const roles = { load: async () => ({ roles: { 'SHX048': 'shoe_pair' } }) };
  const result = await createSkuCosts({ dir, roles }).lookup(['SHOE+BOW-hei30', 'SHOE-hei30', 'NOPE']);
  assert.deepEqual(result.costs['SHOE+BOW-hei30'].parts, [{ sku: 'SHOE-hei30', spu: 'SHX048', spuName: '2026马卡龙', role: 'shoe_pair' }, { sku: 'BOW', spu: 'ACC-DP-0013', spuName: 'ACC055波点蝴蝶结', role: 'accessory' }]);
  assert.deepEqual(result.costs['SHOE-hei30'].parts.map(p => p.spu), ['SHX048']); assert.deepEqual(result.costs.NOPE.parts, []);
});
