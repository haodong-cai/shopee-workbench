import { businessConfig } from './business-config.mjs';

const round = value => Math.round((value + Number.EPSILON) * 100) / 100;

// perPair：跨境每双鞋的头程 / 处理费（人民币），来自 config/business.json；未设置时毛利保持待补。
export function estimateCrossBorderBeforeFreight({ sourceNet, fxRate, costLines, adsCny, compoundSource, perPair = businessConfig.crossBorderPerPair }) {
  if (!Number.isFinite(fxRate) || fxRate <= 0) throw new Error('跨境订单汇率无效');
  const validLines = costLines.every(line => Number.isFinite(line.unitCostCny) && Number.isInteger(line.quantity) && line.quantity > 0);
  const validPairs = costLines.every(line => Number.isInteger(line.shoePairsPerUnit) && line.shoePairsPerUnit >= 0);
  const shoePairs = validPairs ? costLines.reduce((sum, line) => sum + line.shoePairsPerUnit * line.quantity, 0) : null;
  const incomeCny = Number.isFinite(sourceNet) ? round(sourceNet * fxRate) : null;
  const goodsCny = validLines ? round(costLines.reduce((sum, line) => sum + line.unitCostCny * line.quantity, 0)) : null;
  const rate = typeof perPair === 'number' && Number.isFinite(perPair) && perPair >= 0 ? perPair : null;
  const packingCny = shoePairs === null || rate === null ? null : round(shoePairs * rate);
  const compoundCny = Number.isFinite(compoundSource) ? round(compoundSource * fxRate) : null;
  const ready = [incomeCny, goodsCny, packingCny, adsCny].every(Number.isFinite);
  const preFreightA = ready ? round(incomeCny - goodsCny - packingCny - adsCny) : null;
  return { shoePairs, incomeCny, goodsCny, packingCny, transportCny: null, compoundCny,
    preFreightA, preFreightB: preFreightA !== null && compoundCny !== null ? round(preFreightA + compoundCny) : null,
    profitA: null, profitB: null };
}
