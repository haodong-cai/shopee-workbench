import express from 'express';
import multer from 'multer';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { inspectWorkbook, readSource, validateRows, exportWorkbook } from './workbook.mjs';
import { createControlStatus, loadLocalEnvironment } from './control.mjs';
import { createMonitorStore } from './monitor.mjs';
import { createAdsMonitor } from './ads-monitor.mjs';
import { readProfitEstimates } from './profit-estimates.mjs';
import { createOperations } from './operations.mjs';
import { createAdsClient } from './shopee-ads.mjs';
import { createFxMonitor } from './fx.mjs';
import { createSkuCosts } from './sku-costs.mjs';
import { createLiveProfit } from './profit-live.mjs';
import { createScheduler } from './scheduler.mjs';
import { createInventory } from './inventory.mjs';
import { createLanAccess, lanUrls } from './lan.mjs';
import { buildAuthLink, parseCallback, saveAuthorization } from './shop-authorize.mjs';

loadLocalEnvironment();
const appVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function createApp({ monitorStore = createMonitorStore(), adsMonitor = createAdsMonitor(), profitSnapshot = readProfitEstimates, operations = createOperations(), fx = createFxMonitor(), skuCosts = createSkuCosts(), liveProfit = null, scheduler = null, inventory = null, lan = null } = {}) {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1, fieldSize: 15 * 1024 * 1024 } });
  app.use(express.json({ limit: '15mb' }));
  // 浏览器发来的写操作必须来自工作台页面本身（Origin 与 Host 一致），本机或局域网地址都适用；没有 Origin 的命令行请求照常放行。
  const sameOrigin = req => { const origin = req.get('origin'); if (!origin) return true; try { return new URL(origin).host === req.get('host'); } catch { return false; } };
  const fromWorkbench = req => req.is('application/json') && sameOrigin(req);
  // 局域网访问：本机直接放行；其他电脑需主机开启并输入访问码。开关与访问码只能在主机上改。
  if (lan) {
    app.use((req, res, next) => lan.guard(req, res, next));
    app.post('/api/lan/login', async (req, res) => { if (!fromWorkbench(req)) return res.status(403).json({ error: '请从工作台页面登录' }); await lan.login(req, res); });
  }
  app.get('/api/lan', async (req, res) => res.set('Cache-Control', 'no-store').json(lan ? await lan.status(req) : { available: false }));
  app.put('/api/lan', async (req, res) => {
    if (!lan) return res.status(404).json({ error: '局域网访问未启用' });
    if (!req.lan?.local) return res.status(403).json({ error: '只能在主机电脑上修改局域网设置' });
    if (!fromWorkbench(req)) return res.status(403).json({ error: '请从本地工作台修改设置' });
    await lan.configure(req.body); res.set('Cache-Control', 'no-store').json(await lan.status(req));
  });
  app.post('/api/lan/regenerate', async (req, res) => {
    if (!lan) return res.status(404).json({ error: '局域网访问未启用' });
    if (!req.lan?.local) return res.status(403).json({ error: '只能在主机电脑上更换访问码' });
    if (!fromWorkbench(req)) return res.status(403).json({ error: '请从本地工作台修改设置' });
    await lan.regenerate(); res.set('Cache-Control', 'no-store').json(await lan.status(req));
  });
  // 店铺授权：只能在主机上操作。/auth/start 跳转到虾皮授权页，授权完成后虾皮回跳 /auth/callback，自动换取令牌并保存到 .local。
  const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,'Microsoft YaHei',sans-serif;max-width:560px;margin:60px auto;padding:0 16px;line-height:1.7"><h2>${title}</h2><p>${body}</p><p><a href="/">返回工作台</a></p></body>`;
  const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hostOnly = req => (req.lan ? req.lan.local : true);
  app.get('/auth/start', (req, res) => {
    if (!hostOnly(req)) return res.status(403).send(page('只能在主机上授权', '请在运行工作台的那台电脑上打开本页。'));
    try { res.redirect(buildAuthLink()); } catch (error) { res.status(400).send(page('无法生成授权链接', escape(error.message))); }
  });
  app.get('/auth/callback', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!hostOnly(req)) return res.status(403).send(page('只能在主机上授权', '请在运行工作台的那台电脑上完成授权。'));
    try {
      const result = await saveAuthorization(parseCallback(req.originalUrl.split('?')[1] || ''));
      res.send(page('授权成功', `本次授权 ${result.shops.length} 家店铺（${result.shops.join('、')}），当前共 ${result.total} 家。回到工作台，在“数据与接入”点“同步”即可读取数据。`));
    } catch (error) { res.status(400).send(page('授权失败', `${escape(error.message)}${error.code ? `（${escape(error.code)}）` : ''}<br>授权码只能用一次，请重新打开 <a href="/auth/start">/auth/start</a> 再授权。`)); }
  });
  app.get('/api/health', (req, res) => res.json({ app: 'shopee-vn-workbench', version: appVersion }));
  app.get('/api/control/status', (req, res) => res.json(createControlStatus()));
  app.get('/api/operations', async (req, res) => { const rev = /^\d+$/.test(String(req.query.rev || '')) ? Number(req.query.rev) : undefined; res.set('Cache-Control', 'no-store').json(await operations.snapshot(rev, { jobOnly: req.query.job === '1' })); });
  app.post('/api/operations/sync', async (req, res) => {
    if (!fromWorkbench(req)) return res.status(403).json({ error: '请从工作台页面发起同步' });
    const job = await operations.sync(req.body.kinds, req.body.shopIds);
    // 同步结束后把最新毛利写入按天记录；失败不影响同步本身。
    if (liveProfit) Promise.resolve(operations.wait?.()).then(() => liveProfit.record()).catch(() => {});
    res.status(202).json(job);
  });
  // 默认返回按最新同步数据自动重算的近 7 天毛利；?source=archive 读取 .local 中的固定试算存档（如有）。
  app.get('/api/profit-estimates', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (liveProfit && req.query.source !== 'archive') { const live = await liveProfit.snapshot(Number(req.query.days) || 7); if (live.available) return res.json(live); }
    res.json({ mode: 'archive', ...await profitSnapshot() });
  });
  app.get('/api/profit-history', async (req, res) => res.set('Cache-Control', 'no-store').json(liveProfit ? await liveProfit.history() : { updatedAt: null, days: {} }));
  app.get('/api/schedule', async (req, res) => res.set('Cache-Control', 'no-store').json(scheduler ? await scheduler.snapshot() : { available: false }));
  app.put('/api/schedule', async (req, res) => {
    if (!scheduler) return res.status(404).json({ error: '定时同步未启用' });
    if (!fromWorkbench(req)) return res.status(403).json({ error: '请从本地工作台修改设置' });
    res.set('Cache-Control', 'no-store').json(await scheduler.configure(req.body));
  });
  app.get('/api/ads-monitor', async (req, res) => res.set('Cache-Control', 'no-store').json(await adsMonitor.snapshot()));
  app.post('/api/ads-monitor/check', async (req, res) => res.set('Cache-Control', 'no-store').json(await adsMonitor.check()));
  app.get('/api/fx', async (req, res) => res.set('Cache-Control', 'no-store').json(await fx.snapshot()));
  app.post('/api/fx/refresh', async (req, res) => res.set('Cache-Control', 'no-store').json(await fx.refresh()));
  app.post('/api/sku-costs', async (req, res) => res.set('Cache-Control', 'no-store').json(await skuCosts.lookup(req.body?.skus)));
  app.get('/api/monitor', async (req, res) => res.set('Cache-Control', 'no-store').json(await monitorStore.snapshot()));
  app.patch('/api/monitor/permissions/:id', async (req, res) => res.json(await monitorStore.setPermission(req.params.id, req.body)));
  app.post('/api/monitor/tasks', async (req, res) => res.status(201).json(await monitorStore.addTask(req.body)));
  app.post('/api/monitor/tasks/:id/cancel', async (req, res) => res.json(await monitorStore.cancelTask(req.params.id)));
  // 断货预警：在库 / 在途表导入（按表头自动识别）、头程与安全天数设置、预测结果。
  app.get('/api/inventory', async (req, res) => res.set('Cache-Control', 'no-store').json(inventory ? await inventory.snapshot() : { available: false }));
  app.post('/api/inventory/import', upload.single('file'), async (req, res) => {
    if (!inventory) return res.status(404).json({ error: '断货预警未启用' });
    if (!sameOrigin(req)) return res.status(403).json({ error: '请从本地工作台导入' });
    if (!req.file || !/\.(xlsx|csv)$/i.test(req.file.originalname)) throw new Error('请选择仓库系统导出的 XLSX 或 CSV 表格。');
    res.set('Cache-Control', 'no-store').json(await inventory.importFile(req.file.buffer, req.file.originalname));
  });
  app.put('/api/inventory/settings', async (req, res) => {
    if (!inventory) return res.status(404).json({ error: '断货预警未启用' });
    if (!fromWorkbench(req)) return res.status(403).json({ error: '请从本地工作台修改设置' });
    res.set('Cache-Control', 'no-store').json(await inventory.configure(req.body));
  });
  app.post('/api/inspect', upload.single('file'), async (req, res) => {
    if (!req.file || !/\.xlsx$/i.test(req.file.originalname)) throw new Error('请选择 XLSX 模板；不支持 XLS、XLSM。');
    res.json(await inspectWorkbook(req.file.buffer));
  });
  app.post('/api/source', upload.single('file'), async (req, res) => {
    if (!req.file) throw new Error('请选择商品文件。');
    res.json(await readSource(req.file.buffer, req.file.originalname, req.body.sheet, Number(req.body.headerRow || 1)));
  });
  app.post('/api/validate', (req, res) => res.json(validateRows(req.body.rows, req.body.mappings)));
  app.post('/api/export', upload.single('file'), async (req, res) => {
    if (!req.file || !/\.xlsx$/i.test(req.file.originalname)) throw new Error('请先选择官方 XLSX 模板。');
    const options = JSON.parse(req.body.options);
    const result = await exportWorkbook(req.file.buffer, options);
    res.setHeader('Content-Disposition', "attachment; filename=shopee-vn-upload.xlsx");
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(result);
  });
  const dist = fileURLToPath(new URL('../dist', import.meta.url));
  app.use(express.static(dist));
  app.get('/', (req, res) => res.sendFile(path.join(dist, 'index.html')));
  app.use((err, req, res, next) => res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? '文件不能超过 15 MB。' : err.message || '处理失败。' }));
  return app;
}
export function startServer() {
  const client = createAdsClient(), adsMonitor = createAdsMonitor({ client }), operations = createOperations({ client }), fx = createFxMonitor(), skuCosts = createSkuCosts();
  const liveProfit = createLiveProfit({ operations, skuCosts, fx });
  const scheduler = createScheduler({ operations, onFinished: () => liveProfit.record() });
  const inventory = createInventory({ operations, skuCosts });
  const lan = createLanAccess({ port: 8787 });
  // 监听全部网卡，局域网同事才能连上；是否放行由 lan.guard 决定（本机始终可用）。
  const server = createApp({ adsMonitor, operations, fx, skuCosts, liveProfit, scheduler, inventory, lan }).listen(8787, '0.0.0.0', () => {
    console.log('本地服务：http://127.0.0.1:8787');
    for (const { url } of lanUrls(8787)) console.log(`局域网：${url}`);
    adsMonitor.start(); fx.start(); scheduler.start();
  });
  server.on('close', () => { adsMonitor.stop(); fx.stop(); scheduler.stop(); });
  server.on('error', err => { console.error(`启动失败：${err.message}`); process.exitCode = 1; });
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();
