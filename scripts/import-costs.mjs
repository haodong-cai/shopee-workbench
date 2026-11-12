// 导入采购成本档案：把自己的成本表（CSV UTF-8 / XLSX）转换成工作台读取的 .local/product-cost-catalog-YYYY-MM-DD.json。
//   npm run import-costs -- 单品成本表.xlsx [组合装表.xlsx]
// 单品成本表表头（第 1 行）：SKU、采购成本（人民币），可选 SPU、名称、用途（鞋 / 配件）。
// 组合装表表头：组合SKU、子SKU、数量。模板见 templates/ 目录。
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from '../server/workbook.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), local = path.join(root, '.local');
const pick = (columns, names) => columns.find(c => names.includes(String(c.label).trim().toLowerCase()))?.key;
const text = value => String(value ?? '').trim();

async function table(file) {
  const data = await readSource(await readFile(file), path.basename(file), undefined, 1);
  return data;
}

const [singleFile, comboFile] = process.argv.slice(2);
try {
  if (!singleFile) throw new Error('用法：npm run import-costs -- 单品成本表.xlsx [组合装表.xlsx]');
  const catalog = { currency: 'CNY', sources: {}, costs: {}, combos: {}, single: {} }, roles = {};
  const single = await table(singleFile);
  const col = { sku: pick(single.columns, ['sku', '单品sku', '商品sku', 'sku编码']), cost: pick(single.columns, ['采购成本', '成本', '成本价', '采购价']),
    spu: pick(single.columns, ['spu', '款号']), name: pick(single.columns, ['名称', '商品名称', '品名']), role: pick(single.columns, ['用途', '类型']) };
  if (!col.sku || !col.cost) throw new Error('单品成本表需要“SKU”和“采购成本”两列。');
  let bad = 0;
  for (const row of single.rows) {
    const sku = text(row.values[col.sku]), value = Number(text(row.values[col.cost]).replace(/,/g, ''));
    if (!sku) continue;
    if (!Number.isFinite(value) || value < 0) { bad++; console.warn(`第 ${row.line} 行成本无效，已跳过：${sku}`); continue; }
    (catalog.costs[sku] ||= []).push({ value, row: row.line });
    const spu = col.spu ? text(row.values[col.spu]) : '', name = col.name ? text(row.values[col.name]) : '';
    catalog.single[sku] = { spu: spu || null, spuName: name || null };
    const role = col.role ? text(row.values[col.role]) : '';
    if (spu && /^(鞋|鞋子|shoe)$/i.test(role)) roles[spu] = 'shoe_pair';
    if (spu && /^(配件|accessory)$/i.test(role)) roles[spu] = 'accessory';
  }
  catalog.sources[path.basename(singleFile)] = single.rows.length;
  if (comboFile) {
    const combo = await table(comboFile);
    const c = { parent: pick(combo.columns, ['组合sku', '组合装sku', '父sku']), child: pick(combo.columns, ['子sku', '单品sku', '部件sku']), qty: pick(combo.columns, ['数量', '件数']) };
    if (!c.parent || !c.child || !c.qty) throw new Error('组合装表需要“组合SKU”“子SKU”“数量”三列。');
    for (const row of combo.rows) {
      const parent = text(row.values[c.parent]), child = text(row.values[c.child]), quantity = Number(text(row.values[c.qty]));
      if (!parent || !child) continue;
      if (!Number.isInteger(quantity) || quantity <= 0) { bad++; console.warn(`组合装第 ${row.line} 行数量无效，已跳过：${parent}`); continue; }
      (catalog.combos[parent] ||= []).push({ sku: child, quantity });
    }
    catalog.sources[path.basename(comboFile)] = combo.rows.length;
  }
  await mkdir(local, { recursive: true });
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const out = path.join(local, `product-cost-catalog-${day}.json`);
  await writeFile(`${out}.tmp`, JSON.stringify(catalog)); await rename(`${out}.tmp`, out);
  if (Object.keys(roles).length) {
    const file = path.join(local, 'sku-roles.json');
    let saved = { version: 1, roles: {} };
    try { saved = JSON.parse(await readFile(file, 'utf8')); } catch {}
    saved.roles = { ...saved.roles, ...roles };
    await writeFile(file, JSON.stringify(saved, null, 2));
  }
  console.log(`已导入：单品 ${Object.keys(catalog.costs).length} 个、组合装 ${Object.keys(catalog.combos).length} 个${Object.keys(roles).length ? `、鞋 / 配件用途 ${Object.keys(roles).length} 个 SPU` : ''}${bad ? `，跳过 ${bad} 行` : ''}。`);
  console.log(`文件：${path.relative(root, out)}（工作台自动读取日期最新的一份）`);
} catch (error) { console.error(`导入失败：${error.message}`); process.exitCode = 1; }
