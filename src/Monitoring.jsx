import React, { useEffect, useState } from 'react';
import { RefreshCw, Download, ClipboardCheck, AlertCircle, Info } from 'lucide-react';
import './monitoring.css';

const permissionStates = { unknown: '待核对', planned: '计划申请', confirmed: '人工确认可用', excluded: '暂不接入' };
const taskStates = { waiting: '待新应用接入', completed: '本地检查完成', cancelled: '已取消' };
const sections = { permissions: '权限清单', tasks: '任务记录', alerts: '异常与待办' };
const time = value => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '—';

export default function Monitoring({ connection }) {
  const [data, setData] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [section, setSection] = useState('permissions'), [dataset, setDataset] = useState('orders'), [filter, setFilter] = useState('all');
  async function load() {
    const response = await fetch('/api/monitor', { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '读取监控状态失败。');
    setData(result);
  }
  async function run(url, method, body, message) {
    setBusy(true); setError(''); setNotice('');
    try {
      if (url) {
        const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '操作失败，请重试。');
      }
      await load();
      if (message) setNotice(message);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  useEffect(() => { run(); }, [connection]);
  function exportReport() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = '虾皮中台-监控报告.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice('监控报告已导出，不包含密钥或令牌值。');
  }
  function tabKey(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const keys = Object.keys(sections), index = keys.indexOf(section);
    const next = event.key === 'Home' ? keys[0] : event.key === 'End' ? keys.at(-1) : keys[(index + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length];
    setSection(next); event.currentTarget.parentElement.querySelector(`#monitor-${next}`).focus();
  }
  const tasks = data?.tasks.filter(task => filter === 'all' || task.status === filter) || [];
  return <section className="monitor" aria-label="接入与监控" aria-busy={busy}>
    <div className="monitor-toolbar"><p>等待新应用接入 · 当前仅在本机记录准备情况</p><div className="mon-actions"><button className="sm" onClick={() => run()} disabled={busy}><RefreshCw size={14}/>刷新监控</button><button className="sm" onClick={exportReport} disabled={!data || busy}><Download size={14}/>导出记录</button></div></div>
    {error && <div className="hub-message hub-error" role="alert"><AlertCircle size={18}/>{error}</div>}
    {notice && <div className="hub-message hub-success" role="status">{notice}</div>}
    {data && <>
      <div className="monitor-summary"><span>配置存在 <b>{data.connection.configuredFields}/{data.connection.totalFields}</b> 项</span><span>任务共 <b>{data.totals.tasks}</b> 条</span><span>待接入 <b>{data.totals.waiting}</b> 条</span><span>检查时间 {time(data.generatedAt)}（北京时间）</span></div>
      <div className="hub-tabs" role="tablist" aria-label="监控分类">{Object.entries(sections).map(([key, label]) => <button key={key} id={`monitor-${key}`} role="tab" aria-selected={section === key} aria-controls="monitor-panel" tabIndex={section === key ? 0 : -1} onKeyDown={tabKey} className={section === key ? 'selected' : ''} onClick={() => setSection(key)}>{label}</button>)}</div>
      <div id="monitor-panel" role="tabpanel" aria-labelledby={`monitor-${section}`}>
        {section === 'permissions' && <><p className="monitor-note">这是新应用的权限准备清单。人工记录不代表平台授权或接口验证已通过；商品与库存同属 Product 模块。</p><div className="table-wrap"><table className="tbl"><thead><tr><th>能力 / 模块</th><th>准备状态（人工记录）</th><th>适用范围</th><th>文档</th></tr></thead><tbody>{data.permissions.map(item => <tr key={item.id}><td><strong>{item.name}</strong><span className="hub-table-note">{item.module}</span></td><td><select aria-label={`${item.name}权限准备`} value={item.status} disabled={busy} onChange={event => run(`/api/monitor/permissions/${item.id}`, 'PATCH', { status: event.target.value }, '权限准备状态已保存在本机，尚未进行接口验证。')}>{Object.entries(permissionStates).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td><td className="monitor-description">{item.note}</td><td><a href={item.guideUrl} target="_blank" rel="noreferrer">官方说明</a></td></tr>)}</tbody></table></div><p className="note">仅做经营分析通常不需要买家姓名、电话或地址；敏感数据默认脱敏，按实际用途另行申请。</p></>}
        {section === 'tasks' && <>
          <div className="monitor-task-controls"><button onClick={() => run('/api/monitor/tasks', 'POST', { kind: 'check' }, '本地检查已记录；未验证店铺或令牌。')} disabled={busy}><ClipboardCheck size={16}/>运行本地检查</button><div><select aria-label="同步计划数据集" value={dataset} onChange={event => setDataset(event.target.value)} disabled={busy}><option value="orders">订单</option><option value="products">商品</option><option value="inventory">库存</option><option value="payment">收入与结算</option></select><button onClick={() => run('/api/monitor/tasks', 'POST', { kind: 'sync', dataset }, '同步计划已登记，等待新应用接入；未调用 Shopee。')} disabled={busy}>登记同步计划</button></div></div>
          <div className="monitor-task-filter"><span>显示最近记录中的 {tasks.length} 条，历史共 {data.totals.tasks} 条</span><label>任务状态<select aria-label="任务状态筛选" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部状态</option>{Object.entries(taskStates).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div>
          <div className="table-wrap"><table className="tbl"><thead><tr><th>创建时间（北京时间）</th><th>任务</th><th>状态</th><th>结果 / 原因</th><th>操作</th></tr></thead><tbody>{tasks.length ? tasks.map(task => <tr key={task.id}><td>{time(task.createdAt)}</td><td>{task.name}</td><td><span className={`tag ${task.status === 'completed' ? (task.outcome === 'local_config_ready' ? 'good' : 'warn') : task.status === 'cancelled' ? '' : 'info'}`}>{taskStates[task.status]}</span>{task.outcome === 'needs_attention' && <span className="hub-table-note">配置尚未齐全</span>}</td><td className="monitor-description">{task.detail}<span className="hub-table-note">同步记录数：— · 同步金额：—</span></td><td>{task.status === 'waiting' ? <button className="link" disabled={busy} onClick={() => run(`/api/monitor/tasks/${task.id}/cancel`, 'POST', undefined, '计划已取消，历史记录保留。')}>取消计划</button> : '—'}</td></tr>) : <tr><td colSpan={5}><div className="empty"><h3>{filter === 'all' ? '尚无任务记录' : '没有此状态的任务'}</h3><p>运行本地检查或登记同步计划后显示；记录保存在本机，刷新页面后保留。</p></div></td></tr>}</tbody></table></div>
          <p className="note">本地检查完成不代表同步成功。同步任务尚未执行，记录数和金额均为未知；页面最多显示最近 100 条历史。</p>
        </>}
        {section === 'alerts' && <div className="monitor-alerts">{data.alerts.map(alert => <article key={alert.code}><div className={alert.level === 'warning' ? 'monitor-warning' : ''}>{alert.level === 'warning' ? <AlertCircle size={20}/> : <Info size={20}/>}</div><div><h2>{alert.title}</h2><p>{alert.detail}</p><small>{alert.level === 'warning' ? '待处理' : '接入提示'}</small></div></article>)}</div>}
      </div>
    </>}
  </section>;
}
