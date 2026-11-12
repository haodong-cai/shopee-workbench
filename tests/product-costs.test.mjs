import './helpers/test-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSkuCost, overseasOrderCost } from '../server/product-costs.mjs';

const catalog = { costs: { '001': [{ value: 10, row: 2 }], accessory: [{ value: 2, row: 3 }], free: [{ value: 0, row: 4 }] }, combos: { bundle: [{ sku: '001', quantity: 2 }, { sku: 'accessory', quantity: 1 }], nested: [{ sku: 'bundle', quantity: 2 }], cycle: [{ sku: 'cycle', quantity: 1 }] } };
test('单品与组合成本按数量算，保留SKU前导零与来源', () => {
  assert.equal(resolveSkuCost('001', catalog).unitCost, 10);
  assert.equal(resolveSkuCost('1', catalog).unitCost, null);
  assert.equal(resolveSkuCost('bundle', catalog).unitCost, 22);
  assert.equal(resolveSkuCost('nested', catalog).unitCost, 44);
  assert.deepEqual(resolveSkuCost('001', catalog).components[0].sourceRows, [2]);
});
test('缺成本、冲突、重复部件、循环不猜测；来源明确的零成本可识别', () => {
  assert.equal(resolveSkuCost('unknown', catalog).unitCost, null);
  assert.equal(resolveSkuCost('free', catalog).unitCost, 0);
  assert.equal(resolveSkuCost('cycle', catalog).unitCost, null);
  assert.equal(resolveSkuCost('001', { ...catalog, costs: { '001': [{ value: 10 }, { value: 11 }] } }).unitCost, null);
  assert.equal(resolveSkuCost('bundle', { ...catalog, combos: { bundle: [{ sku: '001', quantity: 1 }, { sku: '001', quantity: 1 }] } }).unitCost, null);
});
test('四国打包每单一次，运输按鞋双数，配件数量不传为鞋双数', () => {
  assert.deepEqual(overseasOrderCost('MY', 2), { currency: 'CNY', shoePairs: 2, packing: 4, transport: 4, total: 8 });
  assert.equal(overseasOrderCost('VN', 2).total, 3);
  assert.equal(overseasOrderCost('PH', 2).total, 7);
  assert.equal(overseasOrderCost('TH', 2).total, 4);
  assert.deepEqual(overseasOrderCost('TH', 3), { currency: 'CNY', shoePairs: 3, packing: 2, transport: 3, total: 5 });
  assert.throws(() => overseasOrderCost('MY', 0)); assert.throws(() => overseasOrderCost('BR', 1));
  assert.throws(() => overseasOrderCost('MY', 1, {}), /已确认/, '未在 config/business.json 设置费用的站点不试算');
});
