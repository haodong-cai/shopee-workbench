// 统计周期：同步保存近 30 个完整自然日，页面按“昨日 / 近 3 天 / 近 7 天 / 近 30 天”从中切片。
// 服务端（毛利、断货预警）和前端共用，保证同一周期下各页口径一致。
export const PERIODS = [[1, '昨日'], [3, '近 3 天'], [7, '近 7 天'], [30, '近 30 天']];
export const DAY_OPTIONS = PERIODS.map(([days]) => days);
export const periodLabel = days => (PERIODS.find(([d]) => d === days) || [, `近 ${days} 天`])[1];
const isNum = n => typeof n === 'number' && Number.isFinite(n);
const iso = dmy => dmy.split('-').reverse().join('-');
const localDate = (seconds, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(seconds * 1000));
const round = n => Math.round(n * 100) / 100;
const METRICS = ['expense', 'impression', 'clicks', 'broad_order', 'broad_gmv', 'direct_order', 'direct_gmv'];

/** 取统计期最后 days 天；数据不足时取全部并在 short 中标出。 */
export function windowPeriod(period, days) {
  if (!period?.dates?.length) return null;
  const dates = period.dates.slice(-days);
  return { ...period, dates, start: iso(dates[0]), end: iso(dates.at(-1)), days: dates.length, short: dates.length < days };
}
export function sumMetrics(rows) {
  const out = {};
  for (const key of METRICS) out[key] = rows.length && rows.every(r => isNum(r[key])) ? round(rows.reduce((n, r) => n + r[key], 0)) : rows.length ? null : 0;
  return out;
}

/** 广告数据按周期切片：店铺日消耗、计划日表现求和，GMV Max 用该周期单独查询的结果。 */
export function adsForWindow(ads, win, fullDays) {
  if (!ads || !win) return ads;
  if (!Array.isArray(ads.daily) || ads.period?.end !== win.end) return ads; // 广告与订单不是同一统计期，保持原样，由下游判断“待核”
  const dateSet = new Set(win.dates), whole = win.dates.length >= (fullDays || ads.period?.dates?.length || 0);
  const daily = ads.daily.filter(d => dateSet.has(d.date));
  const total = daily.length === win.dates.length && daily.every(d => isNum(d.expense)) ? round(daily.reduce((n, d) => n + d.expense, 0)) : null;
  const campaigns = (ads.campaigns || []).map(c => {
    if (Array.isArray(c.daily)) return { ...c, ...sumMetrics(c.daily.filter(d => dateSet.has(d.date))), windowed: true };
    return whole ? c : { ...c, expense: null, windowed: false };
  });
  const gmsWindow = ads.gms?.windows?.[win.dates.length] || (whole && ads.gms?.windows?.[ads.period?.dates?.length]) || null;
  const gmsItems = gmsWindow ? gmsWindow.items : whole ? ads.gmsItems || [] : null;
  const gmsTotal = gmsWindow ? gmsWindow.report?.expense ?? null : whole ? ads.reconciliation?.gmsTotal ?? null : null;
  const warnings = [...(ads.warnings || [])];
  let reconciliation = null;
  if (!campaigns.every(c => isNum(c.expense)) || gmsItems === null || (ads.reconciliation === null && whole)) {
    if (!ads.warnings?.length) warnings.push('该周期的计划 / GMV Max 明细缺失，请重新同步广告数据');
  } else if (isNum(total)) {
    const planTotal = round(campaigns.reduce((n, c) => n + c.expense, 0)), gms = isNum(gmsTotal) ? gmsTotal : 0;
    reconciliation = { ...(ads.reconciliation || {}), planTotal, gmsTotal: isNum(gmsTotal) ? gmsTotal : null, gap: round(total - planTotal - gms),
      gmsItemGap: isNum(gmsTotal) ? round(gmsTotal - gmsItems.reduce((n, i) => n + (i.expense || 0), 0)) : null };
  }
  return { ...ads, daily, total, campaigns, gmsItems: gmsItems || [], gmsReport: gmsWindow?.report || null, reconciliation, warnings, period: win, windowDays: win.dates.length };
}

/** 店铺快照按周期切片：订单按当地创建日，扣费跟随订单，广告见上；退货、库存不切。 */
export function scopeShop(shop, days) {
  const period = shop?.orders?.period;
  const win = windowPeriod(period, days);
  if (!win) return shop;
  const dateSet = new Set(win.dates.map(iso));
  const rows = (shop.orders.rows || []).filter(r => isNum(r.createTime) && dateSet.has(localDate(r.createTime, period.timeZone)));
  const sns = new Set(rows.map(r => r.orderSn));
  const fees = shop.fees?.rows ? (() => { const list = shop.fees.rows.filter(r => sns.has(r.orderSn)); return { ...shop.fees, rows: list, expected: list.length, received: list.filter(r => r.income).length, period: shop.fees.period?.end === period.end ? win : shop.fees.period }; })() : shop.fees;
  return { ...shop, orders: { ...shop.orders, rows, period: win }, fees, ads: adsForWindow(shop.ads, win, period.dates.length), fullPeriod: period };
}
