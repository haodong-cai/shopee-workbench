import './helpers/test-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateProductAdSpend } from '../server/ad-allocation.mjs';

test('其他站点保留原币种与分摊精度', () => {
  for (const currency of ['VND', 'THB', 'PHP']) {
    const result = allocateProductAdSpend([{ itemId: 11, amount: 100 }], [
      { orderSn: 'a', itemIds: [11] }, { orderSn: 'b', itemIds: [11] }, { orderSn: 'c', itemIds: [11] }
    ], currency);
    assert.equal(result.currency, currency);
    assert.equal(result.sourceAmount, result.allocatedAmount + result.unallocatedAmount);
    assert.deepEqual(result.orders.map(row => row.amount), [33.34, 33.33, 33.33]);
  }
});

test('按商品有效订单均摊，分配尾差且合计守恒', () => {
  const result=allocateProductAdSpend([{itemId:11,amount:.06}],[{orderSn:'d',itemIds:[11]},{orderSn:'b',itemIds:[11]},{orderSn:'c',itemIds:[11]},{orderSn:'a',itemIds:[11]}]);
  assert.equal(result.allocatedAmount,.06);assert.equal(result.unallocatedAmount,0);
  assert.equal(result.orders.find(row=>row.orderSn==='a').amount,.02);assert.equal(result.orders.find(row=>row.orderSn==='d').amount,.01);
});
test('同单同商品多SKU不重复；无订单商品广告费保留，不摊给其他商品', () => {
  const result=allocateProductAdSpend([{itemId:11,amount:10},{itemId:12,amount:2}],[{orderSn:'a',itemIds:[11,11]},{orderSn:'b',itemIds:[11]}]);
  assert.equal(result.orders[0].amount,5);assert.equal(result.orders[1].amount,5);assert.equal(result.unallocatedAmount,2);assert.equal(result.sourceAmount,12);
});
test('重复商品或订单、负金额拒绝分摊', () => {
  assert.throws(()=>allocateProductAdSpend([{itemId:11,amount:-1}],[]));
  assert.throws(()=>allocateProductAdSpend([{itemId:11,amount:1},{itemId:11,amount:2}],[]));
  assert.throws(()=>allocateProductAdSpend([],[{orderSn:'a',itemIds:[]},{orderSn:'a',itemIds:[]}]));
});
