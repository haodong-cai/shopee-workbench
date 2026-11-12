export function allocateProductAdSpend(itemSpends, orders, currency = 'MYR') {
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('广告分摊需要明确币种。');
  const allocations = new Map(orders.map(order => [order.orderSn, { orderSn: order.orderSn, amount: 0, items: [] }]));
  if (allocations.size !== orders.length) throw new Error('分摊订单号重复。');
  const seenItems = new Set(), unallocated = [];
  let sourceCents = 0;
  for (const item of itemSpends) {
    if (!Number.isSafeInteger(item.itemId) || seenItems.has(item.itemId) || typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount < 0) throw new Error('商品广告费重复或金额无效。');
    seenItems.add(item.itemId);
    const cents = Math.round(item.amount * 100);
    sourceCents += cents;
    const eligible = orders.filter(order => order.itemIds.includes(item.itemId)).sort((a,b) => a.orderSn.localeCompare(b.orderSn));
    if (!eligible.length) { unallocated.push({ itemId: item.itemId, amount: cents / 100, reason: '期间无有效订单，保留店铺层面广告费' }); continue; }
    const base = Math.floor(cents / eligible.length), remainder = cents % eligible.length;
    eligible.forEach((order,index) => {
      const row = allocations.get(order.orderSn), portion = base + (index < remainder ? 1 : 0);
      row.amount += portion;
      row.items.push({ itemId: item.itemId, amount: portion / 100, eligibleOrders: eligible.length });
    });
  }
  const result = [...allocations.values()].map(row => ({ ...row, amount: row.amount / 100 }));
  const allocatedCents = result.reduce((total,row) => total + Math.round(row.amount * 100), 0);
  const unallocatedCents = unallocated.reduce((total,row) => total + Math.round(row.amount * 100), 0);
  if (sourceCents !== allocatedCents + unallocatedCents) throw new Error('广告分摊金额未守恒。');
  return { currency, sourceAmount: sourceCents / 100, allocatedAmount: allocatedCents / 100, unallocatedAmount: unallocatedCents / 100, orders: result, unallocated };
}
