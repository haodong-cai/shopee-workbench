import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const snapshotFile = fileURLToPath(new URL('../.local/profit-estimates.ndjson', import.meta.url));
const numbers = ['shoePairs', 'sourceNet', 'incomeCny', 'goodsCny', 'packingCny', 'transportCny', 'adsCny', 'adsSource', 'compoundCny', 'profitA', 'profitB'];
const pick = (row, keys) => Object.fromEntries(keys.map(key => [key, row[key] ?? null]));
export async function readProfitEstimates(file = snapshotFile) {
  let meta = null;
  const orders = [], ids = new Set();
  try {
    for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (!meta) { if (row.kind !== 'meta' || row.version !== 1 || !Array.isArray(row.shops)) throw new Error(); meta = row; continue; }
      const id = `${row.region}/${row.orderSn}`;
      if (row.kind !== 'order' || !row.orderSn || ids.has(id) || !meta.shops.some(shop => shop.region === row.region) || !['overseas_warehouse', 'cross_border'].includes(row.fulfillment) || numbers.some(key => row[key] !== null && !Number.isFinite(row[key])) || !Array.isArray(row.missing) || !Array.isArray(row.lines)) throw new Error();
      if (row.fulfillment === 'cross_border' && (row.profitA !== null || row.profitB !== null || row.transportCny !== null)) throw new Error();
      if (['preFreightA', 'preFreightB'].some(key => row[key] !== undefined && row[key] !== null && !Number.isFinite(row[key]))) throw new Error();
      for (const [field, addback] of [['preFreightA', 0], ['preFreightB', row.compoundCny]]) if (row[field] !== undefined && row[field] !== null) {
        const values = [row.incomeCny, row.goodsCny, row.packingCny, row.adsCny, addback];
        if (row.fulfillment !== 'cross_border' || values.some(value => !Number.isFinite(value)) || Math.round((values[0] - values[1] - values[2] - values[3] + values[4]) * 100) !== Math.round(row[field] * 100)) throw new Error();
      }
      if (row.links !== undefined) {
        if (!Array.isArray(row.links) || (row.fulfillment === 'overseas_warehouse' && !row.links.length) || new Set(row.links.map(link => link.itemId)).size !== row.links.length || (row.fulfillment === 'overseas_warehouse' && (new Set(row.lines.map(line => line.itemId)).size !== row.links.length || row.links.some(link => !row.lines.some(line => line.itemId === link.itemId))))) throw new Error();
        for (const link of row.links) if (!Number.isSafeInteger(link.itemId) || typeof link.name !== 'string' || !Number.isSafeInteger(link.quantity) || link.quantity < 1 || !Number.isSafeInteger(link.shoePairs) || link.shoePairs < 0 || !Array.isArray(link.skus) || link.skus.some(sku => typeof sku !== 'string') || !['single_link','sales_ratio','pending'].includes(link.basis) || [...numbers, 'saleAmount', 'goodsRaw', 'adSource'].some(key => link[key] !== undefined && link[key] !== null && !Number.isFinite(link[key]))) throw new Error();
        for (const key of ['incomeCny','goodsCny','packingCny','transportCny','adsCny','compoundCny','profitA','profitB']) if (row[key] !== null && row.links.every(link => link[key] !== null) && row.links.reduce((sum,link) => sum + Math.round(link[key] * 100), 0) !== Math.round(row[key] * 100)) throw new Error();
      }
      for (const [field, addback] of [['profitA', 0], ['profitB', row.compoundCny]]) if (row[field] !== null) {
        const values = [row.incomeCny, row.goodsCny, row.packingCny, row.transportCny, row.adsCny, addback];
        if (values.some(value => typeof value !== 'number' || !Number.isFinite(value)) || values.slice(1).some(value => value < 0)) throw new Error();
        const cents = values.map(value => Math.round(value * 100));
        if (cents[0] + cents[5] - cents[1] - cents[2] - cents[3] - cents[4] !== Math.round(row[field] * 100)) throw new Error();
      }
      ids.add(id);
      orders.push({ ...pick(row, ['region', 'orderSn', 'status', 'fulfillment', 'sourceCurrency', ...numbers, 'preFreightA', 'preFreightB']), platformFees: row.platformFees ? pick(row.platformFees, ['commission', 'service', 'transaction', 'compound']) : null, missing: row.missing.filter(item => typeof item === 'string'), lines: row.lines.map(item => ({ ...pick(item, ['sku', 'itemId', 'name', 'quantity', 'unitCostCny']), components: (item.components || []).map(part => pick(part, ['sku', 'quantity', 'unitCostCny', 'sourceRows'])) })), links: (row.links || []).map(link => ({ ...pick(link, ['itemId', 'name', 'quantity', 'saleAmount', 'shoePairs', 'adSource', 'incomeCny', 'goodsCny', 'packingCny', 'transportCny', 'adsCny', 'compoundCny', 'profitA', 'profitB', 'basis']), skus: link.skus.filter(sku => typeof sku === 'string') })) });
    }
    if (!meta || meta.count !== orders.length || !/^\d{4}-\d{2}-\d{2}$/.test(meta.period?.start) || !/^\d{4}-\d{2}-\d{2}$/.test(meta.period?.end)) throw new Error();
    for (const shop of meta.shops) {
      const selected = orders.filter(row => row.region === shop.region);
      if (selected.filter(row => row.fulfillment === 'overseas_warehouse').length !== shop.overseas || selected.filter(row => row.fulfillment === 'cross_border').length !== shop.crossBorder) throw new Error();
      for (const [field, expected] of [['profitA', shop.expectedProfitA], ['profitB', shop.expectedProfitB]]) if (Math.round(selected.reduce((sum, row) => sum + (row[field] ?? 0), 0) * 100) !== Math.round(expected * 100)) throw new Error();
    }
    return { available: true, period: pick(meta.period, ['start', 'end']), sourceDate: meta.sourceDate, builtAt: meta.builtAt, shops: meta.shops.map(shop => pick(shop, ['region', 'shopId', 'name', 'label', 'currency', 'dataAt', 'crossIncomeDate', 'overseas', 'crossBorder', 'incomplete', 'adGap', 'noOrderAd', 'fxRate', 'fxDate', 'fxSource', 'fxLabel', 'packingPerOrder', 'transportPerPair'])), orders };
  } catch (error) {
    if (error.code === 'ENOENT') return { available: false, period: null, sourceDate: null, shops: [], orders: [] };
    throw new Error('试算快照校验失败，请检查本地试算数据后重新载入。');
  }
}
