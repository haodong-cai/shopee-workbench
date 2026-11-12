import { useEffect, useRef, useState } from 'react';

/* ---------- 局域网访问：登录过期时回到访问码页 ---------- */
if (typeof window !== 'undefined' && !window.__wbLanFetch) {
  const original = window.fetch.bind(window);
  window.__wbLanFetch = true;
  window.fetch = async (...args) => {
    const response = await original(...args);
    if (response.status === 401 && String(args[0]).startsWith('/api/')) response.clone().json().then(body => { if (body?.needCode) location.reload(); }).catch(() => {});
    return response;
  };
}

/* ---------- 站点 ---------- */
export const MARKETS = {
  MY: { name: '马来西亚', short: '马来', tone: 'my' },
  TH: { name: '泰国', short: '泰国', tone: 'th' },
  VN: { name: '越南', short: '越南', tone: 'vn' },
  PH: { name: '菲律宾', short: '菲律宾', tone: 'ph' },
  BR: { name: '巴西', short: '巴西', tone: 'br' }
};
export const marketName = code => MARKETS[code]?.name || code || '站点待确认';
export const ORDER_ORDER = ['MY', 'TH', 'VN', 'PH', 'BR'];
const marketIndex = code => { const i = ORDER_ORDER.indexOf(code); return i < 0 ? 99 : i; };
export const sortByMarket = (a, b) => marketIndex(a.region) - marketIndex(b.region);

/* ---------- 状态文案 ---------- */
export const STATUS = { READY_TO_SHIP: '待发货', PROCESSED: '待出库', RETRY_SHIP: '重新发货', SHIPPED: '已发货', COMPLETED: '已完成', UNPAID: '未付款', CANCELLED: '已取消', IN_CANCEL: '取消中', TO_CONFIRM_RECEIVE: '待收货', TO_RETURN: '退货中', REQUESTED: '待处理', ACCEPTED: '已接受', PROCESSING: '处理中', JUDGING: '平台处理中', CLOSED: '已关闭', REFUND_PAID: '已退款', SELLER_DISPUTE: '卖家争议中' };
export const STATUS_TONE = { CANCELLED: 'mute', IN_CANCEL: 'warn', UNPAID: 'mute', TO_RETURN: 'bad', COMPLETED: 'good', SHIPPED: 'info', TO_CONFIRM_RECEIVE: 'info', PROCESSED: 'warn', READY_TO_SHIP: 'warn', REQUESTED: 'warn', JUDGING: 'warn', SELLER_DISPUTE: 'bad', REFUND_PAID: 'mute', CLOSED: 'mute' };
export const EXCLUDED = ['CANCELLED', 'IN_CANCEL', 'UNPAID'];
export const FULFILLMENT = { overseas_warehouse: '海外仓', cross_border: '跨境', unknown: '待核' };

/* ---------- 数字 ---------- */
const decimalsFor = currency => currency === 'VND' ? 0 : 2;
export const isNum = n => typeof n === 'number' && Number.isFinite(n);
export function money(n, currency, fallback = '—') {
  if (!isNum(n)) return fallback;
  const d = decimalsFor(currency);
  return n.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function compact(n, currency) {
  if (!isNum(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (abs >= 1e5) return `${(n / 1e4).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}万`;
  return money(n, currency);
}
export function short(n) {
  if (!isNum(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (abs >= 1e5) return `${(n / 1e4).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}万`;
  return n.toLocaleString('zh-CN', { maximumFractionDigits: abs >= 1000 ? 0 : 2 });
}
export const int = n => isNum(n) ? n.toLocaleString('zh-CN') : '—';
export const pct = (n, digits = 1) => isNum(n) ? `${(n * 100).toFixed(digits)}%` : '—';
export const ratio = (a, b) => isNum(a) && isNum(b) && b !== 0 ? a / b : null;
export const sumBy = (rows, fn) => rows.reduce((n, r) => n + (fn(r) || 0), 0);

/* ---------- 时间 ---------- */
export function stamp(value, zone = 'Asia/Shanghai') {
  if (!value) return '—';
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return new Intl.DateTimeFormat('zh-CN', { timeZone: zone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
export function ago(value, now = Date.now()) {
  if (!value) return '未同步';
  const diff = Math.max(0, now - Date.parse(value)) / 60000;
  if (diff < 1) return '刚刚';
  if (diff < 60) return `${Math.round(diff)} 分钟前`;
  if (diff < 60 * 24) return `${Math.floor(diff / 60)} 小时前`;
  return `${Math.floor(diff / 1440)} 天前`;
}
export const isStale = (value, hours = 24) => !!value && Date.now() - Date.parse(value) >= hours * 3600000;
export const localDate = (seconds, zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(seconds * 1000));
/** "02-11-2026" → "2026-11-02" */
export const isoFromDmy = dmy => dmy.split('-').reverse().join('-');
export const md = iso => iso ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}` : '—';

/* ---------- 数据读取 ---------- */
const cache = new Map();
export async function getJson(url, { fresh = false, signal } = {}) {
  if (!fresh && cache.has(url)) return cache.get(url);
  const promise = fetch(url, { cache: 'no-store', signal }).then(async response => {
    if (!response.ok) throw new Error(`读取失败（${response.status}）`);
    return response.json();
  });
  cache.set(url, promise);
  promise.catch(() => cache.delete(url));
  return promise;
}
export function useJson(url, { interval = 0 } = {}) {
  const [state, setState] = useState({ data: null, error: '', loading: true });
  const tick = useRef(0);
  async function load(fresh = true) {
    const id = ++tick.current;
    setState(s => ({ ...s, loading: true }));
    try { const data = await getJson(url, { fresh }); if (id === tick.current) setState({ data, error: '', loading: false }); }
    catch (e) { if (id === tick.current) setState(s => ({ ...s, error: e.message, loading: false })); }
  }
  useEffect(() => {
    load(false);
    if (!interval) return undefined;
    const timer = setInterval(() => load(true), interval);
    return () => clearInterval(timer);
  }, [url, interval]);
  return { ...state, reload: () => load(true) };
}
export function downloadJson(data, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- 汇总 ---------- */
export function shopDigest(shop) {
  const orders = shop.orders?.rows || [];
  const valid = orders.filter(r => !EXCLUDED.includes(r.status));
  const cancelled = orders.filter(r => r.status === 'CANCELLED' || r.status === 'IN_CANCEL').length;
  const validAmount = valid.every(r => isNum(r.totalAmount)) ? sumBy(valid, r => r.totalAmount) : null;
  const fees = shop.fees?.rows || [];
  const netRows = fees.filter(r => r.income);
  const net = netRows.length ? sumBy(netRows, r => r.income.net) : null;
  const netBase = netRows.length ? sumBy(orders.filter(o => netRows.some(r => r.orderSn === o.orderSn)), o => o.totalAmount) : null;
  const ads = shop.ads || {};
  const daily = ads.daily || [];
  const adSpend = isNum(ads.total) ? ads.total : null;
  const adGmv = daily.length ? sumBy(daily, d => d.broad_gmv) : null;
  const adOrders = daily.length ? sumBy(daily, d => d.broad_order) : null;
  const zone = shop.orders?.period?.timeZone;
  const dates = (shop.orders?.period?.dates || []).map(isoFromDmy);
  const perDay = dates.map(date => ({ date, orders: valid.filter(r => zone && localDate(r.createTime, zone) === date).length, spend: daily.find(d => isoFromDmy(d.date) === date)?.expense ?? null }));
  const gap = ads.reconciliation?.gap;
  return {
    total: orders.length, valid: valid.length, cancelled, cancelRate: ratio(cancelled, orders.length),
    pendingShip: orders.filter(r => r.status === 'PROCESSED' || r.status === 'READY_TO_SHIP').length,
    toReturn: orders.filter(r => r.status === 'TO_RETURN').length,
    validAmount, net, netRate: ratio(net, netBase), feeCoverage: shop.fees ? [shop.fees.received, shop.fees.expected] : null,
    adSpend, adGmv, adOrders, roas: ratio(adGmv, adSpend), adShare: ratio(adSpend, validAmount),
    adGap: isNum(gap) && adSpend ? (Math.abs(gap) >= Math.max(1, adSpend * 0.005) ? gap : 0) : null,
    returns: shop.returns?.rows || [], perDay, period: shop.orders?.period
  };
}

/* ---------- 发货时效 ---------- */
export const TO_SHIP = ['READY_TO_SHIP', 'PROCESSED', 'RETRY_SHIP'];
export function shipUrgency(row, now = Date.now()) {
  if (!TO_SHIP.includes(row.status)) return null;
  if (!isNum(row.shipByDate)) return { bucket: 'unknown', hours: null };
  const hours = (row.shipByDate * 1000 - now) / 3600000;
  return { hours, bucket: hours < 0 ? 'overdue' : hours < 12 ? 'h12' : hours < 24 ? 'h24' : hours < 48 ? 'h48' : 'later' };
}
export const SHIP_BUCKETS = { overdue: ['已超时', 'bad'], h12: ['12 小时内', 'bad'], h24: ['24 小时内', 'warn'], h48: ['48 小时内', 'info'], later: ['48 小时以上', 'good'], unknown: ['期限待同步', ''] };
export function hoursText(hours) {
  if (!isNum(hours)) return '—';
  const abs = Math.abs(hours), text = abs < 1 ? `${Math.max(1, Math.round(abs * 60))} 分钟` : abs < 48 ? `${abs.toFixed(abs < 10 ? 1 : 0)} 小时` : `${(abs / 24).toFixed(1)} 天`;
  return hours < 0 ? `已超 ${text}` : `剩 ${text}`;
}

/* ---------- 取消原因 ---------- */
const CANCEL_TEXT = [
  [/out of stock/i, '缺货'], [/backend_logistics_not_started|logistics_not_start/i, '未按时发货（物流未启动）'], [/pickup_failed/i, '物流揽收失败'],
  [/logistics_request_cancel/i, '物流取消'], [/failed[_ ]delivery/i, '派送失败'], [/lost/i, '包裹丢失'], [/undeliverable/i, '无法配送地区'],
  [/\bcod\b/i, '不支持货到付款'], [/unpaid|payment.*(time|expire)/i, '未付款超时'], [/delivery address/i, '买家要改收货地址'], [/voucher/i, '买家要改优惠券'],
  [/modify order|size|color|colour/i, '买家要改尺码/颜色/数量'], [/troublesome/i, '买家嫌付款麻烦'], [/cheaper/i, '买家找到更便宜的'],
  [/don'?t want|no longer/i, '买家不想买了'], [/customer request|buyer request/i, '买家申请取消'], [/^others?$/i, '其他']
];
export const CANCEL_BY = { buyer: '买家', seller: '卖家', system: '系统', ops: '平台', Ops: '平台' };
export function cancelLabel(row) {
  const raw = row.cancelBy === 'buyer' && row.buyerCancelReason ? row.buyerCancelReason : row.cancelReason || row.buyerCancelReason;
  if (!raw) return { label: row.status === 'UNPAID' ? '未付款' : '原因待同步', raw: '' };
  return { label: CANCEL_TEXT.find(([re]) => re.test(raw))?.[1] || raw, raw };
}

/* ---------- 商品 / 规格键 ---------- */
export const modelKey = (shopId, itemId, modelId) => `${shopId}:${itemId}:${modelId || 0}`;
export function salesByModel(shops) {
  const map = new Map();
  for (const shop of shops) for (const row of shop.orders?.rows || []) {
    if (EXCLUDED.includes(row.status)) continue;
    for (const item of row.items || []) {
      const key = modelKey(shop.shopId, item.itemId, item.modelId), cur = map.get(key) || { qty: 0, orders: new Set() };
      cur.qty += item.quantity || 0; cur.orders.add(row.orderSn); map.set(key, cur);
    }
  }
  return map;
}
