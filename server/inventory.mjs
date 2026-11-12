import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from './workbook.mjs';
import { scopeShop } from '../src/window.mjs';
import { businessConfig } from './business-config.mjs';

// 断货预警：海外仓在库表 + 在途表（仓库系统导出）结合近 7 天海外仓订单销量，
// 预测每个单品 SKU 何时卖完、在途能否接上，并按“需要把销量压低多少”给出广告建议。只读，不修改店铺。
const day = 86400000;
export const SITES = ['MY', 'TH', 'VN', 'PH'];
// 头程天数默认取 config/business.json，未设置的站点需在“断货预警”页面填写后才会预测。
export const DEFAULT_SETTINGS = { leadDays: { ...businessConfig.leadDays }, safetyDays: businessConfig.safetyDays };
export const PAUSE_CUT = 0.5, REDUCE_CUT = 0.2, REORDER_BUFFER_DAYS = 7, MAX_IMPORT_ROWS = 60000;
const EXCLUDED = ['CANCELLED', 'IN_CANCEL', 'UNPAID'];
const isNum = value => typeof value === 'number' && Number.isFinite(value);
const round = (value, digits = 2) => isNum(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
const label = value => String(value ?? '').replace(/\s+/g, '').toLowerCase();
const HEADERS = {
  stock: { sku: ['sku', '商品sku', 'sku编码'], qty: ['可用库存', '可用数量', '可用'], warehouse: ['仓库', '仓库代码', '仓库名称'] },
  transit: { order: ['入库单号'], warehouse: ['仓库', '仓库代码', '仓库名称'], created: ['创建时间'], sku: ['sku', '商品sku', 'sku编码'], qty: ['预约数量', '在途数量', '数量'] }
};

/** 仓库系统给 SKU 加的客户代码前缀（如 88888-）：八成以上的行都以同一串数字开头才认定。 */
export function detectPrefix(values) {
  const counts = new Map();
  for (const value of values) { const m = /^(\d{3,})-/.exec(String(value ?? '').trim()); if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1); }
  const [code, count] = [...counts].sort((a, b) => b[1] - a[1])[0] || [];
  return code && count >= values.length * 0.8 ? code : '';
}
/** 去掉客户代码前缀（个别 SKU 被重复加了两次，一并去掉）。 */
export function normalizeSku(raw, prefix = '') {
  let sku = String(raw ?? '').trim();
  while (prefix && sku.startsWith(`${prefix}-`)) sku = sku.slice(prefix.length + 1);
  return sku;
}
export function siteOf(warehouse) {
  const code = /^([A-Za-z]{2})(?:[-_\s]|\d|$)/.exec(String(warehouse ?? '').trim())?.[1]?.toUpperCase();
  return SITES.includes(code) ? code : null;
}
function wholeNumber(value) {
  const text = String(value ?? '').trim().replace(/,/g, '');
  return /^\d+(\.0+)?$/.test(text) ? Number(text) : null;
}
/** "2026-10-14 14:40:34"（按北京时间）或 Excel 日期序号 → ISO 时间。 */
export function parseCreated(value) {
  const text = String(value ?? '').trim();
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (m) { const t = Date.parse(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T${(m[4] || '0').padStart(2, '0')}:${m[5] || '00'}:${m[6] || '00'}+08:00`); return Number.isFinite(t) ? new Date(t).toISOString() : null; }
  if (/^\d{5}(\.\d+)?$/.test(text)) return new Date(Math.round((Number(text) - 25569) * day) - 8 * 3600000).toISOString();
  return null;
}
function columnMap(columns, kind) {
  const found = {};
  for (const [field, names] of Object.entries(HEADERS[kind])) { const hit = columns.find(column => names.includes(label(column.label))); if (hit) found[field] = hit.key; }
  return found;
}
export function detectKind(columns) {
  const has = names => columns.some(column => names.includes(label(column.label)));
  if (has(HEADERS.transit.order)) return 'transit';
  if (has(HEADERS.stock.qty)) return 'stock';
  throw new Error('无法识别表格：在库表需包含“SKU / 可用库存 / 仓库”，在途表需包含“入库单号 / 仓库 / 创建时间 / SKU / 预约数量”。');
}
const skip = (list, line, reason) => { list.count++; if (list.rows.length < 30) list.rows.push({ line, reason }); };

export function parseStock({ columns, rows }) {
  const map = columnMap(columns, 'stock');
  if (!map.sku || !map.qty || !map.warehouse) throw new Error('在库表缺少必要的列：SKU、可用库存、仓库。');
  const prefix = detectPrefix(rows.map(row => row.values[map.sku]));
  const merged = new Map(), skipped = { count: 0, rows: [] };
  let empty = 0;
  for (const row of rows) {
    const sku = normalizeSku(row.values[map.sku], prefix), qty = wholeNumber(row.values[map.qty]), warehouse = String(row.values[map.warehouse] ?? '').trim();
    if (!sku) { skip(skipped, row.line, 'SKU 为空'); continue; }
    if (qty === null) { skip(skipped, row.line, `可用库存不是非负整数：${String(row.values[map.qty] ?? '').slice(0, 20)}`); continue; }
    if (!warehouse) { if (qty === 0) empty++; else skip(skipped, row.line, `有库存 ${qty} 但没有仓库：${sku}`); continue; }
    const site = siteOf(warehouse);
    if (!site) { skip(skipped, row.line, `仓库代码无法对应站点：${warehouse.slice(0, 20)}`); continue; }
    const key = `${warehouse}\u0000${sku}`, current = merged.get(key);
    if (current) current.qty += qty; else merged.set(key, { site, warehouse, sku, qty });
  }
  const list = [...merged.values()];
  if (!list.length) throw new Error('在库表里没有可用的数据行。');
  const bySite = {};
  for (const row of list) { const s = bySite[row.site] ||= { skus: 0, units: 0, warehouses: [] }; s.skus++; s.units += row.qty; if (!s.warehouses.includes(row.warehouse)) s.warehouses.push(row.warehouse); }
  return { prefix, rows: list, skipped, stats: { rows: list.length, skus: new Set(list.map(row => row.sku)).size, units: list.reduce((n, row) => n + row.qty, 0), emptyRows: empty, bySite } };
}

export function parseTransit({ columns, rows }) {
  const map = columnMap(columns, 'transit');
  if (!map.order || !map.warehouse || !map.created || !map.sku || !map.qty) throw new Error('在途表缺少必要的列：入库单号、仓库、创建时间、SKU、预约数量。');
  const prefix = detectPrefix(rows.map(row => row.values[map.sku]));
  const orders = [], skipped = { count: 0, rows: [] };
  let current = null;
  for (const row of rows) {
    const no = String(row.values[map.order] ?? '').trim();
    if (no) {
      // 入库单号、仓库、创建时间只写在每张单的第一行，后面的行沿用。
      const warehouse = String(row.values[map.warehouse] ?? '').trim(), site = siteOf(warehouse), createdAt = parseCreated(row.values[map.created]);
      current = { no, warehouse, site, createdAt, lines: new Map(), invalid: !site ? `仓库代码无法对应站点：${warehouse.slice(0, 20) || '空'}` : !createdAt ? `创建时间无法识别：${String(row.values[map.created] ?? '').slice(0, 30) || '空'}` : '' };
      if (orders.some(order => order.no === no)) current.invalid = `入库单号重复：${no}`;
      orders.push(current);
    }
    if (!current) { skip(skipped, row.line, '缺少入库单号'); continue; }
    if (current.invalid) { skip(skipped, row.line, current.invalid); continue; }
    const sku = normalizeSku(row.values[map.sku], prefix), qty = wholeNumber(row.values[map.qty]);
    if (!sku) { skip(skipped, row.line, 'SKU 为空'); continue; }
    if (qty === null) { skip(skipped, row.line, `预约数量不是非负整数：${String(row.values[map.qty] ?? '').slice(0, 20)}`); continue; }
    if (qty > 0) current.lines.set(sku, (current.lines.get(sku) || 0) + qty);
  }
  const valid = orders.filter(order => !order.invalid && order.lines.size).map(({ invalid, lines, ...order }) => ({ ...order, lines: [...lines].map(([sku, qty]) => ({ sku, qty })), units: [...lines.values()].reduce((n, qty) => n + qty, 0) }));
  if (!valid.length && !rows.length) throw new Error('在途表里没有数据行。');
  return { prefix, orders: valid, skipped, stats: { orders: valid.length, lines: valid.reduce((n, order) => n + order.lines.length, 0), units: valid.reduce((n, order) => n + order.units, 0) } };
}

/** 上架规格 SKU → 单品部件（组合装按档案展开；档案里查不到的当作单品本身）。 */
export function explodeSku(sku, catalog, trail = []) {
  const key = String(sku ?? '').trim(), parts = new Map();
  if (!key) return parts;
  const combo = catalog?.combos?.[key];
  if (catalog?.costs?.[key]?.length || !combo?.length || trail.includes(key)) { parts.set(key, 1); return parts; }
  for (const item of combo) {
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) continue;
    for (const [part, count] of explodeSku(item.sku, catalog, [...trail, key])) parts.set(part, (parts.get(part) || 0) + count * quantity);
  }
  if (!parts.size) parts.set(key, 1);
  return parts;
}

/**
 * 单个 SKU 的推演：按当前日均销量消耗库存，在途按预计到仓日补入。
 * cutPct = 要撑到最吃紧的那批到货（再留安全天数），销量至少要压低的比例；没有在途时按“今天发货”的头程天数算。
 */
export function projectSku({ stock, rate, arrivals, leadDays, safetyDays, now }) {
  const sorted = [...arrivals].sort((a, b) => a.etaMs - b.etaMs);
  const result = { coverDays: rate > 0 ? stock / rate : null, outAt: null, gapDays: 0, marginDays: null, cutPct: 0, bindingEta: null, daysToNext: sorted.length ? Math.max(0, (sorted[0].etaMs - now) / day) : null, state: 'ok', coverAfterAll: null };
  if (!(rate > 0)) return result;
  if (stock <= 0) result.outAt = now;
  let level = stock, t = now, supply = stock, worst = Infinity;
  for (const arrival of sorted) {
    const eta = Math.max(arrival.etaMs, now), span = (eta - t) / day, need = rate * span;
    if (level < need) { const out = t + (level / rate) * day; if (!result.outAt) result.outAt = out; result.gapDays += (eta - out) / day; level = 0; } else level -= need;
    const horizon = (eta - now) / day + safetyDays, ratio = horizon > 0 ? supply / (rate * horizon) : Infinity;
    if (ratio < worst) { worst = ratio; result.bindingEta = eta; }
    level += arrival.qty; supply += arrival.qty; t = eta;
  }
  const finalOut = t + (level / rate) * day;
  result.coverAfterAll = (finalOut - now) / day;
  if (!result.outAt) result.outAt = finalOut;
  if (sorted.length) {
    result.marginDays = stock / rate - result.daysToNext;
    result.cutPct = Math.max(0, 1 - worst);
    result.state = stock <= 0 ? 'out' : result.gapDays > 0 ? 'gap' : worst < 1 ? 'tight' : result.coverAfterAll < leadDays + safetyDays + REORDER_BUFFER_DAYS ? 'reorder' : 'ok';
  } else {
    const cover = stock / rate;
    result.cutPct = Math.max(0, 1 - stock / (rate * (leadDays + safetyDays)));
    result.state = stock <= 0 ? 'out' : cover < leadDays ? 'late' : cover < leadDays + safetyDays ? 'tight' : cover < leadDays + safetyDays + REORDER_BUFFER_DAYS ? 'reorder' : 'ok';
  }
  if (stock <= 0) result.cutPct = 1;
  return result;
}
export const actionFor = cut => cut >= PAUSE_CUT ? 'pause' : cut >= REDUCE_CUT ? 'reduce' : cut > 0 ? 'watch' : 'ok';

export function forecastInventory({ stock, transit, settings = DEFAULT_SETTINGS, shops = [], catalog = null, now = Date.now() } = {}) {
  const base = { available: false, asOf: new Date(now).toISOString(), rows: [], listings: [], transitOrders: [], summary: null, notes: [] };
  if (!stock?.rows?.length) return { ...base, reason: '还没有导入在库表' };
  const importedAt = Date.parse(stock.importedAt), elapsedDays = Math.max(0, (now - importedAt) / day);
  const onHand = new Map();
  for (const row of stock.rows) { const key = `${row.site}\u0000${row.sku}`, cur = onHand.get(key) || { qty: 0, warehouses: [] }; cur.qty += row.qty; cur.warehouses.push({ warehouse: row.warehouse, qty: row.qty }); onHand.set(key, cur); }
  const inbound = new Map(), transitOrders = [];
  for (const order of transit?.orders || []) {
    const lead = settings.leadDays[order.site];
    if (!isNum(lead)) continue;
    const etaMs = Date.parse(order.createdAt) + lead * day, overdueDays = Math.max(0, (now - etaMs) / day);
    transitOrders.push({ no: order.no, warehouse: order.warehouse, site: order.site, createdAt: order.createdAt, eta: new Date(etaMs).toISOString(), leadDays: lead, overdueDays: round(overdueDays, 1), skuCount: order.lines.length, units: order.units });
    for (const line of order.lines) { const key = `${order.site}\u0000${line.sku}`; inbound.set(key, [...(inbound.get(key) || []), { orderNo: order.no, warehouse: order.warehouse, qty: line.qty, etaMs, overdueDays }]); }
  }

  // 销量：只算从海外仓发货的有效订单（跨境单不消耗海外仓库存），组合装拆成单品。
  const usage = new Map(), listings = new Map(), sites = [], notes = [];
  for (const shop of shops) {
    if (!SITES.includes(shop.region) || !Array.isArray(shop.orders?.rows) || !shop.orders.period) continue;
    const days = shop.orders.period.dates?.length || 7;
    sites.push({ site: shop.region, shopId: shop.shopId, name: shop.name, currency: shop.currency, days, period: { start: shop.orders.period.start, end: shop.orders.period.end }, ordersAt: shop.orders.updatedAt || null });
    const adsUsable = Array.isArray(shop.ads?.daily) && shop.ads.period?.end === shop.orders.period.end;
    for (const order of shop.orders.rows) {
      if (EXCLUDED.includes(order.status) || order.fulfillment !== 'overseas_warehouse') continue;
      for (const item of order.items || []) {
        if (!Number.isInteger(item.quantity) || item.quantity <= 0) continue;
        const parts = explodeSku(item.sku, catalog), listKey = `${shop.shopId}:${item.itemId}`;
        const listing = listings.get(listKey) || { shopId: shop.shopId, site: shop.region, currency: shop.currency, itemId: item.itemId, name: item.name || '', units: 0, orders: new Set(), variants: new Map(), adsUsable };
        listing.units += item.quantity; listing.orders.add(order.orderSn);
        const variant = listing.variants.get(item.sku || '') || { sku: item.sku || '', units: 0, parts: [...parts.keys()] };
        variant.units += item.quantity; listing.variants.set(item.sku || '', variant); listings.set(listKey, listing);
        for (const [part, count] of parts) {
          const key = `${shop.region}\u0000${part}`, cur = usage.get(key) || { site: shop.region, sku: part, units: 0, days, listings: new Map() };
          cur.units += count * item.quantity; cur.listings.set(listKey, (cur.listings.get(listKey) || 0) + count * item.quantity); usage.set(key, cur);
        }
      }
    }
    for (const listing of listings.values()) if (listing.shopId === shop.shopId && !listing.ads) {
      const manual = adsUsable ? (shop.ads.campaigns || []).filter(plan => plan.itemIds?.length === 1 && plan.itemIds[0] === listing.itemId && plan.expense > 0).map(plan => ({ campaignId: plan.campaignId, expense: plan.expense })) : [];
      const gms = adsUsable ? (shop.ads.gmsItems || []).find(row => row.itemId === listing.itemId)?.expense || 0 : 0;
      listing.ads = adsUsable ? { manual, gms: round(gms), gmsCampaignId: shop.ads.reconciliation?.gmsCampaignId || null, total: round(manual.reduce((n, plan) => n + plan.expense, 0) + gms) } : null;
    }
  }
  if (!sites.length) return { ...base, reason: '还没有同步到海外仓站点的订单' };

  const rows = [], bySku = new Map(), noLead = new Set();
  for (const use of usage.values()) {
    const key = `${use.site}\u0000${use.sku}`, record = onHand.get(key), arrivals = inbound.get(key) || [];
    const rate = use.units / use.days, lead = settings.leadDays[use.site];
    if (!isNum(lead)) { noLead.add(use.site); continue; }
    const imported = record ? record.qty : null, estimate = record ? Math.max(0, record.qty - rate * elapsedDays) : null;
    const p = record ? projectSku({ stock: estimate, rate, arrivals, leadDays: lead, safetyDays: settings.safetyDays, now }) : null;
    const horizon = p ? (p.bindingEta ? (p.bindingEta - now) / day : lead) + settings.safetyDays : null;
    const row = { site: use.site, sku: use.sku, hasRecord: Boolean(record), onHand: imported, estimate: round(estimate, 1), warehouses: record?.warehouses || [], units: use.units, rate: round(rate, 2),
      coverDays: p ? round(p.coverDays, 1) : null, transitQty: arrivals.reduce((n, a) => n + a.qty, 0),
      transit: arrivals.map(a => ({ orderNo: a.orderNo, warehouse: a.warehouse, qty: a.qty, eta: new Date(a.etaMs).toISOString(), overdueDays: round(a.overdueDays, 1) })).sort((a, b) => a.eta.localeCompare(b.eta)),
      nextEta: arrivals.length ? new Date(Math.min(...arrivals.map(a => a.etaMs))).toISOString() : null, daysToNext: p ? round(p.daysToNext, 1) : null,
      outAt: p?.outAt ? new Date(p.outAt).toISOString() : null, gapDays: p ? round(p.gapDays, 1) : null, marginDays: p ? round(p.marginDays, 1) : null,
      state: p ? p.state : 'norecord', cutPct: p ? round(p.cutPct, 3) : null, action: p ? actionFor(p.cutPct) : 'check',
      targetRate: p && p.cutPct > 0 && horizon > 0 ? round(estimate / horizon, 2) : null,
      listings: [...use.listings].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([listKey, units]) => ({ shopId: listings.get(listKey).shopId, itemId: listings.get(listKey).itemId, name: listings.get(listKey).name, units })) };
    rows.push(row); bySku.set(key, row);
  }
  const rank = { out: 0, gap: 1, late: 2, tight: 3, norecord: 4, reorder: 5, ok: 6 }, order = { pause: 0, reduce: 1, watch: 2, ok: 3 };
  rows.sort((a, b) => rank[a.state] - rank[b.state] || (b.cutPct ?? 0) - (a.cutPct ?? 0) || b.units - a.units);

  // 广告以链接为单位开关，所以把各规格“需要压低的销量”按销量加权汇总到链接。
  const listingRows = [...listings.values()].map(listing => {
    let weighted = 0, riskUnits = 0, outUnits = 0, unknownUnits = 0, earliest = null;
    const variants = [...listing.variants.values()].map(variant => {
      const parts = variant.parts.map(part => bySku.get(`${listing.site}\u0000${part}`)).filter(Boolean);
      const worst = parts.filter(part => part.hasRecord).sort((a, b) => b.cutPct - a.cutPct || rank[a.state] - rank[b.state])[0] || null;
      const unknown = parts.some(part => !part.hasRecord), cut = worst?.cutPct || 0;
      weighted += variant.units * cut;
      if (cut > 0) riskUnits += variant.units;
      if (worst?.state === 'out') outUnits += variant.units;
      if (unknown) unknownUnits += variant.units;
      if (['out', 'gap', 'late'].includes(worst?.state) && worst.outAt && (!earliest || worst.outAt < earliest)) earliest = worst.outAt;
      return { sku: variant.sku, units: variant.units, state: unknown && !cut ? 'norecord' : worst?.state || 'ok', cutPct: cut, outAt: worst?.outAt || null, coverDays: worst?.coverDays ?? null, nextEta: worst?.nextEta || null, limiting: worst?.sku || null };
    }).sort((a, b) => b.cutPct - a.cutPct || b.units - a.units);
    const cutPct = listing.units ? weighted / listing.units : 0;
    return { shopId: listing.shopId, site: listing.site, currency: listing.currency, itemId: listing.itemId, name: listing.name, units: listing.units, orders: listing.orders.size, variantCount: variants.length,
      cutPct: round(cutPct, 3), riskUnits, outUnits, unknownUnits, riskShare: round(listing.units ? riskUnits / listing.units : 0, 3), earliestOutAt: earliest, action: actionFor(cutPct), ads: listing.ads,
      variants: variants.filter(variant => variant.cutPct > 0 || variant.state === 'norecord').slice(0, 40) };
  }).filter(listing => listing.cutPct >= 0.005 || listing.unknownUnits > 0).sort((a, b) => order[a.action] - order[b.action] || (b.ads?.total > 0) - (a.ads?.total > 0) || b.cutPct - a.cutPct || b.units - a.units);

  const count = state => rows.filter(row => row.state === state).length;
  const soldKeys = new Set(usage.keys());
  if (elapsedDays >= 3) notes.push(`在库表已 ${Math.floor(elapsedDays)} 天没有更新，当前库存是按销量推算的，建议重新导入。`);
  if (noLead.size) notes.push(`${[...noLead].join('、')} 还没有设置头程天数，这些站点暂不预测；请在上方“头程天数”里填写。`);
  if (!catalog) notes.push('未找到成本档案，组合装无法拆成单品，结果可能偏乐观。');
  return { available: true, asOf: new Date(now).toISOString(), stockAt: stock.importedAt, stockAgeDays: round(elapsedDays, 1), sites, rows, listings: listingRows, transitOrders: transitOrders.sort((a, b) => a.eta.localeCompare(b.eta)), notes,
    summary: { skus: rows.length, out: count('out'), gap: count('gap'), late: count('late'), tight: count('tight'), reorder: count('reorder'), norecord: count('norecord'), ok: count('ok'),
      pauseListings: listingRows.filter(l => l.action === 'pause').length, reduceListings: listingRows.filter(l => l.action === 'reduce').length, watchListings: listingRows.filter(l => l.action === 'watch').length,
      pauseWithAds: listingRows.filter(l => l.action === 'pause' && l.ads?.total > 0).length, overdueOrders: transitOrders.filter(order => order.overdueDays >= 1).length,
      idleSkus: [...onHand].filter(([key, value]) => value.qty > 0 && !soldKeys.has(key)).length } };
}

function decodeName(name) {
  const raw = String(name || '').slice(0, 300);
  // multer 把文件名按 latin1 解码，中文会变成乱码；能无损还原成 UTF-8 时还原。
  try { const fixed = Buffer.from(raw, 'latin1').toString('utf8'); if (!fixed.includes('�') && Buffer.from(fixed, 'utf8').toString('latin1') === raw) return fixed.slice(0, 120); } catch { /* 保留原名 */ }
  return raw.slice(0, 120);
}

export function createInventory({ file = fileURLToPath(new URL('../.local/inventory.json', import.meta.url)), operations, skuCosts, now = Date.now } = {}) {
  let data, saving = Promise.resolve();
  async function read() {
    if (data) return data;
    try { const saved = JSON.parse(await readFile(file, 'utf8')); if (saved.version !== 1 || typeof saved.settings !== 'object') throw new Error(); data = { ...saved, settings: { leadDays: { ...DEFAULT_SETTINGS.leadDays, ...saved.settings.leadDays }, safetyDays: saved.settings.safetyDays ?? DEFAULT_SETTINGS.safetyDays } }; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('库存预警数据读取失败，原文件未覆盖。'); data = { version: 1, settings: structuredClone(DEFAULT_SETTINGS), stock: null, transit: null }; }
    return data;
  }
  async function save() {
    const text = JSON.stringify(data);
    saving = saving.catch(() => {}).then(async () => { await mkdir(dirname(file), { recursive: true }); await writeFile(`${file}.tmp`, text, 'utf8'); await rename(`${file}.tmp`, file); });
    await saving;
  }
  const meta = block => block ? { importedAt: block.importedAt, fileName: block.fileName, prefix: block.prefix, stats: block.stats, skipped: block.skipped } : null;
  return {
    async snapshot() {
      const state = await read();
      const [ops, costs] = await Promise.all([operations.snapshot(), skuCosts.catalog().catch(() => ({ available: false }))]);
      // 销量速度固定取近 7 天（与页面所选统计周期无关），太短波动大，太长反应慢。
      const forecast = forecastInventory({ stock: state.stock, transit: state.transit, settings: state.settings, shops: ops.shops.map(shop => scopeShop(shop, 7)), catalog: costs.available ? costs.catalog : null, now: now() });
      return { settings: state.settings, sites: SITES, stock: meta(state.stock), transit: meta(state.transit), catalogDate: costs.available ? costs.date : null, thresholds: { pause: PAUSE_CUT, reduce: REDUCE_CUT, reorderBufferDays: REORDER_BUFFER_DAYS }, forecast };
    },
    /** 导入仓库系统导出的在库表或在途表（按表头自动识别）；整表覆盖上一次同类导入。 */
    async importFile(buffer, originalName) {
      const fileName = decodeName(originalName);
      const table = await readSource(buffer, /\.csv$/i.test(fileName) ? 'a.csv' : /\.xlsx$/i.test(fileName) ? 'a.xlsx' : fileName, '', 1, { maxRows: MAX_IMPORT_ROWS });
      const kind = detectKind(table.columns), parsed = kind === 'stock' ? parseStock(table) : parseTransit(table);
      const state = await read();
      state[kind] = { importedAt: new Date(now()).toISOString(), fileName, ...parsed };
      await save();
      return { kind, fileName, stats: parsed.stats, skipped: parsed.skipped, prefix: parsed.prefix };
    },
    async configure(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置无效');
      const state = await read(), next = structuredClone(state.settings);
      if ('leadDays' in patch) {
        if (!patch.leadDays || typeof patch.leadDays !== 'object') throw new Error('头程天数无效');
        for (const [site, value] of Object.entries(patch.leadDays)) { if (!SITES.includes(site) || !Number.isInteger(value) || value < 1 || value > 120) throw new Error('头程天数需为 1–120 的整数'); next.leadDays[site] = value; }
      }
      if ('safetyDays' in patch) { if (!Number.isInteger(patch.safetyDays) || patch.safetyDays < 0 || patch.safetyDays > 30) throw new Error('安全天数需为 0–30 的整数'); next.safetyDays = patch.safetyDays; }
      state.settings = next;
      await save();
      return this.snapshot();
    }
  };
}
