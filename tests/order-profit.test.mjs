import './helpers/test-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEstimatedFulfillment, estimateOrderProfit } from '../server/order-profit.mjs';

const complete = { currency: 'MYR', platformNetIncome: 100, goodsCost: 20, packagingCost: 2, fulfillmentCost: 8, advertisingCost: 10, advertisingTransferAddback: 0 };
test('逐单估算100收入减40成本得到60，不重复扣平台已扣费用', () => {
  assert.equal(estimateOrderProfit(complete).profit, 60);
  assert.deepEqual(estimateOrderProfit(complete).missing, []);
});
test('广告充值划拨加回后再扣消耗；技术费不加回', () => {
  assert.equal(estimateOrderProfit({ ...complete, platformNetIncome: 95, advertisingTransferAddback: 5 }).profit, 60);
  assert.equal(estimateOrderProfit({ ...complete, platformNetIncome: 95 }).profit, 55);
});
test('缺成本或划拨性质未知时利润为null，已确认0值保留', () => {
  const result = estimateOrderProfit({ ...complete, goodsCost: null, advertisingTransferAddback: null });
  assert.equal(result.profit, null); assert.equal(result.missing.length, 2); assert.equal(result.status, 'incomplete');
  assert.equal(estimateOrderProfit({ ...complete, goodsCost: 0 }).profit, 80);
});
test('允许平台负收入，拒绝负成本、非数值及未换算币种', () => {
  assert.equal(estimateOrderProfit({ ...complete, platformNetIncome: -5 }).profit, -45);
  for (const value of [-1, NaN, Infinity, '20']) assert.throws(() => estimateOrderProfit({ ...complete, goodsCost: value }));
  assert.throws(() => estimateOrderProfit({ ...complete, costCurrency: 'CNY' }), /汇率/);
});
test('预估路径以平台仓库国家匹配，不按仓库名字或ID猜国家', () => {
  const warehouses = [{ location_id: 'arbitrary-a', region: 'MY' }, { location_id: 'arbitrary-b', region: 'CN' }];
  const order = location => ({ item_list: [{ product_location_id: [location] }] });
  assert.equal(classifyEstimatedFulfillment(order('arbitrary-a'), warehouses, 'MY').type, 'overseas_warehouse');
  assert.equal(classifyEstimatedFulfillment(order('arbitrary-b'), warehouses, 'MY').type, 'cross_border');
  assert.equal(classifyEstimatedFulfillment(order('MY-looking-id'), warehouses, 'MY').type, 'unknown');
  assert.equal(classifyEstimatedFulfillment({ item_list: [{ product_location_id: ['arbitrary-a', 'arbitrary-b'] }] }, warehouses, 'MY').type, 'unknown');
});
