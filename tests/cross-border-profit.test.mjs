import './helpers/test-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCrossBorderBeforeFreight } from '../server/cross-border-profit.mjs';

test('跨境两双各收每双处理费（测试配置 0.5 元），平台净收入已扣费用且完整毛利保持待补', () => {
  const row = estimateCrossBorderBeforeFreight({ sourceNet: 50, fxRate: 1.6, costLines: [{ unitCostCny: 10, quantity: 2, shoePairsPerUnit: 1 }], adsCny: 5, compoundSource: 2 });
  assert.deepEqual([row.incomeCny, row.goodsCny, row.packingCny, row.preFreightA, row.preFreightB, row.transportCny, row.profitA], [80, 20, 1, 54, 57.2, null, null]);
});

test('账单、SKU双数或广告缺失时不把未知项目算作零', () => {
  const base = { sourceNet: 10, fxRate: 1, costLines: [{ unitCostCny: 3, quantity: 1, shoePairsPerUnit: 1 }], adsCny: 1, compoundSource: null };
  assert.equal(estimateCrossBorderBeforeFreight(base).preFreightB, null);
  assert.equal(estimateCrossBorderBeforeFreight({ ...base, sourceNet: null }).preFreightA, null);
  assert.equal(estimateCrossBorderBeforeFreight({ ...base, adsCny: null }).preFreightA, null);
  assert.equal(estimateCrossBorderBeforeFreight({ ...base, costLines: [{ ...base.costLines[0], shoePairsPerUnit: null }] }).preFreightA, null);
  assert.equal(estimateCrossBorderBeforeFreight({ ...base, perPair: null }).packingCny, null, '每双处理费未设置时保持待补');
  assert.equal(estimateCrossBorderBeforeFreight({ ...base, perPair: null }).preFreightA, null);
});
