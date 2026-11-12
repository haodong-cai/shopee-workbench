import './helpers/test-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { windowPeriod, scopeShop, adsForWindow, periodLabel } from '../src/window.mjs';

// 5 天的小样本：01–05/11，站点时区 UTC+7。
const dates = ['01-11-2026', '02-11-2026', '03-11-2026', '04-11-2026', '05-11-2026'];
const period = { start: '2026-11-01', end: '2026-11-05', timeZone: 'Asia/Bangkok', dates };
const at = day => Date.parse(`2026-11-${String(day).padStart(2, '0')}T10:00:00+07:00`) / 1000;
const day = (date, expense) => ({ date, expense, impression: 10, clicks: 2, broad_order: 1, broad_gmv: expense * 3, direct_order: 0, direct_gmv: 0 });
function shop() {
  return { shopId: 1, region: 'TH', currency: 'THB',
    orders: { rows: [1, 3, 5, 5].map((d, i) => ({ orderSn: `O${i}`, status: 'COMPLETED', createTime: at(d), totalAmount: 100, items: [{ itemId: 11, sku: 'A', quantity: 1 }] })), period, updatedAt: 'x' },
    fees: { rows: ['O0', 'O1', 'O2', 'O3'].map(orderSn => ({ orderSn, income: { net: 80 } })), period, expected: 4, received: 4 },
    ads: { period, daily: dates.map((d, i) => day(d, i + 1)), total: 15,
      campaigns: [{ campaignId: 7, itemIds: [11], expense: 10, daily: dates.map(d => day(d, 2)) }, { campaignId: 8, itemIds: [], expense: 5 }],
      gmsItems: [{ itemId: 12, expense: 3 }], gms: { campaignId: 9, windows: { 1: { report: { expense: 0.5 }, items: [{ itemId: 12, expense: 0.5 }] }, 3: { report: { expense: 1.5 }, items: [{ itemId: 12, expense: 1.5 }] }, 5: { report: { expense: 3 }, items: [{ itemId: 12, expense: 3 }] } } },
      reconciliation: { planTotal: 15, gmsTotal: 3, gap: -3 }, warnings: [] },
    returns: { rows: [{ returnSn: 'R' }] } };
}

test('周期切片：取最后 N 天，数据不足时标记', () => {
  assert.deepEqual(windowPeriod(period, 1), { ...period, dates: ['05-11-2026'], start: '2026-11-05', end: '2026-11-05', days: 1, short: false });
  const thirty = windowPeriod(period, 30); assert.deepEqual([thirty.days, thirty.short, thirty.start], [5, true, '2026-11-01']);
  assert.equal(windowPeriod(null, 3), null);
  assert.deepEqual([periodLabel(1), periodLabel(30)], ['昨日', '近 30 天']);
});

test('店铺切片：订单按当地创建日，扣费跟随订单，广告日消耗与计划按天求和，GMV Max 取同周期结果，退货不切', () => {
  const s = scopeShop(shop(), 3);
  assert.deepEqual(s.orders.rows.map(r => r.orderSn), ['O1', 'O2', 'O3']); assert.equal(s.orders.period.start, '2026-11-03');
  assert.deepEqual([s.fees.rows.length, s.fees.expected, s.fees.received], [3, 3, 3]);
  assert.deepEqual([s.ads.daily.length, s.ads.total, s.ads.campaigns[0].expense, s.ads.campaigns[0].broad_gmv, s.ads.gmsItems[0].expense], [3, 12, 6, 18, 1.5]);
  assert.equal(s.ads.campaigns[1].expense, null, '旧数据没有按天明细的计划，短周期无法拆分');
  assert.equal(s.ads.reconciliation, null); assert.match(s.ads.warnings.join(), /重新同步广告/);
  assert.deepEqual(s.returns, shop().returns); assert.equal(s.fullPeriod.dates.length, 5);
  const one = scopeShop(shop(), 1); assert.deepEqual([one.orders.rows.length, one.ads.total, one.ads.gmsReport.expense], [2, 5, 0.5]);
});

test('整段周期沿用原有合计与核对；有按天明细时重算核对差额；广告与订单统计期不同则不切', () => {
  const whole = scopeShop(shop(), 30);
  assert.deepEqual([whole.ads.total, whole.ads.campaigns[1].expense, whole.ads.gmsItems[0].expense], [15, 5, 3]);
  assert.deepEqual([whole.ads.reconciliation.planTotal, whole.ads.reconciliation.gap], [15, -3]);
  const fresh = shop(); fresh.ads.campaigns = [fresh.ads.campaigns[0]];
  const s = adsForWindow(fresh.ads, windowPeriod(period, 3), 5);
  assert.deepEqual([s.reconciliation.planTotal, s.reconciliation.gmsTotal, s.reconciliation.gap, s.reconciliation.gmsItemGap], [6, 1.5, 12 - 6 - 1.5, 0]);
  const stale = shop(); stale.ads.period = { ...period, end: '2026-11-04' };
  assert.equal(scopeShop(stale, 3).ads, stale.ads);
});
