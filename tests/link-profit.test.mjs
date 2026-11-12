import './helpers/test-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateLinkProfits } from '../server/link-profit.mjs';

test('单链接直接承接整单到手额与成本', () => {
  const order = { incomeCny: 100, goodsCny: 40, packingCny: 3, transportCny: 2, adsCny: 10, compoundCny: 5, profitA: 45, profitB: 50 };
  const [link] = estimateLinkProfits(order, [{ itemId: 1, saleAmount: null, goodsRaw: 40, shoePairs: 2, adSource: 10 }]);
  assert.deepEqual([link.basis, link.incomeCny, link.packingCny, link.adsCny, link.profitA, link.profitB], ['single_link', 100, 3, 10, 45, 50]);
});

test('多链接按成交额拆净收入和一次性处理费，运输按双数且分位守恒', () => {
  const order = { incomeCny: 100.01, goodsCny: 30.01, packingCny: 3, transportCny: 3.6, adsCny: 6.01, compoundCny: 1.01, profitA: 57.39, profitB: 58.4 };
  const links = estimateLinkProfits(order, [
    { itemId: 1, saleAmount: 60, goodsRaw: 20, shoePairs: 2, adSource: 4 },
    { itemId: 2, saleAmount: 40, goodsRaw: 10, shoePairs: 1, adSource: 2 }
  ]);
  assert.equal(links[0].basis, 'sales_ratio');
  for (const key of ['incomeCny','goodsCny','packingCny','transportCny','adsCny','compoundCny','profitA','profitB']) assert.equal(Math.round(links.reduce((sum, link) => sum + link[key], 0) * 100), Math.round(order[key] * 100));
  assert.deepEqual(links.map(link => link.transportCny), [2.4, 1.2]);
  assert.deepEqual(links.map(link => link.packingCny), [1.8, 1.2]);
});

test('多链接缺成交金额时只保留整单试算，链接利润待补', () => {
  const order = { incomeCny: 20, goodsCny: 8, packingCny: 3, transportCny: 1, adsCny: 0, compoundCny: 0, profitA: 8, profitB: 8 };
  const links = estimateLinkProfits(order, [{ itemId: 1, saleAmount: null, goodsRaw: 4, shoePairs: 1, adSource: 0 }, { itemId: 2, saleAmount: 10, goodsRaw: 4, shoePairs: 0, adSource: 0 }]);
  assert(links.every(link => link.basis === 'pending' && link.profitA === null));
});
