import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdsClient } from './shopee-ads.mjs';

const day = 86400000;
const markets = { VN: ['VND', 'Asia/Ho_Chi_Minh'], TH: ['THB', 'Asia/Bangkok'], MY: ['MYR', 'Asia/Kuala_Lumpur'], PH: ['PHP', 'Asia/Manila'], SG: ['SGD', 'Asia/Singapore'], ID: ['IDR', 'Asia/Jakarta'], TW: ['TWD', 'Asia/Taipei'], BR: ['BRL', 'America/Sao_Paulo'], MX: ['MXN', 'America/Mexico_City'] };
export function completeDates(now, timeZone, days = 7) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const midnight = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  return Array.from({ length: days }, (_, index) => { const date = new Date(midnight - (days - index) * day); return `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()}`; });
}
export function summarizeSpend(rows, dates) {
  if (!Array.isArray(rows)) throw new Error('广告消耗响应格式异常。');
  const selected = rows.filter(row => dates.includes(row.date));
  if (selected.length !== 7 || new Set(selected.map(row => row.date)).size !== 7 || selected.some(row => typeof row.expense !== 'number' || !Number.isFinite(row.expense) || row.expense < 0)) throw new Error(`近7日消耗不完整（有效日期 ${new Set(selected.map(row => row.date)).size}/7），暂不估算可用天数。`);
  const total = selected.reduce((sum, row) => sum + row.expense, 0);
  return { total, average: total / 7 };
}
export function assessRow(row, now) {
  const stale = row.balance !== null && (!row.balanceAt || now - Date.parse(row.balanceAt) >= day);
  const complete = typeof row.balance === 'number' && typeof row.dailyAverage === 'number' && row.currency && !row.error && !stale;
  const days = complete && row.dailyAverage > 0 ? row.balance / row.dailyAverage : null;
  return { ...row, stale: Boolean(stale), days, low: days !== null && days < 3, status: row.error ? 'failed' : stale ? 'stale' : !complete ? 'unknown' : row.dailyAverage === 0 ? 'no_spend' : days < 3 ? 'low' : 'ready' };
}
export function createAdsMonitor({ file = fileURLToPath(new URL('../.local/ads-monitor.json', import.meta.url)), client = createAdsClient(), now = Date.now } = {}) {
  let flight, timer, current;
  async function read() {
    if (current) return current;
    try { const saved = JSON.parse(await readFile(file, 'utf8')); if (saved.version !== 1 || !Array.isArray(saved.shops)) throw new Error(); current = saved; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('广告监控记录读取失败，原文件未覆盖。'); current = { version: 1, lastAttemptAt: null, finishedAt: null, error: '', shops: [] }; }
    return current;
  }
  async function save(data) { await mkdir(dirname(file), { recursive: true }); await writeFile(`${file}.tmp`, JSON.stringify(data, null, 2), 'utf8'); await rename(`${file}.tmp`, file); }
  async function snapshot() {
    const data = await read();
    return { intervalHours: 24, thresholdDays: 3, averageDays: 7, running: Boolean(flight), lastAttemptAt: data.lastAttemptAt, finishedAt: data.finishedAt, nextCheckAt: data.lastAttemptAt ? new Date(Date.parse(data.lastAttemptAt) + day).toISOString() : null, error: data.error, shops: data.shops.map(row => assessRow(row, now())) };
  }
  function check() {
    if (flight) return flight.then(snapshot);
    flight = (async () => {
      const data = await read();
      data.lastAttemptAt = new Date(now()).toISOString(); data.error = '';
      await save(data);
      try {
        const ids = await client.shops();
        data.shops = ids.map(id => data.shops.find(row => row.shopId === id) || { shopId: id, name: `店铺 ${id}`, region: null, currency: null, balance: null, balanceAt: null, dailyAverage: null, spendTotal: null, spendDates: [], checkedAt: null, error: '' });
        for (const row of data.shops) {
          row.error = ''; row.checkedAt = new Date(now()).toISOString(); row.dailyAverage = null; row.spendTotal = null; row.spendDates = [];
          try {
            const info = await client.get('shop', row.shopId);
            if (!info.shop_name || !info.region) throw new Error('店铺名称或站点缺失，暂不确定币种。');
            row.name = info.shop_name; row.region = info.region;
            const market = markets[info.region];
            row.currency = market?.[0] || null; row.currencySource = '站点币种映射';
            const result = (await client.get('balance', row.shopId)).response;
            if (typeof result?.total_balance !== 'number' || !Number.isFinite(result.total_balance) || result.total_balance < 0 || !Number.isSafeInteger(result.data_timestamp) || result.data_timestamp <= 0 || result.data_timestamp * 1000 > now() + 300000) throw new Error('余额或平台更新时间缺失/异常，未覆盖历史余额。');
            row.balance = result.total_balance; row.balanceAt = new Date(result.data_timestamp * 1000).toISOString();
            if (!market) throw new Error('站点币种或时区尚未确认，暂不估算。');
            const dates = completeDates(now(), market[1]);
            const resultSpend = await client.get('daily', row.shopId, { start_date: dates[0], end_date: dates[6] });
            const spend = summarizeSpend(resultSpend.response, dates);
            row.dailyAverage = spend.average; row.spendTotal = spend.total; row.spendDates = dates;
          } catch (error) { row.error = error.message; }
        }
      } catch (error) {
        data.error = '授权列表读取失败，请检查本地授权配置。';
        for (const row of data.shops) Object.assign(row, { error: data.error, dailyAverage: null, spendTotal: null, spendDates: [], checkedAt: data.lastAttemptAt });
      }
      data.finishedAt = new Date(now()).toISOString();
      await save(data);
    })().finally(() => { flight = null; });
    return flight.then(snapshot);
  }
  return { snapshot, check,
    start() { if (timer) return; const tick = async () => { try { const data = await read(); if (!data.lastAttemptAt || now() - Date.parse(data.lastAttemptAt) >= day) await check(); } catch { /* Snapshot exposes storage errors without discarding the file. */ } }; timer = setInterval(tick, 60000); timer.unref?.(); void tick(); },
    stop() { clearInterval(timer); timer = null; }
  };
}
