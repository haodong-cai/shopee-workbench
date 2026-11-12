import React, { useMemo, useState } from 'react';
import { AlertTriangle, AlertCircle, Info, CheckCircle2, ArrowRight, ArrowUpRight, FileSpreadsheet, Database, Calculator } from 'lucide-react';
import { MARKETS, marketName, shopDigest, money, compact, int, pct, ratio, md, ago, isStale, isNum, stamp } from './lib.js';
import { filterProfitOrders, summarizeProfitOrders } from './profit-model.mjs';
import { shipSummary } from './OrderInsights.jsx';
import { returnRows } from './returns-model.mjs';
import { scopeShop, periodLabel } from './window.mjs';
import './overview.css';

const TONE_ICON = { bad: AlertCircle, warn: AlertTriangle, info: Info };
const TONE_RANK = { bad: 0, warn: 1, info: 2 };
const BLOCK = { orders: '订单', fees: '平台扣费', ads: '广告数据', returns: '退货' };

function buildAlerts(shops, adShops, profit, inventory, fullOf = shop => shop) {
  const out = [];
  if (inventory?.available) {
    for (const shop of shops) {
      const rows = inventory.rows.filter(r => r.site === shop.region), region = shop.region;
      const gone = rows.filter(r => r.state === 'out').length, soon = rows.filter(r => r.state === 'gap' || r.state === 'late').length;
      const pause = inventory.listings.filter(l => l.site === region && l.action === 'pause' && l.ads?.total > 0);
      if (pause.length) out.push({ region, page: 'inventory', tone: 'bad', title: `${pause.length} 个在投广告的链接建议暂停广告`, detail: `库存撑不到下一批到货：${pause.slice(0, 2).map(l => (l.name || `商品 ${l.itemId}`).slice(0, 18)).join('、')}${pause.length > 2 ? ' 等' : ''}` });
      if (gone + soon) out.push({ region, page: 'inventory/skus', tone: soon ? 'warn' : 'info', title: `${soon ? `${soon} 个单品到货前会断货` : ''}${soon && gone ? '，' : ''}${gone ? `${gone} 个已断货` : ''}`, detail: '按海外仓在库、在途与近 7 天销量推算，可提前降速或补货' });
    }
    for (const order of inventory.transitOrders) if (order.overdueDays >= 1 && shops.some(s => s.region === order.site)) out.push({ region: order.site, page: 'inventory/transit', tone: 'info', title: `在途入库单已超预计到仓 ${Math.floor(order.overdueDays)} 天`, detail: `${order.warehouse} · ${order.units} 件；到仓上架后请重新导入在库 / 在途表` });
    if (inventory.stockAgeDays >= 3) out.push({ region: '', page: 'inventory', tone: 'info', title: `海外仓在库表已 ${Math.floor(inventory.stockAgeDays)} 天没更新`, detail: '断货预警按销量推算当前库存，建议重新导入仓库表' });
  }
  for (const row of adShops) {
    const where = { region: row.region, page: 'ads' };
    if (row.status === 'failed') out.push({ ...where, tone: 'bad', title: '广告余额查询失败', detail: row.error || '平台未返回余额' });
    else if (row.stale) out.push({ ...where, tone: 'warn', title: '广告余额快照超过 24 小时', detail: '本机服务需保持运行，或手动重新检查' });
    if (row.low) out.push({ ...where, tone: 'bad', title: `广告余额仅够 ${row.days.toFixed(1)} 天`, detail: `余额 ${money(row.balance, row.currency)} ${row.currency} · 日均消耗 ${money(row.dailyAverage, row.currency)}，尽快充值` });
    else if (isNum(row.days) && row.days < 7) out.push({ ...where, tone: 'warn', title: `广告余额约 ${row.days.toFixed(1)} 天后耗尽`, detail: `余额 ${money(row.balance, row.currency)} ${row.currency} · 近 7 日日均 ${money(row.dailyAverage, row.currency)}，本周内安排充值` });
  }
  for (const shop of shops) {
    const d = shopDigest(shop), region = shop.region;
    if (shop.connectionError) out.push({ region, page: 'data', tone: 'bad', title: '店铺连接异常', detail: shop.connectionError });
    for (const kind of Object.keys(BLOCK)) if (shop[kind]?.error) out.push({ region, page: kind, tone: 'bad', title: `${BLOCK[kind]}同步失败`, detail: `${shop[kind].error}${shop[kind].updatedAt ? '；当前显示历史快照' : ''}` });
    if (isStale(shop.orders?.updatedAt)) out.push({ region, page: 'data', tone: 'warn', title: '经营数据超过 24 小时未更新', detail: `上次成功同步 ${ago(shop.orders.updatedAt)}` });
    const todo = returnRows([fullOf(shop)]).filter(r => r.stage === 'action'), soon = todo.filter(r => r.due && r.due * 1000 - Date.now() < 72 * 3600000);
    if (todo.length) out.push({ region, page: 'returns', tone: soon.length ? 'bad' : 'warn', title: `${todo.length} 个退货 / 退款申请待处理${soon.length ? `，${soon.length} 个 72 小时内到期` : ''}`, detail: `退货退款 ${todo.filter(r => r.solution === 'return_refund').length} · 仅退款 ${todo.filter(r => r.solution === 'refund_only').length}；逾期未处理平台可能默认退款` });
    const ship = shipSummary([fullOf(shop)]).count;
    if (ship.overdue) out.push({ region, page: 'orders/ship', tone: 'bad', title: `${ship.overdue} 单已超过最晚发货时间`, detail: '尽快安排发货，迟发会计入店铺迟发率' });
    if (ship.h12 + ship.h24) out.push({ region, page: 'orders/ship', tone: 'warn', title: `${ship.h12 + ship.h24} 单 24 小时内需发货`, detail: `其中 ${ship.h12} 单不足 12 小时` });
    const now = shopDigest(fullOf(shop));
    if (now.toReturn) out.push({ region, page: 'returns', tone: 'info', title: `${now.toReturn} 单订单处于退货中`, detail: '在退货售后页按退货退款 / 仅退款查看进度' });
    if (d.cancelRate !== null && d.cancelRate >= 0.25 && d.total >= 10) out.push({ region, page: 'orders/cancel', tone: 'warn', title: `取消率 ${pct(d.cancelRate, 0)}`, detail: `${d.cancelled}/${d.total} 单已取消或取消中，可在“取消分析”查看原因与 SKU` });
    if (d.feeCoverage && d.feeCoverage[0] < d.feeCoverage[1]) out.push({ region, page: 'fees', tone: 'info', title: `${d.feeCoverage[1] - d.feeCoverage[0]} 单收入明细待补`, detail: '缺项不按零计算' });
    if (d.adGap) out.push({ region, page: 'ads', tone: 'info', title: `广告费有 ${money(Math.abs(d.adGap), shop.currency)} ${shop.currency} 未归属计划`, detail: '店铺总消耗与计划/GMV Max 合计存在差额，不强行分摊' });
  }
  if (profit?.available && profit.mode === 'live') for (const s of profit.shops) {
    if (!shops.some(shop => shop.region === s.region)) continue;
    const pending = s.incomplete + (s.crossIncomplete || 0);
    if (s.adNote) out.push({ region: s.region, page: 'profit', tone: 'warn', title: '毛利暂时算不出：广告费未能分摊', detail: `${s.adNote}；重新同步广告数据后自动恢复` });
    else if (pending) out.push({ region: s.region, page: 'profit', tone: 'info', title: `${pending} 单毛利待补`, detail: s.pendingParts?.length ? `缺项：${s.pendingParts.slice(0, 2).join('；')}${s.pendingParts.length > 2 ? ` 等 ${s.pendingParts.length} 项` : ''}` : '成本、鞋双数或结算收入缺项，不按零计算' });
    if (isNum(s.adUnattributed) && s.adTotal > 0 && s.adUnattributed / s.adTotal >= 0.1 && s.adUnattributedCny >= 30) out.push({ region: s.region, page: 'profit', tone: 'info', title: `${pct(s.adUnattributed / s.adTotal, 0)} 的广告费无法归属到订单`, detail: `${money(s.adUnattributed, s.currency)} ${s.currency}${isNum(s.adUnattributedCny) ? `（≈¥${money(s.adUnattributedCny)}）` : ''}来自多商品广告组或近 7 天没出单的商品，逐单毛利未扣这部分` });
  }
  if (profit?.available && profit.mode !== 'live' && isStale(`${profit.sourceDate}T00:00:00Z`, 24 * 7)) out.push({ region: '', page: 'profit', tone: 'info', title: `毛利试算快照停在 ${md(profit.period.start)}–${md(profit.period.end)}`, detail: `生成于 ${profit.sourceDate}，可按需重算最近一周` });
  return out.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
}

function Spark({ days, currency, on }) {
  const max = Math.max(1, ...days.map(d => d.orders));
  const spendMax = Math.max(0, ...days.map(d => d.spend || 0));
  const w = 100 / Math.max(days.length, 1);
  const line = spendMax > 0 ? days.map((d, i) => `${(i + .5) * w},${40 - ((d.spend || 0) / spendMax) * 34}`).join(' ') : '';
  return <div className="spark">
    <svg viewBox="0 0 100 42" preserveAspectRatio="none" role="img" aria-label={`每日有效订单：${days.map(d => `${md(d.date)} ${d.orders} 单`).join('，')}`}>
      {days.map((d, i) => <rect key={d.date} className={on && !on.has(d.date) ? 'off' : ''} x={i * w + w * .18} width={w * .64} y={42 - (d.orders / max) * 36 - 1} height={(d.orders / max) * 36 + 1} rx="1.2"><title>{`${md(d.date)} · ${d.orders} 单 · 广告 ${money(d.spend, currency)}`}</title></rect>)}
      {line && <polyline points={line} vectorEffect="non-scaling-stroke"/>}
    </svg>
    <div className="spark-axis"><span>{md(days[0]?.date)}</span><span className="spark-legend"><i className="bar"/>订单 <i className="ln"/>广告</span><span>{md(days.at(-1)?.date)}</span></div>
  </div>;
}

function MarketCard({ shop, full, days: windowDays, balance, fx, go }) {
  const d = shopDigest(shop), cur = shop.currency, code = shop.region;
  const live = shopDigest(full || shop), trend = shopDigest(scopeShop(full || shop, Math.max(windowDays || 7, 7))).perDay, on = new Set(d.perDay.map(x => x.date));
  const failed = shop.connectionError || ['orders', 'fees', 'ads', 'returns'].some(k => shop[k]?.error);
  const days = balance?.days, tone = balance?.low || balance?.status === 'failed' ? 'bad' : isNum(days) && days < 7 ? 'warn' : '';
  return <article className="mcard card">
    <header>
      <span className={`mk mk-${code.toLowerCase()}`}>{code}</span>
      <div><strong>{shop.name || shop.shopId}</strong><span>{marketName(code)} · {cur}</span></div>
      <span className={`tag ${failed ? 'bad' : isStale(shop.orders?.updatedAt) ? 'warn' : 'good'}`}>{failed ? '有异常' : isStale(shop.orders?.updatedAt) ? '待更新' : ago(shop.orders?.updatedAt)}</span>
    </header>
    <div className="mcard-hero">
      <div>
        <span className="eyebrow">有效销售额</span>
        <strong className="num">{compact(d.validAmount, cur)}<small>{cur}</small></strong>
        <p title={fx ? `1 ${cur} ≈ ${fx.rate.toPrecision(5)} CNY · ${fx.label} ${fx.date || ''}` : ''}>{isNum(d.validAmount) && fx ? `≈ ¥${compact(d.validAmount * fx.rate)}` : ' '}</p>
      </div>
      <div className="mcard-orders">
        <strong className="num">{int(d.valid)}</strong><span>有效订单</span>
        <em className={d.cancelRate >= .25 ? 'bad' : ''}>取消 {pct(d.cancelRate, 0)}</em>
      </div>
    </div>
    {trend.length > 0 && <Spark days={trend} currency={cur} on={on}/>}
    <dl className="mcard-stats">
      <div><dt>预计到手率</dt><dd className="num">{pct(d.netRate)}</dd></div>
      <div><dt>广告消耗</dt><dd className="num">{compact(d.adSpend, cur)}</dd></div>
      <div><dt>ROAS</dt><dd className="num">{isNum(d.roas) ? d.roas.toFixed(1) : '—'}</dd></div>
      <div><dt>广告占比</dt><dd className={`num ${d.adShare > .2 ? 'warn' : ''}`}>{pct(d.adShare)}</dd></div>
      <div><dt>待出库</dt><dd className="num" title="当前全部待出库，不受统计周期影响">{int(live.pendingShip)}</dd></div>
      <div><dt>退货中</dt><dd className={`num ${live.toReturn ? 'warn' : ''}`} title="当前处于退货中的订单">{int(live.toReturn)}</dd></div>
    </dl>
    <div className="mcard-balance">
      <div><span>广告余额</span><b className="num">{balance ? `${compact(balance.balance, cur)} ${cur}` : '—'}</b><em className={tone}>{isNum(days) ? `可用 ${days >= 99 ? '99+' : days.toFixed(1)} 天` : balance?.status === 'no_spend' ? '近 7 日无消耗' : '待检查'}</em></div>
      <div className={`meter ${tone}`}><i style={{ width: `${isNum(days) ? Math.min(100, days / 14 * 100) : 0}%` }}/></div>
    </div>
    <footer>
      <button className="link" onClick={() => go('orders', code)}>订单<ArrowRight size={13}/></button>
      <button className="link" onClick={() => go('fees', code)}>扣费<ArrowRight size={13}/></button>
      <button className="link" onClick={() => go('ads', code)}>广告<ArrowRight size={13}/></button>
      <button className="link" onClick={() => go('profit', code)}>毛利<ArrowRight size={13}/></button>
    </footer>
  </article>;
}

export default function Overview({ ops, fullShops = ops.shops, days = 7, ads, fx, profit, inv, market, go }) {
  const fullOf = useMemo(() => { const m = new Map(fullShops.map(s => [s.shopId, s])); return shop => m.get(shop.shopId) || shop; }, [fullShops]);
  const shops = ops.shops.filter(s => market === 'all' || s.region === market);
  const adShops = (ads.data?.shops || []).filter(s => market === 'all' || s.region === market);
  const fxBy = useMemo(() => Object.fromEntries(ops.shops.map(s => {
    const live = fx?.data?.rates?.[s.currency];
    if (isNum(live?.cnyPerUnit)) return [s.region, { rate: live.cnyPerUnit, live: true, label: live.label, date: live.date, stale: live.stale }];
    const snap = (profit.data?.shops || []).find(p => p.region === s.region);
    return [s.region, snap ? { rate: snap.fxRate, live: false, label: `试算快照 ${snap.fxLabel}`, date: snap.fxDate } : null];
  })), [ops.shops, fx?.data, profit.data]);
  const alerts = useMemo(() => buildAlerts(shops, adShops, market === 'all' || profit.data?.shops?.some(s => s.region === market) ? profit.data : null, inv?.data?.forecast, fullOf), [shops, adShops, profit.data, market, inv?.data, fullOf]);
  const [showAll, setShowAll] = useState(false);

  const totals = useMemo(() => {
    const digests = shops.map(s => ({ shop: s, d: shopDigest(s), fx: fxBy[s.region] }));
    const withFx = digests.filter(x => x.fx);
    const cny = key => withFx.length ? withFx.reduce((n, x) => n + (isNum(x.d[key]) ? x.d[key] * x.fx.rate : 0), 0) : null;
    const total = digests.reduce((n, x) => n + x.d.total, 0), cancelled = digests.reduce((n, x) => n + x.d.cancelled, 0);
    const sales = cny('validAmount'), spend = cny('adSpend');
    return { valid: digests.reduce((n, x) => n + x.d.valid, 0), cancelRate: ratio(cancelled, total), pending: digests.reduce((n, x) => n + shopDigest(fullOf(x.shop)).pendingShip, 0), sales, spend, share: ratio(spend, sales), net: cny('net'), missingFx: digests.filter(x => !x.fx).map(x => x.shop.region), fallbackFx: digests.filter(x => x.fx && !x.fx.live).map(x => x.shop.region) };
  }, [shops, fxBy, fullOf]);

  const profitSummary = useMemo(() => {
    if (!profit.data?.available) return null;
    const regions = profit.data.shops.filter(s => market === 'all' || s.region === market);
    if (!regions.length) return null;
    // 海外仓 + 跨境合计（跨境头程按每双处理费计，已是完整毛利）。
    const both = region => { const parts = ['overseas_warehouse', 'cross_border'].map(fulfillment => summarizeProfitOrders(filterProfitOrders(profit.data.orders, { region, fulfillment }), 'A'));
      const add = key => parts.every(p => p[key] === null) ? null : parts.reduce((n, p) => n + (p[key] || 0), 0);
      return { orders: parts[0].orders + parts[1].orders, included: parts[0].included + parts[1].included, pending: parts[0].pending + parts[1].pending, losses: parts[0].losses + parts[1].losses, income: add('income'), profit: add('profit'), crossIncluded: parts[1].included, crossProfit: parts[1].profit }; };
    const rows = regions.map(s => { const sum = both(s.region); return { ...s, ...sum, margin: ratio(sum.profit, sum.income) }; });
    const all = both(market === 'all' ? 'all' : market);
    const unattributed = profit.data.mode === 'live' ? regions.reduce((n, s) => n + (s.adUnattributedCny || 0), 0) : null;
    return { rows, all: { ...all, margin: ratio(all.profit, all.income) }, unattributed };
  }, [profit.data, market]);
  const liveProfit = profit.data?.mode === 'live';

  const period = shops.find(s => s.orders?.period)?.orders.period;
  const visibleAlerts = showAll ? alerts : alerts.slice(0, 6);

  if (!ops.data && !ops.error) return <p className="muted" role="status">正在读取经营快照…</p>;
  if (ops.data && !ops.shops.length) return <div className="card empty"><Database size={40}/><h3>还没有经营数据</h3><p>点击右上角“同步全部”，读取已授权店铺最近 30 天的订单、扣费、广告与退货。</p></div>;

  return <div className="overview">
    {ops.error && <div className="hub-message hub-error" role="alert"><AlertCircle size={16}/>{ops.error}；以下为上次保存的快照。</div>}

    <section className="ov-hero">
      <div className="ov-period">
        <span className="eyebrow">统计周期 · {periodLabel(days)}{period?.short ? '（已同步数据不足，下次全量同步后补齐）' : ''}</span>
        <strong className="num">{period ? `${md(period.start)} — ${md(period.end)}` : '—'}</strong>
        <p>{shops.length} 个店铺 · 各站按当地时区 · 金额保留原币，人民币为参考折算</p>
      </div>
      <div className="kpis ov-kpis">
        <div className="kpi"><span>有效订单</span><strong>{int(totals.valid)}<small>单</small></strong><p>取消率 {pct(totals.cancelRate)}</p></div>
        <div className="kpi"><span>有效销售额 ≈ CNY</span><strong>{isNum(totals.sales) ? `¥${compact(totals.sales)}` : '—'}</strong><p>{totals.missingFx.length ? `不含 ${totals.missingFx.join('、')}（无汇率）` : totals.fallbackFx.length ? `${totals.fallbackFx.join('、')} 暂用试算快照汇率` : '按当日参考汇率折算'}</p></div>
        <div className="kpi"><span>平台预计净收入 ≈ CNY</span><strong>{isNum(totals.net) ? `¥${compact(totals.net)}` : '—'}</strong><p>到手率 {pct(ratio(totals.net, totals.sales))}</p></div>
        <div className="kpi"><span>广告消耗 ≈ CNY</span><strong>{isNum(totals.spend) ? `¥${compact(totals.spend)}` : '—'}</strong><p>占销售额 {pct(totals.share)}</p></div>
        <div className="kpi"><span>待出库</span><strong>{int(totals.pending)}<small>单</small></strong><p>已安排、等待揽收</p></div>
      </div>
    </section>

    <section className="section">
      <div className="section-head"><div><h2>需要处理</h2><p>{alerts.length ? `${alerts.filter(a => a.tone === 'bad').length} 项紧急 · ${alerts.filter(a => a.tone === 'warn').length} 项关注 · ${alerts.filter(a => a.tone === 'info').length} 项提示` : '所有数据块同步正常，余额充足。'}</p></div>{alerts.length > 6 && <button className="ghost sm" onClick={() => setShowAll(!showAll)}>{showAll ? '收起' : `查看全部 ${alerts.length} 项`}</button>}</div>
      {alerts.length ? <ul className="alerts card">{visibleAlerts.map((a, i) => { const Icon = TONE_ICON[a.tone]; return <li key={i} className={a.tone}>
        <Icon size={16}/>
        {a.region ? <span className={`mk mk-${a.region.toLowerCase()}`}>{a.region}</span> : <span className="mk">ALL</span>}
        <div><strong>{a.title}</strong><span>{a.detail}</span></div>
        <button className="ghost sm" onClick={() => go(a.page, a.region || undefined)}>去处理<ArrowRight size={13}/></button>
      </li>; })}</ul> : <div className="callout good"><CheckCircle2 size={16}/><p><strong>一切正常。</strong>没有失败的同步、即将耗尽的广告余额或临期退货。</p></div>}
    </section>

    <section className="section">
      <div className="section-head"><div><h2>各站表现</h2><p>柱为每日有效订单，折线为当日广告消耗；ROAS 为平台宽口径归因 GMV ÷ 消耗。</p></div></div>
      <div className="mgrid">{shops.map(shop => <MarketCard key={shop.shopId} shop={shop} full={fullOf(shop)} days={days} balance={(ads.data?.shops || []).find(b => b.shopId === shop.shopId)} fx={fxBy[shop.region]} go={go}/>)}</div>
    </section>

    <div className="ov-split section">
      <section className="card card-pad ov-profit">
        <div className="section-head"><div><h2>{liveProfit ? `${periodLabel(days)}预估毛利` : '毛利试算快照'}</h2><p>{profit.data?.available ? `${profit.data.period.start} 至 ${profit.data.period.end} · 海外仓 + 跨境 · 情景 A · CNY${liveProfit ? ' · 随同步自动重算' : ''}` : profit.error || '读取中…'}</p></div><button className="ghost sm" onClick={() => go('profit')}>打开试算<ArrowUpRight size={13}/></button></div>
        {profitSummary ? <>
          <div className="ov-profit-head">
            <div><span>预估毛利</span><strong className={`num ${profitSummary.all.profit < 0 ? 'bad' : ''}`}>¥{money(profitSummary.all.profit)}</strong></div>
            <div><span>毛利率</span><strong className="num">{pct(profitSummary.all.margin)}</strong></div>
            <div><span>亏损订单</span><strong className="num">{int(profitSummary.all.losses)}<small> / {int(profitSummary.all.included)}</small></strong></div>
          </div>
          {liveProfit && <p className="note ov-profit-note">{profitSummary.all.pending ? `另有 ${profitSummary.all.pending} 单待补未计入。` : ''}{profitSummary.unattributed > 0 ? `未归属到订单的广告费 ≈ ¥${money(profitSummary.unattributed)} 尚未扣除，全部计入后约 ¥${money(profitSummary.all.profit - profitSummary.unattributed)}。` : ''}{profitSummary.all.crossIncluded ? `其中跨境 ${profitSummary.all.crossIncluded} 单 ¥${money(profitSummary.all.crossProfit)}（头程按每双处理费）。` : ''}</p>}
          <table className="tbl ov-profit-table"><thead><tr><th>站点</th><th className="num">订单</th><th className="num">试算收入</th><th className="num">预估毛利</th><th>毛利率</th></tr></thead><tbody>
            {profitSummary.rows.map(r => <tr key={r.region}><td><span className={`mk mk-${r.region.toLowerCase()}`}>{r.region}</span> {MARKETS[r.region]?.short}</td><td className="num">{int(r.included)}</td><td className="num">{money(r.income)}</td><td className={`num ${r.profit < 0 ? 'bad' : ''}`}>{money(r.profit)}</td><td><div className="margin-bar"><i style={{ width: `${Math.max(0, Math.min(100, (r.margin || 0) * 100 / 0.4))}%` }}/><span className="num">{pct(r.margin)}</span></div></td></tr>)}
          </tbody></table>
        </> : <p className="muted">{market === 'BR' ? '巴西费用规则尚未提供，未纳入试算。' : profit.data && !profit.data.available ? '尚无可用试算。' : '正在读取…'}</p>}
      </section>
      <section className="ov-links">
        <button className="ov-link card" onClick={() => go('listing')}><FileSpreadsheet size={20}/><div><strong>批量上架</strong><span>商品表对应官方模板，校验后导出 Excel</span></div><ArrowUpRight size={15}/></button>
        <button className="ov-link card" onClick={() => go('profit')}><Calculator size={20}/><div><strong>毛利试算</strong><span>逐单核对采购、履约与广告分摊</span></div><ArrowUpRight size={15}/></button>
        <button className="ov-link card" onClick={() => go('data')}><Database size={20}/><div><strong>数据与接入</strong><span>同步矩阵、授权配置与权限清单</span></div><ArrowUpRight size={15}/></button>
      </section>
    </div>

    <footer className="page-foot"><span>汇率：{fx?.data?.lastSuccessAt ? `${[...new Set(Object.values(fx.data.rates).filter(r => r.date).map(r => `${r.label} ${r.date}`))].join(' · ')}；每 ${fx.data.intervalHours} 小时自动更新，仅用于跨站对比，非结汇价` : '实时汇率尚未取得，暂用毛利试算快照汇率'}</span><span>广告余额上次检查 {stamp(ads.data?.lastAttemptAt)}（北京时间）</span></footer>
  </div>;
}
