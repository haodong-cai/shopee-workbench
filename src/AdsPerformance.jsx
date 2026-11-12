import React, { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search, AlertCircle, ChevronDown, Megaphone } from 'lucide-react';
import { money, short, int, pct, ratio, isNum, md, isoFromDmy, marketName, ago, isStale, EXCLUDED, sumBy } from './lib.js';
import { scopeShop, periodLabel } from './window.mjs';
import './ads-performance.css';

const TYPE = { gms: ['全店托管 GMV Max', 'accent'], manual: ['手动出价', 'info'], auto: ['自动出价', 'good'] };
const STATUS = { ongoing: ['投放中', 'good'], scheduled: ['待开始', 'info'], paused: ['已暂停', 'warn'], ended: ['已结束', 'mute'], deleted: ['已删除', 'mute'], closed: ['已关闭', 'mute'] };
const roas = (gmv, spend) => isNum(gmv) && isNum(spend) && spend > 0 ? (gmv / spend).toFixed(2) : '—';
const sum = (rows, key) => rows.length && rows.every(r => isNum(r[key])) ? sumBy(rows, r => r[key]) : rows.length ? null : 0;

/** 商品 → 规格 SKU → SPU（货品档案）。订单里出现过的规格 + 同步时读取的商品资料。 */
function useItemMap(shops) {
  const items = useMemo(() => {
    const map = new Map();
    for (const shop of shops) {
      const get = id => { const key = `${shop.shopId}:${id}`; if (!map.has(key)) map.set(key, { itemId: id, name: '', skus: new Set() }); return map.get(key); };
      for (const [id, info] of Object.entries(shop.ads?.items || {})) { const row = get(Number(id)); if (info.name) row.name = info.name; for (const s of info.skus || []) row.skus.add(s); }
      for (const order of shop.orders?.rows || []) for (const it of order.items || []) { const row = get(it.itemId); if (!row.name && it.name) row.name = it.name; if (it.sku) row.skus.add(it.sku); }
    }
    return map;
  }, [shops]);
  const skuList = useMemo(() => [...new Set([...items.values()].flatMap(r => [...r.skus]))].sort(), [items]);
  const [parts, setParts] = useState({});
  useEffect(() => {
    if (!skuList.length) return;
    let off = false;
    fetch('/api/sku-costs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skus: skuList.slice(0, 20000) }) })
      .then(r => r.ok ? r.json() : null).then(d => { if (!off && d?.costs) setParts(Object.fromEntries(Object.entries(d.costs).map(([sku, v]) => [sku, v.parts || []]))); }).catch(() => {});
    return () => { off = true; };
  }, [skuList.join('|')]);
  return useMemo(() => {
    const out = new Map();
    for (const [key, row] of items) {
      const spus = new Map();
      for (const sku of row.skus) for (const p of parts[sku] || []) { const k = p.spu || p.sku; if (!spus.has(k)) spus.set(k, { code: p.spu || p.sku, name: p.spuName || p.spu || p.sku, role: p.role }); }
      out.set(key, { ...row, skus: [...row.skus].sort(), spus: [...spus.values()].sort((a, b) => (a.role === 'accessory') - (b.role === 'accessory')) });
    }
    return out;
  }, [items, parts]);
}

function SpuChips({ spus, max = 4 }) {
  if (!spus.length) return <span className="muted">SPU 待补</span>;
  return <div className="ap-spus">{spus.slice(0, max).map(s => <span key={s.code} className={`ap-spu ${s.role === 'accessory' ? 'acc' : ''}`} title={`${s.code}${s.role === 'accessory' ? ' · 配件' : s.role === 'shoe_pair' ? ' · 鞋' : ''}`}>{s.name}</span>)}{spus.length > max && <span className="ap-spu more" title={spus.slice(max).map(s => s.name).join('、')}>+{spus.length - max}</span>}</div>;
}

/** 店铺下的广告组：手动 / 自动计划 + 全店托管 GMV Max（一行），按消耗排序。 */
function groupsOf(shop) {
  const ads = shop.ads, groups = [];
  if (ads?.gmsReport || ads?.gmsItems?.length) {
    const r = ads.gmsReport || {};
    groups.push({ key: 'gms', id: ads.gms?.campaignId || ads.reconciliation?.gmsCampaignId, type: 'gms', name: '全店托管 GMV Max', status: null, budget: null,
      expense: isNum(r.expense) ? r.expense : sum(ads.gmsItems, 'expense'), broad_gmv: r.broad_gmv ?? null, broad_order: r.broad_order ?? null, clicks: r.clicks ?? null, impression: r.impression ?? null,
      items: ads.gmsItems.map(i => ({ itemId: i.itemId, expense: i.expense, gmv: i.broad_gmv ?? null })), perItem: true });
  }
  for (const c of ads?.campaigns || []) groups.push({ key: `c${c.campaignId}`, id: c.campaignId, type: c.adType === 'auto' ? 'auto' : 'manual', name: c.name || `广告组 ${c.campaignId}`, status: c.status, budget: c.budget,
    expense: c.expense, broad_gmv: c.broad_gmv ?? null, broad_order: c.broad_order ?? null, clicks: c.clicks ?? null, impression: c.impression ?? null, windowed: c.windowed !== false,
    items: (c.itemIds || []).map(id => ({ itemId: id, expense: c.itemIds.length === 1 ? c.expense : null })), perItem: c.itemIds?.length === 1, listed: c.listed });
  return groups.sort((a, b) => (b.expense ?? -1) - (a.expense ?? -1));
}

function ShopDetail({ shop, full, days, itemMap, filters }) {
  const cur = shop.currency, ads = shop.ads, [openGroup, setOpenGroup] = useState(null);
  const trendDays = Math.max(days, 7), trend = scopeShop(full, trendDays).ads?.daily || [];
  const winDates = new Set(ads?.period?.dates || []);
  const maxSpend = Math.max(1, ...trend.map(d => d.expense || 0));
  const sold = useMemo(() => { const m = new Map(); for (const o of shop.orders?.rows || []) { if (EXCLUDED.includes(o.status)) continue; for (const it of o.items || []) m.set(it.itemId, (m.get(it.itemId) || 0) + (it.quantity || 0)); } return m; }, [shop]);
  const q = filters.query.trim().toLowerCase();
  const itemMatches = i => { const info = itemMap.get(`${shop.shopId}:${i.itemId}`); return String(i.itemId).includes(q) || Boolean(info && (info.name.toLowerCase().includes(q) || info.skus.some(s => s.toLowerCase().includes(q)) || info.spus.some(s => s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q)))); };
  const groups = groupsOf(shop).filter(g => (filters.type === 'all' || g.type === filters.type) && (!filters.spendOnly || (g.expense || 0) > 0) &&
    (!q || [g.name, String(g.id || '')].some(v => v.toLowerCase().includes(q)) || g.items.some(itemMatches)));
  return <div className="ap-detail">
    <div className="ap-trend">
      <h3>近期消耗 · {trendDays} 天<small>深色为所选周期</small></h3>
      <div className="ap-bars" role="img" aria-label="每日广告消耗">{trend.map(d => <div key={d.date} className={`ap-day ${winDates.has(d.date) ? 'on' : ''}`} title={`${md(isoFromDmy(d.date))} · 消耗 ${money(d.expense, cur)} ${cur} · ROAS ${roas(d.broad_gmv, d.expense)} · 订单 ${int(d.broad_order)}`}>
        <i style={{ height: `${Math.max(2, (d.expense || 0) / maxSpend * 100)}%` }}/><span>{md(isoFromDmy(d.date)).slice(3)}</span></div>)}</div>
    </div>
    <h3 className="ap-h3">广告组 · {periodLabel(days)}<small>{groups.length} 个</small></h3>
    {groups.length ? <div className="table-wrap"><table className="tbl ap-groups"><thead><tr><th>广告组</th><th>类型 / 状态</th><th className="num">消耗</th><th className="num">GMV</th><th className="num">ROAS</th><th className="num">订单</th><th className="num">点击</th><th>主推 SPU</th><th/></tr></thead><tbody>
      {groups.map(g => {
        const isOpen = openGroup === g.key, [typeText, typeTone] = TYPE[g.type], st = STATUS[g.status];
        const infos = g.items.map(i => ({ ...i, info: itemMap.get(`${shop.shopId}:${i.itemId}`) }));
        const spus = [...new Map(infos.flatMap(i => i.info?.spus || []).map(s => [s.code, s])).values()].sort((a, b) => (a.role === 'accessory') - (b.role === 'accessory'));
        return <React.Fragment key={g.key}>
          <tr className={isOpen ? 'row-open' : ''}>
            <td className="ap-name"><strong title={g.name}>{g.name}</strong><small className="mono">{g.id ? `ID ${g.id}` : ''}{g.items.length ? ` · ${g.items.length} 个商品` : ' · 商品待补'}{g.listed === false ? ' · 列表外补查' : ''}</small></td>
            <td><span className={`tag ${typeTone}`}>{typeText}</span>{st ? <small><span className={`tag plain ${st[1]}`}>{st[0]}</span></small> : null}{isNum(g.budget) && g.budget > 0 && <small>日预算 {money(g.budget, cur)}</small>}</td>
            <td className="num strong">{g.windowed === false ? <span className="warn" title="旧数据只有整段合计，重新同步广告后可按周期查看">需重新同步</span> : money(g.expense, cur)}</td>
            <td className="num">{money(g.broad_gmv, cur)}</td><td className="num">{roas(g.broad_gmv, g.expense)}</td><td className="num">{int(g.broad_order)}</td><td className="num">{int(g.clicks)}</td>
            <td><SpuChips spus={spus}/></td>
            <td><button className="ghost sm icon-sm" aria-expanded={isOpen} aria-label="查看商品" onClick={() => setOpenGroup(isOpen ? null : g.key)} disabled={!g.items.length}><ChevronDown size={15} className={isOpen ? 'flip' : ''}/></button></td>
          </tr>
          {isOpen && <tr className="detail"><td colSpan={9}><div className="ap-items">
            <table className="tbl"><thead><tr><th>商品</th><th>SPU</th><th>规格 SKU</th><th className="num">{g.perItem ? '消耗' : '消耗（组内不分商品）'}</th>{g.type === 'gms' && <th className="num">GMV</th>}<th className="num">同期销量</th></tr></thead><tbody>
              {infos.sort((a, b) => (b.expense ?? -1) - (a.expense ?? -1) || (sold.get(b.itemId) || 0) - (sold.get(a.itemId) || 0)).slice(0, 200).map(i => <tr key={i.itemId}>
                <td className="ap-item"><strong title={i.info?.name}>{i.info?.name || '商品名称待补'}</strong><small className="mono">ID {i.itemId}</small></td>
                <td><SpuChips spus={i.info?.spus || []} max={3}/></td>
                <td><div className="skus">{(i.info?.skus || []).slice(0, 3).map(s => <span className="sku" key={s}>{s}</span>)}{(i.info?.skus?.length || 0) > 3 && <span className="sku" title={i.info.skus.slice(3).join('、')}>+{i.info.skus.length - 3}</span>}{!i.info?.skus?.length && <span className="muted">待补</span>}</div></td>
                <td className="num">{isNum(i.expense) ? money(i.expense, cur) : '—'}</td>{g.type === 'gms' && <td className="num">{money(i.gmv, cur)}</td>}<td className="num">{int(sold.get(i.itemId) || 0)}</td>
              </tr>)}
            </tbody></table>
            {infos.length > 200 && <p className="note">只显示消耗最高的 200 个商品。</p>}
            {!g.perItem && g.type !== 'gms' && <p className="note">手动 / 自动广告组的消耗平台只给整组合计，接口拿不到组内每个商品各花了多少。</p>}
          </div></td></tr>}
        </React.Fragment>;
      })}
    </tbody></table></div> : <p className="muted ap-empty">没有符合筛选条件的广告组。</p>}
    {ads?.warnings?.map((w, i) => <div className="callout warn" key={i}><AlertCircle size={15}/><p>{w}</p></div>)}
    {ads?.reconciliation && <p className="note">核对：店铺总消耗 {money(ads.total, cur)} − 广告组 {money(ads.reconciliation.planTotal, cur)} − GMV Max {money(ads.reconciliation.gmsTotal ?? 0, cur)} = 差额 {money(ads.reconciliation.gap, cur)} {cur}。差额来自平台未列出的计划或统计时差，不强行分摊。</p>}
  </div>;
}

export default function AdsPerformance({ shops, fullShops, days, balance, fxFor, ops, scopeIds }) {
  const [open, setOpen] = useState(() => shops.length === 1 ? shops[0].shopId : null);
  const [filters, setFilters] = useState({ type: 'all', spendOnly: true, query: '' });
  const itemMap = useItemMap(fullShops.filter(f => shops.some(s => s.shopId === f.shopId)));
  const rows = shops.map(shop => {
    const ads = shop.ads, daily = ads?.daily || [], fx = fxFor(shop.currency);
    const valid = (shop.orders?.rows || []).filter(o => !EXCLUDED.includes(o.status)), sales = valid.every(o => isNum(o.totalAmount)) ? sumBy(valid, o => o.totalAmount) : null;
    const m = { spend: isNum(ads?.total) ? ads.total : null, gmv: sum(daily, 'broad_gmv'), orders: sum(daily, 'broad_order'), clicks: sum(daily, 'clicks'), imps: sum(daily, 'impression') };
    const bal = (balance?.shops || []).find(b => b.shopId === shop.shopId);
    const gap = ads?.reconciliation?.gap, flag = (ads?.warnings?.length || 0) > 0 || (isNum(gap) && m.spend && Math.abs(gap) >= Math.max(1, m.spend * 0.005));
    return { shop, ads, fx, sales, bal, flag, ...m };
  });
  const withFx = rows.filter(r => r.fx);
  const cny = key => withFx.length ? withFx.reduce((n, r) => n + (isNum(r[key]) ? r[key] * r.fx : 0), 0) : null;
  const T = { spend: cny('spend'), gmv: cny('gmv'), sales: cny('sales'), orders: rows.reduce((n, r) => n + (r.orders || 0), 0), clicks: rows.reduce((n, r) => n + (r.clicks || 0), 0), imps: rows.reduce((n, r) => n + (r.imps || 0), 0) };
  const missingFx = rows.filter(r => !r.fx).map(r => r.shop.region);
  const set = (k, v) => setFilters(f => ({ ...f, [k]: v }));

  return <div className="ap">
    <div className="kpis ap-kpis">
      <div className="kpi"><span>广告消耗 ≈ CNY</span><strong>{isNum(T.spend) ? `¥${short(T.spend)}` : '—'}</strong><p>{periodLabel(days)} · 日均 ¥{isNum(T.spend) ? short(T.spend / days) : '—'}{missingFx.length ? ` · 不含 ${missingFx.join('、')}` : ''}</p></div>
      <div className="kpi"><span>广告带来 GMV ≈ CNY</span><strong>{isNum(T.gmv) ? `¥${short(T.gmv)}` : '—'}</strong><p>点击后 7 天内全店成交（宽口径）</p></div>
      <div className="kpi"><span>ROAS</span><strong className={isNum(T.spend) && T.spend > 0 && T.gmv / T.spend < 3 ? 'warn' : ''}>{roas(T.gmv, T.spend)}</strong><p>每花 1 元带来的 GMV</p></div>
      <div className="kpi"><span>广告订单</span><strong>{int(T.orders)}</strong><p>单均成本 ¥{isNum(T.spend) && T.orders ? short(T.spend / T.orders) : '—'}</p></div>
      <div className="kpi"><span>点击率 · 点击成本</span><strong>{pct(ratio(T.clicks, T.imps), 2)}</strong><p>{int(T.clicks)} 次点击 · 每次 ¥{isNum(T.spend) && T.clicks ? (T.spend / T.clicks).toFixed(2) : '—'}</p></div>
      <div className="kpi"><span>广告占销售额</span><strong className={ratio(T.spend, T.sales) > .2 ? 'warn' : ''}>{pct(ratio(T.spend, T.sales))}</strong><p>同期有效订单销售额 ¥{isNum(T.sales) ? short(T.sales) : '—'}</p></div>
    </div>

    <div className="toolbar ap-bar">
      <div className="seg" role="group" aria-label="广告类型">{[['all', '全部类型'], ['gms', 'GMV Max'], ['manual', '手动'], ['auto', '自动']].map(([k, l]) => <button key={k} aria-pressed={filters.type === k} onClick={() => set('type', k)}>{l}</button>)}</div>
      <label className="check"><input type="checkbox" checked={filters.spendOnly} onChange={e => set('spendOnly', e.target.checked)}/>只看有消耗的广告组</label>
      <label className="search grow"><Search size={14}/><input type="search" placeholder="广告组名 / 商品 ID / SKU / SPU" value={filters.query} onChange={e => set('query', e.target.value)}/></label>
      <button onClick={() => ops.sync(['ads'], scopeIds)} disabled={ops.busy}><RefreshCw size={14} className={ops.busy ? 'spin' : ''}/>{ops.busy ? '同步中' : '同步广告'}</button>
    </div>

    {rows.length ? <div className="ap-shops">{rows.map(r => {
      const { shop } = r, cur = shop.currency, isOpen = open === shop.shopId || filters.query.trim() !== '';
      const block = shop.ads, state = shop.connectionError || block?.error ? ['bad', '查询失败'] : !block?.updatedAt ? ['', '待同步'] : isStale(block.updatedAt) ? ['warn', '超过 24 小时'] : r.flag ? ['warn', '费用覆盖待核'] : ['good', `${ago(block.updatedAt)}同步`];
      const full = fullShops.find(f => f.shopId === shop.shopId) || shop;
      return <section className={`ap-shop card ${isOpen ? 'open' : ''}`} key={shop.shopId}>
        <button className="ap-row" onClick={() => setOpen(open === shop.shopId ? null : shop.shopId)} aria-expanded={isOpen}>
          <span className={`mk mk-${shop.region.toLowerCase()}`}>{shop.region}</span>
          <span className="ap-shopname"><strong>{shop.name}</strong><small>{marketName(shop.region)} · {cur}</small></span>
          <span className="ap-cell"><small>消耗</small><b className="num">{money(r.spend, cur)}</b><em>{r.fx && isNum(r.spend) ? `≈ ¥${short(r.spend * r.fx)}` : ''}</em></span>
          <span className="ap-cell"><small>GMV</small><b className="num">{short(r.gmv)}</b></span>
          <span className="ap-cell"><small>ROAS</small><b className="num">{roas(r.gmv, r.spend)}</b></span>
          <span className="ap-cell"><small>订单</small><b className="num">{int(r.orders)}</b></span>
          <span className="ap-cell"><small>占销售额</small><b className={`num ${ratio(r.spend, r.sales) > .2 ? 'warn' : ''}`}>{pct(ratio(r.spend, r.sales))}</b></span>
          <span className="ap-cell"><small>余额</small><b className={`num ${r.bal?.low ? 'bad' : ''}`}>{r.bal ? short(r.bal.balance) : '—'}</b><em>{isNum(r.bal?.days) ? `可用 ${r.bal.days >= 99 ? '99+' : r.bal.days.toFixed(1)} 天` : ''}</em></span>
          <span className={`tag ${state[0]}`} title={block?.error || ''}>{state[1]}</span>
          <ChevronDown size={16} className={isOpen ? 'flip' : ''}/>
        </button>
        {isOpen && (block?.daily ? <ShopDetail shop={shop} full={full} days={days} itemMap={itemMap} filters={filters}/> : <p className="muted ap-empty">{block?.error || '暂无广告数据，点击“同步广告”。'}</p>)}
      </section>;
    })}</div> : <div className="card empty"><Megaphone size={36}/><h3>还没有广告数据</h3><p>点击“同步广告”读取各店广告表现。</p></div>}
    <p className="note ap-note">金额为店铺原币，人民币按当日参考汇率折算，仅供跨站对比。GMV、订单为平台归因口径（点击后 7 天内），不等于实际订单。SPU 来自货品档案：组合装拆成单品后显示，配件以浅色标出。</p>
  </div>;
}
