import React, { useMemo, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, ChevronDown, PackageX, Search, Truck, Upload, Megaphone } from 'lucide-react';
import { MARKETS, marketName, stamp, ago, int, pct, isNum, money } from './lib.js';
import './inventory.css';

const STATE = { out: ['已断货', 'bad'], gap: ['到货前断货', 'bad'], late: ['补货来不及', 'bad'], tight: ['紧张', 'warn'], reorder: ['该补货了', 'info'], norecord: ['仓库表无此 SKU', 'warn'], ok: ['正常', 'good'] };
const ACTION = { pause: ['暂停广告', 'bad'], reduce: ['降低预算', 'warn'], watch: ['留意个别规格', 'info'], ok: ['无需调整', 'good'], check: ['先核对库存', 'warn'] };
const PAGE = 30;
const dayText = iso => iso ? stamp(iso).split(' ')[0] : '—';
const num1 = n => isNum(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) : '—';
const daysText = n => !isNum(n) ? '—' : n >= 365 ? '1 年以上' : `${num1(n)} 天`;

function Sources({ inv }) {
  const data = inv.data, input = useRef(null);
  const [busy, setBusy] = useState(false), [messages, setMessages] = useState([]), [draft, setDraft] = useState(null);
  const settings = draft || data.settings;
  async function upload(files) {
    setBusy(true); const out = [];
    for (const file of files) {
      const body = new FormData(); body.append('file', file);
      try {
        const response = await fetch('/api/inventory/import', { method: 'POST', body }), result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `导入失败（${response.status}）`);
        out.push({ ok: true, text: result.kind === 'stock' ? `在库表已导入：${int(result.stats.skus)} 个 SKU、${int(result.stats.units)} 件` : `在途表已导入：${result.stats.orders} 张入库单、${int(result.stats.units)} 件`, skipped: result.skipped });
      } catch (e) { out.push({ ok: false, text: `${file.name}：${e.message}` }); }
    }
    setMessages(out); setBusy(false); inv.reload();
  }
  async function save() {
    setBusy(true);
    try {
      const response = await fetch('/api/inventory/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) }), result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || '保存失败');
      setDraft(null); setMessages([{ ok: true, text: '头程与安全天数已保存，预警已按新设置重算。' }]); inv.reload();
    } catch (e) { setMessages([{ ok: false, text: e.message }]); } finally { setBusy(false); }
  }
  const setLead = (site, value) => setDraft({ ...settings, leadDays: { ...settings.leadDays, [site]: value === '' ? '' : Number(value) } });
  const valid = draft && data.sites.every(site => Number.isInteger(draft.leadDays[site]) && draft.leadDays[site] >= 1 && draft.leadDays[site] <= 120) && Number.isInteger(draft.safetyDays) && draft.safetyDays >= 0 && draft.safetyDays <= 30;
  return <section className="inv-sources card">
    <div className="inv-source">
      <span className="eyebrow">在库表</span>
      {data.stock ? <><strong>{int(data.stock.stats.skus)} 个 SKU · {int(data.stock.stats.units)} 件</strong>
        <p title={data.stock.fileName}>{data.stock.fileName} · {ago(data.stock.importedAt)}导入</p>
        <p className="inv-sites">{data.sites.filter(site => data.stock.stats.bySite[site]).map(site => <span key={site}><i className={`mk mk-${site.toLowerCase()}`}>{site}</i>{int(data.stock.stats.bySite[site].units)}</span>)}</p></>
        : <><strong>尚未导入</strong><p>仓库系统导出的“SKU / 可用库存 / 仓库”表</p></>}
    </div>
    <div className="inv-source">
      <span className="eyebrow">在途表</span>
      {data.transit ? <><strong>{data.transit.stats.orders} 张入库单 · {int(data.transit.stats.units)} 件</strong><p title={data.transit.fileName}>{data.transit.fileName} · {ago(data.transit.importedAt)}导入</p><p>到仓日 = 入库单创建时间 + 该站头程天数</p></>
        : <><strong>尚未导入</strong><p>“入库单号 / 仓库 / 创建时间 / SKU / 预约数量”表；没有在途可不导入</p></>}
    </div>
    <div className="inv-settings">
      <span className="eyebrow">头程天数 · 安全天数</span>
      <div className="inv-days">
        {data.sites.map(site => <label key={site}><i className={`mk mk-${site.toLowerCase()}`}>{site}</i><input type="number" min="1" max="120" value={settings.leadDays[site] ?? ''} onChange={e => setLead(site, e.target.value)} aria-label={`${marketName(site)}头程天数`}/></label>)}
        <label><span>安全</span><input type="number" min="0" max="30" value={settings.safetyDays} onChange={e => setDraft({ ...settings, safetyDays: e.target.value === '' ? '' : Number(e.target.value) })} aria-label="安全天数"/></label>
      </div>
      <div className="inv-actions">
        <input ref={input} type="file" accept=".xlsx,.csv" multiple hidden onChange={e => { const files = [...e.target.files]; e.target.value = ''; if (files.length) upload(files); }}/>
        <button className="primary" onClick={() => input.current.click()} disabled={busy}><Upload size={14}/>{busy ? '处理中' : '导入在库 / 在途表'}</button>
        {draft && <button onClick={save} disabled={busy || !valid}>保存天数</button>}
        {draft && <button className="ghost" onClick={() => setDraft(null)} disabled={busy}>取消</button>}
      </div>
    </div>
    {messages.length > 0 && <div className="inv-messages">{messages.map((m, i) => <div key={i} className={`hub-message ${m.ok ? 'hub-success' : 'hub-error'}`}>{m.ok ? null : <AlertCircle size={15}/>}<span>{m.text}{m.skipped?.count > 0 && `；跳过 ${m.skipped.count} 行（${m.skipped.rows.slice(0, 3).map(r => `第 ${r.line} 行 ${r.reason}`).join('；')}${m.skipped.count > 3 ? ' 等' : ''}）`}</span></div>)}</div>}
  </section>;
}

function Listings({ rows }) {
  const [open, setOpen] = useState(null), [onlyAds, setOnlyAds] = useState(false);
  const shown = rows.filter(l => !onlyAds || l.ads?.total > 0);
  if (!rows.length) return <div className="card empty"><Megaphone size={36}/><h3>没有需要调整广告的链接</h3><p>当前范围内，各链接的在售规格都能撑到下一批到货。</p></div>;
  return <>
    <div className="toolbar inv-bar"><label className="check"><input type="checkbox" checked={onlyAds} onChange={e => setOnlyAds(e.target.checked)}/>只看在投广告的链接</label><span className="muted">共 {shown.length} 个链接 · 广告为近 7 天消耗（原币）</span></div>
    <div className="table-wrap"><table className="tbl inv-table"><thead><tr><th>商品链接</th><th>站点</th><th className="num">7 天销量</th><th>受影响销量</th><th className="num">需压低销量</th><th>最早断货</th><th className="num">7 天广告</th><th>建议</th></tr></thead><tbody>
      {shown.map(l => { const key = `${l.shopId}:${l.itemId}`, isOpen = open === key, [text, tone] = ACTION[l.action];
        return <React.Fragment key={key}>
          <tr className={isOpen ? 'row-open' : ''}>
            <td className="inv-name"><button className="pf-order" onClick={() => setOpen(isOpen ? null : key)} aria-expanded={isOpen}><ChevronDown size={14} className={isOpen ? 'flip' : ''}/><strong title={l.name}>{l.name || `商品 ${l.itemId}`}</strong></button><small className="mono">ID {l.itemId} · {l.variantCount} 个在售规格</small></td>
            <td><span className={`mk mk-${l.site.toLowerCase()}`}>{l.site}</span></td>
            <td className="num">{int(l.units)}<small>{l.orders} 单</small></td>
            <td><div className="inv-share"><i style={{ width: `${Math.round(l.riskShare * 100)}%` }}/><span className="num">{pct(l.riskShare, 0)}</span></div>{l.outUnits > 0 && <small className="bad">其中 {l.outUnits} 件来自已断货规格</small>}{l.unknownUnits > 0 && <small className="warn">{l.unknownUnits} 件的规格仓库表无记录</small>}</td>
            <td className={`num strong ${l.cutPct >= .5 ? 'bad' : ''}`}>{l.cutPct > 0 ? pct(l.cutPct, 0) : '—'}</td>
            <td className="date">{dayText(l.earliestOutAt)}</td>
            <td className="num">{!l.ads ? <span className="muted">广告待同步</span> : l.ads.total > 0 ? <>{money(l.ads.total, l.currency)}<small>{[l.ads.gms > 0 ? 'GMV Max' : '', l.ads.manual.length ? `手动 ${l.ads.manual.length} 个` : ''].filter(Boolean).join(' · ')}</small></> : <span className="muted">未投广告</span>}</td>
            <td><span className={`tag ${tone}`}>{l.cutPct > 0 ? text : '先核对库存'}</span></td>
          </tr>
          {isOpen && <tr className="detail"><td colSpan={8}><div className="inv-detail">
            <p className="inv-how">{l.action === 'pause' ? '这个链接大部分销量来自撑不到下一批到货的规格，继续投广告只会更快卖断。' : l.action === 'reduce' ? '部分规格撑不到下一批到货，建议把预算或出价调低，放慢出单。' : l.cutPct > 0 ? '只有个别规格吃紧，广告可以照投，留意这些规格即可。' : '这些规格在仓库表里查不到库存记录，先核对。'}
              {l.ads?.total > 0 && <> 在卖家中心操作：{l.ads.gms > 0 && <>把商品 <b className="mono">{l.itemId}</b> 从全店托管 GMV Max{l.ads.gmsCampaignId ? <>（计划 <b className="mono">{l.ads.gmsCampaignId}</b>）</> : ''}中移出{l.ads.manual.length ? '；' : '。'}</>}{l.ads.manual.length > 0 && <>暂停手动计划 {l.ads.manual.map(p => <b className="mono" key={p.campaignId}>{p.campaignId} </b>)}。</>}</>}</p>
            <div className="table-wrap"><table className="tbl"><thead><tr><th>规格 SKU</th><th className="num">7 天销量</th><th>状态</th><th className="num">可卖天数</th><th>预计断货</th><th>下一批到仓</th><th>卡在哪个单品</th></tr></thead><tbody>
              {l.variants.map(v => { const [st, tn] = STATE[v.state] || [v.state, '']; return <tr key={v.sku}><td><span className="mono">{v.sku || 'SKU 待补'}</span></td><td className="num">{v.units}</td><td><span className={`tag ${tn}`}>{st}</span></td><td className="num">{daysText(v.coverDays)}</td><td className="date">{v.state === 'out' ? '已断' : dayText(v.outAt)}</td><td className="date">{v.nextEta ? dayText(v.nextEta) : <span className="muted">无在途</span>}</td><td><span className="mono">{v.limiting && v.limiting !== v.sku ? v.limiting : '—'}</span></td></tr>; })}
            </tbody></table></div>
          </div></td></tr>}
        </React.Fragment>; })}
    </tbody></table></div>
    <p className="note inv-note">“需压低销量”= 要让现有库存撑到最吃紧的那批到货并留出安全天数，日销至少要降的比例，按各规格销量加权。≥ 50% 建议暂停广告，20%–50% 建议降低预算，更低只需留意个别规格。暂停广告不等于停止出单，自然流量仍会消耗库存。</p>
  </>;
}

function Skus({ rows }) {
  const [filter, setFilter] = useState('risk'), [query, setQuery] = useState(''), [page, setPage] = useState(0);
  const counts = useMemo(() => Object.fromEntries(Object.keys(STATE).map(k => [k, rows.filter(r => r.state === k).length])), [rows]);
  const q = query.trim().toLowerCase();
  const shown = rows.filter(r => (filter === 'all' || (filter === 'risk' ? r.state !== 'ok' : r.state === filter)) && (!q || r.sku.toLowerCase().includes(q) || r.listings.some(l => String(l.itemId).includes(q) || (l.name || '').toLowerCase().includes(q))));
  const pages = Math.max(1, Math.ceil(shown.length / PAGE)), cur = Math.min(page, pages - 1);
  const tabs = [['risk', `需关注 ${rows.length - counts.ok}`], ...['out', 'gap', 'late', 'tight', 'reorder', 'norecord'].filter(k => counts[k]).map(k => [k, `${STATE[k][0]} ${counts[k]}`]), ['all', `全部 ${rows.length}`]];
  return <>
    <div className="toolbar inv-bar">
      <div className="seg" role="group" aria-label="状态筛选">{tabs.map(([k, l]) => <button key={k} aria-pressed={filter === k} onClick={() => { setFilter(k); setPage(0); }}>{l}</button>)}</div>
      <label className="search grow"><Search size={14}/><input type="search" placeholder="单品 SKU / 商品名 / 商品 ID" value={query} onChange={e => { setQuery(e.target.value); setPage(0); }}/></label>
    </div>
    {shown.length ? <div className="table-wrap"><table className="tbl inv-table"><thead><tr><th>单品 SKU</th><th>站点</th><th className="num">在库</th><th className="num">日均销量</th><th className="num">可卖天数</th><th>在途</th><th>预计断货</th><th className="num">断货缺口</th><th>状态</th><th>怎么办</th></tr></thead><tbody>
      {shown.slice(cur * PAGE, cur * PAGE + PAGE).map(r => { const [st, tn] = STATE[r.state]; const overdue = r.transit.find(t => t.overdueDays >= 1);
        return <tr key={`${r.site}/${r.sku}`}>
          <td className="inv-name"><strong className="mono">{r.sku}</strong><small title={r.listings.map(l => l.name).join('\n')}>{r.listings.length ? `${r.listings[0].name?.slice(0, 34) || `商品 ${r.listings[0].itemId}`}${r.listings.length > 1 ? ` 等 ${r.listings.length} 个链接` : ''}` : ''}</small></td>
          <td><span className={`mk mk-${r.site.toLowerCase()}`}>{r.site}</span></td>
          <td className="num strong">{r.hasRecord ? int(r.onHand) : '—'}{r.hasRecord && r.estimate !== null && Math.round(r.estimate) !== r.onHand && <small title="导入后按日均销量推算的当前库存">现约 {num1(r.estimate)}</small>}{r.warehouses.length > 1 && <small>{r.warehouses.map(w => `${w.warehouse} ${w.qty}`).join(' · ')}</small>}</td>
          <td className="num">{num1(r.rate)}<small>7 天 {r.units} 件</small></td>
          <td className={`num strong ${['out', 'gap', 'late'].includes(r.state) ? 'bad' : ''}`}>{daysText(r.coverDays)}</td>
          <td>{r.transitQty > 0 ? <>{int(r.transitQty)} 件 · {dayText(r.nextEta)} 到{overdue && <small className="warn">已超预计 {Math.floor(overdue.overdueDays)} 天，按随时到仓算</small>}</> : <span className="muted">无在途</span>}</td>
          <td className="date">{r.state === 'out' ? '已断' : r.state === 'norecord' ? '—' : isNum(r.coverDays) && r.coverDays > 180 ? '半年后' : dayText(r.outAt)}</td>
          <td className="num">{r.gapDays > 0 ? <span className="bad strong">{num1(r.gapDays)} 天</span> : '—'}</td>
          <td><span className={`tag ${tn}`}>{st}</span></td>
          <td className="inv-todo">{r.state === 'norecord' ? '核对仓库表是否漏了这个 SKU' : r.state === 'ok' ? '—' : r.state === 'reorder' ? '安排补货' : overdue && r.state === 'out' ? '在途已过预计到仓日，先核对是否已上架；未到则关掉相关广告' : <>{r.state === 'out' ? '关掉相关广告' : `日销压到 ${num1(r.targetRate)} 以内（降 ${pct(r.cutPct, 0)}）`}{r.transitQty > 0 ? '' : '，并尽快补货'}</>}</td>
        </tr>; })}
    </tbody></table></div> : <div className="card empty"><PackageX size={36}/><h3>没有符合条件的单品</h3><p>可切换筛选或站点。</p></div>}
    <div className="pager"><span>共 {shown.length} 个单品 · 第 {cur + 1}/{pages} 页</span><div><button className="sm" disabled={cur === 0} onClick={() => setPage(cur - 1)}>上一页</button><button className="sm" disabled={cur + 1 >= pages} onClick={() => setPage(cur + 1)}>下一页</button></div></div>
  </>;
}

function Transit({ orders }) {
  if (!orders.length) return <div className="card empty"><Truck size={36}/><h3>没有在途入库单</h3><p>导入在途表后，这里按预计到仓日列出每张入库单。</p></div>;
  return <div className="table-wrap"><table className="tbl inv-table"><thead><tr><th>入库单号</th><th>仓库</th><th>创建时间</th><th className="num">头程</th><th>预计到仓</th><th className="num">SKU 数</th><th className="num">件数</th><th>状态</th></tr></thead><tbody>
    {orders.map(o => <tr key={o.no}><td><span className="mono">{o.no}</span></td><td><span className={`mk mk-${o.site.toLowerCase()}`}>{o.site}</span> {o.warehouse}</td><td className="date">{stamp(o.createdAt)}</td><td className="num">{o.leadDays} 天</td><td className="date strong">{dayText(o.eta)}</td><td className="num">{int(o.skuCount)}</td><td className="num">{int(o.units)}</td>
      <td>{o.overdueDays >= 1 ? <><span className="tag warn">已超预计 {Math.floor(o.overdueDays)} 天</span><small>到仓上架后请重新导入在库 / 在途表</small></> : <span className="tag info">在途</span>}</td></tr>)}
  </tbody></table></div>;
}

export default function Inventory({ inv, market, sub, go }) {
  const data = inv.data, forecast = data?.forecast;
  const view = ['skus', 'transit'].includes(sub) ? sub : 'ads';
  const inScope = row => market === 'all' || row.site === market;
  const rows = useMemo(() => (forecast?.rows || []).filter(inScope), [forecast, market]);
  const listings = useMemo(() => (forecast?.listings || []).filter(inScope), [forecast, market]);
  const orders = useMemo(() => (forecast?.transitOrders || []).filter(inScope), [forecast, market]);
  if (!data && inv.loading) return <p className="muted" role="status">正在读取库存预警…</p>;
  if (!data || data.available === false) return <div className="card empty"><PackageX size={40}/><h3>断货预警尚未启用</h3><p>{inv.error ? '本机服务还是旧版本，重新双击“启动工作台”后可用。' : '读取失败，请稍后重试。'}</p></div>;
  const count = state => rows.filter(r => r.state === state).length;
  const pauseAds = listings.filter(l => l.action === 'pause' && l.ads?.total > 0).length;
  const period = forecast?.sites?.find(s => market === 'all' || s.site === market)?.period;
  return <section className="inv">
    <Sources inv={inv}/>
    {!forecast?.available ? <div className="card empty"><PackageX size={40}/><h3>{forecast?.reason || '暂无预测'}</h3><p>点击上方“导入在库 / 在途表”，选择仓库系统导出的表格（可一次选两个，自动识别）。</p></div>
      : market !== 'all' && !data.sites.includes(market) ? <div className="card empty"><PackageX size={40}/><h3>{marketName(market)}没有海外仓库存数据</h3><p>断货预警覆盖 {data.sites.map(s => MARKETS[s]?.short || s).join('、')}。</p></div>
      : <>
        {forecast.notes.map((text, i) => <div className="callout warn" key={i}><AlertTriangle size={15}/><p>{text}</p></div>)}
        <div className="kpis inv-kpis">
          <div className="kpi"><span>已断货</span><strong className={count('out') ? 'bad' : ''}>{count('out')}</strong><p>有销量但在库为 0 的单品</p></div>
          <div className="kpi"><span>到货前断货</span><strong className={count('gap') ? 'bad' : ''}>{count('gap')}</strong><p>在途到仓前就会卖完</p></div>
          <div className="kpi"><span>补货来不及</span><strong className={count('late') ? 'bad' : ''}>{count('late')}</strong><p>没有在途，今天发货也接不上</p></div>
          <div className="kpi"><span>紧张 / 该补货</span><strong className={count('tight') ? 'warn' : ''}>{count('tight')}<small> / {count('reorder')}</small></strong><p>余量不足安全天数 / 该安排下一批</p></div>
          <div className="kpi"><span>建议暂停广告</span><strong className={pauseAds ? 'bad' : ''}>{pauseAds}<small> 个在投链接</small></strong><p>另有 {listings.filter(l => l.action === 'reduce').length} 个建议降预算</p></div>
        </div>
        <div className="inv-tabs">
          <div className="tabs" role="tablist">
            {[['ads', `广告建议 ${listings.length}`], ['skus', `单品库存 ${rows.filter(r => r.state !== 'ok').length}`], ['transit', `在途入库单 ${orders.length}`]].map(([k, l]) => <button key={k} role="tab" aria-selected={view === k} onClick={() => go(k === 'ads' ? 'inventory' : `inventory/${k}`)}>{l}</button>)}
          </div>
          <span className="muted">销量取 {period ? `${period.start.slice(5).replace('-', '/')}–${period.end.slice(5).replace('-', '/')}` : '近 7 天'} 海外仓有效订单，组合装已拆成单品；跨境单不计。</span>
        </div>
        {view === 'ads' && <Listings rows={listings}/>}
        {view === 'skus' && <Skus rows={rows}/>}
        {view === 'transit' && <Transit orders={orders}/>}
        <details className="fold inv-method"><summary>预警是怎么算的</summary><div className="fold-body">
          <p><strong>日均销量</strong> = 近 7 个完整自然日里，从海外仓发货的有效订单销量 ÷ 7。组合装按货品档案拆成鞋和配件分别计；跨境订单从国内发货，不消耗海外仓库存，不计入。{data.catalogDate ? `货品档案日期 ${data.catalogDate}。` : ''}</p>
          <p><strong>在库</strong>取导入的仓库表“可用库存”，同站多个仓合并；导入之后按日均销量逐日扣减，所以表越旧越不准，建议至少每 2–3 天导入一次。<strong>在途</strong>的到仓日 = 入库单创建时间 + 该站头程天数；超过预计日仍在在途表里的，按“随时到仓”计算并提示核对。</p>
          <p><strong>状态</strong>：已断货（在库 0 仍有销量）；到货前断货（在途到仓前卖完，给出缺口天数）；补货来不及（没有在途，可卖天数短于头程）；紧张（能接上但余量不足 {data.settings.safetyDays} 天安全天数）；该补货了（接下来 {data.thresholds.reorderBufferDays} 天内不发货就会接不上）。</p>
          <p><strong>广告建议</strong>：广告是按商品链接投的，所以把链接下各规格“需要压低的销量比例”按销量加权。≥ {pct(data.thresholds.pause, 0)} 建议暂停，≥ {pct(data.thresholds.reduce, 0)} 建议降预算。销量很小的单品（一周只卖 1–2 件）波动大，结论仅供参考。当前只给出建议和计划编号，需要到卖家中心手动操作。</p>
          <p>仓库表里有库存、但近 7 天没有海外仓销量的单品共 {int(forecast.summary.idleSkus)} 个，没有断货风险，未列出。</p>
        </div></details>
      </>}
  </section>;
}
