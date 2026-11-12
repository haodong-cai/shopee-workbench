import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allocateProductAdSpend } from './ad-allocation.mjs';
import { estimateLinkProfits } from './link-profit.mjs';
import { estimateCrossBorderBeforeFreight } from './cross-border-profit.mjs';
import { businessConfig } from './business-config.mjs';
import { overseasFeeRules, resolveSkuCost } from './product-costs.mjs';
import { roleOf, createSkuRoles } from './sku-roles.mjs';
import { scopeShop, DAY_OPTIONS } from '../src/window.mjs';

// 滚动毛利：用最近一次同步的订单、平台扣费、广告与成本档案，按原试算口径逐单重算。
// 履约费用与跨境处理费来自 config/business.json；缺项保持 null，不按 0 计算。
const EXCLUDED = ['CANCELLED', 'IN_CANCEL', 'UNPAID'];
const LABEL = { MY: '马来西亚', VN: '越南', PH: '菲律宾', TH: '泰国' };
const COMPOUND = 'ads_escrow_top_up_fee_or_technical_support_fee';
const isNum = value => typeof value === 'number' && Number.isFinite(value);
const cents = value => Math.round((value + Number.EPSILON) * 100);
const round = value => cents(value) / 100;
const sameWindow = (a, b) => Boolean(a?.period && b?.period && a.period.start === b.period.start && a.period.end === b.period.end);
const localDate = (seconds, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(seconds * 1000));

function allocateAds(shop, valid) {
  const ads = shop.ads;
  if (!Array.isArray(ads?.daily) || !isNum(ads.total)) return { note: '广告数据待同步' };
  if (!sameWindow(ads, shop.orders)) return { note: '广告数据与订单不是同一统计期，待重新同步' };
  if (!ads.reconciliation) return { note: `广告计划明细未取得${ads.warnings?.[0] ? `（${ads.warnings[0]}）` : ''}` };
  try {
    const byItem = new Map();
    const add = (itemId, amount) => byItem.set(itemId, (byItem.get(itemId) || 0) + amount);
    for (const plan of ads.campaigns || []) if (plan.itemIds?.length === 1 && plan.expense > 0) add(plan.itemIds[0], plan.expense);
    for (const item of ads.gmsItems || []) if (item.expense > 0) add(item.itemId, item.expense);
    const result = allocateProductAdSpend([...byItem].map(([itemId, amount]) => ({ itemId, amount: round(amount) })),
      valid.map(row => ({ orderSn: row.orderSn, itemIds: [...new Set(row.items.map(item => item.itemId))] })), shop.currency);
    return { note: '', total: ads.total, attributed: result.sourceAmount, noOrder: result.unallocatedAmount, gap: round(ads.total - result.sourceAmount),
      byOrder: new Map(result.orders.map(row => [row.orderSn, row])) };
  } catch (error) { return { note: `广告分摊未完成：${error.message}` }; }
}

function costLine(item, catalog, roles, missing) {
  const cost = resolveSkuCost(item.sku, catalog);
  let pairs = 0, unknown = cost.unitCost === null, inferred = false;
  if (cost.unitCost === null) missing.push(...cost.missing);
  for (const part of cost.components) {
    const spu = catalog.single?.[part.sku]?.spu, found = roleOf(spu, roles);
    if (!found.role) { unknown = true; missing.push(`部件鞋双数待核：${part.sku}${spu ? ` / ${spu}` : ''}`); continue; }
    if (found.basis === 'prefix') inferred = true;
    if (found.role === 'shoe_pair') pairs += part.quantity;
  }
  if (!Number.isInteger(item.quantity) || item.quantity < 1) missing.push('商品数量待核');
  return { sku: item.sku || '', itemId: item.itemId, name: item.name || '', quantity: item.quantity, unitCostCny: cost.unitCost === null ? null : Math.round(cost.unitCost * 10000) / 10000,
    shoePairsPerUnit: unknown ? null : pairs, inferred,
    components: cost.components.map(part => ({ sku: part.sku, quantity: part.quantity, unitCostCny: part.unitCost, sourceRows: part.sourceRows })) };
}

function linkItems(order, lines, adRow) {
  return [...new Set(order.items.map(item => item.itemId))].map(itemId => {
    const items = order.items.filter(item => item.itemId === itemId), own = lines.filter(line => line.itemId === itemId);
    return { itemId, name: items[0]?.name || '', quantity: items.reduce((sum, item) => sum + (item.quantity || 0), 0), skus: [...new Set(own.map(line => line.sku))],
      saleAmount: items.every(item => isNum(item.price) && isNum(item.quantity)) ? items.reduce((sum, item) => sum + item.price * item.quantity, 0) : null,
      goodsRaw: own.every(line => isNum(line.unitCostCny) && isNum(line.quantity)) ? own.reduce((sum, line) => sum + line.unitCostCny * line.quantity, 0) : null,
      shoePairs: own.every(line => line.shoePairsPerUnit !== null && isNum(line.quantity)) ? own.reduce((sum, line) => sum + line.shoePairsPerUnit * line.quantity, 0) : null,
      adSource: adRow ? adRow.items.find(row => row.itemId === itemId)?.amount ?? 0 : null };
  });
}

function buildOrder(shop, order, ctx) {
  const { rule, rate, catalog, roles, income, feesReady, ads, crossPerPair } = ctx, missing = [];
  const lines = order.items.map(item => costLine(item, catalog, roles, missing));
  const bill = income.get(order.orderSn) || null;
  const sourceNet = bill ? (isNum(bill.fields?.escrow_amount_after_adjustment) ? bill.fields.escrow_amount_after_adjustment : bill.net) : null;
  if (!isNum(sourceNet)) missing.push(feesReady ? '结算净收入待补' : '平台扣费待与订单同期同步');
  if (!rate) missing.push('汇率待取');
  const adRow = ads.byOrder?.get(order.orderSn) || null;
  if (!adRow) missing.push(ads.note || '广告分摊待补');
  const compoundSource = bill && isNum(bill.fields?.[COMPOUND]) ? bill.fields[COMPOUND] : null;
  const costReady = lines.every(line => isNum(line.unitCostCny) && Number.isInteger(line.quantity) && line.quantity > 0);
  const shoePairs = lines.every(line => line.shoePairsPerUnit !== null && Number.isInteger(line.quantity)) ? lines.reduce((sum, line) => sum + line.shoePairsPerUnit * line.quantity, 0) : null;
  const adsSource = adRow ? adRow.amount : null, adsCny = adRow && rate ? round(adRow.amount * rate) : null;
  const base = { region: shop.region, orderSn: order.orderSn, status: order.status, fulfillment: order.fulfillment, sourceCurrency: shop.currency, createTime: order.createTime,
    date: isNum(order.createTime) ? localDate(order.createTime, shop.orders.period.timeZone) : null, shoePairs, sourceNet: isNum(sourceNet) ? sourceNet : null, adsSource, adsCny,
    inferred: lines.some(line => line.inferred),
    platformFees: bill ? { commission: bill.commission ?? null, service: bill.service ?? null, transaction: bill.transaction ?? null, compound: compoundSource } : null };
  const publicLines = lines.map(({ shoePairsPerUnit, inferred, ...line }) => line);

  if (order.fulfillment === 'cross_border') {
    const estimate = rate ? estimateCrossBorderBeforeFreight({ sourceNet, fxRate: rate, costLines: lines, adsCny, compoundSource, perPair: crossPerPair })
      : { shoePairs, incomeCny: null, goodsCny: null, packingCny: null, transportCny: null, compoundCny: null, preFreightA: null, preFreightB: null, profitA: null, profitB: null };
    // 跨境头程按 config/business.json 的每双处理费计（平台账单内运费已含在结算净收入里），preFreightA/B 即跨境完整毛利。
    if (crossPerPair === null) missing.push('跨境每双处理费未设置（config/business.json）');
    return { ...base, ...estimate, transportCny: estimate.packingCny === null ? null : 0, shoePairs, missing: [...new Set(missing)], lines: publicLines, links: [] };
  }

  const incomeCny = isNum(sourceNet) && rate ? round(sourceNet * rate) : null;
  const goodsCny = costReady ? round(lines.reduce((sum, line) => sum + line.unitCostCny * line.quantity, 0)) : null;
  const compoundCny = compoundSource !== null && rate ? round(compoundSource * rate) : null;
  const billable = Number.isInteger(shoePairs) && shoePairs > 0;
  if (shoePairs === 0) missing.push('纯配件订单运输规则待补，不套鞋类费用');
  const packingCny = billable ? rule.packingPerOrder : null, transportCny = billable ? round(rule.transportPerPair * shoePairs) : null;
  const ready = !missing.length && [incomeCny, goodsCny, packingCny, transportCny, adsCny].every(isNum);
  const profitA = ready ? (cents(incomeCny) - cents(goodsCny) - cents(packingCny) - cents(transportCny) - cents(adsCny)) / 100 : null;
  const profitB = profitA !== null && compoundCny !== null ? (cents(profitA) + cents(compoundCny)) / 100 : null;
  const row = { ...base, incomeCny, goodsCny, packingCny, transportCny, compoundCny, profitA, profitB, preFreightA: null, preFreightB: null, missing: [...new Set(missing)], lines: publicLines, links: [] };
  try { row.links = estimateLinkProfits(row, linkItems(order, lines, adRow)).map(({ goodsRaw, ...link }) => link); } catch { row.links = []; }
  return row;
}

export function buildLiveProfit({ shops = [], catalog, roles = {}, rates = {}, now = Date.now(), feeRules = overseasFeeRules, crossPerPair = businessConfig.crossBorderPerPair } = {}) {
  const outShops = [], orders = [], excluded = [];
  for (const shop of shops) {
    const rule = feeRules[shop.region];
    if (!rule) { if (shop.region) excluded.push({ region: shop.region, reason: '履约费用尚未设置（config/business.json）' }); continue; }
    if (!Array.isArray(shop.orders?.rows) || !shop.orders.period) { excluded.push({ region: shop.region, reason: '订单尚未同步' }); continue; }
    const valid = shop.orders.rows.filter(row => !EXCLUDED.includes(row.status));
    const fx = rates[shop.currency], rate = isNum(fx?.cnyPerUnit) && fx.cnyPerUnit > 0 ? fx.cnyPerUnit : null;
    const feesReady = Array.isArray(shop.fees?.rows) && sameWindow(shop.fees, shop.orders);
    const income = new Map(feesReady ? shop.fees.rows.filter(row => row.income).map(row => [row.orderSn, row.income]) : []);
    const ads = allocateAds(shop, valid);
    const ctx = { rule, rate, catalog, roles, income, feesReady, ads, crossPerPair };
    const rows = valid.filter(row => row.fulfillment === 'overseas_warehouse' || row.fulfillment === 'cross_border').map(row => buildOrder(shop, row, ctx));
    orders.push(...rows);
    const overseas = rows.filter(row => row.fulfillment === 'overseas_warehouse'), cross = rows.filter(row => row.fulfillment === 'cross_border');
    const pendingParts = [...new Set(rows.flatMap(row => row.missing).filter(text => text.startsWith('部件鞋双数待核') || text.startsWith('未找到成本') || text.startsWith('平台规格SKU为空')))];
    const unattributed = ads.byOrder ? round(Math.max(0, ads.gap) + ads.noOrder) : null;
    outShops.push({ region: shop.region, shopId: shop.shopId, name: shop.name || `店铺 ${shop.shopId}`, label: LABEL[shop.region] || shop.region, currency: shop.currency,
      period: { start: shop.orders.period.start, end: shop.orders.period.end }, dataAt: shop.orders.updatedAt || null, feesAt: shop.fees?.updatedAt || null, adsAt: shop.ads?.updatedAt || null,
      crossIncomeDate: shop.fees?.updatedAt ? shop.fees.updatedAt.slice(0, 10) : null,
      overseas: overseas.length, crossBorder: cross.length, unknownFulfillment: valid.length - rows.length,
      incomplete: overseas.filter(row => row.profitA === null).length, crossIncomplete: cross.filter(row => row.preFreightA === null).length,
      inferredOrders: rows.filter(row => row.inferred).length, pendingParts: pendingParts.slice(0, 30),
      adTotal: ads.byOrder ? ads.total : null, adAttributed: ads.byOrder ? ads.attributed : null, adGap: ads.byOrder ? ads.gap : null, noOrderAd: ads.byOrder ? ads.noOrder : null,
      adUnattributed: unattributed, adUnattributedCny: unattributed !== null && rate ? round(unattributed * rate) : null, adNote: ads.note,
      fxRate: rate, fxDate: fx?.date || null, fxSource: fx?.url || null, fxLabel: fx?.label || '每日参考汇率', fxStatus: fx?.status || 'missing',
      packingPerOrder: rule.packingPerOrder, transportPerPair: rule.transportPerPair, crossBorderPerPair: crossPerPair });
  }
  const starts = outShops.map(shop => shop.period.start).sort(), ends = outShops.map(shop => shop.period.end).sort(), stamps = outShops.map(shop => shop.dataAt).filter(Boolean).sort();
  return { available: outShops.length > 0, mode: 'live', period: outShops.length ? { start: starts[0], end: ends.at(-1) } : null,
    sourceDate: stamps.length ? stamps.at(-1).slice(0, 10) : null, dataAt: stamps.at(-1) || null, builtAt: new Date(now).toISOString(), shops: outShops, excluded, orders };
}

/** 按“站点 × 订单创建日（当地）”汇总，供按天累计的毛利走势使用。 */
export function summarizeDays(snapshot, sourceShops = []) {
  const days = {};
  for (const meta of snapshot.shops) {
    const source = sourceShops.find(shop => shop.shopId === meta.shopId), zone = source?.orders?.period?.timeZone;
    const dates = (source?.orders?.period?.dates || []).map(date => date.split('-').reverse().join('-'));
    const spend = new Map((source?.ads?.daily || []).map(row => [row.date.split('-').reverse().join('-'), row.expense]));
    const adsUsable = meta.adTotal !== null;
    days[meta.region] = Object.fromEntries(dates.map(date => {
      const rows = snapshot.orders.filter(row => row.region === meta.region && row.date === date);
      const overseas = rows.filter(row => row.fulfillment === 'overseas_warehouse'), cross = rows.filter(row => row.fulfillment === 'cross_border');
      const done = overseas.filter(row => row.profitA !== null), crossDone = cross.filter(row => row.preFreightA !== null);
      const sum = (list, key) => list.reduce((total, row) => total + cents(row[key] ?? 0), 0) / 100;
      const valid = zone ? (source.orders.rows || []).filter(row => !EXCLUDED.includes(row.status) && localDate(row.createTime, zone) === date) : [];
      const adSpend = adsUsable && isNum(spend.get(date)) ? spend.get(date) : null;
      return [date, { validOrders: valid.length, salesSource: valid.every(row => isNum(row.totalAmount)) ? round(valid.reduce((total, row) => total + row.totalAmount, 0)) : null,
        overseas: overseas.length, included: done.length, pending: overseas.length - done.length,
        incomeCny: sum(done, 'incomeCny'), goodsCny: sum(done, 'goodsCny'), fulfilCny: round(sum(done, 'packingCny') + sum(done, 'transportCny')), adsCny: sum(done, 'adsCny'), profitA: sum(done, 'profitA'), profitB: sum(done.filter(row => row.profitB !== null), 'profitB'),
        crossBorder: cross.length, crossIncluded: crossDone.length, crossIncomeCny: sum(crossDone, 'incomeCny'), crossPreFreightA: sum(crossDone, 'preFreightA'),
        adSpendSource: adSpend, adSpendCny: adSpend !== null && meta.fxRate ? round(adSpend * meta.fxRate) : null, currency: meta.currency, fxRate: meta.fxRate }];
    }));
  }
  return days;
}

export function createLiveProfit({ operations, skuCosts, fx, roles = createSkuRoles(), historyFile = fileURLToPath(new URL('../.local/profit-daily.json', import.meta.url)), now = Date.now, keepDays = 400 } = {}) {
  const caches = new Map();
  let history = null, saving = Promise.resolve();
  /** days：统计周期（1 / 3 / 7 / 30 天），订单、扣费、广告都按同一周期切片后逐单计算。 */
  async function compute(days = 7) {
    if (!DAY_OPTIONS.includes(days)) days = 7;
    const [ops, costs, rates, reviewed] = await Promise.all([operations.snapshot(), skuCosts.catalog(), fx.snapshot(), roles.load()]);
    if (!costs.available) return { ops, value: { available: false, mode: 'live', reason: '未找到成本档案', period: null, sourceDate: null, shops: [], excluded: [], orders: [] } };
    const signature = JSON.stringify([ops.shops.map(shop => [shop.shopId, shop.orders?.updatedAt, shop.fees?.updatedAt, shop.ads?.updatedAt, shop.ads?.attemptedAt]), costs.name, reviewed.stamp,
      Object.entries(rates.rates || {}).map(([code, row]) => [code, row.cnyPerUnit ?? null])]);
    const scoped = ops.shops.map(shop => scopeShop(shop, days));
    let cache = caches.get(days);
    if (cache?.signature !== signature) {
      const value = buildLiveProfit({ shops: scoped, catalog: costs.catalog, roles: reviewed.roles, rates: rates.rates || {}, now: now() });
      cache = { signature, value: { ...value, days, costCatalogDate: costs.date, rolesReviewed: reviewed.count, rolesError: reviewed.error } };
      caches.set(days, cache);
    }
    return { ops: { ...ops, shops: scoped }, value: cache.value };
  }
  async function readHistory() {
    if (history) return history;
    try { const saved = JSON.parse(await readFile(historyFile, 'utf8')); if (saved.version !== 1 || typeof saved.days !== 'object' || !saved.days) throw new Error(); history = saved; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('毛利日记录读取失败，原文件未覆盖。'); history = { version: 1, updatedAt: null, days: {} }; }
    return history;
  }
  return {
    async snapshot(days) { return (await compute(days)).value; },
    /** 同步结束后调用：把当前 7 天窗口内每天的结果写入日记录（窗口内的日期会被最新结果覆盖，更早的日期保持定格）。 */
    async record() {
      const { ops, value } = await compute(30);
      if (!value.available) return null;
      const data = await readHistory(), recordedAt = new Date(now()).toISOString();
      for (const [region, byDate] of Object.entries(summarizeDays(value, ops.shops))) {
        const target = data.days[region] ||= {};
        for (const [date, row] of Object.entries(byDate)) target[date] = { ...row, recordedAt };
        for (const date of Object.keys(target).sort().slice(0, -keepDays)) delete target[date];
      }
      data.updatedAt = recordedAt;
      const text = JSON.stringify(data);
      saving = saving.catch(() => {}).then(async () => { await mkdir(dirname(historyFile), { recursive: true }); await writeFile(`${historyFile}.tmp`, text, 'utf8'); await rename(`${historyFile}.tmp`, historyFile); });
      await saving;
      return data.updatedAt;
    },
    async history() { const data = await readHistory(); return { updatedAt: data.updatedAt, days: data.days }; }
  };
}
