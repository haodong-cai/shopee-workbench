import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createControlStatus } from './control.mjs';

export const permissionCatalog = [
  { id: 'shop', name: '店铺信息', module: 'Shop', note: '店铺名称、站点、类型；需店铺授权。' },
  { id: 'order', name: '订单数据', module: 'Order', note: '订单列表、状态和详情；买家敏感字段可能脱敏。' },
  { id: 'product', name: '商品与库存', module: 'Product', note: '商品、SKU、价格、库存和评论；本阶段仅规划读取。' },
  { id: 'logistics', name: '物流跟踪', module: 'Logistics', note: '物流渠道、运单和轨迹；发货属于另行操作。' },
  { id: 'returns', name: '售后数据', module: 'Returns', note: '退货退款进度；不执行退款或争议处理。' },
  { id: 'payment', name: '收入与结算', module: 'Payment', note: '订单收入、打款和钱包数据；金额须保留币种。' },
  { id: 'health', name: '店铺健康', module: 'AccountHealth', note: '店铺表现和处罚积分；以实际站点返回为准。' },
  { id: 'ads', name: '广告表现', module: 'Ads', note: '费用、转化和 ROAS；需核对应用权限及站点支持。', guide: 277 },
  { id: 'push', name: '变更通知', module: 'Push', note: '通知不等于完整数据，收到通知后仍需查询对应接口。', guide: 18 }
].map(item => ({ ...item, guideUrl: `https://open.shopee.com/developer-guide/${item.guide || 16}` }));
const permissionStates = ['unknown', 'planned', 'confirmed', 'excluded'];
const syncTargets = { orders: '订单', products: '商品', inventory: '库存', payment: '收入与结算' };
const defaultFile = fileURLToPath(new URL('../.local/monitor.json', import.meta.url));

export function createMonitorStore(file = defaultFile, getConnection = () => createControlStatus().connection) {
  let queue = Promise.resolve();
  async function read() {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (data.version !== 1 || !data.permissions || typeof data.permissions !== 'object' || Array.isArray(data.permissions) || !Array.isArray(data.tasks)) throw new Error();
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, permissions: {}, tasks: [] };
      throw new Error('监控记录读取失败，原文件未改写。');
    }
  }
  function change(update) {
    const work = queue.then(async () => {
      const data = await read();
      const result = update(data);
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, JSON.stringify(data, null, 2), 'utf8');
        await rename(`${file}.tmp`, file);
      } catch { throw new Error('监控记录保存失败，请检查本地数据目录。'); }
      return result;
    });
    queue = work.catch(() => {});
    return work;
  }
  return {
    async snapshot() {
      await queue;
      const data = await read(), connection = getConnection();
      const permissions = permissionCatalog.map(item => ({ ...item, status: data.permissions[item.id]?.status || 'unknown', updatedAt: data.permissions[item.id]?.updatedAt || null, source: 'manual', apiVerified: false }));
      const waiting = data.tasks.filter(task => task.status === 'waiting').length;
      const alerts = [{ code: 'REMOTE_SYNC_NOT_ENABLED', level: 'info', title: '等待新应用接入', detail: '同步计划只登记在本机，尚未启用远程同步。' }];
      const unconfirmed = permissions.filter(item => ['unknown', 'planned'].includes(item.status)).length;
      if (unconfirmed) alerts.push({ code: 'PERMISSION_REVIEW_PENDING', level: 'info', title: `${unconfirmed} 项权限准备待确认`, detail: '权限清单为人工准备记录，不代表新应用已获批或接口已验证。' });
      if (connection.missing.length) alerts.push({ code: 'AUTH_CONFIG_MISSING', level: 'warning', title: `授权配置缺少 ${connection.missing.length} 项`, detail: '当前配置存在状态不代表新应用已经授权；请在新应用创建后补齐。' });
      if (waiting) alerts.push({ code: 'PLANS_WAITING', level: 'info', title: `${waiting} 条同步计划待接入`, detail: '尚未发起 Shopee 请求，未产生同步记录数或金额。' });
      return { generatedAt: new Date().toISOString(), mode: 'preparing_new_app', permissions, tasks: data.tasks.slice(-100).reverse(), alerts,
        totals: { tasks: data.tasks.length, waiting, completed: data.tasks.filter(task => task.status === 'completed').length, cancelled: data.tasks.filter(task => task.status === 'cancelled').length },
        connection: { configuredFields: Object.values(connection.fields).filter(Boolean).length, totalFields: Object.keys(connection.fields).length, verified: false } };
    },
    setPermission(id, body) {
      if (!permissionCatalog.some(item => item.id === id) || !body || Object.keys(body).some(key => key !== 'status') || !permissionStates.includes(body.status)) throw new Error('权限记录参数无效。');
      return change(data => { data.permissions[id] = { status: body.status, updatedAt: new Date().toISOString() }; return { saved: true, apiVerified: false }; });
    },
    addTask(body) {
      if (!body || Object.keys(body).some(key => !['kind', 'dataset'].includes(key)) || !['check', 'sync'].includes(body.kind) || (body.kind === 'sync' && !Object.hasOwn(syncTargets, body.dataset)) || (body.kind === 'check' && body.dataset !== undefined)) throw new Error('任务参数无效。');
      return change(data => {
        const connection = getConnection();
        const task = { id: randomUUID(), kind: body.kind, dataset: body.kind === 'sync' ? body.dataset : null, createdAt: new Date().toISOString(), records: null, amount: null };
        if (body.kind === 'check') Object.assign(task, { name: '本地接入检查', status: 'completed', outcome: connection.missing.length ? 'needs_attention' : 'local_config_ready', detail: `已检查 ${Object.values(connection.fields).filter(Boolean).length}/${Object.keys(connection.fields).length} 项配置；尚未验证店铺或令牌。`, finishedAt: new Date().toISOString() });
        else Object.assign(task, { name: `${syncTargets[body.dataset]}同步计划`, status: 'waiting', outcome: 'waiting_new_app', detail: '等待新应用授权及同步接口接入，未发起远程请求。' });
        data.tasks.push(task);
        return task;
      });
    },
    cancelTask(id) {
      return change(data => {
        const task = data.tasks.find(item => item.id === id);
        if (!task || task.status !== 'waiting') throw new Error('未找到可取消的同步计划。');
        Object.assign(task, { status: 'cancelled', outcome: 'cancelled', detail: '同步计划已取消，历史记录保留。', finishedAt: new Date().toISOString() });
        return { cancelled: true };
      });
    }
  };
}
