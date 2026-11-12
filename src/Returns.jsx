import React, { useMemo, useState } from 'react';
import { RefreshCw, Search, AlertCircle, ChevronDown, ChevronLeft, ChevronRight, Inbox, Undo2, PackageOpen } from 'lucide-react';
import { money, short, int, stamp, ago, isStale, marketName } from './lib.js';
import { SOLUTION, RETURN_STATUS, returnRows, reasonText, proofText, negotiationText, compensationText, warehouseText, requestTypeText, offerText, logisticsText } from './returns-model.mjs';
import './returns.css';

const PAGE = 25;
const STAGE = { action: ['待我处理', 'bad'], progress: ['进行中', 'info'], done: ['已结束', 'mute'] };
const TYPES = [['all', '全部'], ['return_refund', '退货退款'], ['refund_only', '仅退款']];

function Kind({ solution, basis }) {
  const [text, tone] = SOLUTION[solution] || ['类型待核', 'warn'];
  return <span className={`tag rt-kind ${tone}`} title={basis === 'needs_logistics' ? '平台未返回方案字段，按是否需要退回商品判断' : ''}>{solution === 'return_refund' ? <PackageOpen size={12}/> : solution === 'refund_only' ? <Undo2 size={12}/> : null}{text}</span>;
}
function Status({ status }) { const [text, tone] = RETURN_STATUS[status] || [status, '']; return <span className={`tag ${tone}`}>{text}</span>; }
function dueText(seconds, zone) {
  if (!seconds) return null;
  const hours = (seconds * 1000 - Date.now()) / 3600000;
  const left = hours < 0 ? `已过 ${Math.ceil(-hours / 24)} 天` : hours < 24 ? `剩 ${Math.max(1, Math.round(hours))} 小时` : `剩 ${Math.floor(hours / 24)} 天`;
  return { when: stamp(seconds, zone), left, tone: hours < 0 ? 'bad' : hours < 48 ? 'bad' : hours < 96 ? 'warn' : '' };
}

export default function Returns({ ops, market, scopeIds }) {
  const shops = ops.shops.filter(s => market === 'all' || s.region === market);
  const [type, setType] = useState('all'), [stage, setStage] = useState('open'), [query, setQuery] = useState(''), [page, setPage] = useState(0), [open, setOpen] = useState(null);
  const all = useMemo(() => returnRows(shops), [shops]);
  const typed = all.filter(r => type === 'all' || r.solution === type || (type === 'unknown' && !r.solution));
  const q = query.trim().toLowerCase();
  const rank = { action: 0, progress: 1, done: 2 };
  const rows = typed.filter(r => (stage === 'all' || (stage === 'open' ? r.stage !== 'done' : r.stage === stage)) &&
    (!q || [r.returnSn, r.orderSn, r.textReason, ...r.items.flatMap(i => [i.sku, i.name])].some(v => String(v || '').toLowerCase().includes(q))))
    .sort((a, b) => rank[a.stage] - rank[b.stage] || (a.due || Infinity) - (b.due || Infinity) || (b.updateTime || 0) - (a.updateTime || 0));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE)), current = Math.min(page, pages - 1);
  const reset = () => { setPage(0); setOpen(null); };
  const count = (list, key, value) => list.filter(r => r[key] === value).length;
  const unknownType = count(all, 'solution', null);

  // 订单显示“退货中”，但近 30 天的退货列表里找不到对应申请（订单快照只覆盖近 7 天）。
  const missing = useMemo(() => shops.flatMap(shop => {
    if (!shop.returns?.rows) return [];
    const known = new Set(shop.returns.rows.map(r => r.orderSn));
    return (shop.orders?.rows || []).filter(o => o.status === 'TO_RETURN' && !known.has(o.orderSn)).map(o => ({ shop, orderSn: o.orderSn }));
  }), [shops]);
  const synced = shops.some(s => s.returns?.rows);
  const firstAction = typed.filter(r => r.stage === 'action' && r.due).sort((a, b) => a.due - b.due)[0];

  if (!ops.data && !ops.error) return <p className="muted" role="status">正在读取经营数据…</p>;
  return <section className="ops rt" aria-label="退货售后">
    {ops.error && <div className="hub-message hub-error" role="alert"><AlertCircle size={16}/>{ops.error}。已显示的数据保留原快照时间。</div>}
    <div className="rt-head">
      <div className="seg rt-types" role="group" aria-label="售后类型">
        {TYPES.map(([k, l]) => <button key={k} aria-pressed={type === k} onClick={() => { setType(k); reset(); }}>{l}<b>{k === 'all' ? all.length : count(all, 'solution', k)}</b></button>)}
        {unknownType > 0 && <button aria-pressed={type === 'unknown'} onClick={() => { setType('unknown'); reset(); }}>类型待核<b>{unknownType}</b></button>}
      </div>
      <button onClick={() => ops.sync(['returns'], scopeIds)} disabled={ops.busy}><RefreshCw size={14} className={ops.busy ? 'spin' : ''}/>{ops.busy ? '同步中' : '同步退货'}</button>
    </div>

    <div className="kpis rt-kpis">
      <div className="kpi"><span>待我处理</span><strong className={count(typed, 'stage', 'action') ? 'bad' : ''}>{count(typed, 'stage', 'action')}</strong><p>{firstAction ? `最近截止 ${stamp(firstAction.due, firstAction.shop.orders?.period?.timeZone)}（当地）` : '回应申请、举证、验收、赔付'}</p></div>
      <div className="kpi"><span>退货退款 · 进行中</span><strong>{typed.filter(r => r.solution === 'return_refund' && r.stage !== 'done').length}</strong><p>其中退回途中 {typed.filter(r => r.solution === 'return_refund' && r.stage !== 'done' && logisticsText(r) === '退回途中').length}，待买家寄回 {typed.filter(r => r.solution === 'return_refund' && r.stage !== 'done' && logisticsText(r) === '待买家寄回').length}</p></div>
      <div className="kpi"><span>仅退款 · 进行中</span><strong>{typed.filter(r => r.solution === 'refund_only' && r.stage !== 'done').length}</strong><p>不退回商品，货款直接退给买家</p></div>
      <div className="kpi"><span>已结束</span><strong>{count(typed, 'stage', 'done')}</strong><p>已退款、已关闭或买家取消</p></div>
    </div>

    <div className="shop-strip">{shops.map(shop => {
      const block = shop.returns, subset = typed.filter(r => r.shop.shopId === shop.shopId), cur = shop.currency;
      const tone = shop.connectionError || block?.error ? 'bad' : !block?.updatedAt ? '' : isStale(block.updatedAt) ? 'warn' : 'good';
      const amount = subset.filter(r => r.stage !== 'done');
      return <article className="strip card" key={shop.shopId}>
        <header><span className={`mk mk-${shop.region.toLowerCase()}`} title={marketName(shop.region)}>{shop.region}</span><strong>{shop.name}<small>{cur}</small></strong><span className={`tag ${tone}`} title={block?.error || ''}>{block?.error ? '查询失败' : block?.updatedAt ? ago(block.updatedAt) : '待同步'}</span></header>
        {block?.rows ? <dl>
          <div><dt>退货退款</dt><dd className="num">{count(subset, 'solution', 'return_refund')}</dd></div>
          <div><dt>仅退款</dt><dd className="num">{count(subset, 'solution', 'refund_only')}</dd></div>
          <div><dt>待处理</dt><dd className={`num ${count(subset, 'stage', 'action') ? 'bad' : ''}`}>{count(subset, 'stage', 'action')}</dd></div>
          <div className="strip-wide"><dt>未结束申请金额</dt><dd className="num sm">{amount.length ? `${short(amount.reduce((n, r) => n + (r.refundAmount || 0), 0), cur)} ${cur}` : '—'}</dd></div>
        </dl> : <p className="muted">{block?.error || '尚未同步退货'}</p>}
      </article>;
    })}</div>

    {missing.length > 0 && <div className="callout warn"><AlertCircle size={15}/><p><strong>{missing.length} 笔订单显示“退货中”，但退货列表里没有对应申请：</strong>{missing.slice(0, 6).map(m => `${m.shop.region} ${m.orderSn}`).join('、')}{missing.length > 6 ? ' 等' : ''}。可能是申请超过 30 天没有更新，或平台尚未生成退货单，请在卖家中心核对。</p></div>}

    <div className="toolbar rt-bar">
      <div className="seg" role="group" aria-label="进度">
        {[['open', '未结束'], ['action', '待我处理'], ['progress', '进行中'], ['done', '已结束'], ['all', '全部']].map(([k, l]) => <button key={k} aria-pressed={stage === k} onClick={() => { setStage(k); reset(); }}>{l} {k === 'open' ? typed.filter(r => r.stage !== 'done').length : k === 'all' ? typed.length : count(typed, 'stage', k)}</button>)}
      </div>
      <label className="search grow"><Search size={14}/><input type="search" placeholder="退货号 / 订单号 / SKU / 商品名 / 买家说明" value={query} onChange={e => { setQuery(e.target.value); reset(); }}/></label>
    </div>

    {!synced ? <div className="card empty"><Inbox size={40}/><h3>还没有退货数据</h3><p>点击“同步退货”，读取近 30 天内有更新的退货 / 退款申请。</p></div>
      : rows.length ? <div className="table-wrap tall"><table className="tbl ops-table rt-table"><thead><tr>
        <th>类型</th><th>退货单 / 订单 / SKU</th><th>站点</th><th>状态</th><th className="num">申请退款</th><th>原因</th><th>进度 / 要做的事</th><th>截止（当地）</th><th/>
      </tr></thead><tbody>
        {rows.slice(current * PAGE, current * PAGE + PAGE).map(r => {
          const key = `${r.shop.shopId}-${r.returnSn}`, isOpen = open === key, cur = r.shop.currency, zone = r.shop.orders?.period?.timeZone || r.shop.returns?.period?.timeZone, d = dueText(r.due, zone);
          return <React.Fragment key={key}><tr className={`${isOpen ? 'row-open' : ''} rt-${r.stage}`}>
            <td><Kind solution={r.solution} basis={r.solutionBasis}/></td>
            <td><span className="order-id">{r.returnSn}</span><small className="mono">订单 {r.orderSn} · 申请于 {stamp(r.createTime, zone)}</small><div className="skus">{r.items.length ? r.items.map((i, n) => <span className="sku" key={n} title={i.name}>{i.sku || 'SKU 待补'} × {i.quantity ?? '?'}</span>) : <span className="sku">SKU 待补</span>}</div></td>
            <td><span className={`mk mk-${r.shop.region.toLowerCase()}`}>{r.shop.region}</span></td>
            <td><Status status={r.status}/></td>
            <td className="num strong">{money(r.refundAmount, cur)}<small>{cur}</small></td>
            <td className="rt-reason">{reasonText(r.reason)}{r.textReason && <small title={r.textReason}>“{r.textReason}”</small>}</td>
            <td className="rt-progress">{r.todos.length ? r.todos.map((t, n) => <span key={n} className="rt-todo">{t.text}</span>) : <span>{r.progress}</span>}{r.todos.length > 0 && <small>{r.progress}</small>}{r.detailError && <small className="warn">详情待补：{r.detailError}</small>}</td>
            <td className="rt-due">{d ? <><b className={d.tone}>{d.left}</b><small>{r.dueOwner === 'buyer' ? '买家寄回截止 ' : ''}{d.when}</small></> : <span className="muted">—</span>}</td>
            <td><button className="ghost sm icon-sm" aria-expanded={isOpen} aria-label="查看详情" onClick={() => setOpen(isOpen ? null : key)}><ChevronDown size={15} className={isOpen ? 'flip' : ''}/></button></td>
          </tr>
          {isOpen && <tr className="detail"><td colSpan={9}><div className="rt-detail">
            <dl>
              <div><dt>售后类型</dt><dd>{(SOLUTION[r.solution] || ['类型待核'])[0]}{r.solutionBasis === 'needs_logistics' && <small>按是否退回商品判断</small>}</dd></div>
              <div><dt>申请时机</dt><dd>{requestTypeText(r.requestType)}{r.refundType && <small>{r.refundType === 'RRBOC' ? '订单完成前申请' : r.refundType === 'RRAOC' ? '订单完成后申请' : r.refundType}</small>}</dd></div>
              <div><dt>买家凭证</dt><dd>图片 {r.imageCount} · 视频 {r.videoCount}</dd></div>
              <div><dt>金额</dt><dd>{money(r.refundAmount, cur)} {cur}{r.amountBeforeDiscount != null && <small>原价 {money(r.amountBeforeDiscount, cur)}{r.partial ? ' · 部分数量退货' : ''}{r.refundAdjusted ? ' · 退款金额已调低' : ''}</small>}</dd></div>
              {r.solution !== 'refund_only' && <div><dt>退回物流</dt><dd title={r.logisticsStatus || ''}>{logisticsText(r)}<small>{[r.reverseChannel, r.trackingNumber && `运单 ${r.trackingNumber}`, r.buyerShipDueDate && `买家寄回截止 ${stamp(r.buyerShipDueDate, zone)}`].filter(Boolean).join(' · ') || '—'}</small></dd></div>}
              {r.validationType === 'warehouse_validation' && <div><dt>仓库验货</dt><dd>{warehouseText(r.warehouseStatus)}</dd></div>}
              <div><dt>协商</dt><dd>{negotiationText(r.negotiationStatus)}{r.latestSolution && <small>最新方案 {offerText(r.latestSolution)}{r.latestOfferAmount != null ? ` · ${money(r.latestOfferAmount, cur)} ${cur}` : ''}{r.offerDueDate ? ` · 截止 ${stamp(r.offerDueDate, zone)}` : ''}</small>}</dd></div>
              <div><dt>举证</dt><dd>{proofText(r.proofStatus)}{r.proofDueDate && <small>截止 {stamp(r.proofDueDate, zone)}</small>}</dd></div>
              <div><dt>赔付</dt><dd>{compensationText(r.compensationStatus)}{(r.compensationDueDate || r.compensationAmount != null) && <small>{r.compensationAmount != null ? `${money(r.compensationAmount, cur)} ${cur}` : ''}{r.compensationDueDate ? ` 申请截止 ${stamp(r.compensationDueDate, zone)}` : ''}</small>}</dd></div>
              <div><dt>平台处理截止</dt><dd>{stamp(r.sellerDueDate || r.dueDate, zone)}</dd></div>
            </dl>
            {r.textReason && <p className="rt-text"><b>买家说明：</b>{r.textReason}</p>}
            <p className="note">时间为店铺当地时间。工作台只读，同意 / 争议 / 举证 / 申请赔付请在卖家中心的退货退款页面操作。</p>
          </div></td></tr>}
          </React.Fragment>;
        })}
      </tbody></table></div> : <div className="card empty"><Inbox size={36}/><h3>当前范围没有匹配记录</h3><p>可切换类型、进度、站点或搜索条件。</p></div>}
    {synced && <div className="pager"><span>共 {rows.length} 条 · 第 {current + 1} / {pages} 页</span><div><button className="sm" disabled={current === 0} onClick={() => { setPage(current - 1); setOpen(null); }}><ChevronLeft size={14}/>上一页</button><button className="sm" disabled={current + 1 >= pages} onClick={() => { setPage(current + 1); setOpen(null); }}>下一页<ChevronRight size={14}/></button></div></div>}
    <p className="note rt-scope">范围：近 30 天内有更新的退货 / 退款申请。“退货退款”需要买家把商品寄回；“仅退款”不退回商品，按平台返回的最新方案区分，协商中途改方案会随同步更新。</p>
    <footer className="page-foot"><span>数据来源：Shopee 开放平台只读接口 · 本机保存快照</span><span>不保存买家姓名、电话与地址</span></footer>
  </section>;
}
