const cents = value => value === null || value === undefined ? null : Math.round(value * 100);
const money = value => value === null ? null : value / 100;

function splitCents(total, weights) {
  const amount = cents(total);
  if (amount === null) return weights.map(() => null);
  if (weights.length === 1) return [amount];
  if (weights.some(weight => typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0)) return weights.map(() => null);
  const sum = weights.reduce((value, weight) => value + weight, 0);
  if (sum === 0) return amount === 0 ? weights.map(() => 0) : weights.map(() => null);
  const sign = Math.sign(amount), absolute = Math.abs(amount);
  const shares = weights.map(weight => absolute * weight / sum);
  const result = shares.map(share => Math.floor(share));
  let remainder = absolute - result.reduce((value, share) => value + share, 0);
  const order = shares.map((share, index) => ({ index, fraction: share - result[index] })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let i = 0; i < remainder; i++) result[order[i].index]++;
  return result.map(share => share * sign);
}

export function estimateLinkProfits(order, items) {
  if (!items.length || new Set(items.map(item => item.itemId)).size !== items.length) throw new Error('订单商品链接缺失或重复');
  const sales = items.map(item => item.saleAmount), goods = items.map(item => item.goodsRaw), pairs = items.map(item => item.shoePairs), ads = items.map(item => item.adSource);
  const fields = {
    incomeCny: splitCents(order.incomeCny, sales), goodsCny: splitCents(order.goodsCny, goods), packingCny: splitCents(order.packingCny, sales),
    transportCny: splitCents(order.transportCny, pairs), adsCny: splitCents(order.adsCny, ads), compoundCny: splitCents(order.compoundCny, sales)
  };
  const result = items.map((item, index) => {
    const value = Object.fromEntries(Object.entries(fields).map(([key, shares]) => [key, money(shares[index])]));
    const ready = ['incomeCny','goodsCny','packingCny','transportCny','adsCny'].every(key => value[key] !== null);
    return { ...item, ...value, basis: items.length === 1 ? 'single_link' : sales.every(sale => typeof sale === 'number' && sale >= 0) && sales.some(Boolean) ? 'sales_ratio' : 'pending',
      profitA: ready ? money(fields.incomeCny[index] - fields.goodsCny[index] - fields.packingCny[index] - fields.transportCny[index] - fields.adsCny[index]) : null,
      profitB: ready && fields.compoundCny[index] !== null ? money(fields.incomeCny[index] + fields.compoundCny[index] - fields.goodsCny[index] - fields.packingCny[index] - fields.transportCny[index] - fields.adsCny[index]) : null };
  });
  for (const key of Object.keys(fields)) if (fields[key].every(value => value !== null) && fields[key].reduce((sum, value) => sum + value, 0) !== cents(order[key])) throw new Error(`链接${key}分摊未守恒`);
  for (const key of ['profitA','profitB']) if (order[key] !== null && result.every(item => item[key] !== null) && result.reduce((sum,item) => sum + cents(item[key]), 0) !== cents(order[key])) throw new Error(`链接${key}与整单不一致`);
  return result;
}
