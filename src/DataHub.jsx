import React from 'react';
import { RefreshCw, Download, Check, Circle, AlertCircle, ArrowUpRight, KeyRound, Clock, CalendarClock, Wifi, Copy } from 'lucide-react';
import Monitoring from './Monitoring.jsx';
import { marketName, ago, stamp, isStale, int, useJson, downloadJson } from './lib.js';
import './datahub.css';

const BLOCKS = [['orders', '订单'], ['fees', '平台扣费'], ['ads', '广告数据'], ['returns', '退货']];
const FIELDS = { SHOPEE_PARTNER_ID: '应用 ID', SHOPEE_PARTNER_KEY: '应用密钥', SHOPEE_SHOP_ID: '店铺 ID', SHOPEE_ACCESS_TOKEN: '访问令牌', SHOPEE_REFRESH_TOKEN: '刷新令牌' };
const count = (kind, block) => kind === 'stock' ? `${int(block.items ?? 0)} 商品 · ${int(block.models ?? 0)} 规格` : kind === 'ads' ? (block.daily ? `${block.daily.length} 天` : '') : kind === 'fees' ? `${block.received ?? 0}/${block.expected ?? 0} 单` : `${int(block.rows?.length ?? 0)} 条`;

function Cell({ shop, kind }) {
  const block = shop[kind];
  const state = shop.connectionError || block?.error ? 'bad' : !block?.updatedAt ? 'none' : isStale(block.updatedAt) ? 'warn' : 'good';
  return <td className={`dh-cell s-${state}`} title={block?.error || (block?.updatedAt ? `更新于 ${stamp(block.updatedAt)}（北京时间）` : '')}>
    <span className="dh-dot"/>
    <div><b>{state === 'bad' ? '失败' : state === 'none' ? '未同步' : ago(block.updatedAt)}</b><small>{block?.error ? block.error : block?.updatedAt ? count(kind, block) : '—'}</small></div>
  </td>;
}

const FX_STATE = { ok: ['good', '最新'], kept: ['warn', '本次失败 · 沿用上次'], stale: ['warn', '超过 4 天未更新'], missing: ['bad', '尚未取得'] };

function FxPanel({ fx }) {
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
  const data = fx.data;
  async function refresh() {
    setBusy(true); setError('');
    try { const r = await fetch('/api/fx/refresh', { method: 'POST' }); if (!r.ok) throw new Error('汇率刷新失败'); await fx.reload(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const rows = Object.values(data?.rates || {});
  return <section className="section">
    <div className="section-head"><div><h2>每日汇率</h2><p>本机服务每 {data?.intervalHours ?? 6} 小时自动拉取一次；用于概览的人民币折算。毛利试算仍按其统计期间的汇率，不随今日变动。</p></div>
      <div className="actions"><span className="muted dh-job">{data?.lastAttemptAt ? `上次拉取 ${stamp(data.lastAttemptAt)} · 下次 ${stamp(data.nextCheckAt)}（北京时间）` : '尚未拉取'}</span><button onClick={refresh} disabled={busy || data?.running}><RefreshCw size={14} className={busy || data?.running ? 'spin' : ''}/>{busy ? '拉取中' : '立即更新'}</button></div></div>
    {(error || fx.error) && <div className="hub-message hub-error"><AlertCircle size={16}/>{error || fx.error}</div>}
    {Object.values(data?.errors || {}).map((e, i) => <div className="callout warn" key={i}><AlertCircle size={15}/><p>{e}</p></div>)}
    <div className="table-wrap"><table className="tbl dh-fx"><thead><tr><th>币种</th><th className="num">1 单位 ≈ CNY</th><th className="num">1 CNY ≈</th><th>报价日期</th><th>来源</th><th>状态</th></tr></thead><tbody>
      {rows.map(r => { const [tone, text] = FX_STATE[r.status] || ['', r.status]; return <tr key={r.currency}>
        <td><strong className="mono">{r.currency}</strong></td>
        <td className="num">{r.cnyPerUnit ? r.cnyPerUnit.toPrecision(r.currency === 'VND' ? 4 : 6) : '—'}</td>
        <td className="num">{r.unitPerCny ? `${r.unitPerCny.toLocaleString('zh-CN', { maximumFractionDigits: r.currency === 'VND' ? 2 : 4 })} ${r.currency}` : '—'}</td>
        <td className="date">{r.date || '—'}{r.quotedAt && r.quotedAt !== r.date && <small>报价 {r.quotedAt}</small>}</td>
        <td><a href={r.url} target="_blank" rel="noreferrer">{r.label}</a><small>{r.note}</small></td>
        <td><span className={`tag ${tone}`} title={r.error || ''}>{text}</span></td>
      </tr>; })}
      {!rows.length && <tr><td colSpan={6}><div className="empty"><p>{fx.loading ? '读取中…' : '本地服务未返回汇率'}</p></div></td></tr>}
    </tbody></table></div>
    <p className="note dh-fx-note">ECB 仅在欧洲工作日发布，周末与假日沿用最近一个工作日报价，属正常现象。取不到时保留上次成功的汇率并标注，不会填入估计值。</p>
  </section>;
}

const TIMES = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const RUN_TYPE = { daily: '每日全量', catchup: '补跑全量', interval: '定时增量', retry: '失败重试' };
const KIND = { orders: '订单', fees: '平台扣费', ads: '广告', returns: '退货', stock: '库存', connection: '店铺连接', job: '同步任务' };

function AutoSync({ schedule, shops }) {
  const data = schedule.data, [saving, setSaving] = React.useState(false), [error, setError] = React.useState('');
  const regionOf = id => shops.find(s => s.shopId === id)?.region || id;
  async function change(patch) {
    setSaving(true); setError('');
    try {
      const r = await fetch('/api/schedule', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || '设置保存失败');
      await schedule.reload();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }
  if (!data?.available) return <section className="section"><div className="section-head"><div><h2>自动同步</h2><p>{schedule.loading ? '读取中…' : '本机服务还是旧版本，重新双击“启动工作台”后可用。'}</p></div></div></section>;
  const { config } = data, on = config.enabled;
  return <section className="section">
    <div className="section-head"><div><h2><CalendarClock size={16}/> 自动同步</h2><p>本机服务运行期间自动读取各店数据，毛利与“需要处理”清单随之更新。全部为只读请求，不修改店铺。</p></div>
      <label className={`dh-switch ${on ? 'on' : ''}`}><input type="checkbox" checked={on} disabled={saving} onChange={e => change({ enabled: e.target.checked })}/><span>{on ? '已开启' : '已关闭'}</span></label></div>
    {(error || schedule.error) && <div className="hub-message hub-error"><AlertCircle size={16}/>{error || '定时同步状态读取失败'}</div>}
    <div className="dh-auto card">
      <div className="dh-auto-set">
        <label className="field">每日全量同步（北京时间）<select value={config.dailyTime} disabled={saving || !on} onChange={e => change({ dailyTime: e.target.value })}>{[...new Set([config.dailyTime, ...TIMES])].sort().map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        <label className="field">之后每隔<select value={config.lightEveryHours} disabled={saving || !on} onChange={e => change({ lightEveryHours: Number(e.target.value) })}>{data.intervals.map(h => <option key={h} value={h}>{h ? `${h} 小时刷新订单与退货` : '不做增量刷新'}</option>)}</select></label>
        <p className="note">全量 = 订单、平台扣费、广告、退货。增量只刷新订单状态与退货，并顺带补齐上次失败或统计期已换日的数据块（如巴西中午换日）。午夜到每日时间之间不运行；电脑关机错过的全量同步，会在下次启动工作台后立即补跑。</p>
      </div>
      <dl className="dh-sched dh-auto-next">
        <div><dt>下次全量</dt><dd className="num">{!on ? '—' : data.running ? '正在同步' : stamp(data.nextFullAt)}</dd></div>
        <div><dt>下次增量</dt><dd className="num">{!on || !data.nextIntervalAt ? '—' : stamp(data.nextIntervalAt)}</dd></div>
        <div><dt>上次全量</dt><dd className="num">{stamp(data.lastFullAt)}</dd></div>
        <div><dt>失败重试</dt><dd className="num">{data.retryAt ? stamp(data.retryAt) : '无'}</dd></div>
      </dl>
    </div>
    {data.runs.length > 0 && <div className="table-wrap dh-runs"><table className="tbl"><thead><tr><th>开始（北京时间）</th><th>类型</th><th>范围</th><th className="num">用时</th><th>结果</th></tr></thead><tbody>
      {data.runs.slice(0, 8).map(run => <tr key={run.id}>
        <td className="date">{stamp(run.startedAt)}</td><td>{RUN_TYPE[run.type] || run.type}</td>
        <td>{run.steps.length ? run.steps.map((step, i) => <small key={i} style={{ display: 'block' }}>{step.shopIds === 'all' ? '全部店铺' : step.shopIds.map(regionOf).join('、')}：{step.kinds.map(k => KIND[k] || k).join(' · ')}</small>) : <small>无需同步</small>}</td>
        <td className="num">{run.finishedAt ? `${Math.max(1, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000))} 秒` : '—'}</td>
        <td>{run.failures.length ? <><span className="tag bad">{run.failures.length} 项失败</span>{run.failures.slice(0, 3).map((f, i) => <small key={i} className="bad" style={{ display: 'block', whiteSpace: 'normal' }}>{f.region ? `${f.region} ` : ''}{KIND[f.kind] || f.kind}：{f.error}</small>)}{run.failures.length > 3 && <small>另有 {run.failures.length - 3} 项</small>}</> : <span className="tag good">成功</span>}</td>
      </tr>)}
    </tbody></table></div>}
  </section>;
}

function LanAccess({ lan }) {
  const data = lan.data, [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [copied, setCopied] = React.useState('');
  async function send(url, method, body) {
    setBusy(true); setError('');
    try { const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }), d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '保存失败'); await lan.reload(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function copy(text) { try { await navigator.clipboard.writeText(text); setCopied(text); setTimeout(() => setCopied(''), 1500); } catch { setError('浏览器不允许自动复制，请手动选中复制'); } }
  if (!data?.available) return lan.loading ? null : <section className="section"><div className="section-head"><div><h2><Wifi size={16}/> 局域网访问</h2><p>本机服务还是旧版本，重新双击“启动工作台”后可用。</p></div></div></section>;
  if (!data.local) return <section className="section"><div className="section-head"><div><h2><Wifi size={16}/> 局域网访问</h2><p>你正在通过局域网访问这台主机的工作台。开关和访问码只能在主机电脑上修改。</p></div></div></section>;
  const on = data.enabled;
  return <section className="section">
    <div className="section-head"><div><h2><Wifi size={16}/> 局域网访问</h2><p>开启后，和这台电脑连在同一个网络（同一 Wi-Fi 或公司网线）的同事，用浏览器打开下面的地址就能使用工作台。</p></div>
      <label className={`dh-switch ${on ? 'on' : ''}`}><input type="checkbox" checked={on} disabled={busy} onChange={e => send('/api/lan', 'PUT', { enabled: e.target.checked })}/><span>{on ? '已开启' : '已关闭'}</span></label></div>
    {error && <div className="hub-message hub-error"><AlertCircle size={16}/>{error}</div>}
    <div className={`dh-lan card ${on ? '' : 'off'}`}>
      <div className="dh-lan-urls">
        <span className="eyebrow">同事在浏览器打开</span>
        {data.urls.length ? data.urls.map(u => <div className="dh-lan-url" key={u.url}><code>{u.url}</code><small>{u.name}</small><button className="ghost sm" onClick={() => copy(u.url)} disabled={!on}><Copy size={13}/>{copied === u.url ? '已复制' : '复制'}</button></div>)
          : <p className="bad note">没有检测到局域网地址：这台电脑可能没联网，或只连了 VPN。</p>}
        <label className="check"><input type="checkbox" checked={data.requireCode} disabled={busy || !on} onChange={e => send('/api/lan', 'PUT', { requireCode: e.target.checked })}/>需要访问码</label>
      </div>
      <div className="dh-lan-code">
        <span className="eyebrow">访问码</span>
        {data.requireCode ? <><strong className="num">{data.code}</strong><p>同事第一次打开时输入一次，浏览器会记住 30 天。已登录 {data.devices} 台设备，24 小时内在用 {data.recent} 台。</p>
          <button className="sm" disabled={busy || !on} onClick={() => { if (confirm('换新访问码后，所有同事都要重新输入。确定更换？')) send('/api/lan/regenerate', 'POST'); }}><RefreshCw size={13}/>更换访问码</button></>
          : <p>未设访问码：同一网络里打开地址就能直接使用。如需限制，可勾选左侧“需要访问码”。</p>}
      </div>
    </div>
    <p className="note dh-lan-note">同事打不开时依次检查：① 第一次开启时 Windows 会弹出防火墙提示，要勾选“专用网络”并点“允许访问”（点了取消的话，到“Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙”里给 Node.js 勾上“专用”）；② 这台电脑的网络类型要是“专用网络”，不是“公用网络”；③ 同事和这台电脑在同一个网络；④ 这台电脑开着、没有休眠，工作台在运行。地址里的 IP 可能会因重新联网而变化，变了以这里显示的为准。</p>
  </section>;
}

export default function DataHub({ ops, ads, fx, schedule, lan, go }) {
  const control = useJson('/api/control/status');
  const status = control.data;
  const configured = status ? Object.values(status.connection.fields).filter(Boolean).length : null;
  function exportStatus() {
    const report = { generatedAt: new Date().toISOString(), connection: status ? { status: status.connection.status, configured: status.connection.configured, verified: status.connection.verified, fields: status.connection.fields, missing: status.connection.missing } : null,
      shops: ops.shops.map(s => ({ shopId: s.shopId, name: s.name, region: s.region, connectionError: s.connectionError || '', blocks: Object.fromEntries(BLOCKS.map(([k]) => [k, { updatedAt: s[k]?.updatedAt || null, error: s[k]?.error || '' }])) })),
      adsMonitor: ads.data ? { lastAttemptAt: ads.data.lastAttemptAt, nextCheckAt: ads.data.nextCheckAt, error: ads.data.error } : null };
    downloadJson(report, `虾皮中台-接入检查-${new Date().toISOString().slice(0, 10)}.json`);
  }
  return <div className="datahub">
    <LanAccess lan={lan}/>
    <AutoSync schedule={schedule} shops={ops.shops}/>
    <section className="section">
      <div className="section-head"><div><h2>同步矩阵</h2><p>每个店铺 × 每个数据块的最近一次成功同步。失败时保留历史快照，不显示为成功。</p></div>
        <div className="actions"><span className="muted dh-job">{ops.job?.running ? `正在读取：${ops.job.progress}` : ops.job?.finishedAt ? `上次任务结束 ${ago(ops.job.finishedAt)}` : ''}</span><button onClick={exportStatus}><Download size={14}/>导出检查报告</button><button className="primary" onClick={() => ops.sync()} disabled={ops.busy}><RefreshCw size={14} className={ops.busy ? 'spin' : ''}/>{ops.busy ? '同步中' : '全部同步'}</button></div></div>
      {ops.error && <div className="hub-message hub-error"><AlertCircle size={16}/>{ops.error}</div>}
      <div className="table-wrap"><table className="tbl dh-matrix"><thead><tr><th>店铺</th>{BLOCKS.map(([k, l]) => <th key={k}>{l}</th>)}<th>广告余额</th><th/></tr></thead><tbody>
        {ops.shops.map(shop => { const bal = (ads.data?.shops || []).find(b => b.shopId === shop.shopId); const balState = !bal ? 'none' : bal.status === 'failed' ? 'bad' : bal.stale ? 'warn' : 'good';
          return <tr key={shop.shopId}>
            <td><div className="dh-shop"><span className={`mk mk-${String(shop.region).toLowerCase()}`}>{shop.region}</span><div><strong>{shop.name}</strong><small className="mono">{marketName(shop.region)} · {shop.shopId}</small>{shop.connectionError && <small className="bad">{shop.connectionError}</small>}</div></div></td>
            {BLOCKS.map(([k]) => <Cell key={k} shop={shop} kind={k}/>)}
            <td className={`dh-cell s-${balState}`} title={bal?.error || ''}><span className="dh-dot"/><div><b>{!bal ? '未检查' : bal.status === 'failed' ? '失败' : ago(bal.checkedAt)}</b><small>{bal?.error || (bal ? `${bal.currency} ${Math.round(bal.balance ?? 0).toLocaleString('zh-CN')}` : '—')}</small></div></td>
            <td><button className="sm" onClick={() => ops.sync(undefined, [shop.shopId])} disabled={ops.busy}><RefreshCw size={13}/>同步此店</button></td>
          </tr>; })}
        {!ops.shops.length && <tr><td colSpan={7}><div className="empty"><h3>还没有店铺快照</h3><p>先在主机上 <a href="/auth/start">授权店铺</a>（需已在 .env 填写应用 ID 和密钥），再点击“全部同步”读取已授权店铺。</p></div></td></tr>}
      </tbody></table></div>
      <div className="dh-legend"><span><i className="dh-dot good"/>24 小时内成功</span><span><i className="dh-dot warn"/>超过 24 小时</span><span><i className="dh-dot bad"/>本次失败，保留历史</span><span><i className="dh-dot none"/>未同步</span></div>
    </section>

    <div className="dh-split section">
      <section className="card card-pad">
        <div className="section-head"><div><h2><KeyRound size={15}/> 本地授权配置</h2><p>仅检查 .env 中是否存在，不显示任何值；存在不等于已验证。</p></div><button className="ghost sm" onClick={control.reload} disabled={control.loading}><RefreshCw size={13}/>重新检查</button></div>
        {control.error && <div className="hub-message hub-error"><AlertCircle size={16}/>本地状态服务暂不可用</div>}
        <ul className="dh-fields">{Object.entries(FIELDS).map(([key, label]) => { const ok = status?.connection.fields[key]; return <li key={key} className={ok ? 'ok' : ''}>{ok ? <Check size={14}/> : <Circle size={12}/>}<span>{label}</span><code>{key}</code><em>{control.loading && !status ? '检查中' : ok ? '已配置' : '未配置'}</em></li>; })}</ul>
        <p className="note">已配置 {configured ?? '—'}/5 项 · 环境 {status?.system.environment || '—'} · 店铺数据实际通过本机 OAuth 授权文件读取。密钥与令牌只由本地服务读取。<a href="/auth/start">授权 / 追加店铺</a>（仅主机可用）。</p>
      </section>
      <section className="card card-pad">
        <div className="section-head"><div><h2><Clock size={15}/> 广告余额巡检</h2><p>本机服务运行期间每 {ads.data?.intervalHours ?? 24} 小时自动检查一次。</p></div><button className="ghost sm" onClick={() => go('ads')}>查看余额<ArrowUpRight size={13}/></button></div>
        <dl className="dh-sched">
          <div><dt>上次检查</dt><dd className="num">{stamp(ads.data?.lastAttemptAt)}</dd></div>
          <div><dt>下次检查</dt><dd className="num">{stamp(ads.data?.nextCheckAt)}</dd></div>
          <div><dt>提醒阈值</dt><dd>不足 {ads.data?.thresholdDays ?? 3} 天</dd></div>
          <div><dt>消耗口径</dt><dd>近 {ads.data?.averageDays ?? 7} 个完整自然日</dd></div>
        </dl>
        {ads.data?.error && <p className="bad note">{ads.data.error}</p>}
        <p className="note">时间均为北京时间。关闭本机服务后重启会补查到期任务。余额巡检独立于上方的自动同步。</p>
      </section>
    </div>

    <FxPanel fx={fx}/>

    <section className="section">
      <div className="section-head"><div><h2>权限清单与任务记录</h2><p>人工记录的开放平台权限准备情况、本地检查与同步计划。</p></div></div>
      <div className="card card-pad"><Monitoring connection={status?.connection}/></div>
    </section>
  </div>;
}
