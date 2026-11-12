import React, { useMemo, useState } from 'react';
import { AlertCircle, RefreshCw, Clock, Inbox } from 'lucide-react';
import { STATUS, STATUS_TONE, EXCLUDED, TO_SHIP, SHIP_BUCKETS, shipUrgency, hoursText, cancelLabel, CANCEL_BY, stamp, int, pct, ratio, md } from './lib.js';

function Mk({ code }) { return <span className={`mk mk-${String(code).toLowerCase()}`}>{code}</span>; }
function Skus({ items }) { return <div className="skus">{items.length ? items.map((i, k) => <span className="sku" key={k} title={i.name}>{i.sku || 'SKU 待补'} × {i.quantity ?? '?'}</span>) : <span className="sku">SKU 待补</span>}</div>; }
function Resync({ ops, scopeIds, text }) {
  return <div className="callout warn"><AlertCircle size={15}/><div><p><strong>{text}</strong>这些字段从本版本开始读取，已保存的订单快照里还没有。</p>
    <p><button className="sm" onClick={() => ops.sync(['orders'], scopeIds)} disabled={ops.busy}><RefreshCw size={13} className={ops.busy ? 'spin' : ''}/>{ops.busy ? '同步中' : '立即同步订单'}</button></p></div></div>;
}

export function shipSummary(shops, now = Date.now()) {
  const rows = shops.flatMap(shop => (shop.orders?.rows || []).filter(r => TO_SHIP.includes(r.status)).map(r => ({ ...r, shop, urgency: shipUrgency(r, now) })));
  const count = Object.fromEntries(Object.keys(SHIP_BUCKETS).map(k => [k, rows.filter(r => r.urgency.bucket === k).length]));
  return { rows, count };
}

export function ShipDeadlines({ shops, ops, scopeIds }) {
  const [bucket, setBucket] = useState('all');
  const { rows, count } = useMemo(() => shipSummary(shops), [shops]);
  const visible = rows.filter(r => bucket === 'all' || r.urgency.bucket === bucket).sort((a, b) => (a.urgency.hours ?? 1e9) - (b.urgency.hours ?? 1e9));
  const allUnknown = rows.length > 0 && count.unknown === rows.length;
  return <div className="stack">
    {allUnknown && <Resync ops={ops} scopeIds={scopeIds} text="还没有发货期限数据。"/>}
    <div className="bucket-row">
      <button className={`bucket ${bucket === 'all' ? 'on' : ''}`} onClick={() => setBucket('all')}><span>全部待发</span><strong className="num">{rows.length}</strong></button>
      {Object.entries(SHIP_BUCKETS).filter(([k]) => k !== 'unknown' || count.unknown).map(([k, [label, tone]]) => <button key={k} className={`bucket t-${tone || 'mute'} ${bucket === k ? 'on' : ''}`} onClick={() => setBucket(k)}><span>{label}</span><strong className="num">{count[k]}</strong></button>)}
    </div>
    <p className="note">包含“待发货 / 待出库 / 重新发货”状态的订单。期限取平台返回的最晚发货时间（ship_by_date），按店铺当地时间显示；超时可能计入店铺迟发率。</p>
    {visible.length ? <div className="table-wrap tall"><table className="tbl"><thead><tr><th>订单 / SKU</th><th>站点</th><th>状态</th><th>最晚发货（当地）</th><th>剩余时间</th><th className="num">备货天数</th><th>付款时间</th></tr></thead><tbody>
      {visible.map(r => { const [label, tone] = SHIP_BUCKETS[r.urgency.bucket]; const zone = r.shop.orders?.period?.timeZone; return <tr key={`${r.shop.shopId}-${r.orderSn}`}>
        <td><span className="order-id">{r.orderSn}</span><Skus items={r.items || []}/></td>
        <td><Mk code={r.shop.region}/></td>
        <td><span className={`tag ${STATUS_TONE[r.status] || ''}`}>{STATUS[r.status] || r.status}</span></td>
        <td className="num">{r.shipByDate ? stamp(r.shipByDate, zone) : '—'}</td>
        <td><span className={`tag ${tone} plain`}>{r.urgency.hours === null ? label : hoursText(r.urgency.hours)}</span></td>
        <td className="num">{r.daysToShip ?? '—'}</td>
        <td className="num">{r.payTime ? stamp(r.payTime, zone) : '—'}</td>
      </tr>; })}
    </tbody></table></div> : <div className="card empty"><Clock size={36}/><h3>{rows.length ? '该分组没有订单' : '没有待发货订单'}</h3><p>{rows.length ? '切换上方分组查看其他订单。' : '所选站点近 7 天创建的订单都已发出或已取消。'}</p></div>}
  </div>;
}

export function CancelAnalysis({ shops, ops, scopeIds }) {
  const all = shops.flatMap(shop => (shop.orders?.rows || []).map(r => ({ ...r, shop })));
  const cancelled = all.filter(r => r.status === 'CANCELLED' || r.status === 'IN_CANCEL');
  const known = cancelled.filter(r => r.cancelReason || r.buyerCancelReason || r.cancelBy);
  const reasons = useMemo(() => {
    const m = new Map();
    for (const r of cancelled) { const { label, raw } = cancelLabel(r); const cur = m.get(label) || { label, raw: new Set(), total: 0, by: {} }; cur.total++; if (raw) cur.raw.add(raw); const by = r.cancelBy || '待同步'; cur.by[by] = (cur.by[by] || 0) + 1; m.set(label, cur); }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [shops]);
  const skus = useMemo(() => {
    const m = new Map();
    for (const r of all) for (const sku of new Set((r.items || []).map(i => i.sku || 'SKU 待补'))) {
      const key = `${r.shop.region}|${sku}`, cur = m.get(key) || { region: r.shop.region, sku, total: 0, cancelled: 0, reasons: {} };
      cur.total++;
      if (r.status === 'CANCELLED' || r.status === 'IN_CANCEL') { cur.cancelled++; const l = cancelLabel(r).label; cur.reasons[l] = (cur.reasons[l] || 0) + 1; }
      m.set(key, cur);
    }
    return [...m.values()].filter(x => x.cancelled > 0).sort((a, b) => b.cancelled - a.cancelled || b.cancelled / b.total - a.cancelled / a.total).slice(0, 30);
  }, [shops]);
  const max = Math.max(1, ...reasons.map(r => r.total));
  if (!all.length) return <div className="card empty"><Inbox size={36}/><h3>没有订单数据</h3></div>;
  return <div className="stack">
    {cancelled.length > 0 && !known.length && <Resync ops={ops} scopeIds={scopeIds} text="还没有取消原因数据。"/>}
    <div className="table-wrap"><table className="tbl"><thead><tr><th>店铺</th><th className="num">订单</th><th className="num">取消 / 取消中</th><th className="num">取消率</th><th className="num">未付款</th>{Object.values({ buyer: '买家', seller: '卖家', system: '系统', ops: '平台' }).map(l => <th key={l} className="num">{l}发起</th>)}</tr></thead><tbody>
      {shops.map(shop => { const rows = shop.orders?.rows || [], c = rows.filter(r => r.status === 'CANCELLED' || r.status === 'IN_CANCEL'), rate = ratio(c.length, rows.length); const by = k => c.filter(r => (r.cancelBy || '').toLowerCase() === k).length; return <tr key={shop.shopId}>
        <td><Mk code={shop.region}/> {shop.name}</td><td className="num">{int(rows.length)}</td><td className="num">{int(c.length)}</td>
        <td className="num"><span className={`pf-margin ${rate >= .25 ? 'bad' : rate >= .12 ? 'warn' : 'good'}`}>{pct(rate)}</span></td>
        <td className="num">{int(rows.filter(r => r.status === 'UNPAID').length)}</td>
        {['buyer', 'seller', 'system', 'ops'].map(k => <td key={k} className={`num ${k === 'seller' && by(k) ? 'bad strong' : ''}`}>{known.length ? int(by(k)) : '—'}</td>)}
      </tr>; })}
    </tbody></table></div>
    <div className="insight-split">
      <section className="card card-pad">
        <div className="section-head"><div><h2>取消原因</h2><p>买家发起时优先显示买家选择的原因；卖家发起的取消会影响店铺取消率指标。</p></div></div>
        {reasons.length ? <ul className="reason-list">{reasons.map(r => <li key={r.label}>
          <div><strong title={[...r.raw].join(' / ')}>{r.label}</strong><span>{Object.entries(r.by).map(([k, v]) => `${CANCEL_BY[k] || k} ${v}`).join(' · ')}</span></div>
          <div className="reason-bar"><i style={{ width: `${r.total / max * 100}%` }}/></div><b className="num">{r.total}</b>
        </li>)}</ul> : <p className="muted">所选范围没有取消订单。</p>}
      </section>
      <section className="card card-pad">
        <div className="section-head"><div><h2>取消最多的 SKU</h2><p>按包含该 SKU 的订单计数；一单多件只算一次。</p></div></div>
        {skus.length ? <div className="scroll-x"><table className="tbl compact"><thead><tr><th>SKU</th><th className="num">取消 / 总单</th><th className="num">取消率</th><th>主要原因</th></tr></thead><tbody>
          {skus.map(x => <tr key={`${x.region}|${x.sku}`}><td><Mk code={x.region}/> <span className="mono">{x.sku}</span></td><td className="num">{x.cancelled}/{x.total}</td><td className={`num ${x.total >= 3 && x.cancelled / x.total >= .3 ? 'bad strong' : ''}`}>{pct(x.cancelled / x.total, 0)}</td><td>{Object.entries(x.reasons).sort((a, b) => b[1] - a[1])[0]?.[0]}</td></tr>)}
        </tbody></table></div> : <p className="muted">所选范围没有取消订单。</p>}
      </section>
    </div>
  </div>;
}
