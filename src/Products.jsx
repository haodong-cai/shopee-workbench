import React, { useEffect, useMemo, useState } from 'react';
import { Search, AlertCircle, Trophy, ArrowDown, ArrowUp } from 'lucide-react';
import { EXCLUDED, money, int, pct, ratio, isNum, marketName, short } from './lib.js';
import { periodLabel } from './window.mjs';
import './insights.css';

const PAGE = 30;
const SORTS = { sales: '销售额', contribution: '贡献', margin: '贡献率', adShare: '广告占比', cancelRate: '取消率', qty: '件数' };

/** 把所选周期的订单、收入、广告、库存名称、采购成本与履约费用汇总到“店铺 × 商品链接”。
 * live：滚动毛利的逐单结果（region/orderSn → 订单），用于取海外仓打包 / 运输和跨境每双处理费。 */
export function buildLinks(shops, costs, fxFor, live) {
  const links = new Map();
  const get = (shop, itemId, name) => {
    const key = `${shop.shopId}:${itemId}`;
    if (!links.has(key)) links.set(key, { key, shop, itemId, name: name || '', skus: new Map(), orders: new Set(), valid: new Set(), cancelled: new Set(), toReturn: new Set(), qty: 0, sales: 0, salesMissing: 0, net: 0, netMissing: 0, cost: 0, costMissing: 0, ads: 0, fulfil: 0, fulfilMissing: 0, crossOrders: 0 });
    const link = links.get(key); if (!link.name && name) link.name = name; return link;
  };
  for (const shop of shops) {
    const fx = fxFor(shop.currency);
    const income = new Map((shop.fees?.rows || []).filter(r => r.income).map(r => [r.orderSn, r.income.net]));
    for (const order of shop.orders?.rows || []) {
      const items = order.items || [];
      const byItem = new Map();
      for (const it of items) { const g = byItem.get(it.itemId) || []; g.push(it); byItem.set(it.itemId, g); }
      const lineSales = it => isNum(it.price) && isNum(it.quantity) ? it.price * it.quantity : null;
      const itemSales = new Map([...byItem].map(([id, its]) => [id, its.every(it => lineSales(it) !== null) ? its.reduce((n, it) => n + lineSales(it), 0) : byItem.size === 1 && isNum(order.totalAmount) ? order.totalAmount : null]));
      const totalSales = [...itemSales.values()].every(isNum) ? [...itemSales.values()].reduce((a, b) => a + b, 0) : null;
      const valid = !EXCLUDED.includes(order.status), net = income.get(order.orderSn);
      for (const [itemId, its] of byItem) {
        const link = get(shop, itemId, its[0].name);
        link.orders.add(order.orderSn);
        for (const it of its) link.skus.set(it.sku || 'SKU 待补', (link.skus.get(it.sku || 'SKU 待补') || 0) + (it.quantity || 0));
        if (order.status === 'CANCELLED' || order.status === 'IN_CANCEL') link.cancelled.add(order.orderSn);
        if (order.status === 'TO_RETURN') link.toReturn.add(order.orderSn);
        if (!valid) continue;
        link.valid.add(order.orderSn);
        link.qty += its.reduce((n, it) => n + (it.quantity || 0), 0);
        const s = itemSales.get(itemId);
        if (isNum(s)) link.sales += s; else link.salesMissing++;
        const share = byItem.size === 1 ? 1 : isNum(s) && totalSales ? s / totalSales : null;
        if (isNum(net) && share !== null && fx) link.net += net * share * fx; else link.netMissing++;
        for (const it of its) { const c = costs?.[it.sku]?.unitCost; if (isNum(c) && isNum(it.quantity)) link.cost += c * it.quantity; else link.costMissing++; }
        // 履约：海外仓取逐单试算里该链接的打包 + 运输；跨境为头程（每双处理费，见 config/business.json）。
        const est = live?.get(`${shop.region}/${order.orderSn}`);
        if (est?.fulfillment === 'cross_border') { link.crossOrders++; if (isNum(est.packingCny) && share !== null) link.fulfil += est.packingCny * share; else link.fulfilMissing++; }
        else { const part = est?.links?.find(l => l.itemId === itemId); if (part && isNum(part.packingCny) && isNum(part.transportCny)) link.fulfil += part.packingCny + part.transportCny; else link.fulfilMissing++; }
      }
    }
    const ads = shop.ads;
    const fxAds = fxFor(shop.currency);
    for (const c of ads?.campaigns || []) if (c.itemIds?.length === 1 && c.expense) { const l = get(shop, c.itemIds[0]); l.ads += fxAds ? c.expense * fxAds : 0; l.adsSource = (l.adsSource || 0) + c.expense; }
    for (const g of ads?.gmsItems || []) if (g.expense) { const l = get(shop, g.itemId); l.ads += fxAds ? g.expense * fxAds : 0; l.adsSource = (l.adsSource || 0) + g.expense; }
    for (const s of shop.stock?.rows || []) { const key = `${shop.shopId}:${s.itemId}`; if (links.has(key) && !links.get(key).name) links.get(key).name = s.itemName; }
  }
  return [...links.values()].map(l => {
    const fx = fxFor(l.shop.currency);
    const salesCny = fx && l.valid.size ? l.sales * fx : l.valid.size ? null : 0;
    const contribution = fx && l.valid.size && !l.netMissing && !l.costMissing ? l.net - l.ads - l.cost - l.fulfil : !l.valid.size && l.ads ? -l.ads : null;
    return { ...l, fx, salesCny, contribution, margin: l.valid.size ? ratio(contribution, l.net) : null, adShare: ratio(l.ads, salesCny), cancelRate: ratio(l.cancelled.size, l.orders.size),
      topSkus: [...l.skus].sort((a, b) => b[1] - a[1]).map(([sku]) => sku) };
  });
}

export default function Products({ ops, market, fxFor, fxNote, profit, days = 7 }) {
  const shops = ops.shops.filter(s => market === 'all' || s.region === market);
  const [costs, setCosts] = useState({ loading: true });
  const [sort, setSort] = useState(['sales', -1]), [filter, setFilter] = useState('all'), [query, setQuery] = useState(''), [page, setPage] = useState(0);
  const skuList = useMemo(() => [...new Set(ops.shops.flatMap(s => (s.orders?.rows || []).flatMap(r => (r.items || []).map(i => i.sku)).filter(Boolean)))].sort(), [ops.shops]);
  useEffect(() => {
    if (!skuList.length) return;
    let off = false;
    fetch('/api/sku-costs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skus: skuList }) })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('成本档案读取失败'))).then(d => !off && setCosts(d)).catch(e => !off && setCosts({ error: e.message }));
    return () => { off = true; };
  }, [skuList.join('|')]);
  const liveReady = profit?.data?.mode === 'live';
  const live = useMemo(() => liveReady ? new Map(profit.data.orders.map(o => [`${o.region}/${o.orderSn}`, o])) : null, [profit?.data]);
  const links = useMemo(() => buildLinks(shops, costs.costs, fxFor, live), [shops, costs, fxFor, live]);
  const q = query.trim().toLowerCase();
  const filtered = links.filter(l => (filter === 'all' ? l.valid.size || l.ads : filter === 'loss' ? l.valid.size && l.contribution !== null && l.contribution < 0 : filter === 'adNoOrder' ? l.ads >= 1 && !l.valid.size : filter === 'cancel' ? l.orders.size >= 3 && l.cancelRate >= .3 : filter === 'missing' ? l.costMissing || l.netMissing || (l.valid.size && l.fulfilMissing) : true)
    && (!q || [String(l.itemId), l.name, ...l.topSkus].some(v => String(v).toLowerCase().includes(q))));
  const [key, dir] = sort;
  const sorted = [...filtered].sort((a, b) => { const x = a[key === 'sales' ? 'salesCny' : key], y = b[key === 'sales' ? 'salesCny' : key]; if (!isNum(x) && !isNum(y)) return 0; if (!isNum(x)) return 1; if (!isNum(y)) return -1; return (x - y) * dir; });
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE)), cur = Math.min(page, pages - 1);
  const active = links.filter(l => l.valid.size);
  const totalSales = active.reduce((n, l) => n + (l.salesCny || 0), 0);
  const top10 = [...active].sort((a, b) => (b.salesCny || 0) - (a.salesCny || 0)).slice(0, 10).reduce((n, l) => n + (l.salesCny || 0), 0);
  const counts = { loss: links.filter(l => l.valid.size && l.contribution !== null && l.contribution < 0).length, adNoOrder: links.filter(l => l.ads >= 1 && !l.valid.size).length, cancel: links.filter(l => l.orders.size >= 3 && l.cancelRate >= .3).length, missing: links.filter(l => l.costMissing || l.netMissing || (l.valid.size && l.fulfilMissing)).length };
  const Th = ({ k, children }) => <th className="num sortable" onClick={() => { setSort([k, key === k ? -dir : -1]); setPage(0); }} aria-sort={key === k ? (dir < 0 ? 'descending' : 'ascending') : 'none'}>{children}{key === k && (dir < 0 ? <ArrowDown size={11}/> : <ArrowUp size={11}/>)}</th>;

  if (!ops.data) return <p className="muted">正在读取经营数据…</p>;
  return <section className="insights">
    <div className="kpis">
      <div className="kpi"><span>有销量的商品链接</span><strong>{int(active.length)}</strong><p>{periodLabel(days)}有效订单</p></div>
      <div className="kpi"><span>头部 10 个链接占比</span><strong>{pct(ratio(top10, totalSales))}</strong><p>按 ≈CNY 销售额</p></div>
      <div className="kpi"><span>贡献为负</span><strong className={counts.loss ? 'bad' : ''}>{int(counts.loss)}</strong><p>到手 − 广告 − 采购 − 履约 &lt; 0</p></div>
      <div className="kpi"><span>有广告无订单</span><strong className={counts.adNoOrder ? 'warn' : ''}>{int(counts.adNoOrder)}</strong><p>{periodLabel(days)}广告 ≥ ¥1 但没出单</p></div>
      <div className="kpi"><span>高取消链接</span><strong className={counts.cancel ? 'warn' : ''}>{int(counts.cancel)}</strong><p>≥3 单且取消率 ≥30%</p></div>
    </div>
    <div className="callout"><AlertCircle size={15}/><p><strong>贡献 = 预计到手 − 直接广告 − 采购成本 − 履约费用</strong>。履约为海外仓打包 + 按双运输（多链接订单按成交额拆分打包费）；跨境为头程，按每双处理费计（在 config/business.json 设置）。{liveReady ? '' : '逐单试算尚未就绪，履约费用暂缺。'}巴西无履约规则，标为缺项。采购成本来自 {costs.available ? `成本档案 ${costs.date}` : costs.error || (costs.loading ? '读取中…' : '未找到成本档案')}；广告只计归属唯一商品的计划与 GMV Max 商品消耗。{fxNote}</p></div>
    <div className="toolbar insights-bar">
      <div className="seg" role="group" aria-label="筛选">
        {[['all', '全部'], ['loss', `贡献为负 ${counts.loss}`], ['adNoOrder', `有广告无单 ${counts.adNoOrder}`], ['cancel', `高取消 ${counts.cancel}`], ['missing', `数据缺项 ${counts.missing}`]].map(([k, l]) => <button key={k} aria-pressed={filter === k} onClick={() => { setFilter(k); setPage(0); }}>{l}</button>)}
      </div>
      <label className="search grow"><Search size={14}/><input type="search" placeholder="商品名 / 商品 ID / SKU" value={query} onChange={e => { setQuery(e.target.value); setPage(0); }}/></label>
    </div>
    {sorted.length ? <div className="table-wrap tall"><table className="tbl links-table"><thead><tr>
      <th>#</th><th>商品链接</th><th>站点</th><Th k="qty">有效单 / 件</Th><Th k="sales">销售额</Th><th className="num">到手 ¥</th><th className="num">广告 ¥</th><th className="num">采购 ¥</th><th className="num">履约 ¥</th><Th k="contribution">贡献 ¥</Th><Th k="margin">贡献率</Th><Th k="adShare">广告占比</Th><Th k="cancelRate">取消率</Th>
    </tr></thead><tbody>
      {sorted.slice(cur * PAGE, cur * PAGE + PAGE).map((l, i) => <tr key={l.key}>
        <td className="num muted">{cur * PAGE + i + 1}</td>
        <td className="link-name"><strong title={l.name}>{l.name || `商品 ${l.itemId}`}</strong><small className="mono">ID {l.itemId}{l.toReturn.size ? ` · 退货中 ${l.toReturn.size}` : ''}</small><div className="skus">{l.topSkus.slice(0, 2).map(s => <span className="sku" key={s}>{s}</span>)}{l.topSkus.length > 2 && <span className="sku" title={l.topSkus.slice(2).join('、')}>+{l.topSkus.length - 2}</span>}</div></td>
        <td><span className={`mk mk-${l.shop.region.toLowerCase()}`} title={marketName(l.shop.region)}>{l.shop.region}</span></td>
        <td className="num">{l.valid.size}<small>/ {l.qty} 件</small></td>
        <td className="num strong">{l.valid.size ? short(l.sales) : '—'}<small>{l.shop.currency}</small>{l.salesMissing > 0 && <small className="warn">缺 {l.salesMissing} 单价</small>}</td>
        <td className="num">{l.valid.size ? money(l.net) : '—'}{l.netMissing > 0 && <small className="warn">缺 {l.netMissing}</small>}</td>
        <td className="num">{l.ads ? money(l.ads) : '—'}</td>
        <td className="num">{l.valid.size ? money(l.cost) : '—'}{l.costMissing > 0 && <small className="warn">缺 {l.costMissing} 行</small>}</td>
        <td className="num">{l.valid.size ? money(l.fulfil) : '—'}{l.valid.size > 0 && l.fulfilMissing > 0 && <small className="warn blk">缺 {l.fulfilMissing} 单</small>}{l.crossOrders > 0 && <small className="blk">含跨境 {l.crossOrders} 单</small>}</td>
        <td className={`num strong ${l.contribution < 0 ? 'bad' : ''}`}>{isNum(l.contribution) ? money(l.contribution) : <span className="tag warn plain">待补</span>}</td>
        <td className="num">{isNum(l.margin) ? <span className={`pf-margin ${l.margin < 0 ? 'bad' : l.margin < .15 ? 'warn' : 'good'}`}>{pct(l.margin, 0)}</span> : '—'}</td>
        <td className={`num ${l.adShare > .25 ? 'warn strong' : ''}`}>{l.valid.size ? pct(l.adShare) : l.ads ? '无单' : '—'}</td>
        <td className={`num ${l.orders.size >= 3 && l.cancelRate >= .3 ? 'bad strong' : ''}`}>{pct(l.cancelRate, 0)}<small>{l.cancelled.size}/{l.orders.size}</small></td>
      </tr>)}
    </tbody></table></div> : <div className="card empty"><Trophy size={36}/><h3>没有符合条件的链接</h3><p>可切换筛选或站点。</p></div>}
    <div className="pager"><span>共 {sorted.length} 个链接 · 第 {cur + 1}/{pages} 页</span><div><button className="sm" disabled={cur === 0} onClick={() => setPage(cur - 1)}>上一页</button><button className="sm" disabled={cur + 1 >= pages} onClick={() => setPage(cur + 1)}>下一页</button></div></div>
  </section>;
}
