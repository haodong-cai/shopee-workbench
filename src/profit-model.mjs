export function filterProfitOrders(orders, { region = 'all', fulfillment = 'overseas_warehouse', result = 'all', search = '', excludeReturns = false, scenario = 'A' } = {}) {
  const query = search.trim().toLowerCase(), field = fulfillment === 'cross_border' ? (scenario === 'B' ? 'preFreightB' : 'preFreightA') : (scenario === 'B' ? 'profitB' : 'profitA');
  return orders.filter(row => (region === 'all' || row.region === region) && row.fulfillment === fulfillment && (!excludeReturns || row.status !== 'TO_RETURN') && (result === 'all' || (result === 'pending' ? row[field] == null : result === 'loss' ? row[field] != null && row[field] < 0 : row[field] != null)) && (!query || [row.orderSn, ...row.lines.flatMap(line => [line.sku, line.name || ''])].some(value => value.toLowerCase().includes(query))));
}
export function summarizeProfitOrders(orders, scenario = 'A') {
  const field = row => row.fulfillment === 'cross_border' ? (scenario === 'B' ? 'preFreightB' : 'preFreightA') : (scenario === 'B' ? 'profitB' : 'profitA');
  const included = orders.filter(row => row[field(row)] != null);
  const cents = key => included.reduce((sum, row) => sum + Math.round(row[key] * 100), 0);
  const income = cents('incomeCny') + (scenario === 'B' ? cents('compoundCny') : 0);
  return { orders: orders.length, included: included.length, pending: orders.length - included.length, losses: included.filter(row => row[field(row)] < 0).length,
    income: included.length ? income / 100 : null, cost: included.length ? (cents('goodsCny') + cents('packingCny') + cents('adsCny') + included.filter(row => row.fulfillment !== 'cross_border').reduce((sum, row) => sum + Math.round(row.transportCny * 100), 0)) / 100 : null,
    profit: included.length ? included.reduce((sum, row) => sum + Math.round(row[field(row)] * 100), 0) / 100 : null };
}
