import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { periodFor } from './operations.mjs';

// 定时同步：每天固定时间全量同步；之后每隔数小时刷新订单与退货，并补齐失败、缺失或统计期已滚动的数据块。
// 只在“每日时间 → 当天午夜”之间运行；服务未开机错过的全量同步会在启动后补跑。全部为只读请求。
export const FULL_KINDS = ['orders', 'fees', 'ads', 'returns'];
export const LIGHT_KINDS = ['orders', 'returns'];
export const INTERVALS = [0, 1, 2, 3, 4, 6, 8, 12];
const TIME_ZONE = 'Asia/Shanghai', minute = 60000, hour = 3600000;
const defaults = { enabled: true, dailyTime: '08:30', lightEveryHours: 4 };
const validTime = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

/** 当前时刻在指定时区的“当天第几分钟”。 */
export function minuteOfDay(now, timeZone = TIME_ZONE) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map(part => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}
/** 不晚于 now 的最近一个每日时间点（毫秒）。 */
export function latestSlot(now, dailyTime, timeZone = TIME_ZONE) {
  const [h, m] = dailyTime.split(':').map(Number);
  const delta = (minuteOfDay(now, timeZone) - (h * 60 + m) + 1440) % 1440;
  return Math.floor(now / minute) * minute - delta * minute;
}
/** 某店铺本次需要同步的数据块：基础块 + 失败 / 缺失 / 统计期已滚动的块。 */
export function neededKinds(shop, base, now) {
  let current = null;
  try { current = periodFor(shop.region, now); } catch { /* 站点未知时只做基础同步 */ }
  // 统计期换日，或起点变了（例如从 7 天扩到 30 天）都要整块重读。
  const stale = FULL_KINDS.filter(kind => { const block = shop[kind]; return !block?.updatedAt || block.error || (current && (block.period?.end !== current.end || block.period?.start !== current.start)); });
  return FULL_KINDS.filter(kind => base.includes(kind) || stale.includes(kind));
}

export function createScheduler({ file = fileURLToPath(new URL('../.local/schedule.json', import.meta.url)), operations, onFinished = async () => {}, now = Date.now, retryMinutes = 20, keepRuns = 40 } = {}) {
  let data, timer, flight = null, saving = Promise.resolve();
  async function read() {
    if (data) return data;
    try { const saved = JSON.parse(await readFile(file, 'utf8')); if (saved.version !== 1 || typeof saved.config !== 'object' || !Array.isArray(saved.runs)) throw new Error(); data = { ...saved, config: { ...defaults, ...saved.config } }; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('定时同步配置读取失败，原文件未覆盖。'); data = { version: 1, config: { ...defaults }, lastFullAt: null, lastRunAt: null, retryAt: null, runs: [] }; }
    return data;
  }
  async function save() {
    const text = JSON.stringify(data, null, 2);
    saving = saving.catch(() => {}).then(async () => { await mkdir(dirname(file), { recursive: true }); await writeFile(`${file}.tmp`, text, 'utf8'); await rename(`${file}.tmp`, file); });
    await saving;
  }
  /** 现在应执行哪种任务；不到时间返回 null。 */
  function due(state, t) {
    const { config } = state;
    if (!config.enabled) return null;
    const slot = latestSlot(t, config.dailyTime);
    if (!state.lastFullAt || Date.parse(state.lastFullAt) < slot) return state.lastFullAt && t - slot < 5 * minute ? 'daily' : 'catchup';
    if (state.retryAt && t >= Date.parse(state.retryAt)) return 'retry';
    const [h, m] = config.dailyTime.split(':').map(Number);
    const active = minuteOfDay(t) >= h * 60 + m;
    if (active && config.lightEveryHours > 0 && state.lastRunAt && t - Date.parse(state.lastRunAt) >= config.lightEveryHours * hour) return 'interval';
    return null;
  }
  function nextTimes(state, t) {
    const { config } = state;
    if (!config.enabled) return { nextFullAt: null, nextIntervalAt: null };
    const slot = latestSlot(t, config.dailyTime), fullDone = state.lastFullAt && Date.parse(state.lastFullAt) >= slot;
    const nextFull = fullDone ? slot + 24 * hour : t;
    let nextInterval = null;
    if (config.lightEveryHours > 0 && fullDone && state.lastRunAt) {
      const candidate = Math.max(t, Date.parse(state.lastRunAt) + config.lightEveryHours * hour);
      const [h, m] = config.dailyTime.split(':').map(Number);
      // 落在午夜之后、每日时间之前的增量同步不执行，由下一次全量同步覆盖。
      if (candidate < slot + 24 * hour && minuteOfDay(candidate) >= h * 60 + m) nextInterval = candidate;
    }
    return { nextFullAt: new Date(nextFull).toISOString(), nextIntervalAt: nextInterval ? new Date(nextInterval).toISOString() : null };
  }
  async function execute(type) {
    const state = await read(), startedAt = new Date(now()).toISOString();
    const base = type === 'retry' ? [] : type === 'interval' ? LIGHT_KINDS : FULL_KINDS;
    const run = { id: `${startedAt}-${type}`, type, startedAt, finishedAt: null, steps: [], failures: [] };
    if (type !== 'retry') state.lastRunAt = startedAt;
    if (type === 'daily' || type === 'catchup') state.lastFullAt = startedAt;
    state.retryAt = null;
    await save();
    try {
      const before = await operations.snapshot();
      const groups = new Map();
      if (base.length === FULL_KINDS.length || !before.shops.length) groups.set(FULL_KINDS.join(','), undefined);
      else for (const shop of before.shops) {
        if (shop.connectionError === '已不在当前授权范围') continue;
        const kinds = neededKinds(shop, base, now());
        if (!kinds.length) continue;
        const key = kinds.join(','); groups.set(key, [...(groups.get(key) || []), shop.shopId]);
      }
      for (const [key, shopIds] of groups) {
        const kinds = key.split(',');
        await operations.wait();
        const job = await operations.sync(kinds, shopIds);
        await operations.wait();
        run.steps.push({ kinds, shopIds: shopIds || 'all' });
        const after = await operations.snapshot();
        if (after.job?.error) run.failures.push({ region: '', kind: 'job', error: after.job.error });
        else if (job?.error) run.failures.push({ region: '', kind: 'job', error: job.error });
        for (const shop of after.shops) {
          if (shopIds && !shopIds.includes(shop.shopId)) continue;
          if (shop.connectionError) { if (shop.connectionError !== '已不在当前授权范围') run.failures.push({ region: shop.region || String(shop.shopId), kind: 'connection', error: shop.connectionError }); continue; }
          for (const kind of kinds) if (shop[kind]?.error) run.failures.push({ region: shop.region || String(shop.shopId), kind, error: shop[kind].error });
        }
      }
    } catch (error) { run.failures.push({ region: '', kind: 'job', error: error.message }); }
    run.finishedAt = new Date(now()).toISOString();
    if (run.failures.length && type !== 'retry') state.retryAt = new Date(now() + retryMinutes * minute).toISOString();
    state.runs = [...state.runs, run].slice(-keepRuns);
    await save();
    try { await onFinished(run); } catch { /* 后续汇总失败不影响同步记录 */ }
    return run;
  }
  async function tick() {
    if (flight) return null;
    const state = await read();
    const type = due(state, now());
    if (!type) return null;
    if ((await operations.snapshot()).job?.running) return null;
    flight = execute(type).finally(() => { flight = null; });
    return flight;
  }
  return {
    tick,
    async snapshot() {
      const state = await read(), t = now();
      return { available: true, timeZone: TIME_ZONE, config: { ...state.config }, running: Boolean(flight), lastFullAt: state.lastFullAt, lastRunAt: state.lastRunAt, retryAt: state.config.enabled ? state.retryAt : null,
        ...nextTimes(state, t), intervals: INTERVALS, fullKinds: FULL_KINDS, lightKinds: LIGHT_KINDS, runs: state.runs.slice(-12).reverse() };
    },
    async configure(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('定时同步设置无效');
      const state = await read(), next = { ...state.config };
      if ('enabled' in patch) { if (typeof patch.enabled !== 'boolean') throw new Error('开关值无效'); next.enabled = patch.enabled; }
      if ('dailyTime' in patch) { if (!validTime(patch.dailyTime)) throw new Error('每日时间需为 HH:MM'); next.dailyTime = patch.dailyTime; }
      if ('lightEveryHours' in patch) { if (!INTERVALS.includes(patch.lightEveryHours)) throw new Error('增量间隔不在可选范围'); next.lightEveryHours = patch.lightEveryHours; }
      state.config = next;
      await save();
      return this.snapshot();
    },
    start() { if (timer) return; const run = () => tick().catch(() => {}); timer = setInterval(run, minute); timer.unref?.(); setTimeout(run, 5000).unref?.(); },
    stop() { clearInterval(timer); timer = null; }
  };
}
