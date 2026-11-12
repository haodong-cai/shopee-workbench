import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSkuCost } from './product-costs.mjs';
import { roleOf, createSkuRoles } from './sku-roles.mjs';

// 采购成本查询：读取 .local 中最新的 product-cost-catalog-YYYY-MM-DD.json（人民币），组合装按部件展开。
export function createSkuCosts({ dir = fileURLToPath(new URL('../.local', import.meta.url)), roles = createSkuRoles() } = {}) {
  let cache;
  async function load() {
    const names = (await readdir(dir).catch(() => [])).filter(n => /^product-cost-catalog-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
    const name = names.at(-1);
    if (!name) return { available: false };
    if (cache?.name === name) return cache;
    const catalog = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
    if (!catalog?.costs || !catalog?.combos) throw new Error('成本档案格式异常');
    cache = { available: true, name, date: name.slice(21, 31), currency: catalog.currency || 'CNY', sources: Object.keys(catalog.sources || {}), catalog };
    return cache;
  }
  return {
    /** 完整成本档案（供滚动毛利逐单计算）。 */
    async catalog() { const data = await load(); return data.available ? { available: true, name: data.name, date: data.date, catalog: data.catalog } : { available: false }; },
    async lookup(skus) {
      if (!Array.isArray(skus) || skus.length > 20000 || skus.some(s => typeof s !== 'string' || s.length > 200)) throw new Error('SKU 列表无效');
      const data = await load();
      if (!data.available) return { available: false, costs: {} };
      const reviewed = (await roles.load().catch(() => ({ roles: {} }))).roles;
      // parts：组合装拆成单品后各自的 SPU（货品档案），用于广告组、商品排行按 SPU 展示；鞋 / 配件按核对清单或前缀判断。
      const partsOf = (sku, components) => {
        const list = components.length ? components.map(c => c.sku) : data.catalog.single?.[sku] ? [sku] : [];
        return [...new Map(list.map(part => { const single = data.catalog.single?.[part]; const spu = single?.spu || null;
          return [spu || part, { sku: part, spu, spuName: single?.spuName || single?.name || null, role: roleOf(spu, reviewed).role }]; })).values()];
      };
      const costs = Object.fromEntries([...new Set(skus)].filter(Boolean).map(sku => {
        const r = resolveSkuCost(sku, data.catalog);
        return [sku, { unitCost: r.unitCost === null ? null : Math.round(r.unitCost * 10000) / 10000, combo: r.components.length > 1, missing: r.missing, parts: partsOf(sku.trim(), r.components) }];
      }));
      return { available: true, date: data.date, currency: data.currency, sources: data.sources, costs };
    }
  };
}
