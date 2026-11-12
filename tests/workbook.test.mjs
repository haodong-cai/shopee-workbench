import './helpers/test-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { inspectWorkbook, readSource, validateRows, exportWorkbook } from '../server/workbook.mjs';
import { createApp } from '../server/index.mjs';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const columns = ['Tên sản phẩm', 'SKU', 'Giá', 'Tồn kho', 'Hình ảnh'];
const mappings = columns.map((label, i) => ({ label, target: String.fromCharCode(65 + i), source: String.fromCharCode(65 + i), required: i < 4, type: ['text', 'sku', 'price', 'stock', 'url'][i] }));
const csv = '\ufeffTên sản phẩm,SKU,Giá,Tồn kho,Hình ảnh\r\nDép xanh,001-BL,120000,3,https://example.com/blue.jpg\r\nDép đỏ,002-RD,150000,5,https://example.com/red.jpg\r\nDép trắng,003-WH,90000,2,https://example.com/white.jpg\r\n';
async function fixture(extra = '') {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', `<workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sản phẩm" sheetId="1" r:id="rId1"/><sheet name="Instructions" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="${NS}"><dimension ref="A1:E4"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>测试模板，非官方模板</t></is></c></row><row r="3">${columns.map((label, i) => `<c r="${String.fromCharCode(65 + i)}3" t="inlineStr"><is><t>${label}</t></is></c>`).join('')}</row><row r="4">${extra}</row></sheetData><dataValidations count="1"><dataValidation type="whole" sqref="D4:D100"><formula1>0</formula1><formula2>9999</formula2></dataValidation></dataValidations></worksheet>`);
  zip.file('xl/worksheets/sheet2.xml', `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>KEEP INSTRUCTIONS</t></is></c></row></sheetData></worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}
test('UTF-8 越南文 CSV、行号、SKU 前导零及价格库存校验', async () => {
  const data = await readSource(Buffer.from(csv), 'test.csv');
  assert.equal(data.rows.length, 3);
  assert.equal(data.rows[0].line, 2);
  assert.equal(data.rows[0].values.B, '001-BL');
  const validation = validateRows(data.rows, mappings);
  assert.equal(validation.failed, 0);
  assert.equal(validation.totals.C.sum, 360000);
  assert.equal(validation.totals.D.sum, 10);
});
test('识别真实候选表头，排除隐藏说明表', async () => {
  const result = await inspectWorkbook(await fixture());
  assert.equal(result.sheets[0].candidates[0].row, 3);
  assert.equal(result.sheets[0].validations, 1);
  assert.equal(result.sheets[1].hidden, true);
});
test('逐行导出再读取：3 行、价格合计 360000、库存 10，保留隐藏表和验证规则', async () => {
  const original = await fixture();
  const { rows } = await readSource(Buffer.from(csv), 'test.csv');
  const output = await exportWorkbook(original, { sheet: 'Sản phẩm', headerRow: 3, startRow: 4, mappings, rows });
  const data = await readSource(output, 'output.xlsx', 'Sản phẩm', 3);
  assert.equal(data.rows.length, 3);
  assert.deepEqual(data.rows.map(r => r.values.B), ['001-BL', '002-RD', '003-WH']);
  assert.equal(data.rows.reduce((n, r) => n + r.values.C, 0), 360000);
  assert.equal(data.rows.reduce((n, r) => n + r.values.D, 0), 10);
  const before = await JSZip.loadAsync(original), after = await JSZip.loadAsync(output);
  for (const file of Object.keys(before.files).filter(n => !before.files[n].dir && n !== 'xl/worksheets/sheet1.xml')) assert.equal(await after.file(file).async('string'), await before.file(file).async('string'), `${file} should be unchanged`);
  assert.match(await after.file('xl/worksheets/sheet1.xml').async('string'), /sqref="D4:D100"/);
});
test('拒绝空必填、重复 SKU、负价、非整数库存及本地图片路径', async () => {
  const { rows } = await readSource(Buffer.from(csv), 'test.csv');
  rows[1].values = { A: '', B: '001-BL', C: '-1', D: '1.5', E: 'C:/image.jpg' };
  const result = validateRows(rows, mappings);
  assert.equal(result.failed, 1);
  assert.equal(result.issues.length, 5);
  await assert.rejects(exportWorkbook(await fixture(), { sheet: 'Sản phẩm', headerRow: 3, startRow: 4, mappings, rows }), /校验未通过/);
});
test('不覆盖已有示例数据或公式，不写合并单元格', async () => {
  const { rows } = await readSource(Buffer.from(csv), 'test.csv');
  for (const extra of ['<c r="A4" t="inlineStr"><is><t>EXISTING</t></is></c>', '<c r="C4"><f>1+1</f><v>2</v></c>']) {
    await assert.rejects(exportWorkbook(await fixture(extra), { sheet: 'Sản phẩm', headerRow: 3, startRow: 4, mappings, rows }), /不会覆盖/);
  }
  const zip = await JSZip.loadAsync(await fixture());
  zip.file('xl/worksheets/sheet1.xml', (await zip.file('xl/worksheets/sheet1.xml').async('string')).replace('</worksheet>', '<mergeCells><mergeCell ref="A4:B4"/></mergeCells></worksheet>'));
  await assert.rejects(exportWorkbook(await zip.generateAsync({ type: 'nodebuffer' }), { sheet: 'Sản phẩm', headerRow: 3, startRow: 4, mappings, rows }), /合并单元格/);
});
test('CSV 文本公式保留为普通文本，未对应字段保持空白', async () => {
  const { rows } = await readSource(Buffer.from(csv), 'test.csv');
  rows[0].values.A = '=HYPERLINK("https://example.com")';
  const selected = mappings.map(m => m.target === 'E' ? { ...m, source: '' } : m);
  const output = await exportWorkbook(await fixture(), { sheet: 'Sản phẩm', headerRow: 3, startRow: 4, mappings: selected, rows });
  const result = await readSource(output, 'output.xlsx', 'Sản phẩm', 3);
  assert.equal(result.rows[0].values.A, rows[0].values.A);
  assert.equal(result.rows[0].values.E, undefined);
});
test('数字格式 SKU 阻止导出，防止编码静默变化', async () => {
  const { rows } = await readSource(Buffer.from(csv), 'test.csv');
  rows[0].values.B = 123;
  assert.match(validateRows(rows, mappings).issues[0].message, /文本格式/);
});
test('Excel 最后一行边界允许写入，越界拒绝', async () => {
  const { rows } = await readSource(Buffer.from(csv), 'test.csv');
  const options = { sheet: 'Sản phẩm', headerRow: 3, startRow: 1048576, mappings, rows: rows.slice(0, 1) };
  const output = await exportWorkbook(await fixture(), options);
  assert.equal((await readSource(output, 'last-row.xlsx', 'Sản phẩm', 3)).rows[0].line, 1048576);
  await assert.rejects(exportWorkbook(await fixture(), { ...options, rows: rows.slice(0, 2) }), /行数上限/);
});
test('HTTP 文件导入、校验、导出链路', async t => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = new FormData(); body.append('file', new Blob([csv]), 'products.csv');
  const data = await (await fetch(`${base}/api/source`, { method: 'POST', body })).json();
  const response = await fetch(`${base}/api/validate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rows: data.rows, mappings }) });
  assert.equal((await response.json()).passed, 3);
  const exportBody = new FormData(); exportBody.append('file', new Blob([await fixture()]), 'test-template.xlsx'); exportBody.append('options', JSON.stringify({ sheet: 'Sản phẩm', headerRow: 3, startRow: 4, mappings, rows: data.rows }));
  const exported = await fetch(`${base}/api/export`, { method: 'POST', body: exportBody });
  assert.equal(exported.status, 200);
  assert.ok((await exported.arrayBuffer()).byteLength > 1000);
});
