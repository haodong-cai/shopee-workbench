import { businessConfig } from './business-config.mjs';

// 海外仓履约费用来自 config/business.json；未填写的站点不在此表中，毛利会显示待补。
export const overseasFeeRules = businessConfig.overseasFees;

export function overseasOrderCost(region, shoePairs, rules = overseasFeeRules) {
  const rule = rules[region];
  if (!rule || !Number.isInteger(shoePairs) || shoePairs < 1) throw new Error('需要已确认的站点与鞋双数。');
  return { currency: rule.currency, shoePairs, packing: rule.packingPerOrder,
    transport: Math.round(rule.transportPerPair * shoePairs * 100) / 100,
    total: Math.round((rule.packingPerOrder + rule.transportPerPair * shoePairs) * 100) / 100 };
}

export function resolveSkuCost(sku, catalog, ancestors = []) {
  const key = typeof sku === 'string' ? sku.trim() : '';
  const fail = reason => ({ sku: key, unitCost: null, missing: [reason], components: [] });
  if (!key) return fail('平台规格SKU为空');
  if (ancestors.includes(key)) return fail(`组合循环：${[...ancestors, key].join('→')}`);
  const costs = catalog.costs[key];
  if (costs?.length) {
    const values = [...new Set(costs.map(row => row.value))];
    if (values.length !== 1 || typeof values[0] !== 'number' || !Number.isFinite(values[0]) || values[0] < 0) return fail(`成本冲突或无效：${key}`);
    return { sku: key, unitCost: values[0], currency: 'CNY', missing: [], components: [{ sku: key, quantity: 1, unitCost: values[0], sourceRows: costs.map(row => row.row) }] };
  }
  const combo = catalog.combos[key];
  if (!combo?.length) return fail(`未找到成本：${key}`);
  if (new Set(combo.map(row => row.sku)).size !== combo.length) return fail(`组合部件重复：${key}`);
  const components = [], missing = [];
  for (const item of combo) {
    if (!Number.isInteger(Number(item.quantity)) || Number(item.quantity) <= 0) { missing.push(`组合数量无效：${key}/${item.sku}`); continue; }
    const result = resolveSkuCost(item.sku, catalog, [...ancestors, key]);
    missing.push(...result.missing);
    components.push(...result.components.map(row => ({ ...row, quantity: row.quantity * Number(item.quantity) })));
  }
  return { sku: key, currency: 'CNY', unitCost: missing.length ? null : components.reduce((total, row) => total + row.unitCost * row.quantity, 0), missing, components };
}
