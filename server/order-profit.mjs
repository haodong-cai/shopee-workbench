export function classifyEstimatedFulfillment(order, warehouses, shopRegion) {
  const locations = [...new Set((order.item_list || []).flatMap(item => item.product_location_id || []))];
  const regions = locations.map(location => warehouses.find(row => row.location_id === location)?.region || null);
  const unique = [...new Set(regions)];
  const country = locations.length && !regions.includes(null) && unique.length === 1 ? unique[0] : null;
  return { type: !country ? 'unknown' : country === 'CN' && shopRegion !== 'CN' ? 'cross_border' : country === shopRegion ? 'overseas_warehouse' : 'unknown',
    country, locations, basis: '订单商品location_id匹配平台仓库region，仅作为预估履约路径' };
}

export function estimateOrderProfit(input) {
  if (!input || typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) throw new Error('需要明确同一计算币种。');
  const names = { platformNetIncome: '平台预计净收入', goodsCost: '采购成本', packagingCost: '包材费用', fulfillmentCost: '平台未扣除的履约费用', advertisingCost: '广告成本估算', advertisingTransferAddback: '广告划拨与技术费性质核对' };
  const missing = [];
  for (const [key, label] of Object.entries(names)) {
    const value = input[key];
    if (value === null || value === undefined) missing.push(label);
    else if (typeof value !== 'number' || !Number.isFinite(value) || (key !== 'platformNetIncome' && value < 0)) throw new Error(`${label}金额无效。`);
  }
  if (input.costCurrency && input.costCurrency !== input.currency) throw new Error('成本币种不同，需先提供可核对的汇率换算。');
  const profit = missing.length ? null : Math.round((input.platformNetIncome + input.advertisingTransferAddback - input.goodsCost - input.packagingCost - input.fulfillmentCost - input.advertisingCost) * 100) / 100;
  return { currency: input.currency, profit, missing, status: missing.length ? 'incomplete' : 'estimated', formula: '平台预计净收入+已确认广告资金划拨加回-采购成本-包材-平台未扣履约费用-广告成本估算' };
}
