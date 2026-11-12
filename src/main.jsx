import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FileText, Table2, ClipboardCheck, ChevronRight, ChevronLeft, Upload, Check, Download, AlertCircle, X } from 'lucide-react';
import './style.css';
import Workbench from './Workbench.jsx';

const steps = ['导入商品', '对应官方模板', '校验并导出'];
const icons = [FileText, Table2, ClipboardCheck];
const nf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 });
const norm = text => String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
const aliases = [
  ['sku', 'sellersku', '子sku', '商家编码', 'masanpham', 'maskuphanloai'],
  ['productname', 'itemname', '商品名称', '商品名', 'tensanpham'],
  ['price', 'originalprice', '价格', '售价', 'gia', 'giaban'],
  ['stock', 'quantity', '库存', '数量', 'tonkho', 'soluong'],
  ['description', '商品描述', '描述', 'mota', 'motasanpham'],
  ['image', 'image1', 'mainimage', '主图', '图片', 'hinhanh', 'anhbia'],
  ['weight', '重量', 'cannang', 'khoiluong']
];
function fieldType(label) {
  const text = norm(label);
  if (aliases[0].includes(text)) return 'sku';
  if (aliases[2].includes(text)) return 'price';
  if (aliases[3].includes(text)) return 'stock';
  if (aliases[5].includes(text)) return 'url';
  return 'text';
}
async function request(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || `请求失败 ${response.status}`); }
  return response.json();
}
function form(file, fields = {}) {
  const data = new FormData(); data.append('file', file);
  Object.entries(fields).forEach(([key, value]) => data.append(key, value));
  return { method: 'POST', body: data };
}
function App() {
  const [step, setStep] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [sourceFile, setSourceFile] = useState(null), [source, setSource] = useState(null), [sourceSheet, setSourceSheet] = useState(''), [sourceHeader, setSourceHeader] = useState(1);
  const [template, setTemplate] = useState(null), [inspection, setInspection] = useState(null), [sheet, setSheet] = useState(''), [headerRow, setHeaderRow] = useState(1), [startRow, setStartRow] = useState(2);
  const [mappings, setMappings] = useState([]), [confirmed, setConfirmed] = useState(false), [validation, setValidation] = useState(null), [query, setQuery] = useState('');
  const sourceInput = useRef(null), templateInput = useRef(null);
  const selectedSheet = inspection?.sheets.find(s => s.name === sheet);
  const templateColumns = (selectedSheet?.preview.find(r => r.number === Number(headerRow))?.cells || []).filter(c => String(c.value ?? '').trim()).map(c => ({ key: c.column, label: String(c.value) }));
  const mappingKey = `shopee-vn-mapping:${sheet}:${headerRow}:${templateColumns.map(c => `${c.key}:${c.label}`).join('|')}:${source?.columns.map(c => `${c.key}:${c.label}`).join('|')}`;
  function changed() { setValidation(null); setConfirmed(false); setNotice(''); }
  async function run(task) {
    setError(''); setNotice(''); setBusy(true);
    try { await task(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  function suggest(columns, input = source) {
    setMappings(columns.map(c => {
      const target = norm(c.label);
      const group = aliases.find(g => g.includes(target));
      const matches = input?.columns.filter(s => norm(s.label) === target || group?.includes(norm(s.label))) || [];
      return { target: c.key, label: c.label, source: matches.length === 1 ? matches[0].key : '', required: /\*|必填|required|batbuoc/.test(target) || c.label.includes('*'), type: fieldType(c.label) };
    }));
    changed();
  }
  function columnsFor(info, name, row) {
    return (info.sheets.find(s => s.name === name)?.preview.find(r => r.number === Number(row))?.cells || []).filter(c => String(c.value ?? '').trim()).map(c => ({ key: c.column, label: String(c.value) }));
  }
  async function loadSource(file, name = '', row = 1) {
    if (!file) return;
    await run(async () => {
      const result = await request('/api/source', form(file, { sheet: name, headerRow: row }));
      setSourceFile(file); setSource(result); setSourceSheet(result.sheet); setSourceHeader(row); setQuery('');
      if (inspection) suggest(templateColumns, result);
      changed();
    });
  }
  async function loadTemplate(file) {
    if (!file) return;
    await run(async () => {
      const info = await request('/api/inspect', form(file));
      const selected = info.sheets.find(s => !s.hidden && s.candidates.length);
      if (!selected) throw new Error('模板中没有可识别的可见数据工作表。');
      const row = selected.candidates[0].row;
      setTemplate(file); setInspection(info); setSheet(selected.name); setHeaderRow(row); setStartRow(row + 1);
      suggest(columnsFor(info, selected.name, row));
    });
  }
  function selectSheet(name) {
    const s = inspection.sheets.find(s => s.name === name);
    const row = s.candidates[0]?.row || 1;
    setSheet(name); setHeaderRow(row); setStartRow(row + 1); suggest(columnsFor(inspection, name, row));
  }
  function changeMapping(index, key, value) {
    setMappings(prev => prev.map((m, i) => i === index ? { ...m, [key]: value } : m)); changed();
  }
  async function validate() {
    await run(async () => setValidation(await request('/api/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: source.rows, mappings }) })));
  }
  async function download() {
    await run(async () => {
      const options = { sheet, headerRow, startRow, rows: source.rows, mappings };
      const response = await fetch('/api/export', form(template, { options: JSON.stringify(options) }));
      if (!response.ok) throw new Error((await response.json()).error);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = `Shopee-VN-${new Date().toISOString().slice(0, 10)}.xlsx`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`已生成 ${source.rows.length} 行。请在越南卖家中心上传后核对平台校验结果。`);
    });
  }
  const filteredRows = source?.rows.filter(r => !query || Object.values(r.values).some(v => String(v).toLowerCase().includes(query.toLowerCase()))) || [];
  const canMap = !!source?.rows.length && sourceSheet === source.sheet && Number(sourceHeader) === source.headerRow;
  const canValidate = canMap && !!template && mappings.some(m => m.source) && confirmed && Number(startRow) > Number(headerRow) && !selectedSheet?.hasTables;
  const totalEntries = validation ? Object.values(validation.totals) : [];
  return <div className="listing">
    <div className="listing-main">
      <header className="listing-head">
        <ol className="steps" aria-label="上架流程">{steps.map((label, i) => { const Icon = icons[i]; const locked = busy || (i > 0 && !canMap) || (i === 2 && !canValidate && step < 2); return <li key={label} className={i === step ? 'current' : i < step ? 'done' : ''}>
          <button onClick={() => { setStep(i); setError(''); }} disabled={locked && i !== step} aria-current={i === step ? 'step' : undefined}><span>{i < step ? <Check size={14}/> : <Icon size={14}/>}</span><div><small>第 {i + 1} 步</small>{label}</div></button>
        </li>; })}</ol>
        {step === 0 && <button className="primary" onClick={() => sourceInput.current.click()} disabled={busy}><Upload size={15}/>导入商品表</button>}
      </header>
      {error && <div className="message error" role="alert"><AlertCircle size={19}/><span>{error}</span><button aria-label="关闭提示" onClick={() => setError('')}><X size={17}/></button></div>}
      {notice && <div className="message success" role="status"><Check size={19}/>{notice}</div>}
      <input ref={sourceInput} aria-label="商品文件" className="file-input" type="file" accept=".csv,.xlsx" onChange={e => { loadSource(e.target.files[0]); e.target.value = ''; }}/>
      <input ref={templateInput} aria-label="官方模板文件" className="file-input" type="file" accept=".xlsx" onChange={e => { loadTemplate(e.target.files[0]); e.target.value = ''; }}/>
      {step === 0 && <>
        {!source ? <section className="dropzone" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!busy) loadSource(e.dataTransfer.files[0]); }}>
          <FileText className="document-icon" size={76} strokeWidth={1.6}/><h2>导入商品资料</h2><p>支持 CSV、XLSX，保留原始 SKU、价格和库存</p>
          <button className="outline" onClick={() => sourceInput.current.click()} disabled={busy}>选择文件</button>
        </section> : <section className="source-settings"><div><h2>{sourceFile.name}</h2><p>{source.rows.length} 条数据 · {source.columns.length} 个字段 · 价格单位按原表核对，越南站使用越南盾</p></div><div className="controls">
          <label>商品工作表<select value={sourceSheet} onChange={e => setSourceSheet(e.target.value)} disabled={busy}>{source.sheets.filter(s => !s.hidden).map(s => <option key={s.name}>{s.name}</option>)}</select></label>
          <label>表头行<input aria-label="商品表头行" type="number" min="1" max="100" value={sourceHeader} onChange={e => setSourceHeader(e.target.value)}/></label>
          <button onClick={() => loadSource(sourceFile, sourceSheet, sourceHeader)} disabled={busy}>重新读取</button>
        </div></section>}
        {source && <div className="table-toolbar"><span>{query ? `匹配 ${filteredRows.length} 行` : `共 ${source.rows.length} 行`}，预览前 100 行</span><input aria-label="搜索商品" placeholder="搜索名称或 SKU" value={query} onChange={e => setQuery(e.target.value)}/></div>}
        <div className={`table-wrap ${!source ? 'empty-table' : ''}`}><table><thead><tr><th>原始行号</th>{(source?.columns || ['商品名称', 'SKU', '价格（₫）', '库存', '图片'].map(label => ({ key: label, label }))).map(c => <th key={c.key}>{c.label}</th>)}</tr></thead><tbody>
          {!source ? <tr><td colSpan="6" className="empty">尚未导入商品</td></tr> : filteredRows.length ? filteredRows.slice(0, 100).map(row => <tr key={row.line}><td>{row.line}</td>{source.columns.map(c => <td key={c.key} title={String(row.values[c.key] ?? '')}>{String(row.values[c.key] ?? '')}</td>)}</tr>) : <tr><td colSpan={source.columns.length + 1} className="empty">没有匹配的商品</td></tr>}
        </tbody></table></div>
      </>}
      {step === 1 && <>
        <section className="section-heading"><div><h2>对应越南官方模板</h2><p>从越南卖家中心下载对应类目的 XLSX 模板，再导入这里。</p></div><button className="outline" onClick={() => templateInput.current.click()} disabled={busy}><Upload size={15}/>{template ? '更换模板' : '选择官方模板'}</button></section>
        {!inspection ? <div className="empty template-empty"><Table2 size={55} strokeWidth={1.4}/><h3>尚未选择官方模板</h3><p>模板的表头、说明、隐藏工作表和验证规则会保留。</p></div> : <>
          <div className="template-file"><FileText size={15}/>{template.name}</div>
          <div className="controls template-controls"><label>数据工作表<select value={sheet} onChange={e => selectSheet(e.target.value)} disabled={busy}>{inspection.sheets.filter(s => !s.hidden).map(s => <option key={s.name}>{s.name}</option>)}</select></label>
            <label>模板表头行<input aria-label="模板表头行" type="number" min="1" max="40" value={headerRow} onChange={e => { const n = e.target.value; setHeaderRow(n); suggest(columnsFor(inspection, sheet, n)); }}/></label>
            <label>数据起始行<input aria-label="数据起始行" type="number" min={Number(headerRow) + 1} value={startRow} onChange={e => { setStartRow(e.target.value); changed(); }}/></label>
          </div>
          <details className="preview"><summary>查看模板原始行 · {selectedSheet?.validations || 0} 条验证规则 · {inspection.sheets.filter(s => s.hidden).length} 张隐藏表</summary><div className="table-wrap"><table><thead><tr><th>行号</th><th>原始内容（前 8 列）</th></tr></thead><tbody>{selectedSheet?.preview.slice(0, 20).map(r => <tr key={r.number}><td>{r.number}</td><td>{r.cells.slice(0, 8).map(c => `${c.column}: ${c.value}`).join(' ｜ ')}</td></tr>)}</tbody></table></div></details>
          {selectedSheet?.hasTables && <div className="message error">此模板含 Excel 表格结构，首版暂不支持导出。</div>}
          <div className="section-heading compact"><div><h3>字段对应</h3><p>自动对应仅供参考。按模板说明确认必填项、校验类型和单位；“SKU 唯一”仅用于子 SKU。</p></div><div className="button-group"><button onClick={() => run(async () => { localStorage.setItem(mappingKey, JSON.stringify(mappings)); setNotice('字段对应已保存在本机浏览器。'); })} disabled={busy || !mappings.length}>保存对应</button><button onClick={() => run(async () => { const saved = localStorage.getItem(mappingKey); if (!saved) throw new Error('未找到相同表头的已保存对应。'); setMappings(JSON.parse(saved)); changed(); setNotice('已读取保存的对应，请重新确认。'); })} disabled={busy}>读取对应</button></div></div>
          <div className="table-wrap"><table className="mapping-table"><thead><tr><th>模板列</th><th>官方字段</th><th>商品来源字段</th><th>必填</th><th>校验类型</th></tr></thead><tbody>{mappings.length ? mappings.map((m, i) => <tr key={m.target}><td>{m.target}</td><td>{m.label}</td><td><select aria-label={`${m.label}来源字段`} value={m.source} onChange={e => changeMapping(i, 'source', e.target.value)}><option value="">不填写</option>{source.columns.map(c => <option key={c.key} value={c.key}>{c.key} · {c.label}</option>)}</select></td><td><input aria-label={`${m.label}必填`} type="checkbox" checked={m.required} onChange={e => changeMapping(i, 'required', e.target.checked)}/></td><td><select aria-label={`${m.label}校验类型`} value={m.type} onChange={e => changeMapping(i, 'type', e.target.value)}><option value="text">原文保留</option><option value="sku">SKU 唯一</option><option value="price">价格数字</option><option value="stock">库存整数</option><option value="url">图片链接</option></select></td></tr>) : <tr><td colSpan="5" className="empty">所选表头行没有字段，请调整行号。</td></tr>}</tbody></table></div>
          <label className="confirm"><input type="checkbox" checked={confirmed} onChange={e => { setConfirmed(e.target.checked); setValidation(null); }}/><span>已核对字段、单位、数据起始行和多规格行结构；按商品表逐行填入。</span></label>
        </>}
      </>}
      {step === 2 && <>
        <section className="section-heading"><div><h2>校验商品数据</h2><p>本地校验检查已选规则；正式上架仍需通过越南卖家中心校验。</p></div><button className="primary" onClick={validate} disabled={busy || !canValidate}><ClipboardCheck size={15}/>运行校验</button></section>
        {!canValidate && <div className="message warning"><AlertCircle size={15}/>请先在模板映射中选择官方模板、对应字段并确认数据区。</div>}
        {validation ? <>
          <div className="stats"><div><span>输入 / 预计导出行数</span><strong>{nf.format(validation.count)} / {nf.format(validation.count)}</strong></div><div><span>通过行数</span><strong className="green">{nf.format(validation.passed)}</strong></div><div><span>异常行 / 问题数</span><strong className={validation.failed ? 'red' : ''}>{validation.failed} / {validation.issues.length}</strong></div><div><span>对应字段</span><strong>{validation.mapped}</strong></div></div>
          {totalEntries.length > 0 && <div className="totals">{totalEntries.map((t, i) => <span key={i}>{t.label}合计：<b>{nf.format(t.sum)}</b>{t.type === 'price' ? ' ₫（请核对原表币种）' : ''}</span>)}</div>}
          <div className="table-wrap"><table><thead><tr><th>原始行号</th><th>字段</th><th>校验问题</th></tr></thead><tbody>{validation.issues.length ? validation.issues.slice(0, 200).map((issue, i) => <tr key={i}><td>{issue.line}</td><td>{issue.field}</td><td className="red">{issue.message}</td></tr>) : <tr><td colSpan="3" className="empty success-empty"><Check size={32}/><h3>本地校验通过</h3><p>导出时还会检查目标单元格是否为空。</p></td></tr>}</tbody></table></div>
          {validation.issues.length > 200 && <p className="muted">仅显示前 200 个问题，请先修正商品表再重新导入。</p>}
        </> : <div className="empty validation-empty"><ClipboardCheck size={55} strokeWidth={1.4}/><h3>等待校验</h3><p>校验后显示实际行数、异常和已选数值字段合计。</p></div>}
        <p className="footnote">导出保持原表逐行对应，不自动合并商品或生成多规格组合。</p>
      </>}
      <footer className="listing-foot"><span>{busy ? '正在处理文件…' : step === 0 ? source ? `${sourceFile.name} · ${source.rows.length} 行` : '未选择商品文件' : step === 1 ? template ? `${sheet} · 从第 ${startRow} 行填入` : '未选择官方模板' : validation ? `${validation.count} 行 · ${validation.failed} 行异常` : '尚未运行校验'}</span><div className="button-group">{step > 0 && <button disabled={busy} onClick={() => setStep(step - 1)}><ChevronLeft size={15}/>上一步</button>}{step < 2 ? <button className={step === 0 && !canMap || step === 1 && !canValidate ? '' : 'primary'} disabled={busy || (step === 0 ? !canMap : !canValidate)} onClick={() => { setStep(step + 1); setError(''); }}>下一步：{step === 0 ? '对应模板' : '校验与导出'}<ChevronRight size={15}/></button> : <button className="primary" disabled={busy || !canValidate || !validation || validation.failed > 0} onClick={download}><Download size={15}/>导出上架 Excel</button>}</div></footer>
    </div>
  </div>;
}
createRoot(document.getElementById('root')).render(<Workbench><App/></Workbench>);
