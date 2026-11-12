import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { parse } from 'csv-parse/sync';
import path from 'node:path';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const MAX_ROWS = 10000;
const children = (node, name) => Array.from(node.childNodes || []).filter(n => n.nodeType === 1 && n.localName === name);
const descendants = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));
const nonempty = value => value !== undefined && value !== null && String(value).trim() !== '';
export const normalize = value => String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
export function columnNumber(ref) {
  return ref.match(/^[A-Z]+/)[0].split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}
export function columnLetter(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}
function xml(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('不支持含外部实体的 XML。');
  let invalid = false;
  const doc = new DOMParser({ errorHandler: { warning() {}, error() { invalid = true; }, fatalError() { invalid = true; } } }).parseFromString(text, 'application/xml');
  if (invalid) throw new Error('工作簿 XML 无法解析。');
  return doc;
}
async function part(zip, name, required = true) {
  const file = zip.file(name);
  if (!file) { if (required) throw new Error(`工作簿缺少 ${name}`); return null; }
  const text = await file.async('string');
  if (text.length > 30 * 1024 * 1024) throw new Error('解压后的工作表过大，请拆分文件。');
  return xml(text);
}
async function open(buffer) {
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch { throw new Error('无法读取 XLSX 文件，请确认不是旧版 XLS 或加密文件。'); }
  const book = await part(zip, 'xl/workbook.xml');
  const rels = await part(zip, 'xl/_rels/workbook.xml.rels');
  const relMap = new Map(descendants(rels, 'Relationship').map(r => [r.getAttribute('Id'), r]));
  const sheets = descendants(book, 'sheet').map(s => {
    const id = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || s.getAttribute('r:id');
    const rel = relMap.get(id);
    const target = rel?.getAttribute('Target');
    if (!target || rel.getAttribute('TargetMode') === 'External') throw new Error('模板含不支持的工作表引用。');
    return { name: s.getAttribute('name'), hidden: ['hidden', 'veryHidden'].includes(s.getAttribute('state')), path: target.startsWith('/') ? target.slice(1) : path.posix.normalize(`xl/${target}`) };
  });
  const shared = await part(zip, 'xl/sharedStrings.xml', false);
  const strings = shared ? descendants(shared, 'si').map(si => descendants(si, 't').map(t => t.textContent).join('')) : [];
  return { zip, sheets, strings };
}
function cellValue(cell, strings) {
  const raw = children(cell, 'v')[0]?.textContent ?? '';
  switch (cell.getAttribute('t')) {
    case 's': return strings[Number(raw)] ?? '';
    case 'inlineStr': return descendants(cell, 't').map(t => t.textContent).join('');
    case 'b': return raw === '1';
    case 'e': throw new Error(`单元格 ${cell.getAttribute('r')} 含 Excel 错误 ${raw}`);
    default:
      if (children(cell, 'f').length && !nonempty(raw)) throw new Error(`公式 ${cell.getAttribute('r')} 没有缓存结果，请在 Excel 中重算后保存。`);
      return cell.getAttribute('t') === 'str' ? raw : raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
}
async function sheetData(book, name, maxRows = MAX_ROWS) {
  const sheet = book.sheets.find(s => s.name === name) || (!name && (book.sheets.find(s => !s.hidden) || book.sheets[0]));
  if (!sheet) throw new Error('工作表不存在。');
  const doc = await part(book.zip, sheet.path);
  const rows = descendants(doc, 'row').map(row => ({ number: Number(row.getAttribute('r')), cells: children(row, 'c').map(cell => ({ column: columnLetter(columnNumber(cell.getAttribute('r'))), value: cellValue(cell, book.strings) })) }));
  if (rows.length > maxRows + 100) throw new Error(`最多处理 ${maxRows} 行，请拆分文件。`);
  return { sheet, doc, rows };
}
function columnsAt(rows, headerRow) {
  return (rows.find(r => r.number === headerRow)?.cells || []).filter(c => nonempty(c.value)).map(c => ({ key: c.column, label: String(c.value), required: /必填|required|batbuoc/i.test(normalize(c.value)) || String(c.value).includes('*') }));
}
export async function inspectWorkbook(buffer) {
  const book = await open(buffer);
  const sheets = [];
  for (const s of book.sheets) {
    if (s.hidden) { sheets.push({ name: s.name, hidden: true, candidates: [], preview: [] }); continue; }
    const data = await sheetData(book, s.name);
    const preview = data.rows.filter(r => r.number <= 40);
    const candidates = preview.map(r => ({ row: r.number, populated: r.cells.filter(c => nonempty(c.value)).length, score: r.cells.reduce((n, c) => n + (/sku|price|stock|name|image|gia|tonkho|tensanpham|商品|价格|库存|图片/.test(normalize(c.value)) ? 4 : 0) + (nonempty(c.value) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score).slice(0, 4);
    sheets.push({ name: s.name, hidden: false, candidates, preview, hasTables: descendants(data.doc, 'tablePart').length > 0, validations: descendants(data.doc, 'dataValidation').length, merged: descendants(data.doc, 'mergeCell').map(c => c.getAttribute('ref')) });
  }
  return { sheets };
}
export async function readSource(buffer, filename, sheet, headerRow = 1, { maxRows = MAX_ROWS } = {}) {
  if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > 100) throw new Error('表头行需为 1–100 的整数。');
  let rows, sheets;
  if (/\.csv$/i.test(filename)) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text;
    try { text = decoder.decode(buffer); } catch { throw new Error('CSV 需为 UTF-8 编码，请在 Excel 中另存为“CSV UTF-8”。'); }
    const first = text.split(/\r?\n/)[headerRow - 1] || '';
    const delimiter = ['\t', ';', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0];
    const records = parse(text, { bom: true, delimiter, relax_column_count: true, skip_empty_lines: false });
    rows = records.map((cells, i) => ({ number: i + 1, cells: cells.map((value, j) => ({ column: columnLetter(j + 1), value })) }));
    sheets = [{ name: 'CSV', hidden: false }];
    sheet = 'CSV';
  } else if (/\.xlsx$/i.test(filename)) {
    const book = await open(buffer);
    const result = await sheetData(book, sheet, maxRows);
    rows = result.rows; sheet = result.sheet.name;
    sheets = book.sheets.map(({ name, hidden }) => ({ name, hidden }));
  } else throw new Error('商品文件支持 CSV、XLSX；不支持 XLS、XLSM。');
  if (rows.length > maxRows + 100) throw new Error(`最多处理 ${maxRows} 行，请拆分文件。`);
  const columns = columnsAt(rows, headerRow);
  if (!columns.length) throw new Error('所选表头行为空，请调整表头行号。');
  const data = rows.filter(r => r.number > headerRow && r.cells.some(c => nonempty(c.value))).map(r => ({ line: r.number, values: Object.fromEntries(r.cells.map(c => [c.column, c.value])) }));
  if (data.some(r => Object.keys(r.values).some(k => nonempty(r.values[k]) && !columns.some(c => c.key === k)))) throw new Error('存在没有表头的数据列，请补全商品表表头后重试。');
  if (!data.length) throw new Error('表头下方没有商品数据。');
  if (data.length > maxRows) throw new Error(`最多处理 ${maxRows} 行，请拆分文件。`);
  return { columns, rows: data, sheets, sheet, headerRow };
}
function mappingsCheck(mappings) {
  if (!Array.isArray(mappings) || !mappings.some(m => m.source)) throw new Error('至少对应一个模板字段。');
  const columns = new Set();
  for (const m of mappings) {
    if (!/^[A-Z]{1,3}$/.test(m.target) || (m.source && !/^[A-Z]{1,3}$/.test(m.source))) throw new Error('字段列号无效。');
    if (columns.has(m.target)) throw new Error(`模板列 ${m.target} 重复对应。`);
    columns.add(m.target);
    if (!['text', 'sku', 'price', 'stock', 'url'].includes(m.type)) throw new Error('字段校验类型无效。');
  }
}
export function validateRows(rows, mappings) {
  mappingsCheck(mappings);
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS) throw new Error(`商品行数需为 1–${MAX_ROWS}。`);
  const issues = [];
  const seen = new Map();
  const totals = Object.fromEntries(mappings.filter(m => ['price', 'stock'].includes(m.type) && m.source).map(m => [m.target, { label: m.label, type: m.type, sum: 0 }]));
  rows.forEach((row, index) => {
    if (!row.values || typeof row.values !== 'object') throw new Error('商品行格式无效。');
    for (const m of mappings) {
      const value = m.source ? row.values[m.source] : '';
      const add = message => issues.push({ line: row.line ?? index + 1, field: m.label, message });
      if (m.required && !nonempty(value)) { add('必填字段为空或未对应'); continue; }
      if (!nonempty(value) || !m.source) continue;
      if (m.type === 'sku') {
        if (typeof value !== 'string') { add('SKU 需为文本格式，以保留前导零及完整编码'); continue; }
        const key = `${m.target}:${String(value).trim()}`;
        if (seen.has(key)) add(`SKU 重复，与原始第 ${seen.get(key)} 行相同`);
        else seen.set(key, row.line ?? index + 1);
      }
      if (m.type === 'price' || m.type === 'stock') {
        const n = typeof value === 'number' ? value : /^\d+(\.\d+)?$/.test(String(value).trim()) ? Number(value) : NaN;
        if (!Number.isFinite(n) || n < 0 || (m.type === 'stock' && !Number.isInteger(n))) add(m.type === 'stock' ? '库存需为非负整数' : '价格需为非负数字；不要含币种或千位分隔符');
        else totals[m.target].sum += n;
      }
      if (m.type === 'url' && !/^https?:\/\/\S+$/i.test(String(value))) add('图片链接需为 HTTP/HTTPS URL，且不能包含空格');
    }
  });
  Object.values(totals).forEach(t => { t.sum = Number(t.sum.toFixed(6)); });
  const badRows = new Set(issues.map(i => i.line)).size;
  return { count: rows.length, passed: rows.length - badRows, failed: badRows, issues, totals, mapped: mappings.filter(m => m.source).length };
}
export async function exportWorkbook(buffer, { sheet, headerRow, startRow, mappings, rows }) {
  headerRow = Number(headerRow); startRow = Number(startRow);
  if (!Number.isInteger(headerRow) || headerRow < 1 || !Number.isInteger(startRow) || startRow <= headerRow || startRow + rows?.length - 1 > 1048576) throw new Error('数据起始行必须在表头下方，且不能超出 Excel 行数上限。');
  const checked = validateRows(rows, mappings);
  if (checked.failed) throw new Error(`有 ${checked.failed} 行校验未通过，不能导出。`);
  const book = await open(buffer);
  const data = await sheetData(book, sheet);
  if (descendants(data.doc, 'tablePart').length) throw new Error('模板含 Excel 表格结构，首版暂不支持；请使用官方普通单元格模板。');
  const columns = columnsAt(data.rows, headerRow);
  if (mappings.some(m => !columns.some(c => c.key === m.target))) throw new Error('模板表头已变化，请重新对应字段。');
  const sheetDataNode = descendants(data.doc, 'sheetData')[0];
  if (!sheetDataNode) throw new Error('模板缺少数据区域。');
  const rowNodes = new Map(children(sheetDataNode, 'row').map(r => [Number(r.getAttribute('r')), r]));
  const merged = descendants(data.doc, 'mergeCell').map(m => m.getAttribute('ref').split(':').map(ref => ({ col: columnNumber(ref), row: Number(ref.match(/\d+$/)[0]) })));
  const mapped = mappings.filter(m => m.source);
  for (let i = 0; i < rows.length; i++) {
    const n = startRow + i;
    for (const m of mapped) {
      const col = columnNumber(m.target);
      if (merged.some(([a, b = a]) => n >= a.row && n <= b.row && col >= a.col && col <= b.col)) throw new Error(`目标 ${m.target}${n} 是合并单元格，请重新选择数据区。`);
      const old = rowNodes.get(n) && children(rowNodes.get(n), 'c').find(c => c.getAttribute('r') === `${m.target}${n}`);
      if (old && (children(old, 'f').length || nonempty(cellValue(old, book.strings)))) throw new Error(`模板 ${m.target}${n} 已有数据或公式；不会覆盖，请调整数据起始行。`);
    }
  }
  const sample = rowNodes.get(startRow);
  const sampleStyles = new Map(sample ? children(sample, 'c').map(c => [columnNumber(c.getAttribute('r')), c.getAttribute('s')]) : []);
  const node = name => data.doc.createElementNS(NS, name);
  for (let i = 0; i < rows.length; i++) {
    const n = startRow + i;
    let row = rowNodes.get(n);
    if (!row) {
      row = node('row'); row.setAttribute('r', String(n));
      const next = children(sheetDataNode, 'row').find(r => Number(r.getAttribute('r')) > n);
      sheetDataNode.insertBefore(row, next || null); rowNodes.set(n, row);
    }
    row.removeAttribute('spans');
    for (const m of mapped) {
      const value = rows[i].values[m.source];
      if (!nonempty(value)) continue;
      const ref = `${m.target}${n}`;
      let cell = children(row, 'c').find(c => c.getAttribute('r') === ref);
      if (!cell) {
        cell = node('c'); cell.setAttribute('r', ref);
        const style = sampleStyles.get(columnNumber(m.target));
        if (style) cell.setAttribute('s', style);
        const next = children(row, 'c').find(c => columnNumber(c.getAttribute('r')) > columnNumber(ref));
        row.insertBefore(cell, next || null);
      }
      while (cell.firstChild) cell.removeChild(cell.firstChild);
      if (['price', 'stock'].includes(m.type)) {
        cell.removeAttribute('t'); const v = node('v'); v.textContent = String(Number(value)); cell.appendChild(v);
      } else {
        cell.setAttribute('t', 'inlineStr'); const inline = node('is'), t = node('t');
        t.setAttribute('xml:space', 'preserve'); t.textContent = String(value); inline.appendChild(t); cell.appendChild(inline);
      }
    }
  }
  const allCells = descendants(data.doc, 'c');
  const maxCol = allCells.reduce((max, c) => Math.max(max, columnNumber(c.getAttribute('r'))), 1);
  const maxRow = Math.max(1, ...Array.from(rowNodes.keys()));
  const dimension = descendants(data.doc, 'dimension')[0];
  if (dimension) dimension.setAttribute('ref', `A1:${columnLetter(maxCol)}${maxRow}`);
  book.zip.file(data.sheet.path, new XMLSerializer().serializeToString(data.doc));
  return book.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
