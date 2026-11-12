import React, { useState } from 'react';
import { RefreshCw, AlertCircle, ArrowUpRight } from 'lucide-react';
import { money, stamp, isNum, md, isoFromDmy, marketName } from './lib.js';
import './ads-balance.css';

const LABEL = { ready: '余额充足', low: '不足 3 天', failed: '查询失败', stale: '数据已过期', no_spend: '近 7 日无消耗', unknown: '待检查' };
const TONE = { ready: 'good', low: 'bad', failed: 'bad', stale: 'warn', no_spend: '', unknown: '' };

export default function AdsBalance({ ads, market = 'all' }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const data = ads.data;
  async function check() {
    setBusy(true); setError('');
    try { const response = await fetch('/api/ads-monitor/check', { method: 'POST', cache: 'no-store' }); if (!response.ok) throw new Error('广告监控服务读取失败，请稍后重新检查。'); await ads.reload(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  const working = busy || data?.running;
  const shops = (data?.shops || []).filter(s => market === 'all' || s.region === market);
  const tone = row => row.status === 'ready' && isNum(row.days) && row.days < 7 ? 'warn' : TONE[row.status];
  return <section className="ads-balance" aria-label="广告余额监控" aria-busy={working}>
    <div className="kpis ab-kpis">
      <div className="kpi"><span>监控店铺</span><strong>{data ? shops.length : '—'}</strong><p>每 24 小时自动检查</p></div>
      <div className="kpi"><span>不足 3 天</span><strong className={shops.some(s => s.low) ? 'bad' : ''}>{data ? shops.filter(s => s.low).length : '—'}</strong><p>需立即充值</p></div>
      <div className="kpi"><span>7 天内耗尽</span><strong className={shops.some(s => !s.low && isNum(s.days) && s.days < 7) ? 'warn' : ''}>{data ? shops.filter(s => !s.low && isNum(s.days) && s.days < 7).length : '—'}</strong><p>本周安排充值</p></div>
      <div className="kpi"><span>上次检查</span><strong className="ab-time">{stamp(data?.lastAttemptAt)}</strong><p>下次 {stamp(data?.nextCheckAt)} · 北京时间</p></div>
    </div>
    <div className="toolbar ab-bar"><p className="muted">预计可用天数 = 广告总余额 ÷ 近 7 个完整自然日平均消耗。缺日或查询失败时不估算。</p><button onClick={check} disabled={working}><RefreshCw size={14} className={working ? 'spin' : ''}/>{working ? '正在查询…' : '立即检查余额'}</button></div>
    {(error || ads.error) && <div className="hub-message hub-error" role="alert"><AlertCircle size={16}/>{error || ads.error}</div>}
    {data?.error && <div className="hub-message hub-error" role="alert"><AlertCircle size={16}/>{data.error}</div>}
    {!data && !ads.error && <p className="muted" role="status">正在读取本地监控记录…</p>}
    {data && <div className="ab-grid">{shops.length ? shops.map(row => {
      const t = tone(row), days = row.days, cur = row.currency;
      return <article className={`ab-card card tone-${t || 'none'}`} key={row.shopId}>
        <header><span className={`mk mk-${String(row.region).toLowerCase()}`}>{row.region || '?'}</span><div><strong>{row.name}</strong><span>{marketName(row.region)} · ID {row.shopId}</span></div><span className={`tag ${t}`}>{t === 'warn' && row.status === 'ready' ? '7 天内耗尽' : LABEL[row.status]}</span></header>
        <div className="ab-days"><strong className="num">{isNum(days) ? days >= 99 ? '99+' : days.toFixed(1) : '—'}</strong><span>天可用</span></div>
        <div className={`meter ${t}`}><i style={{ width: `${isNum(days) ? Math.min(100, days / 14 * 100) : 0}%` }}/></div>
        <div className="ab-scale"><span>0</span><span className="ab-mark3">3 天</span><span className="ab-mark7">7 天</span><span>14 天+</span></div>
        <dl>
          <div><dt>广告余额 · {cur || '币种待确认'}</dt><dd className="num">{money(row.balance, cur)}{row.error && isNum(row.balance) && <small> 历史</small>}</dd></div>
          <div><dt>近 7 日日均消耗</dt><dd className="num">{money(row.dailyAverage, cur)}</dd></div>
          <div><dt>统计区间</dt><dd className="num">{row.spendDates?.length === 7 ? `${md(isoFromDmy(row.spendDates[0]))}–${md(isoFromDmy(row.spendDates[6]))}` : '完整 7 日待补'}</dd></div>
          <div><dt>平台余额时间</dt><dd className="num">{stamp(row.balanceAt)}{row.stale && <small className="warn"> 已超 24h</small>}</dd></div>
        </dl>
        {row.error && <p className="ab-err"><AlertCircle size={14}/>{row.error}</p>}
      </article>;
    }) : <div className="card empty"><h3>尚无店铺余额记录</h3><p>检查后显示已授权店铺的广告接口结果。</p></div>}</div>}
    <p className="note ab-foot">余额含充值及赠送额度；币种按站点映射，不跨币种合计。需本机服务保持运行，关闭后重启会补查到期任务。提醒只在中台展示，不会自动充值。<a href="https://open.shopee.com/developer-guide/277" target="_blank" rel="noreferrer"> 官方广告接口说明<ArrowUpRight size={12}/></a></p>
  </section>;
}
