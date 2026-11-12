import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutDashboard, ShoppingBag, Receipt, Megaphone, Undo2, Calculator, FileSpreadsheet, Database, RefreshCw, Sun, Moon, Trophy, PackageX } from 'lucide-react';
import './workbench.css';
import Overview from './Overview.jsx';
import Operations from './Operations.jsx';
import ProfitEstimates from './ProfitEstimates.jsx';
import DataHub from './DataHub.jsx';
import Products from './Products.jsx';
import Inventory from './Inventory.jsx';
import Returns from './Returns.jsx';
import { returnRows } from './returns-model.mjs';
import { PERIODS, DAY_OPTIONS, scopeShop, windowPeriod } from './window.mjs';
import { shipSummary } from './OrderInsights.jsx';
import { MARKETS, ORDER_ORDER, ago, sortByMarket, useJson, stamp } from './lib.js';

const NAV = [
  ['', [['overview', '今日概览', LayoutDashboard]]],
  ['经营', [['orders', '订单', ShoppingBag], ['products', '商品排行', Trophy], ['inventory', '断货预警', PackageX], ['fees', '平台扣费', Receipt], ['ads', '广告与余额', Megaphone], ['returns', '退货售后', Undo2]]],
  ['利润', [['profit', '毛利试算', Calculator]]],
  ['工具', [['listing', '批量上架', FileSpreadsheet]]],
  ['系统', [['data', '数据与接入', Database]]]
];
const PAGES = Object.fromEntries(NAV.flatMap(([, items]) => items.map(([key, label]) => [key, label])));
const INTRO = {
  overview: '五站经营一屏看完：先处理异常，再看各站表现。',
  orders: '所选周期的订单与取消原因（按店铺当地日期）；发货时效列出全部待发货订单。',
  products: '按商品链接汇总销量、到手、广告、采购与履约成本，找出亏钱和吃广告的链接。',
  inventory: '海外仓在库 + 在途，结合销量预测哪些单品会断货，提前关广告、控销量。',
  fees: '佣金、服务费、手续费与平台预计净收入。',
  ads: '广告消耗、归因转化、费用核对与余额可用天数。',
  returns: '退货退款与仅退款分开跟进：待我处理的事项、退回物流与平台截止时间。',
  profit: '每次同步后按所选周期自动重算逐单毛利：收入、采购、履约与广告，统一折算人民币。',
  listing: '商品表 → 官方模板 → 本地校验 → 导出上架 Excel。',
  data: '自动同步设置、各店铺各数据块的同步状态，以及本地授权配置。'
};
const OPS = ['orders', 'fees', 'ads', 'returns'];
const readTheme = () => { try { return localStorage.getItem('hub-theme') || ''; } catch { return ''; } };
const readRoute = () => { const [hash, sub = ''] = location.hash.slice(1).split('/'); return PAGES[hash] ? [hash, sub] : ['overview', '']; };

function useOperations() {
  const [data, setData] = useState(null), [error, setError] = useState(''), [sending, setSending] = useState(false);
  const timer = useRef(), rev = useRef(null), running = useRef(false);
  async function load() {
    clearTimeout(timer.current);
    try {
      // 带上次的 rev：快照没变化时服务端只回任务状态，不重复传整份数据。
      // 同步进行中只问进度（每个数据块保存都会变 rev，不必每 2.5 秒下载整份快照），结束后再取一次完整数据。
      const query = rev.current === null ? '' : running.current ? `?rev=${rev.current}&job=1` : `?rev=${rev.current}`;
      const response = await fetch(`/api/operations${query}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('经营数据读取失败');
      const value = await response.json();
      const wasRunning = running.current; running.current = Boolean(value.job?.running);
      if (value.unchanged) { setData(current => current ? { ...current, job: value.job, generatedAt: value.generatedAt } : current); if (wasRunning && !running.current) { clearTimeout(timer.current); timer.current = setTimeout(load, 200); setError(''); return; } }
      else { rev.current = value.rev ?? null; setData(value); }
      setError('');
      timer.current = setTimeout(load, value.job?.running ? 2500 : 30000);
    } catch (e) { setError(e.message); timer.current = setTimeout(load, 10000); }
  }
  useEffect(() => { load(); return () => clearTimeout(timer.current); }, []);
  async function sync(kinds, shopIds) {
    setSending(true); setError('');
    try {
      const response = await fetch('/api/operations/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(kinds ? { kinds } : {}), ...(shopIds?.length ? { shopIds } : {}) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '同步启动失败');
      setData(current => ({ ...(current || { shops: [] }), job: result })); running.current = Boolean(result.running);
      clearTimeout(timer.current); timer.current = setTimeout(load, 1500);
    } catch (e) { setError(e.message); }
    finally { setSending(false); }
  }
  const shops = useMemo(() => [...(data?.shops || [])].sort(sortByMarket), [data]);
  return { data, shops, error, sync, busy: sending || !!data?.job?.running, job: data?.job, reload: load };
}

export default function Workbench({ children }) {
  const [[page, sub], setRoute] = useState(readRoute);
  const setPage = next => setRoute(next.split('/').length > 1 ? next.split('/') : [next, '']);
  const [market, setMarket] = useState('all');
  const [days, setDays] = useState(() => { try { const v = Number(localStorage.getItem('hub-days')); return DAY_OPTIONS.includes(v) ? v : 1; } catch { return 1; } });
  const pickDays = d => { setDays(d); try { localStorage.setItem('hub-days', String(d)); } catch { /* 本机偏好可选 */ } };
  const [theme, setTheme] = useState(readTheme);
  const ops = useOperations();
  const ads = useJson('/api/ads-monitor', { interval: 60000 });
  const fx = useJson('/api/fx', { interval: 10 * 60000 });
  const fxFor = useMemo(() => currency => fx.data?.rates?.[currency]?.cnyPerUnit || null, [fx.data]);
  const fxNote = fx.data?.lastSuccessAt ? '人民币按每日参考汇率折算。' : '每日汇率尚未取得，人民币列暂缺。';
  const schedule = useJson('/api/schedule', { interval: 60000 });
  const lan = useJson('/api/lan', { interval: 60000 });
  // 页面文件更新后，如果后台服务还没重启，新页面会配着旧服务跑（同步仍按旧逻辑）。对比版本号提醒重启。
  const health = useJson('/api/health', { interval: 5 * 60000 });
  const pageVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;
  const staleServer = pageVersion && health.data?.version && health.data.version !== pageVersion ? health.data.version : null;
  // 毛利随同步结果自动重算：订单 / 扣费 / 广告任一数据块更新后重新读取。
  const profit = useJson(`/api/profit-estimates?days=${days}`);
  const profitKey = ops.shops.map(s => [s.orders?.updatedAt, s.fees?.updatedAt, s.ads?.updatedAt].join()).join('|');
  const inv = useJson('/api/inventory', { interval: 10 * 60000 });
  const seenKey = useRef(null);
  useEffect(() => { if (!ops.data) return; if (seenKey.current !== null && seenKey.current !== profitKey) { profit.reload(); schedule.reload(); inv.reload(); } seenKey.current = profitKey; }, [profitKey, !!ops.data]);

  useEffect(() => {
    const dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [theme]);
  useEffect(() => { const onHash = () => setRoute(readRoute()); addEventListener('hashchange', onHash); return () => removeEventListener('hashchange', onHash); }, []);
  useEffect(() => { document.title = `${PAGES[page]} · 虾皮控制中台`; }, [page]);

  function go(next, nextMarket) {
    if (nextMarket) setMarket(nextMarket);
    if (next !== [page, sub].filter(Boolean).join('/')) { history.pushState(null, '', `#${next}`); setPage(next); }
    window.scrollTo({ top: 0 });
  }
  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    setTheme(next); try { localStorage.setItem('hub-theme', next); } catch { /* 本机偏好可选 */ }
  }

  const markets = useMemo(() => {
    const codes = new Set([...ops.shops.map(s => s.region), ...(ads.data?.shops || []).map(s => s.region)].filter(Boolean));
    return ORDER_ORDER.filter(code => codes.has(code)).concat([...codes].filter(code => !ORDER_ORDER.includes(code)));
  }, [ops.shops, ads.data]);
  const scopeIds = market === 'all' ? undefined : ops.shops.filter(s => s.region === market).map(s => s.shopId);

  const badges = useMemo(() => {
    const inScope = ops.shops.filter(s => market === 'all' || s.region === market);
    const pending = inScope.reduce((n, s) => n + (s.orders?.rows || []).filter(r => r.status === 'PROCESSED' || r.status === 'READY_TO_SHIP').length, 0);
    const returns = returnRows(inScope).filter(r => r.stage === 'action').length;
    const lowAds = (ads.data?.shops || []).filter(s => (market === 'all' || s.region === market) && (s.low || s.status === 'failed' || s.status === 'stale')).length;
    const failed = ops.shops.filter(s => s.connectionError || ['orders', 'fees', 'ads', 'returns'].some(k => s[k]?.error)).length;
    const ship = shipSummary(inScope), urgent = ship.count.overdue + ship.count.h12 + ship.count.h24;
    const short = (inv.data?.forecast?.rows || []).filter(r => (market === 'all' || r.site === market) && ['out', 'gap', 'late'].includes(r.state)).length;
    return { orders: urgent ? [urgent, ship.count.overdue > 0] : pending ? [pending] : null, inventory: short ? [short, true] : null, returns: returns ? [returns, true] : null, ads: lowAds ? [lowAds, true] : null, data: failed ? [failed, true] : null };
  }, [ops.shops, ads.data, market, inv.data]);

  const lastSync = ops.shops.map(s => s.orders?.updatedAt).filter(Boolean).sort().at(-1);
  const showMarkets = page !== 'listing' && page !== 'data';
  // 统计周期：同步保存近 30 天，各页按所选周期切片（发货时效、退货、断货预警不受影响）。
  const showPeriod = ['overview', 'orders', 'products', 'fees', 'ads', 'profit'].includes(page);
  const scoped = useMemo(() => ops.shops.map(shop => scopeShop(shop, days)), [ops.shops, days]);
  const scopedOps = useMemo(() => ({ ...ops, shops: scoped }), [ops, scoped]);
  const range = useMemo(() => { const w = ops.shops.map(s => windowPeriod(s.orders?.period, days)).filter(Boolean); if (!w.length) return ''; const start = w.map(x => x.start).sort()[0], end = w.map(x => x.end).sort().at(-1); const f = d => `${d.slice(5, 7)}/${d.slice(8, 10)}`; return start === end ? f(end) : `${f(start)}–${f(end)}`; }, [ops.shops, days]);
  const short = ops.shops.some(s => windowPeriod(s.orders?.period, days)?.short);

  return <div className="shell">
    <a className="skip" href="#content">跳到主要内容</a>
    <aside className="side">
      <div className="brand"><div className="brand-mark" aria-hidden="true">虾</div><div><strong>虾皮控制中台</strong><span>{markets.length ? `${markets.length} 个站点 · 本机工作区` : '本机工作区'}</span></div></div>
      <nav aria-label="主导航">{NAV.map(([group, items]) => <div className="nav-group" key={group || 'home'}>
        {group && <span>{group}</span>}
        {items.map(([key, label, Icon]) => <button key={key} className="nav-item" aria-current={page === key ? 'page' : undefined} onClick={() => go(key)}>
          <Icon size={17} strokeWidth={2}/>{label}{badges[key] && <span className={`nav-badge ${badges[key][1] ? 'hot' : ''}`}>{badges[key][0]}</span>}
        </button>)}
      </div>)}</nav>
      <div className="side-foot">
        <span><i className={`live-dot ${ops.busy ? 'busy' : ops.error ? 'off' : ''}`}/>{ops.busy ? '正在同步…' : ops.error ? '本地服务未响应' : <>经营数据 <b>{ago(lastSync)}</b></>}</span>
        {schedule.data?.available && <span title="可在“数据与接入”调整">{schedule.data.config.enabled ? <>自动同步 <b>{schedule.data.running ? '进行中' : schedule.data.nextIntervalAt || schedule.data.nextFullAt ? `下次 ${stamp([schedule.data.nextIntervalAt, schedule.data.nextFullAt].filter(Boolean).sort()[0]).slice(-5)}` : '已开启'}</b></> : '自动同步已关闭'}</span>}
        {lan.data?.available && (lan.data.local ? lan.data.enabled && <span title={lan.data.urls?.map(u => u.url).join('\n')}>局域网访问 <b>已开启</b>{lan.data.recent ? ` · ${lan.data.recent} 台设备在用` : ''}</span> : <span>通过局域网访问</span>)}
        <span>只读 Shopee 开放平台 · 不写回店铺</span>
      </div>
    </aside>

    <div className="main">
      <header className="topbar">
        <div className="topbar-title"><h1>{PAGES[page]}</h1><p>{INTRO[page]}</p></div>
        <div className="topbar-actions">
          {showPeriod && <div className="markets periods" role="group" aria-label="统计周期" title={short ? '已同步的数据不足所选天数，下次全量同步后补齐（同步保存近 30 天）' : '各站按当地完整自然日统计'}>
            {PERIODS.map(([d, label]) => <button key={d} aria-pressed={days === d} onClick={() => pickDays(d)}>{label}</button>)}
            {range && <span className="period-range">{range}{short ? ' *' : ''}</span>}
          </div>}
          {showMarkets && markets.length > 0 && <div className="markets" role="group" aria-label="站点范围">
            <button aria-pressed={market === 'all'} onClick={() => setMarket('all')}>全部</button>
            {markets.map(code => <button key={code} aria-pressed={market === code} onClick={() => setMarket(code)} title={MARKETS[code]?.name}><i className={`dot mk-${code.toLowerCase()}`}/>{code}</button>)}
          </div>}
          {(OPS.includes(page) || ['overview', 'products'].includes(page)) && <>
            <span className="sync-note" role="status">{ops.job?.running ? `正在读取：${ops.job.progress}` : ops.job?.error ? `上次同步失败：${ops.job.error}` : ''}</span>
            <button onClick={() => ops.sync(undefined, scopeIds)} disabled={ops.busy} title={market === 'all' ? '同步全部店铺的订单、扣费、广告与退货' : `同步 ${market} 店铺`}>
              <RefreshCw size={15} className={ops.busy ? 'spin' : ''}/>{ops.busy ? '同步中' : market === 'all' ? '同步全部' : `同步 ${market}`}
            </button>
          </>}
          <button className="ghost icon" onClick={toggleTheme} aria-label="切换深浅色" title="切换深浅色">{theme === 'dark' || (!theme && matchMedia('(prefers-color-scheme: dark)').matches) ? <Sun size={16}/> : <Moon size={16}/>}</button>
        </div>
      </header>

      {staleServer && <div className="hub-message hub-error stale-server" role="alert">后台服务还在运行旧版本 {staleServer}，页面已经是 {pageVersion}，同步仍按旧逻辑进行。请在主机电脑上双击“启动工作台.cmd”重启后再同步。</div>}
      <div id="content" tabIndex={-1}>
        <div className="page" hidden={page !== 'listing'}>{children}</div>
        {page !== 'listing' && <main className="page">
          {page === 'overview' && <Overview ops={scopedOps} fullShops={ops.shops} days={days} ads={ads} fx={fx} profit={profit} inv={inv} market={market} go={go}/>}
          {OPS.includes(page) && page !== 'returns' && <Operations key={`${page}/${sub}`} view={page} sub={sub} ops={scopedOps} fullShops={ops.shops} days={days} fxFor={fxFor} market={market} ads={ads}/>}
          {page === 'returns' && <Returns ops={ops} market={market} scopeIds={scopeIds}/>}
          {page === 'products' && <Products ops={scopedOps} days={days} market={market} fxFor={fxFor} fxNote={fxNote} profit={profit}/>}
          {page === 'inventory' && <Inventory inv={inv} market={market} sub={sub} go={go}/>}
          {page === 'profit' && <ProfitEstimates market={market} fx={fx} live={profit} days={days}/>}
          {page === 'data' && <DataHub ops={ops} ads={ads} fx={fx} schedule={schedule} lan={lan} go={go}/>}
        </main>}
      </div>
    </div>
  </div>;
}
