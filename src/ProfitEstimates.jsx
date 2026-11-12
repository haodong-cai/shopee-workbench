import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, RefreshCw, Search, Calculator } from 'lucide-react';
import { filterProfitOrders, summarizeProfitOrders } from './profit-model.mjs';
import { getJson, pct, ratio, int, marketName, stamp, md, isNum, useJson } from './lib.js';
import { periodLabel } from './window.mjs';
import './profit-estimates.css';

const initial = { fulfillment: 'overseas_warehouse', result: 'all', search: '', excludeReturns: false, scenario: 'A' };
const amount = value => typeof value === 'number' ? new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) : '—';
const STATUSES = { COMPLETED: ['已完成', 'good'], SHIPPED: ['已发货', 'info'], PROCESSED: ['待出库', 'warn'], READY_TO_SHIP: ['待发货', 'warn'], RETRY_SHIP: ['重新发货', 'warn'], TO_CONFIRM_RECEIVE: ['待收货', 'info'], TO_RETURN: ['退货风险', 'bad'] };
const pageSize = 25;

/** 按天累计的毛利走势：订单按创建日归集，最近 7 天随结算更新，更早日期定格。 */
function DailyTrend({ market }) {
  const history = useJson('/api/profit-history');
  const rows = useMemo(() => {
    const byDate = new Map();
    for (const [region, days] of Object.entries(history.data?.days || {})) {
      if (market !== 'all' && region !== market) continue;
      for (const [date, d] of Object.entries(days)) {
        const cur = byDate.get(date) || { date, orders: 0, included: 0, pending: 0, income: 0, profit: 0, ads: 0, adsMissing: false, cross: 0, crossProfit: 0 };
        cur.orders += d.validOrders || 0; cur.included += d.included || 0; cur.pending += d.pending || 0; cur.income += d.incomeCny || 0; cur.profit += d.profitA || 0;
        if (isNum(d.adSpendCny)) cur.ads += d.adSpendCny; else cur.adsMissing = true;
        cur.cross += d.crossIncluded || 0; cur.crossProfit += d.crossPreFreightA || 0; /* 跨境：头程即每双处理费，即完整毛利 */
        byDate.set(date, cur);
      }
    }
    return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 35);
  }, [history.data, market]);
  const max = Math.max(1, ...rows.map(r => Math.abs(r.profit)));
  return <details className="fold pf-method"><summary>每日走势 · 已累计 {rows.length} 天</summary><div className="fold-body">
    {rows.length ? <div className="table-wrap"><table className="tbl pf-trend"><thead><tr><th>订单创建日</th><th className="num">有效单</th><th className="num">海外仓可试算</th><th className="num">试算收入 ¥</th><th className="num">当日广告消耗 ¥</th><th>海外仓预估毛利 ¥（情景 A）</th><th className="num">毛利率</th><th className="num">跨境毛利 ¥</th></tr></thead><tbody>
      {rows.map(r => <tr key={r.date}><td className="date">{r.date}</td><td className="num">{int(r.orders)}</td><td className="num">{int(r.included)}{r.pending > 0 && <small className="warn">待补 {r.pending}</small>}</td><td className="num">{amount(r.income)}</td><td className="num">{r.adsMissing ? '—' : amount(r.ads)}</td>
        <td><div className={`pf-trend-bar ${r.profit < 0 ? 'bad' : ''}`}><i style={{ width: `${Math.abs(r.profit) / max * 100}%` }}/><span className="num">{amount(r.profit)}</span></div></td>
        <td className="num">{pct(ratio(r.profit, r.income))}</td><td className="num">{r.cross ? amount(r.crossProfit) : '—'}</td></tr>)}
    </tbody></table></div> : <p>{history.loading ? '读取中…' : '完成一次同步后开始按天累计。'}</p>}
    <p>订单按站点当地创建日归集；毛利为逐单扣除“已归属广告”后的结果，“当日广告消耗”为店铺当天全部广告花费（含未归属部分），两者口径不同，仅供对照。最近 7 天会随平台结算更新而变化，滚出窗口后定格，汇率按记录当日。</p>
  </div></details>;
}

export default function ProfitEstimates({ market = 'all', fx, live, days = 7 }) {
  const [archive, setArchive] = useState(null), [archiveBusy, setArchiveBusy] = useState(false), [archiveError, setArchiveError] = useState('');
  const [source, setSource] = useState('live');
  const [filters, setFilters] = useState(initial), [page, setPage] = useState(1), [expanded, setExpanded] = useState(null);
  const liveData = live?.data || null, liveMode = liveData?.mode === 'live';
  const showArchive = source === 'archive' && liveMode;
  const data = showArchive ? archive : liveData;
  const isLive = !showArchive && liveMode;
  const working = showArchive ? archiveBusy : !!live?.loading;
  const error = showArchive ? archiveError : live?.error ? '试算数据读取失败，请重新载入。' : '';
  async function loadArchive(fresh = false) {
    setArchiveBusy(true); setArchiveError('');
    try { setArchive(await getJson('/api/profit-estimates?source=archive', { fresh })); }
    catch (failure) { setArchiveError('存档读取失败，请重新载入。'); setArchive(null); }
    finally { setArchiveBusy(false); }
  }
  const load = () => { setPage(1); setExpanded(null); return showArchive ? loadArchive(true) : live?.reload(); };
  useEffect(() => { if (showArchive && !archive && !archiveBusy) loadArchive(); }, [showArchive]);
  useEffect(() => { setPage(1); setExpanded(null); }, [market, source]);
  const regionKnown = market === 'all' || data?.shops?.some(s => s.region === market);
  const region = regionKnown ? market : 'none';
  const query = { ...filters, region };
  const selected = useMemo(() => filterProfitOrders(data?.orders || [], query), [data, filters, region]);
  const summary = summarizeProfitOrders(selected, filters.scenario);
  const shops = (data?.shops || []).filter(shop => region === 'all' || shop.region === region);
  const visible = selected.slice((page - 1) * pageSize, page * pageSize), pages = Math.max(1, Math.ceil(selected.length / pageSize));
  const crossBorder = filters.fulfillment === 'cross_border';
  const field = crossBorder ? (filters.scenario === 'B' ? 'preFreightB' : 'preFreightA') : (filters.scenario === 'B' ? 'profitB' : 'profitA');
  function update(key, value) { setFilters(current => ({ ...current, [key]: value })); setPage(1); setExpanded(null); }
  const shopFor = row => data.shops.find(shop => shop.region === row.region);
  const unattributed = useMemo(() => { const rows = shops.filter(s => s.adUnattributed > 0 && isNum(s.adUnattributedCny)); return { rows, total: rows.reduce((n, s) => n + s.adUnattributedCny, 0) }; }, [data, region]);
  const notes = isLive ? [
    ...shops.filter(s => s.adNote).map(s => `${s.label}：${s.adNote}，该站订单毛利暂为待补。`),
    ...(shops.some(s => s.inferredOrders) ? [`${shops.reduce((n, s) => n + (s.inferredOrders || 0), 0)} 单含未人工核对的部件，鞋 / 配件用途按 SPU 前缀推定。`] : []),
    ...(shops.some(s => s.pendingParts?.length) ? [`待补部件：${[...new Set(shops.flatMap(s => s.pendingParts || []))].slice(0, 6).join('；')}。`] : []),
    ...(data?.rolesError ? [data.rolesError] : [])
  ] : [];
  const margin = ratio(summary.profit, summary.income);

  return <section className="profit" aria-label="毛利试算" aria-busy={working}>
    {error && <div className="hub-message hub-error" role="alert"><AlertTriangle size={16}/>{error}</div>}
    {working && !data && <p role="status" className="muted">正在读取订单、成本与广告分摊…</p>}
    {!working && data && !data.available && <div className="card empty"><Calculator size={40}/><h3>尚无可用试算</h3><p>完成一次订单、扣费与广告同步后，这里会自动显示所选周期的收入、费用及预估毛利。</p><button onClick={() => load()}>重新载入</button></div>}
    {data?.available && !regionKnown && <div className="card empty"><Calculator size={40}/><h3>{marketName(market)}暂未纳入试算</h3><p>{market === 'BR' ? '巴西费用规则尚未提供。' : '该站点没有试算快照。'}切换到“全部”可查看已试算站点。</p></div>}
    {data?.available && regionKnown && <>
      <div className="pf-head">
        <div className="pf-period"><span className="eyebrow">{isLive ? `${periodLabel(days)} · 随同步自动重算` : '历史试算存档'}</span><strong className="num">{data.period.start} — {data.period.end}</strong><p>{isLive ? `站点当地创建时间 · 数据同步于 ${stamp(data.dataAt)}（北京时间）· 按当日参考汇率折算人民币` : `站点当地创建时间 · ${data.sourceDate} 生成 · 全部金额为人民币 CNY`}</p></div>
        <div className="pf-controls">
          {liveMode && <div className="seg" role="group" aria-label="数据来源">
            <button aria-pressed={source === 'live'} onClick={() => setSource('live')} title="每次同步后按最新订单、扣费、广告与成本档案重算；周期在右上角切换">最新数据</button>
            <button aria-pressed={source === 'archive'} onClick={() => setSource('archive')} title="读取 .local/profit-estimates.ndjson 中的固定试算快照（如有）">历史存档</button>
          </div>}
          <div className="seg" role="group" aria-label="履约方式">
            <button aria-pressed={!crossBorder} onClick={() => update('fulfillment', 'overseas_warehouse')}>海外仓 / 本土</button>
            <button aria-pressed={crossBorder} onClick={() => update('fulfillment', 'cross_border')}>跨境</button>
          </div>
          <div className="seg" role="group" aria-label="费用情景">
            <button aria-pressed={filters.scenario === 'A'} onClick={() => update('scenario', 'A')} title="复合项计作费用">情景 A</button>
            <button aria-pressed={filters.scenario === 'B'} onClick={() => update('scenario', 'B')} title="复合项假设为广告划拨并加回">情景 B</button>
          </div>
          <button className="ghost" onClick={() => load()} disabled={working}><RefreshCw size={14} className={working ? 'spin' : ''}/>重新载入</button>
        </div>
      </div>

      <div className="kpis pf-kpis">
        <div className="kpi"><span>当前订单</span><strong>{int(summary.orders)}<small>单</small></strong><p>可试算 {summary.included} · 待补 {summary.pending}</p></div>
        <div className="kpi"><span>试算收入</span><strong>¥{amount(summary.income)}</strong><p>{filters.scenario === 'B' ? '平台净收入 + 假设广告划拨' : '平台预计结算净收入'}</p></div>
        <div className="kpi"><span>已计成本</span><strong>¥{amount(summary.cost)}</strong><p>{crossBorder ? '采购 + 头程（每双处理费）+ 广告' : '采购 + 代打包 + 运输 + 广告'}</p></div>
        <div className="kpi pf-profit"><span>预估毛利 · 情景 {filters.scenario}</span><strong className={summary.profit < 0 ? 'bad' : 'good'}>¥{amount(summary.profit)}</strong><p>毛利率 {pct(margin)} · 亏损 {summary.losses} 单</p></div>
      </div>

      <div className="callout warn pf-caution"><AlertTriangle size={15}/><div>
        {isLive && unattributed.total > 0 && <p><strong>未归属到订单的广告费 ≈ ¥{amount(unattributed.total)} 尚未扣除</strong>（{unattributed.rows.map(s => `${s.label} ${amount(s.adUnattributed)} ${s.currency}，占该站广告 ${pct(ratio(s.adUnattributed, s.adTotal), 0)}`).join('；')}）。来自多商品广告组和店铺层差额（接口无法定位到单个商品），以及近 7 天没有有效订单的商品；全部计入后，当前站点范围的海外仓 + 跨境合计毛利约少 ¥{amount(unattributed.total)}。</p>}
        {isLive && notes.length > 0 && <p>{notes.join(' ')}</p>}
        <p><strong>{crossBorder ? '跨境订单的头程按每双处理费计。' : '广告归属与复合费用仍待核，毛利为阶段性估算。'}</strong>{crossBorder ? `预计净收入已含平台账单内运费；另扣 SKU 采购、头程和已归属广告。` : '未定位商品的广告费尚未扣入订单，毛利可能偏高；情景 B 另假设复合费用全部为广告资金划拨。'}</p>
        {!isLive && <p>未归属广告差额：{shops.map(shop => `${shop.label} ${amount(shop.adGap)} ${shop.currency}`).join(' · ')}</p>}
      </div></div>

      <div className="toolbar pf-toolbar">
        <label className="field grow">订单号 / SKU / 商品名<span className="search"><Search size={14}/><input type="search" placeholder="搜索" value={filters.search} onChange={event => update('search', event.target.value)}/></span></label>
        <label className="field">利润状态<select value={filters.result} onChange={event => update('result', event.target.value)}><option value="all">全部订单</option><option value="ready">可试算</option><option value="loss">预估亏损</option><option value="pending">待补</option></select></label>
        <label className="check"><input type="checkbox" checked={filters.excludeReturns} onChange={event => update('excludeReturns', event.target.checked)}/>排除退货风险</label>
      </div>

      <div className="table-wrap" role="region" aria-label="订单试算表，可横向滚动" tabIndex={0}><table className="tbl pf-table"><caption className="sr-only">订单收入、采购、履约、广告与预估毛利</caption><thead><tr><th scope="col">订单 / SKU</th><th scope="col">站点</th><th scope="col">状态</th><th scope="col" className="num">试算收入</th><th scope="col" className="num">采购</th><th scope="col" className="num">{crossBorder ? '头程' : '打包 / 运输'}</th><th scope="col" className="num">广告</th><th scope="col" className="num">预估毛利</th><th scope="col" className="num">毛利率</th></tr></thead><tbody>
        {visible.map(row => {
          const key = `${row.region}/${row.orderSn}`, shop = shopFor(row), open = expanded === key;
          const income = row.incomeCny === null ? null : filters.scenario === 'B' && row.compoundCny !== null ? Math.round((row.incomeCny + row.compoundCny) * 100) / 100 : filters.scenario === 'B' ? null : row.incomeCny;
          const st = STATUSES[row.status] || [row.status, ''];
          return <React.Fragment key={key}>
            <tr className={open ? 'row-open' : ''}>
              <th scope="row"><button className="pf-order" onClick={() => setExpanded(open ? null : key)} aria-expanded={open} aria-controls={`pf-${key.replace('/', '-')}`}><ChevronDown size={14} className={open ? 'flip' : ''}/><span className="order-id">{row.orderSn}</span></button><div className="skus">{row.lines.length ? row.lines.map((line, index) => <span className="sku" key={`${line.sku}-${index}`} title={line.name}>{line.sku || 'SKU 待补'} × {line.quantity}</span>) : <span className="sku">SKU 待补</span>}</div></th>
              <td><span className={`mk mk-${row.region.toLowerCase()}`}>{row.region}</span></td>
              <td><span className={`tag ${st[1]}`}>{st[0]}</span></td>
              <td className="num">{amount(income)}</td><td className="num">{amount(row.goodsCny)}</td>
              <td className="num">{crossBorder ? amount(row.packingCny) : `${amount(row.packingCny)} / ${amount(row.transportCny)}`}</td>
              <td className="num">{amount(row.adsCny)}</td>
              <td className={`num strong ${row[field] < 0 ? 'bad' : ''}`}>{row[field] == null ? <span className="tag warn plain">待补</span> : amount(row[field])}</td>
              <td className="num">{row[field] == null || !income ? '—' : <span className={`pf-margin ${row[field] < 0 ? 'bad' : row[field] / income < .1 ? 'warn' : 'good'}`}>{pct(row[field] / income, 0)}</span>}</td>
            </tr>
            {open && <tr className="detail" id={`pf-${key.replace('/', '-')}`}><td colSpan={9}><div className="pf-detail">
              <div className="pf-detail-top">
                <div className="pf-equation">
                  <h3>费用拆解</h3>
                  <dl>
                    <div><dt>平台预计净收入</dt><dd className="num">{amount(row.incomeCny)}</dd></div>
                    <div><dt>复合费用假设加回</dt><dd className="num">{filters.scenario === 'A' ? '0.00' : `+ ${amount(row.compoundCny)}`}</dd></div>
                    <div><dt>采购成本</dt><dd className="num">− {amount(row.goodsCny)}</dd></div>
                    <div><dt>{crossBorder ? '头程（每双处理费）' : '代打包'}</dt><dd className="num">− {amount(row.packingCny)}</dd></div>
                    {!crossBorder && <div><dt>按双运输</dt><dd className="num">− {amount(row.transportCny)}</dd></div>}
                    <div><dt>广告分摊</dt><dd className="num">− {amount(row.adsCny)}</dd></div>
                    <div className="total"><dt>预估毛利</dt><dd className={`num ${row[field] < 0 ? 'bad' : ''}`}>{amount(row[field])}</dd></div>
                  </dl>
                </div>
                <div className="pf-facts">
                  <h3>订单信息</h3>
                  <p>{shop.label} · {shop.name}</p>
                  <p>原币收入 <b className="num">{amount(row.sourceNet)} {row.sourceCurrency}</b> · {row.shoePairs === null ? '双数待核' : `${row.shoePairs} 双鞋`}</p>
                  {row.platformFees && <p>平台已扣（{row.sourceCurrency}）：佣金 {amount(row.platformFees.commission)} · 服务费 {amount(row.platformFees.service)} · 手续费 {amount(row.platformFees.transaction)} · 复合项 {amount(row.platformFees.compound)}</p>}
                  <p>广告分摊 {amount(row.adsSource)} {row.sourceCurrency}，同订单同商品多规格只占一份。{crossBorder ? (isNum(shop.crossBorderPerPair) ? `跨境处理费 ${shop.crossBorderPerPair} 元/双。` : '跨境每双处理费未设置。') : row.shoePairs === 0 ? '纯配件发货费用规则待补。' : `代打包 ${shop.packingPerOrder} 元/单，运输 ${shop.transportPerPair} 元/双。`}</p>
                  {row.missing.filter(item => !/账单外跨境运费/.test(item)).length > 0 && <p className="warn">待补：{row.missing.filter(item => !/账单外跨境运费/.test(item)).map(item => item === '包材费用' ? '代打包费用' : item === '平台未扣除的履约费用' ? '运输费用' : item).join('；')}</p>}
                </div>
              </div>
              {row.links.length > 0 && <div className="table-wrap"><table className="tbl"><caption className="pf-cap">商品链接毛利 · {row.links.length > 1 ? '多链接订单按商品成交额比例拆分到手金额与处理费' : '单链接订单承接整单到手金额'}</caption><thead><tr><th>商品链接</th><th className="num">预估到手</th><th className="num">SKU 成本</th><th className="num">处理费</th><th className="num">运费</th><th className="num">广告</th><th className="num">毛利</th></tr></thead><tbody>{row.links.map(link => {
                const linkIncome = filters.scenario === 'B' ? link.incomeCny !== null && link.compoundCny !== null ? Math.round((link.incomeCny + link.compoundCny) * 100) / 100 : null : link.incomeCny;
                return <tr key={link.itemId}><td className="pf-link-name">{link.name || `商品 ${link.itemId}`}<small className="mono">ID {link.itemId} · {link.quantity} 件 · {link.shoePairs == null ? '双数待核' : `${link.shoePairs} 双`} · {link.skus.join('、') || 'SKU 待补'}</small></td><td className="num">{amount(linkIncome)}</td><td className="num">{amount(link.goodsCny)}</td><td className="num">{amount(link.packingCny)}</td><td className="num">{amount(link.transportCny)}</td><td className="num">{amount(link.adsCny)}</td><td className={`num strong ${link[field] < 0 ? 'bad' : ''}`}>{link[field] == null ? '待补' : amount(link[field])}</td></tr>;
              })}</tbody></table></div>}
              <div className="table-wrap"><table className="tbl"><caption className="pf-cap">SKU 采购成本</caption><thead><tr><th>SKU / 组合部件</th><th className="num">数量</th><th className="num">单位成本</th><th className="num">行成本</th></tr></thead><tbody>{row.lines.map((line, index) => <tr key={`${line.sku}-${index}`}><td><span className="mono">{line.sku || 'SKU 待补'}</span>{line.components.length > 1 && <small className="mono">{line.components.map(part => `${part.sku} × ${part.quantity}`).join(' + ')}</small>}</td><td className="num">{line.quantity}</td><td className="num">{amount(line.unitCostCny)}</td><td className="num">{amount(line.unitCostCny === null ? null : Math.round(line.unitCostCny * line.quantity * 100) / 100)}</td></tr>)}</tbody></table></div>
            </div></td></tr>}
          </React.Fragment>;
        })}
        {!selected.length && <tr><td colSpan={9}><div className="empty"><h3>没有符合筛选条件的订单</h3><p>可更换站点、利润状态或搜索内容。</p><button onClick={() => { setFilters(initial); setPage(1); }}>清除筛选</button></div></td></tr>}
      </tbody></table></div>
      <div className="pager"><span role="status">{selected.length ? `第 ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, selected.length)} 条，共 ${selected.length} 条` : '共 0 条'} · 第 {page} / {pages} 页</span><div><button className="sm" aria-label="上一页订单" disabled={page === 1} onClick={() => { setPage(page - 1); setExpanded(null); }}><ChevronLeft size={14}/>上一页</button><button className="sm" aria-label="下一页订单" disabled={page >= pages} onClick={() => { setPage(page + 1); setExpanded(null); }}>下一页<ChevronRight size={14}/></button></div></div>

      <details className="fold pf-method"><summary>计算口径与汇率来源</summary><div className="fold-body">
        <p>{crossBorder ? '跨境预估毛利 = 平台预计净收入 + 情景假设加回 − 采购 − 头程（每双处理费，鞋类计双、配件不计）− 已定位商品广告分摊；平台账单内运费已含在预计净收入里，没有另外的账单外运费。' : '预估毛利 = 平台预计净收入 + 情景假设加回 − 采购 − 代打包 − 运输 − 已定位商品广告分摊。'}平台净收入已包含平台费用和补贴，佣金、服务费及手续费不重复扣除。</p>
        <p>情景 A 将“广告资金划拨 / 技术支持费”复合项视为费用；情景 B 假设全部属于广告资金划拨而加回。该项性质尚待核对。头程、仓储、退货等未提供的费用未计入，结果为阶段性估算。</p>
        <p>商品实际广告费在同商品的全店有效订单中均摊，海外仓、跨境各承担对应份额；无有效订单商品的广告费留在店铺层面，未计入订单毛利。</p>
        <ul>{shops.map(shop => <li key={shop.region}><strong>{shop.label}</strong>：{isNum(shop.fxRate) ? <>1 {shop.currency} ≈ {shop.fxRate.toPrecision(8)} CNY；{shop.fxSource ? <a href={shop.fxSource} target="_blank" rel="noreferrer">{shop.fxLabel} · {shop.fxDate}</a> : `${shop.fxLabel} · ${shop.fxDate || '日期待核'}`}。</> : '汇率尚未取得，人民币金额待补。'}无有效订单商品消耗：{amount(shop.noOrderAd)} {shop.currency}。{isLive ? <span className="muted"> 订单 {md(shop.period?.start)}–{md(shop.period?.end)}，同步于 {stamp(shop.dataAt)}；海外仓 {shop.overseas} 单（待补 {shop.incomplete}）· 跨境 {shop.crossBorder} 单{shop.unknownFulfillment ? ` · 履约方式待核 ${shop.unknownFulfillment} 单未纳入` : ''}。</span> : (() => { const today = fx?.data?.rates?.[shop.currency]; return today?.cnyPerUnit && isNum(shop.fxRate) ? <span className="muted"> 今日（{today.date}）≈ {today.cnyPerUnit.toPrecision(8)}，较试算 {pct(today.cnyPerUnit / shop.fxRate - 1, 2)}。</span> : null; })()}</li>)}</ul>
        {isLive ? <p>{periodLabel(days)}的数据每次同步后自动重算（周期在右上角切换）：订单与平台结算净收入取自最近一次同步，采购成本取自成本档案{data.costCatalogDate ? `（${data.costCatalogDate}）` : ''}，人民币按当日参考汇率折算（汇率更新后金额会小幅变动）。鞋 / 配件用途已人工核对 {data.rolesReviewed ?? 0} 个 SPU，未核对的按 config/business.json 中设置的 SPU 前缀推定，无法判断的保持待补。公开汇率仅用于估算，非实际结汇价。取消、取消中及未付款订单已排除。{(data.excluded || []).map(x => `${marketName(x.region)}：${x.reason}，未纳入。`).join('')}</p>
          : <p>试算固定使用统计期间的汇率，便于与报告核对，不随每日汇率变动；概览页的人民币折算使用每日更新的汇率。公开汇率仅用于估算，非实际结汇价。取消、取消中及未付款订单已排除。巴西费用规则待提供，尚未纳入。</p>}
      </div></details>
      {isLive && <DailyTrend market={market}/>}
    </>}
  </section>;
}
