import React, { useMemo, useState } from 'react';
import { RefreshCw, Search, AlertCircle, ChevronLeft, ChevronRight, ChevronDown, Inbox } from 'lucide-react';
import AdsBalance from './AdsBalance.jsx';
import AdsPerformance from './AdsPerformance.jsx';
import { periodLabel } from './window.mjs';
import { ShipDeadlines, CancelAnalysis, shipSummary } from './OrderInsights.jsx';
import './insights.css';
import { STATUS, STATUS_TONE, EXCLUDED, FULFILLMENT, money, short, int, pct, ratio, stamp, ago, isStale, isNum, isoFromDmy, md, sumBy, marketName } from './lib.js';
import './operations.css';

const LABEL = { orders: '订单', fees: '平台扣费', ads: '广告', returns: '退货' };
const PAGE = 25;
const FEE_LABEL = { commission_fee: '佣金', service_fee: '服务费', seller_transaction_fee: '卖家交易手续费', buyer_transaction_fee: '买家交易手续费（不另扣卖家）', credit_card_transaction_fee: '信用卡手续费', escrow_amount: '平台预计净收入', escrow_amount_after_adjustment: '调整后净收入', order_selling_price: '商品售价小计', order_original_price: '原始商品金额', order_discounted_price: '商品折后金额', estimated_shipping_fee: '预计物流费用', actual_shipping_fee: '实际物流费用', final_shipping_fee: '最终物流费用', buyer_paid_shipping_fee: '买家支付运费', shipping_fee_sst: '运费税', commission_fee_pri: '佣金（原币字段）', service_fee_pri: '服务费（原币字段）', order_ams_commission_fee: '联盟营销佣金', ads_escrow_top_up_fee_or_technical_support_fee: '广告划拨或技术服务费', seller_order_processing_fee: '平台订单处理费', campaign_fee: '活动费用', overseas_return_service_fee: '海外退货服务费', reverse_shipping_fee: '逆向运费', final_return_to_seller_shipping_fee: '退回卖家运费', escrow_tax: '结算税', withholding_tax: '预扣税', seller_return_refund: '卖家退货退款调整', net_commission_fee: '净佣金', net_service_fee: '净服务费', fbs_fee: 'FBS 费用' };
const sumOrNull = (rows, field) => rows.length && rows.every(r => isNum(r[field])) ? sumBy(rows, r => r[field]) : rows.length ? null : 0;

function Tag({ status }) { return <span className={`tag ${STATUS_TONE[status] || ''}`}>{STATUS[status] || status}</span>; }
function Mk({ code }) { return <span className={`mk mk-${String(code).toLowerCase()}`} title={marketName(code)}>{code}</span>; }
function blockState(shop, block, extra) {
  if (shop.connectionError || block?.error) return ['bad', '查询失败'];
  if (!block?.updatedAt) return ['', '待同步'];
  if (isStale(block.updatedAt)) return ['warn', '超过 24 小时'];
  if (extra) return ['warn', extra];
  return ['good', `${ago(block.updatedAt)}同步`];
}

export default function Operations({ view, sub, ops, market, ads, fullShops = ops.shops, days = 7, fxFor = () => null }) {
  const [status, setStatus] = useState('all'), [path, setPath] = useState('all'), [query, setQuery] = useState('');
  const [page, setPage] = useState(0), [adsTab, setAdsTab] = useState('performance'), [open, setOpen] = useState(null), [ordersTab, setOrdersTab] = useState(sub || 'list');
  const shops = ops.shops.filter(s => market === 'all' || s.region === market);
  const scopeIds = market === 'all' ? undefined : shops.map(s => s.shopId);
  const orderIndex = useMemo(() => new Map(ops.shops.flatMap(s => (s.orders?.rows || []).map(o => [`${s.shopId}/${o.orderSn}`, o]))), [ops.shops]);
  const itemsOf = row => row.items || orderIndex.get(`${row.shop.shopId}/${row.orderSn}`)?.items || [];
  const blockRows = useMemo(() => shops.flatMap(shop => (shop[view]?.rows || []).map(row => ({ ...row, shop }))), [shops, view]);
  const q = query.trim().toLowerCase();
  const rows = blockRows.filter(row => (status === 'all' || row.status === status) && (path === 'all' || row.fulfillment === path) &&
    (!q || [row.orderSn, row.returnSn, ...itemsOf(row).flatMap(i => [i.sku, i.name])].some(v => String(v || '').toLowerCase().includes(q))));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE)), current = Math.min(page, pages - 1);
  const filter = setter => e => { setter(e.target.value); setPage(0); setOpen(null); };
  const statusCounts = blockRows.reduce((m, r) => (m[r.status] = (m[r.status] || 0) + 1, m), {});

  function Skus({ row }) {
    const items = itemsOf(row);
    return <div className="skus">{items.length ? items.map((item, i) => <span className="sku" key={i} title={item.name}>{item.sku || 'SKU 待补'} × {item.quantity ?? '?'}</span>) : <span className="sku">SKU 待补</span>}</div>;
  }

  const syncButton = <button onClick={() => ops.sync([view], scopeIds)} disabled={ops.busy}><RefreshCw size={14} className={ops.busy ? 'spin' : ''}/>{ops.busy ? '同步中' : `同步${LABEL[view]}`}</button>;

  return <section className="ops" aria-label={LABEL[view]}>
    {view === 'orders' && (() => { const sum = shipSummary(shops); const urgent = sum.count.overdue + sum.count.h12 + sum.count.h24; const cancelled = shops.reduce((n, s) => n + (s.orders?.rows || []).filter(r => r.status === 'CANCELLED' || r.status === 'IN_CANCEL').length, 0); return <div className="tabs" role="group" aria-label="订单功能">
      <button aria-pressed={ordersTab === 'list'} onClick={() => setOrdersTab('list')}>订单明细</button>
      <button aria-pressed={ordersTab === 'ship'} onClick={() => setOrdersTab('ship')}>发货时效{urgent > 0 && <span className={`nav-badge ${sum.count.overdue ? 'hot' : ''} tab-badge`}>{urgent}</span>}</button>
      <button aria-pressed={ordersTab === 'cancel'} onClick={() => setOrdersTab('cancel')}>取消分析{cancelled > 0 && <span className="nav-badge tab-badge">{cancelled}</span>}</button>
    </div>; })()}
    {view === 'ads' && <div className="tabs" role="group" aria-label="广告功能">
      <button aria-pressed={adsTab === 'performance'} onClick={() => setAdsTab('performance')}>广告表现</button>
      <button aria-pressed={adsTab === 'balance'} onClick={() => setAdsTab('balance')}>余额与可用天数</button>
    </div>}
    {ops.error && <div className="hub-message hub-error" role="alert"><AlertCircle size={16}/>{ops.error}。已显示的数据保留原快照时间。</div>}
    {ops.job?.error && <div className="hub-message hub-error" role="alert"><AlertCircle size={16}/>{ops.job.error}</div>}

    {view === 'ads' && adsTab === 'balance' ? <AdsBalance ads={ads} market={market}/> : view === 'ads' ? <AdsPerformance shops={shops} fullShops={fullShops} days={days} balance={ads.data} fxFor={fxFor} ops={ops} scopeIds={scopeIds}/> : view === 'orders' && ordersTab === 'ship' ? <ShipDeadlines shops={fullShops.filter(s => market === 'all' || s.region === market)} ops={ops} scopeIds={scopeIds}/> : view === 'orders' && ordersTab === 'cancel' ? <CancelAnalysis shops={shops} ops={ops} scopeIds={scopeIds}/> : <>
      {view !== 'ads' && <div className="toolbar">
        <label className="field">状态<select value={status} onChange={filter(setStatus)}><option value="all">全部状态 · {blockRows.length}</option>{Object.keys(statusCounts).sort((a, b) => statusCounts[b] - statusCounts[a]).map(s => <option key={s} value={s}>{STATUS[s] || s} · {statusCounts[s]}</option>)}</select></label>
        {view !== 'returns' && <label className="field">履约方式<select value={path} onChange={filter(setPath)}><option value="all">全部</option>{Object.entries(FULFILLMENT).map(([k, v]) => <option value={k} key={k}>{v}（预估）</option>)}</select></label>}
        <label className="field grow">{view === 'returns' ? '退货号 / 订单号 / SKU / 商品名' : '订单号 / SKU / 商品名'}<span className="search"><Search size={14}/><input type="search" value={query} onChange={filter(setQuery)} placeholder="输入关键词"/></span></label>
        {syncButton}
      </div>}

      {!ops.data && !ops.error && <p className="muted" role="status">正在读取经营数据…</p>}
      {ops.data && !shops.length && <div className="card empty"><Inbox size={40}/><h3>等待首次同步</h3><p>点击右上角“同步全部”，读取授权店铺的真实数据。</p></div>}

      {<>
        <div className="shop-strip">{shops.map(shop => {
          const block = shop[view], subset = rows.filter(r => r.shop.shopId === shop.shopId), cur = shop.currency;
          const [tone, text] = blockState(shop, block);
          const income = subset.filter(r => r.income).map(r => r.income);
          const feeTotal = field => subset.length && !income.length ? null : sumOrNull(income, field);
          const valid = subset.filter(r => !EXCLUDED.includes(r.status));
          return <article className="strip card" key={shop.shopId}>
            <header><Mk code={shop.region}/><strong>{shop.name}<small>{cur}</small></strong><span className={`tag ${tone}`} title={block?.error || (block?.updatedAt ? `更新于 ${stamp(block.updatedAt)}（北京时间）` : '')}>{text.replace('同步', '')}</span></header>
            {block?.rows ? <dl className={view === 'fees' ? 'two' : ''}>
              {view === 'orders' && <><div><dt>有效/全部</dt><dd className="num">{valid.length}<small>/{subset.length}</small></dd></div><div><dt>有效金额</dt><dd className="num">{short(sumOrNull(valid, 'totalAmount'), cur)}</dd></div><div><dt>缺 SKU</dt><dd className={`num ${subset.some(r => r.items.some(i => !i.sku)) ? 'warn' : ''}`}>{subset.reduce((n, r) => n + r.items.filter(i => !i.sku).length, 0)}</dd></div></>}
              {view === 'fees' && <><div><dt>预计净收入</dt><dd className="num">{short(feeTotal('net'), cur)}</dd></div><div><dt>平台扣费</dt><dd className="num">{short(['commission', 'service', 'transaction'].every(k => feeTotal(k) !== null) ? feeTotal('commission') + feeTotal('service') + feeTotal('transaction') : null, cur)}</dd></div><div className="strip-wide"><dt>佣金 / 服务费 / 手续费 · 明细 {income.length}/{subset.length}</dt><dd className="num sm">{short(feeTotal('commission'), cur)} / {short(feeTotal('service'), cur)} / {short(feeTotal('transaction'), cur)}</dd></div></>}
              {view === 'returns' && <><div><dt>申请/详情</dt><dd className="num">{subset.length}<small>/{subset.filter(r => !r.detailError).length}</small></dd></div><div><dt>申请退款</dt><dd className="num">{short(sumOrNull(subset, 'refundAmount'), cur)}</dd></div></>}
            </dl> : <p className="muted">{block?.error || '尚未同步'}</p>}
          </article>;
        })}</div>

        {view === 'fees' && <div className="callout"><AlertCircle size={15}/><p>平台预计净收入<strong>已扣除</strong>佣金、服务费与手续费，不要再次相减。金额可能随履约或退款变化，不代表已到账；未付款、取消订单不计入。</p></div>}
        {view === 'returns' && <div className="callout"><AlertCircle size={15}/><p>范围为近 7 个完整自然日内<strong>有更新</strong>的退货 / 退款申请，并非全部历史待办。</p></div>}

        {shops.some(s => s[view]?.rows) && <div className="section">
          <div className="section-head"><div><h2>{LABEL[view]}明细</h2><p>筛选结果 {int(rows.length)} 条{market === 'all' && shops.length > 1 ? ' · 多站点混排，金额为各自原币' : ''}</p></div></div>
          {rows.length ? <div className="table-wrap tall"><table className="tbl ops-table"><thead><tr>
            <th>{view === 'returns' ? '退货 / 订单 / SKU' : '订单 / SKU'}</th><th>站点</th><th>状态</th>
            {view === 'orders' && <><th>履约</th><th className="num">订单金额</th><th className="num">创建时间（当地）</th></>}
            {view === 'fees' && <><th className="num">佣金</th><th className="num">服务费</th><th className="num">手续费</th><th className="num">预计净收入</th><th className="num">到手率</th><th/></>}
            {view === 'returns' && <><th className="num">申请退款</th><th>原因 / 进度</th><th className="num">截止（当地）</th></>}
          </tr></thead><tbody>
            {rows.slice(current * PAGE, current * PAGE + PAGE).map(row => {
              const key = `${row.shop.shopId}-${row.returnSn || row.orderSn}`, cur = row.shop.currency, isOpen = open === key;
              const order = orderIndex.get(`${row.shop.shopId}/${row.orderSn}`);
              return <React.Fragment key={key}><tr className={isOpen ? 'row-open' : ''}>
                <td><span className="order-id">{row.returnSn || row.orderSn}</span>{row.returnSn && <small className="mono">订单 {row.orderSn}</small>}<Skus row={row}/></td>
                <td><Mk code={row.shop.region}/></td>
                <td><Tag status={row.status}/></td>
                {view === 'orders' && <><td>{FULFILLMENT[row.fulfillment] || '待核'}</td><td className="num strong">{money(row.totalAmount, cur)}<small>{cur}</small></td><td className="num">{stamp(row.createTime, row.shop.orders.period.timeZone)}</td></>}
                {view === 'fees' && <>{row.error ? <td colSpan={5}><span className="warn">收入待补：{row.error}</span></td> : <><td className="num">{money(row.income.commission, cur)}</td><td className="num">{money(row.income.service, cur)}</td><td className="num">{money(row.income.transaction, cur)}</td><td className="num strong">{money(row.income.net, cur)}<small>{cur}</small></td><td className="num">{pct(ratio(row.income.net, order?.totalAmount))}</td></>}
                  <td>{!row.error && <button className="ghost sm icon-sm" aria-expanded={isOpen} aria-label="查看费用字段" onClick={() => setOpen(isOpen ? null : key)}><ChevronDown size={15} className={isOpen ? 'flip' : ''}/></button>}</td></>}
                {view === 'returns' && <><td className="num strong">{money(row.refundAmount, cur)}<small>{cur}</small></td><td>{row.reason || '原因待补'}<small>{row.logisticsStatus || (row.needsLogistics === false ? '无需退货物流' : '物流状态待补')} · 举证 {row.proofStatus || '待核'} · 赔付 {row.compensationStatus || '待核'}</small>{row.detailError && <small className="warn">详情待补：{row.detailError}</small>}</td><td className="num">处理 {stamp(row.sellerDueDate || row.dueDate, row.shop.returns.period.timeZone)}<small>举证 {stamp(row.proofDueDate, row.shop.returns.period.timeZone)}</small></td></>}
              </tr>
              {view === 'fees' && isOpen && <tr className="detail"><td colSpan={9}><div className="fee-fields">
                <dl>{Object.entries(row.income.fields).filter(([, v]) => v !== 0).map(([k, v]) => <div key={k}><dt>{FEE_LABEL[k] || k}</dt><dd className="num">{money(v, cur)}</dd></div>)}</dl>
                <p className="note">仅列出非零字段（{FULFILLMENT[row.fulfillment] || '履约待核'}）。以上为平台原始字段，可能存在包含关系或调整项，不能全部直接相加。</p>
              </div></td></tr>}
              </React.Fragment>;
            })}
          </tbody></table></div> : <div className="card empty"><Inbox size={36}/><h3>当前范围没有匹配记录</h3><p>可调整站点、状态或搜索条件。</p></div>}
          <div className="pager"><span>第 {current + 1} / {pages} 页 · 每页 {PAGE} 条</span><div><button className="sm" aria-label="上一页" disabled={current === 0} onClick={() => { setPage(current - 1); setOpen(null); }}><ChevronLeft size={14}/>上一页</button><button className="sm" aria-label="下一页" disabled={current + 1 >= pages} onClick={() => { setPage(current + 1); setOpen(null); }}>下一页<ChevronRight size={14}/></button></div></div>
        </div>}
      </>}
    </>}
    <footer className="page-foot"><span>数据来源：Shopee 开放平台只读接口 · 本机保存快照</span><span>同步失败时保留历史数据；未知费用与广告差额保留待核，不按零计算</span></footer>
  </section>;
}
