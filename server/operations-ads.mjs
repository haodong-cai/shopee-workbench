// 广告数据：店铺日表现、各广告组（计划）日表现与设置、全店托管 GMV Max 按周期（1/3/7/30 天）的计划与商品表现、
// 以及广告关联商品的名称和规格 SKU（用于映射 SPU）。全部只读。
import { businessConfig } from './business-config.mjs';
// 可选：列表接口查不到但需补查的广告组 ID，在 config/business.json 的 knownAdCampaignIds 里填写。
const knownIds = businessConfig.knownAdCampaignIds;
export const AD_WINDOWS = [1, 3, 7, 30];
const round = value => Math.round(value * 100) / 100;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;
const campaignRows = response => (Array.isArray(response) ? response : [response]).flatMap(group => group?.campaign_list || []);
const METRICS = ['expense', 'impression', 'clicks', 'direct_order', 'broad_order', 'direct_conversions', 'broad_conversions', 'direct_gmv', 'broad_gmv'];
const CAMPAIGN_METRICS = ['expense', 'impression', 'clicks', 'broad_order', 'broad_gmv', 'direct_order', 'direct_gmv'];
const pick = (row, keys) => Object.fromEntries(keys.map(k => [k, number(row?.[k])]));
const ITEM_TTL = 7 * 86400000, MODEL_FETCH_LIMIT = 150;

/** 日期切段：接口单次的日期范围不宜过长，按 15 天一段查询。 */
export function dateChunks(dates, size = 15) {
  const out = [];
  for (let i = 0; i < dates.length; i += size) { const part = dates.slice(i, i + size); out.push({ start_date: part[0], end_date: part.at(-1) }); }
  return out;
}
function requireDays(rows, dates, what) {
  const selected = rows.filter(r => dates.includes(r.date));
  if (selected.length !== dates.length || new Set(selected.map(r => r.date)).size !== dates.length || selected.some(r => number(r.expense) === null || r.expense < 0)) throw new Error(`${what}不完整（有效日期 ${new Set(selected.map(r => r.date)).size}/${dates.length}）`);
  return dates.map(date => selected.find(r => r.date === date));
}

async function gmsWindow(client, shop, dates) {
  const range = { start_date: dates[0], end_date: dates.at(-1) };
  const items = []; let campaignId, expected;
  for (let offset = 0; ; offset += 100) {
    const page = (await client.get('gmsItems', shop.shopId, { ...range, offset, limit: 100 })).response;
    if (!Array.isArray(page?.result_list) || typeof page.has_next_page !== 'boolean') throw new Error('GMV Max 商品分页格式异常');
    items.push(...page.result_list.map(row => ({ itemId: row.item_id, ...pick(row.report, CAMPAIGN_METRICS) })));
    campaignId = page.campaign_id || campaignId; expected = page.total;
    if (!page.has_next_page) break;
    if (!page.result_list.length || offset >= 19900) throw new Error('GMV Max 商品分页未完成');
  }
  if (items.length !== expected || new Set(items.map(i => i.itemId)).size !== items.length || items.some(i => i.expense === null)) throw new Error('GMV Max 商品覆盖不完整');
  if (!campaignId) return { campaignId: null, start: range.start_date, end: range.end_date, report: null, items };
  const gms = (await client.get('gmsCampaign', shop.shopId, { ...range, campaign_id: campaignId })).response;
  if (number(gms?.report?.expense) === null) throw new Error('GMV Max 计划消耗缺失');
  return { campaignId, start: range.start_date, end: range.end_date, report: pick(gms.report, CAMPAIGN_METRICS), items };
}

/** 广告关联商品的名称与规格 SKU：订单里出现过的直接用；其余读取商品资料（7 天内读过的复用）。 */
async function collectItems(client, shop, itemIds, previous = {}, nowMs = Date.now()) {
  const fromOrders = new Map();
  for (const order of shop.orders?.rows || []) for (const item of order.items || []) {
    const cur = fromOrders.get(item.itemId) || { name: item.name || '', skus: new Set() };
    if (item.sku) cur.skus.add(item.sku); if (!cur.name && item.name) cur.name = item.name; fromOrders.set(item.itemId, cur);
  }
  const items = {}, stale = [];
  for (const id of itemIds) {
    const old = previous[id], seen = fromOrders.get(id);
    if (old && nowMs - Date.parse(old.fetchedAt || 0) < ITEM_TTL) items[id] = { ...old, skus: [...new Set([...(old.skus || []), ...(seen ? seen.skus : [])])] };
    else { items[id] = { name: seen?.name || old?.name || '', itemSku: old?.itemSku || null, skus: seen ? [...seen.skus] : old?.skus || [], fetchedAt: null, source: seen ? 'orders' : 'none' }; stale.push(id); }
  }
  const warnings = [];
  try {
    for (let i = 0; i < stale.length; i += 50) {
      const batch = stale.slice(i, i + 50);
      const list = (await client.get('itemBase', shop.shopId, { item_id_list: batch.join(',') })).response?.item_list;
      if (!Array.isArray(list)) throw new Error('商品资料格式异常');
      for (const row of list) if (items[row.item_id]) Object.assign(items[row.item_id], { name: text(row.item_name) || items[row.item_id].name, itemSku: text(row.item_sku), hasModel: Boolean(row.has_model), status: text(row.item_status), fetchedAt: new Date(nowMs).toISOString(), source: 'product' });
    }
    // 订单里没见过规格的商品，读规格列表拿 SKU；每次最多 150 个，其余下次同步补齐。
    const need = stale.filter(id => !items[id].skus.length && items[id].hasModel !== false).slice(0, MODEL_FETCH_LIMIT);
    for (const id of need) {
      try {
        const data = (await client.get('modelList', shop.shopId, { item_id: id })).response;
        const skus = (data?.model || []).map(m => text(m.model_sku)).filter(Boolean);
        items[id].skus = [...new Set([...items[id].skus, ...skus])];
      } catch { items[id].fetchedAt = null; }
    }
    for (const id of stale) if (!items[id].skus.length && items[id].itemSku) items[id].skus = [items[id].itemSku];
    const left = stale.filter(id => items[id].hasModel !== false && !items[id].skus.length).length;
    if (left) warnings.push(`${left} 个广告商品的规格 SKU 还没读到，下次同步继续补齐`);
  } catch (e) { warnings.push(`广告商品资料：${e.message}`); }
  return { items, warnings };
}

export async function collectAdvertising(client, shop, period, previous = null) {
  const dates = period.dates, chunks = dateChunks(dates);
  const rawDaily = [];
  for (const chunk of chunks) rawDaily.push(...((await client.get('daily', shop.shopId, chunk)).response || []));
  const daily = requireDays(rawDaily, dates, '店铺广告日消耗').map(r => ({ date: r.date, ...pick(r, METRICS) }));
  const total = round(daily.reduce((n, r) => n + r.expense, 0));
  const result = { daily, total, campaigns: [], gmsItems: [], gms: null, items: {}, warnings: [], reconciliation: null };
  try {
    const index = [];
    for (let offset = 0; ; offset += 50) {
      const page = (await client.get('campaignIndex', shop.shopId, { ad_type: 'all', offset, limit: 50 })).response;
      if (!Array.isArray(page?.campaign_list) || typeof page.has_next_page !== 'boolean') throw new Error('广告计划分页格式异常');
      index.push(...page.campaign_list);
      if (!page.has_next_page) break;
      if (!page.campaign_list.length || offset >= 4950) throw new Error('广告计划分页未完成');
    }
    const listed = index.map(r => Number(r.campaign_id));
    if (new Set(listed).size !== listed.length || listed.some(id => !Number.isSafeInteger(id))) throw new Error('广告计划编号重复或无效');
    const ids = [...new Set([...listed, ...(knownIds[shop.region] || [])])];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100), merged = new Map();
      for (const chunk of chunks) {
        const perf = campaignRows((await client.get('campaignDaily', shop.shopId, { campaign_id_list: batch.join(','), ...chunk })).response);
        if (perf.length !== batch.length || new Set(perf.map(r => Number(r.campaign_id))).size !== batch.length || perf.some(r => !batch.includes(Number(r.campaign_id)))) throw new Error('广告计划表现缺失');
        for (const row of perf) { const cur = merged.get(Number(row.campaign_id)) || { row, metrics: [] }; cur.metrics.push(...(row.metrics_list || [])); merged.set(Number(row.campaign_id), cur); }
      }
      for (const [campaignId, { row, metrics }] of merged) {
        const days = requireDays(metrics, dates, `广告计划 ${campaignId} 消耗`).map(d => ({ date: d.date, ...pick(d, CAMPAIGN_METRICS) }));
        result.campaigns.push({ campaignId, name: text(row.ad_name), adType: text(row.ad_type), placement: text(row.campaign_placement), status: null, budget: null, biddingMethod: null,
          expense: round(days.reduce((n, d) => n + d.expense, 0)), listed: listed.includes(campaignId), itemIds: [], daily: days });
      }
      const indexed = batch.filter(id => listed.includes(id));
      if (indexed.length) try {
        const settings = (await client.get('campaignSettings', shop.shopId, { campaign_id_list: indexed.join(','), info_type_list: '1' })).response?.campaign_list;
        if (!Array.isArray(settings)) throw new Error('计划商品关联缺失');
        for (const row of settings) {
          const target = result.campaigns.find(c => c.campaignId === Number(row.campaign_id)), info = row.common_info || {};
          if (target) Object.assign(target, { itemIds: info.item_id_list || [], name: text(info.ad_name) || target.name, adType: text(info.ad_type) || target.adType, status: text(info.campaign_status), budget: number(info.campaign_budget), biddingMethod: text(info.bidding_method), placement: text(info.campaign_placement) || target.placement });
        }
      } catch (e) { result.warnings.push(`计划商品关联：${e.message}`); }
    }
    // 全店托管 GMV Max：每个统计周期单独查询（商品消耗只能按区间汇总，不能按天拆）。
    const windows = {};
    for (const days of AD_WINDOWS.filter(d => d <= dates.length)) windows[days] = await gmsWindow(client, shop, dates.slice(-days));
    const full = windows[dates.length] || await gmsWindow(client, shop, dates);
    windows[dates.length] = full;
    if (!full.campaignId) {
      if (full.items.length) throw new Error('GMV Max 计划编号未返回，不能将其消耗按零计算');
      result.gms = { campaignId: null, windows };
    } else result.gms = { campaignId: full.campaignId, windows };
    result.gmsItems = full.items.map(i => ({ itemId: i.itemId, expense: i.expense }));
    const planTotal = round(result.campaigns.reduce((n, r) => n + r.expense, 0)), gmsTotal = full.report?.expense ?? 0;
    result.reconciliation = { planTotal, gmsTotal, gmsCampaignId: full.campaignId,
      gap: round(total - planTotal - gmsTotal), gmsItemGap: round(gmsTotal - full.items.reduce((n, r) => n + r.expense, 0)),
      recoveredIds: result.campaigns.filter(r => !r.listed).map(r => r.campaignId) };
  } catch (e) { result.warnings.push(e.message); }
  const itemIds = [...new Set([...result.campaigns.flatMap(c => c.itemIds), ...result.gmsItems.map(i => i.itemId)])].filter(Number.isSafeInteger);
  if (itemIds.length) { const { items, warnings } = await collectItems(client, shop, itemIds, previous?.items || {}); result.items = items; result.warnings.push(...warnings); }
  return result;
}
