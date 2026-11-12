import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdsClient } from './shopee-ads.mjs';
import { completeDates } from './ads-monitor.mjs';
import { classifyEstimatedFulfillment } from './order-profit.mjs';
import { collectAdvertising } from './operations-ads.mjs';

const markets = { MY: ['MYR', 'Asia/Kuala_Lumpur', '+08:00'], VN: ['VND', 'Asia/Ho_Chi_Minh', '+07:00'], TH: ['THB', 'Asia/Bangkok', '+07:00'], PH: ['PHP', 'Asia/Manila', '+08:00'], BR: ['BRL', 'America/Sao_Paulo', '-03:00'] };
export const excludedStatuses = ['CANCELLED', 'IN_CANCEL', 'UNPAID'];
export const numberOrNull = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const positiveOrNull = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
const textOrNull = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
/** 同步保存近 30 个完整自然日（店铺当地时间），页面再按昨日 / 近 3 / 7 / 30 天切片。 */
export const PERIOD_DAYS = 30;
export function periodFor(region, now, days = PERIOD_DAYS) {
  const market = markets[region];
  if (!market) throw new Error('站点时区尚未配置');
  const dates = completeDates(now, market[1], days);
  const iso = date => date.split('-').reverse().join('-');
  return { start: iso(dates[0]), end: iso(dates.at(-1)), timeZone: market[1], dates,
    from: Date.parse(`${iso(dates[0])}T00:00:00${market[2]}`) / 1000,
    to: Date.parse(`${iso(dates.at(-1))}T00:00:00${market[2]}`) / 1000 + 86399 };
}
export async function mapLimited(rows, limit, fn) {
  const result = new Array(rows.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, async () => {
    for (;;) { const i = next++; if (i >= rows.length) return; result[i] = await fn(rows[i], i); }
  }));
  return result;
}
export function normalizeIncome(response) {
  const income = response?.order_income;
  if (!income || numberOrNull(income.escrow_amount) === null) throw new Error('收入明细缺少预计净收入');
  // Only monetary fields; buyer information and credentials never enter the snapshot.
  const fields = Object.fromEntries(Object.entries(income).filter(([key, value]) =>
    /fee|tax|commission|escrow_amount|order_selling_price|order_discounted_price|order_original_price|seller_return_refund/.test(key) && numberOrNull(value) !== null));
  return { net: income.escrow_amount, commission: numberOrNull(income.commission_fee), service: numberOrNull(income.service_fee), transaction: numberOrNull(income.seller_transaction_fee), fields };
}
export function orderSummary(rows) {
  const valid = rows.filter(row => !excludedStatuses.includes(row.status));
  return { count: rows.length, validCount: valid.length, skuLines: rows.reduce((n, r) => n + r.items.length, 0),
    totalAmount: rows.every(r => r.totalAmount !== null) ? round(rows.reduce((n, r) => n + r.totalAmount, 0)) : null,
    validAmount: valid.every(r => r.totalAmount !== null) ? round(valid.reduce((n, r) => n + r.totalAmount, 0)) : null,
    missingSku: rows.reduce((n, r) => n + r.items.filter(i => !i.sku).length, 0) };
}
/** 订单列表单次最长 15 天（官方说明），按 14 天切段。 */
export function timeChunks(from, to, span = 14 * 86400) {
  const out = [];
  for (let start = from; start <= to; start += span) out.push({ from: start, to: Math.min(to, start + span - 1) });
  return out;
}
async function collectOrders(client, shop, period) {
  const ids = [];
  for (const range of timeChunks(period.from, period.to)) {
    const seen = new Set(); let cursor = '';
    for (;;) {
      const page = (await client.get('orderList', shop.shopId, { time_range_field: 'create_time', time_from: range.from, time_to: range.to,
        page_size: 100, response_optional_fields: 'order_status', ...(cursor ? { cursor } : {}) })).response;
      if (!Array.isArray(page?.order_list) || typeof page.more !== 'boolean') throw new Error('订单列表或分页标志异常');
      ids.push(...page.order_list.map(r => r.order_sn));
      if (!page.more) break;
      if (!page.next_cursor || seen.has(page.next_cursor) || ids.length >= 50000) throw new Error('订单分页未完成');
      cursor = page.next_cursor; seen.add(cursor);
    }
  }
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error('订单号缺失或重复');
  let warehouses = [], fulfillmentWarning = '';
  try { warehouses = (await client.get('warehouse', shop.shopId, { warehouse_type: 1 })).response;
    if (!Array.isArray(warehouses)) throw new Error('仓库信息格式异常');
  } catch (e) { warehouses = []; fulfillmentWarning = e.message; }
  const rows = [];
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50);
    const data = (await client.get('orderDetail', shop.shopId, { order_sn_list: batch.join(','),
      response_optional_fields: 'item_list,total_amount,fulfillment_flag,pay_time,cancel_by,cancel_reason,buyer_cancel_reason' })).response?.order_list;
    if (!Array.isArray(data) || data.length !== batch.length || new Set(data.map(r => r.order_sn)).size !== batch.length || data.some(r => !batch.includes(r.order_sn))) throw new Error('订单详情覆盖不完整');
    for (const row of data) {
      if (!Array.isArray(row.item_list) || row.currency !== shop.currency) throw new Error('订单商品或币种异常');
      rows.push({ orderSn: row.order_sn, status: row.order_status, currency: row.currency, totalAmount: numberOrNull(row.total_amount),
        createTime: row.create_time, updateTime: row.update_time, fulfillment: classifyEstimatedFulfillment(row, warehouses, shop.region).type,
        payTime: positiveOrNull(row.pay_time), shipByDate: positiveOrNull(row.ship_by_date), daysToShip: numberOrNull(row.days_to_ship),
        cancelBy: textOrNull(row.cancel_by), cancelReason: textOrNull(row.cancel_reason), buyerCancelReason: textOrNull(row.buyer_cancel_reason),
        items: row.item_list.map(i => ({ itemId: i.item_id, modelId: i.model_id, name: i.item_name, sku: i.model_sku || i.item_sku || '', quantity: numberOrNull(i.model_quantity_purchased),
          price: positiveOrNull(i.model_discounted_price), originalPrice: positiveOrNull(i.model_original_price) })) });
    }
  }
  return { rows: rows.sort((a, b) => b.createTime - a.createTime), summary: orderSummary(rows), fulfillmentWarning };
}
/** 已完成订单的结算金额不再变化：上次已取到且状态仍是已完成的直接沿用，其余逐单读取。 */
async function collectFees(client, shop, orders, progress, previous = []) {
  const valid = orders.filter(row => !excludedStatuses.includes(row.status)); let done = 0, reused = 0;
  const old = new Map(previous.filter(r => r.income && r.status === 'COMPLETED').map(r => [r.orderSn, r]));
  const rows = await mapLimited(valid, 3, async row => {
    const keep = row.status === 'COMPLETED' ? old.get(row.orderSn) : null;
    if (keep) { reused++; progress(`${shop.region} 平台扣费 ${++done}/${valid.length}`); return { orderSn: row.orderSn, status: row.status, fulfillment: row.fulfillment, currency: row.currency, income: keep.income, error: '', reused: true }; }
    let income = null, error = '';
    try { const response = (await client.get('escrow', shop.shopId, { order_sn: row.orderSn })).response;
      if (response?.order_sn !== row.orderSn) throw new Error('收入明细订单号不匹配');
      income = normalizeIncome(response);
    } catch (e) { error = e.message; }
    progress(`${shop.region} 平台扣费 ${++done}/${valid.length}`);
    return { orderSn: row.orderSn, status: row.status, fulfillment: row.fulfillment, currency: row.currency, income, error };
  });
  return { rows, expected: valid.length, received: rows.filter(r => r.income).length, reused };
}
const intOrNull = value => Number.isInteger(value) ? value : null;
const boolOrNull = value => typeof value === 'boolean' ? value : null;
/** 0 = 退货退款，1 = 仅退款（return_solution，平台最新方案）；缺失时按是否需要退回商品（needs_logistics）判断并标注依据。 */
export function returnSolution(row) {
  if (row.return_solution === 0 || row.return_solution === 1) return { solution: row.return_solution === 1 ? 'refund_only' : 'return_refund', solutionBasis: 'return_solution' };
  if (typeof row.needs_logistics === 'boolean') return { solution: row.needs_logistics ? 'return_refund' : 'refund_only', solutionBasis: 'needs_logistics' };
  return { solution: null, solutionBasis: null };
}
export function normalizeReturn(row) {
  if (!row.return_sn || !row.order_sn || !row.status) throw new Error('退货记录缺少编号或状态');
  const negotiation = row.negotiation || {};
  return { returnSn: row.return_sn, orderSn: row.order_sn, status: row.status, ...returnSolution(row),
    reason: row.reassessed_request_reason && row.reassessed_request_reason !== 'NONE' ? row.reassessed_request_reason : row.reason,
    originalReason: row.reason || null, textReason: textOrNull(row.text_reason),
    currency: row.currency, refundAmount: numberOrNull(row.refund_amount), amountBeforeDiscount: numberOrNull(row.amount_before_discount),
    createTime: row.create_time, updateTime: row.update_time,
    dueDate: row.due_date || null, sellerDueDate: row.return_seller_due_date || null, buyerShipDueDate: row.return_ship_due_date || null,
    needsLogistics: row.needs_logistics, logisticsStatus: row.reverse_logistics_status || row.logistics_status || null,
    trackingNumber: textOrNull(row.tracking_number), reverseChannel: textOrNull(row.reverse_logistics_channel_name),
    requestType: intOrNull(row.return_refund_request_type), refundType: textOrNull(row.return_refund_type),
    validationType: textOrNull(row.validation_type), warehouseStatus: intOrNull(row.is_arrived_at_warehouse),
    negotiationStatus: negotiation.negotiation_status || row.negotiation_status || null, latestSolution: textOrNull(negotiation.latest_solution),
    latestOfferAmount: numberOrNull(negotiation.latest_offer_amount), offerDueDate: negotiation.offer_due_date || null,
    proofStatus: row.seller_proof?.seller_proof_status || row.seller_proof_status || null,
    proofDueDate: row.seller_proof?.seller_evidence_deadline || null,
    compensationStatus: row.seller_compensation?.seller_compensation_status || row.seller_compensation_status || null,
    compensationDueDate: row.seller_compensation?.seller_compensation_due_date || null, compensationAmount: numberOrNull(row.seller_compensation?.compensation_amount),
    disputeReason: Array.isArray(row.dispute_reason) ? row.dispute_reason.filter(x => typeof x === 'string').slice(0, 5) : [],
    partial: boolOrNull(row.is_partial_quantity_return), refundAdjusted: boolOrNull(row.is_refund_amount_adjusted),
    imageCount: Array.isArray(row.image) ? row.image.length : 0, videoCount: Array.isArray(row.buyer_videos) ? row.buyer_videos.length : 0,
    items: (row.item || []).map(i => ({ itemId: i.item_id, modelId: i.model_id ?? null, name: i.name, sku: i.variation_sku || i.item_sku || '', quantity: numberOrNull(i.amount), price: numberOrNull(i.item_price) })) };
}
/** 退货列表单次查询最长 15 天（官方说明），这里取近 RETURN_DAYS 天按 14 天切段。 */
export const RETURN_DAYS = 30;
export function returnWindows(nowMs, days = RETURN_DAYS, span = 14) {
  const to = Math.floor(nowMs / 1000), from = to - days * 86400 + 1, out = [];
  for (let end = to; end >= from; end -= span * 86400) out.push({ from: Math.max(from, end - span * 86400 + 1), to: end });
  return out;
}
async function collectReturns(client, shop, period, nowMs) {
  const raw = new Map(), windows = returnWindows(nowMs);
  for (const window of windows) {
    // page_no 官方说明默认从 0 开始；同一页重复返回时按编号去重，连续无新记录则判定分页异常。
    for (let pageNo = 0, idle = 0; ; pageNo++) {
      const page = (await client.get('returnList', shop.shopId, { page_no: pageNo, page_size: 100, update_time_from: window.from, update_time_to: window.to })).response;
      if (!Array.isArray(page?.return) || typeof page.more !== 'boolean') throw new Error('退货列表或分页标志异常');
      let added = 0;
      for (const row of page.return) {
        if (!row.return_sn) throw new Error('退货记录缺少编号');
        if (row.currency && row.currency !== shop.currency) throw new Error('退货币种与店铺不符');
        if (!raw.has(row.return_sn)) { raw.set(row.return_sn, row); added++; }
      }
      if (!page.more) break;
      idle = added ? 0 : idle + 1;
      if (!page.return.length || idle >= 2 || pageNo >= 500) throw new Error('退货分页未完成');
    }
  }
  const rows = await mapLimited([...raw.values()], 3, async row => {
    try { const detail = (await client.get('returnDetail', shop.shopId, { return_sn: row.return_sn })).response;
      if (detail?.return_sn !== row.return_sn || detail.order_sn !== row.order_sn) throw new Error('退货详情编号不匹配');
      return { ...normalizeReturn(detail), detailError: '' };
    } catch (e) { return { ...normalizeReturn(row), detailError: e.message }; }
  });
  rows.sort((a, b) => (b.updateTime || 0) - (a.updateTime || 0));
  return { rows, detailsReceived: rows.filter(r => !r.detailError).length, window: { from: windows.at(-1).from, to: windows[0].to, days: RETURN_DAYS },
    scope: `近 ${RETURN_DAYS} 天内有更新的退货 / 退款申请` };
}

/** 库存：从 stock_info_v2 读取可售库存；字段缺失时为 null，不按 0 处理。 */
export function stockOf(info) {
  const summary = info?.summary_info;
  if (summary && typeof summary.total_available_stock === 'number' && Number.isFinite(summary.total_available_stock)) return { available: summary.total_available_stock, reserved: numberOrNull(summary.total_reserved_stock) };
  const lists = [info?.seller_stock, info?.shopee_stock].filter(Array.isArray);
  if (lists.length && lists.flat().every(r => typeof r?.stock === 'number' && Number.isFinite(r.stock))) return { available: lists.flat().reduce((n, r) => n + r.stock, 0), reserved: null };
  return { available: null, reserved: null };
}
function modelName(tiers, index) {
  if (!Array.isArray(tiers) || !Array.isArray(index)) return '';
  return index.map((ix, t) => tiers[t]?.option_list?.[ix]?.option).filter(Boolean).join(' / ');
}
export async function collectStock(client, shop, progress = () => {}) {
  const ids = [], notices = new Set(); let offset = 0;
  // 平台随商品数据返回的提示原样记下（截断），既不当作失败，也不悄悄丢掉。
  const read = async (kind, params) => { const payload = await client.get(kind, shop.shopId, params); const text = typeof payload?.warning === 'string' ? payload.warning : payload?.warning ? JSON.stringify(payload.warning) : ''; if (text.trim() && notices.size < 3) notices.add(text.trim().slice(0, 160)); return payload; };
  for (let guard = 0; ; guard++) {
    const page = (await read('itemList', { offset, page_size: 100, item_status: 'NORMAL' })).response;
    if (!page || typeof page.has_next_page !== 'boolean' || (page.item !== undefined && !Array.isArray(page.item))) throw new Error('商品列表或分页标志异常');
    ids.push(...(page.item || []).map(r => r.item_id));
    if (!page.has_next_page) break;
    if (!Number.isSafeInteger(page.next_offset) || page.next_offset <= offset || guard >= 300) throw new Error('商品分页未完成');
    offset = page.next_offset;
  }
  if (ids.some(id => !Number.isSafeInteger(id)) || new Set(ids).size !== ids.length) throw new Error('商品编号缺失或重复');
  const base = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const list = (await read('itemBase', { item_id_list: batch.join(',') })).response?.item_list;
    if (!Array.isArray(list)) throw new Error('商品基础信息格式异常');
    base.push(...list.filter(item => batch.includes(item.item_id)));
    progress(`${shop.region} 商品 ${Math.min(i + 50, ids.length)}/${ids.length}`);
  }
  let done = 0, modelErrors = 0;
  const groups = await mapLimited(base, 3, async item => {
    const head = { itemId: item.item_id, itemName: textOrNull(item.item_name) || `商品 ${item.item_id}`, itemSku: textOrNull(item.item_sku) || '' };
    try {
      if (!item.has_model) { const stock = stockOf(item.stock_info_v2); return [{ ...head, modelId: 0, modelSku: head.itemSku, modelName: '', ...stock, price: numberOrNull(item.price_info?.[0]?.current_price) }]; }
      const data = (await read('modelList', { item_id: item.item_id })).response;
      if (!Array.isArray(data?.model)) throw new Error('规格列表格式异常');
      return data.model.map(m => ({ ...head, modelId: m.model_id, modelSku: textOrNull(m.model_sku) || '', modelName: modelName(data.tier_variation, m.tier_index), ...stockOf(m.stock_info_v2), price: numberOrNull(m.price_info?.[0]?.current_price) }));
    } catch (e) { modelErrors++; return [{ ...head, modelId: null, modelSku: '', modelName: '', available: null, reserved: null, price: null, error: e.message }]; }
    finally { progress(`${shop.region} 库存 ${++done}/${base.length}`); }
  });
  const rows = groups.flat();
  const warnings = [];
  if (base.length < ids.length) warnings.push(`${ids.length - base.length} 个商品未返回基础信息`);
  if (modelErrors) warnings.push(`${modelErrors} 个商品的规格库存读取失败，已标为待补`);
  for (const text of notices) warnings.push(`平台提示：${text}`);
  return { rows, items: ids.length, models: rows.length, unknownStock: rows.filter(r => r.available === null).length, warnings };
}

export function createOperations({ file = fileURLToPath(new URL('../.local/operations.json', import.meta.url)), client = createAdsClient(), now = Date.now } = {}) {
  let data, flight, saving = Promise.resolve();
  const job = { running: false, progress: '', error: '', startedAt: null, finishedAt: null };
  async function read() {
    if (!data) try { data = JSON.parse(await readFile(file, 'utf8')); if (data.version !== 1 || !Array.isArray(data.shops)) throw new Error('invalid'); }
    catch (e) { if (e.code !== 'ENOENT') throw new Error('经营快照损坏，保留原文件'); data = { version: 1, shops: [] }; }
    return data;
  }
  async function save() {
    data.rev = (data.rev || 0) + 1;
    const text = JSON.stringify(data);
    saving = saving.then(async () => { await mkdir(dirname(file), { recursive: true }); await writeFile(`${file}.tmp`, text, { mode: 0o600 }); await rename(`${file}.tmp`, file); });
    await saving;
  }
  async function stage(shop, kind, period, collect) {
    job.progress = `${shop.region} ${kind}`;
    const attemptedAt = new Date(now()).toISOString();
    try { const result = await collect(); shop[kind] = { ...result, period, updatedAt: new Date(now()).toISOString(), attemptedAt, error: '' }; }
    catch (e) { shop[kind] = { ...(shop[kind] || {}), attemptedAt, error: e.message }; }
    await save();
  }
  async function run(kinds, selected) {
    const state = await read(); const ids = await client.shops();
    if (selected?.some(id => !ids.includes(id))) throw new Error('所选店铺不在授权范围');
    for (const id of selected || ids) {
      let shop = state.shops.find(s => s.shopId === id);
      if (!shop) { shop = { shopId: id }; state.shops.push(shop); }
      try { const info = await client.get('shop', id); if (!markets[info.region]) throw new Error('站点尚未配置');
        Object.assign(shop, { name: info.shop_name, region: info.region, currency: markets[info.region][0], connectionError: '', verifiedAt: new Date(now()).toISOString() });
      } catch (e) { shop.connectionError = e.message; await save(); continue; }
      const period = periodFor(shop.region, now());
      if (kinds.includes('orders') || kinds.includes('fees')) await stage(shop, 'orders', period, () => collectOrders(client, shop, period));
      if (kinds.includes('fees')) {
        if (shop.orders?.error) { shop.fees = { ...shop.fees, error: '本次订单同步失败，未更新扣费', attemptedAt: new Date(now()).toISOString() }; await save(); }
        else { const previous = shop.fees?.rows || []; await stage(shop, 'fees', period, () => collectFees(client, shop, shop.orders.rows, message => { job.progress = message; }, previous)); }
      }
      if (kinds.includes('ads')) { const previous = shop.ads; await stage(shop, 'ads', period, () => collectAdvertising(client, shop, period, previous)); }
      if (kinds.includes('returns')) await stage(shop, 'returns', period, () => collectReturns(client, shop, period, now()));
      if (kinds.includes('stock')) await stage(shop, 'stock', period, () => collectStock(client, shop, message => { job.progress = message; }));
    }
    for (const shop of state.shops) if (!ids.includes(shop.shopId)) shop.connectionError = '已不在当前授权范围';
    await save();
  }
  return {
    /** rev：每次保存加 1。页面带上次的 rev 来问，没变化就只回任务状态，避免反复传整份快照。 */
    async snapshot(sinceRev, { jobOnly = false } = {}) {
      const state = await read();
      if (jobOnly || (sinceRev !== undefined && sinceRev === (state.rev || 0))) return { rev: state.rev || 0, unchanged: true, job: { ...job }, generatedAt: new Date(now()).toISOString() };
      return { ...state, rev: state.rev || 0, job: { ...job }, generatedAt: new Date(now()).toISOString() };
    },
    // 库存（Shopee 后台可售库存）不在默认同步里：断货预警改用海外仓表格；需要时仍可单独请求 'stock'。
    async sync(kinds = ['orders', 'fees', 'ads', 'returns'], selected) {
      if (!Array.isArray(kinds) || !kinds.length || kinds.some(k => !['orders', 'fees', 'ads', 'returns', 'stock'].includes(k))) throw new Error('不支持的同步项目');
      if (selected !== undefined && (!Array.isArray(selected) || !selected.length || selected.some(id => !Number.isSafeInteger(id)))) throw new Error('店铺范围无效');
      await read();
      if (flight) return { ...job };
      Object.assign(job, { running: true, error: '', progress: '准备同步', startedAt: new Date(now()).toISOString(), finishedAt: null });
      flight = run(kinds, selected).catch(e => { job.error = e.message; }).finally(() => { job.running = false; job.finishedAt = new Date(now()).toISOString(); flight = null; });
      return { ...job };
    },
    async wait() { await flight; }
  };
}
