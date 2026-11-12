import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 每日参考汇率：仅用于跨站对比与估算，非实际结汇价。
export const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
export const VCB_URL = 'https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx';
export const CURRENCIES = { MYR: 'ecb', THB: 'ecb', PHP: 'ecb', BRL: 'ecb', VND: 'vcb' };
const SOURCES = {
  ecb: { label: 'ECB 参考汇率', url: ECB_URL, note: '欧洲央行每个工作日约 16:00 CET 发布，经 EUR 交叉换算为 CNY' },
  vcb: { label: 'Vietcombank CNY 卖出价', url: VCB_URL, note: '越南盾按银行人民币卖出价换算，与原试算口径一致' }
};
const hour = 3600000;
const finite = n => typeof n === 'number' && Number.isFinite(n) && n > 0;

export function parseEcb(xml) {
  const date = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(String(xml))?.[1];
  if (!date) throw new Error('ECB 响应缺少日期');
  const eur = {};
  for (const [, code, rate] of String(xml).matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) eur[code] = Number(rate);
  if (!finite(eur.CNY)) throw new Error('ECB 响应缺少 CNY 汇率');
  return { date, eur };
}

export function parseVietcombank(xml) {
  const text = String(xml);
  const quotedAt = /<DateTime>([^<]+)<\/DateTime>/.exec(text)?.[1]?.trim();
  const tag = [...text.matchAll(/<Exrate\b([^>]*)\/?>/g)].map(m => m[1]).find(attrs => /CurrencyCode=["']CNY["']/.test(attrs));
  if (!tag) throw new Error('Vietcombank 响应缺少 CNY 报价');
  const sell = Number((/Sell=["']([^"']+)["']/.exec(tag)?.[1] || '').replace(/,/g, ''));
  if (!finite(sell)) throw new Error('Vietcombank CNY 卖出价缺失');
  if (!quotedAt) throw new Error('Vietcombank 响应缺少报价时间');
  return { quotedAt, vndPerCnySell: sell };
}

/** "11/9/2026 10:27:26 AM"（越南时间）→ "2026-11-09" */
export function vcbDate(quotedAt) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(quotedAt || '');
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

export function ratesFromEcb({ date, eur }, fetchedAt) {
  return Object.fromEntries(Object.entries(CURRENCIES).filter(([, src]) => src === 'ecb').filter(([code]) => finite(eur[code]))
    .map(([code]) => [code, { cnyPerUnit: eur.CNY / eur[code], unitPerCny: eur[code] / eur.CNY, date, quotedAt: date, source: 'ecb', basis: { EURCNY: eur.CNY, [`EUR${code}`]: eur[code] }, fetchedAt }]));
}
export function ratesFromVcb({ quotedAt, vndPerCnySell }, fetchedAt) {
  return { VND: { cnyPerUnit: 1 / vndPerCnySell, unitPerCny: vndPerCnySell, date: vcbDate(quotedAt), quotedAt, source: 'vcb', basis: { VNDperCNY_sell: vndPerCnySell }, fetchedAt } };
}

export function createFxMonitor({ file = fileURLToPath(new URL('../.local/fx-daily.json', import.meta.url)), fetchImpl = globalThis.fetch, now = Date.now, intervalHours = 6, staleDays = 4 } = {}) {
  let current, flight, timer;
  async function read() {
    if (current) return current;
    try { const saved = JSON.parse(await readFile(file, 'utf8')); if (saved.version !== 1 || typeof saved.rates !== 'object') throw new Error(); current = saved; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('汇率记录读取失败，原文件未覆盖。'); current = { version: 1, lastAttemptAt: null, lastSuccessAt: null, errors: {}, rates: {}, history: [] }; }
    return current;
  }
  async function save(data) { await mkdir(dirname(file), { recursive: true }); await writeFile(`${file}.tmp`, JSON.stringify(data, null, 2), 'utf8'); await rename(`${file}.tmp`, file); }
  async function get(url) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'shopee-workbench-fx/1.0' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }
  async function snapshot() {
    const data = await read(), t = now();
    const rates = Object.fromEntries(Object.keys(CURRENCIES).map(code => {
      const row = data.rates[code];
      if (!row) return [code, { currency: code, status: 'missing', ...SOURCES[CURRENCIES[code]], error: data.errors[CURRENCIES[code]] || '' }];
      const stale = !row.date || t - Date.parse(`${row.date}T00:00:00Z`) > staleDays * 24 * hour;
      return [code, { currency: code, ...row, ...SOURCES[row.source], stale, status: stale ? 'stale' : data.errors[row.source] ? 'kept' : 'ok', error: data.errors[row.source] || '' }];
    }));
    return { intervalHours, running: Boolean(flight), lastAttemptAt: data.lastAttemptAt, lastSuccessAt: data.lastSuccessAt, nextCheckAt: data.lastAttemptAt ? new Date(Date.parse(data.lastAttemptAt) + intervalHours * hour).toISOString() : null, errors: data.errors, rates, history: data.history.slice(-30) };
  }
  function refresh() {
    if (flight) return flight.then(snapshot);
    flight = (async () => {
      const data = await read(), fetchedAt = new Date(now()).toISOString();
      data.lastAttemptAt = fetchedAt;
      const results = await Promise.allSettled([get(ECB_URL).then(parseEcb), get(VCB_URL).then(parseVietcombank)]);
      const [ecb, vcb] = results;
      data.errors = {};
      if (ecb.status === 'fulfilled') Object.assign(data.rates, ratesFromEcb(ecb.value, fetchedAt)); else data.errors.ecb = `ECB 读取失败：${ecb.reason?.message || ecb.reason}；保留上次汇率`;
      if (vcb.status === 'fulfilled') Object.assign(data.rates, ratesFromVcb(vcb.value, fetchedAt)); else data.errors.vcb = `Vietcombank 读取失败：${vcb.reason?.message || vcb.reason}；保留上次汇率`;
      if (results.some(r => r.status === 'fulfilled')) {
        data.lastSuccessAt = fetchedAt;
        const day = fetchedAt.slice(0, 10);
        const entry = { day, rates: Object.fromEntries(Object.entries(data.rates).map(([code, row]) => [code, { cnyPerUnit: row.cnyPerUnit, date: row.date }])) };
        data.history = [...data.history.filter(h => h.day !== day), entry].slice(-120);
      }
      await save(data);
    })().finally(() => { flight = null; });
    return flight.then(snapshot);
  }
  async function due() { const data = await read(); return !data.lastAttemptAt || now() - Date.parse(data.lastAttemptAt) >= intervalHours * hour; }
  return {
    snapshot, refresh,
    start() { const tick = () => due().then(isDue => isDue && refresh()).catch(() => {}); tick(); timer = setInterval(tick, 15 * 60000); timer.unref?.(); },
    stop() { clearInterval(timer); }
  };
}
