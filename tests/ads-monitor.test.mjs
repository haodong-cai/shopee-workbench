import './helpers/test-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createAdsClient } from '../server/shopee-ads.mjs';
import { assessRow, completeDates, summarizeSpend, createAdsMonitor } from '../server/ads-monitor.mjs';
import { createApp } from '../server/index.mjs';

const clock = Date.parse('2026-10-20T01:00:00Z'), day = 86400000;
const fixtureEnv = { SHOPEE_PARTNER_ID: '123', SHOPEE_PARTNER_KEY: 'fixture-key' };
async function location() { return join(await mkdtemp(join(tmpdir(), 'shopee-ads-')), 'state.json'); }
const ok = payload => ({ ok: true, json: async () => payload });
const dates = completeDates(clock, 'Asia/Bangkok');
const daily = dates.map(date => ({ date, expense: 10 }));
const row = { balance: 30, balanceAt: new Date(clock).toISOString(), dailyAverage: 10, currency: 'THB', error: '' };
function fixtureClient(overrides = {}) { return { shops: async () => [11], get: async kind => kind === 'shop' ? { shop_name: '测试店铺', region: 'TH' } : kind === 'balance' ? { response: { total_balance: 25, data_timestamp: clock / 1000 } } : { response: daily }, ...overrides }; }

test('完整自然日按店铺时区，跨月跨年正确', () => {
  assert.deepEqual(dates, ['13-10-2026','14-10-2026','15-10-2026','16-10-2026','17-10-2026','18-10-2026','19-10-2026']);
  assert.equal(completeDates(Date.parse('2026-01-01T01:00:00Z'), 'America/Sao_Paulo').at(-1), '30-12-2025');
});
test('7日消耗合计70、日均10，缺日重复空值均不冒充0', () => {
  assert.deepEqual(summarizeSpend(daily, dates), { total: 70, average: 10 });
  for (const rows of [daily.slice(1), [...daily, daily[0]], daily.map((r,i) => i ? r : {...r,expense:null}), daily.map((r,i) => i ? r : {...r,expense:-1})]) assert.throws(() => summarizeSpend(rows, dates), /不完整/);
});
test('三天边界、余额0、无消耗、失败与24小时过期分别判断', () => {
  assert.equal(assessRow(row, clock).low, false);
  assert.equal(assessRow({...row,balance:29}, clock).low, true);
  assert.equal(assessRow({...row,balance:0}, clock).days, 0);
  assert.equal(assessRow({...row,dailyAverage:0}, clock).status, 'no_spend');
  assert.equal(assessRow({...row,error:'失败'}, clock).days, null);
  assert.equal(assessRow(row, clock + day).status, 'stale');
});
test('广告客户端仅白名单GET，签名含店铺令牌且错误脱敏', async () => {
  const file = await location();
  await writeFile(file, JSON.stringify({partner_id:123,shop_id_list:[11],access_token:'fixture-access',refresh_token:'fixture-refresh',expires_at:new Date(clock+day).toISOString()}));
  let calls = 0;
  const client=createAdsClient({file,env:fixtureEnv,now:()=>clock,fetchImpl:async (address,options) => {
    calls++; const url=new URL(address); assert.equal(url.origin,'https://partner.shopeemobile.com'); assert.equal(url.pathname,'/api/v2/ads/get_total_balance'); assert.equal(options.method,'GET'); assert.equal(options.redirect,'error');
    assert.equal(url.searchParams.get('sign'),createHmac('sha256','fixture-key').update(`123${url.pathname}${clock/1000}fixture-access11`).digest('hex'));
    return {ok:false,json:async()=>({error:'fixture-access',message:'fixture-key'})};
  }});
  await assert.rejects(client.get('balance',11), error=>!error.message.includes('fixture-access')&&!error.message.includes('fixture-key'));
  await assert.rejects(client.get('orders',11)); await assert.rejects(client.get('balance',12)); assert.equal(calls,1);
});
test('过期令牌每店铺串行刷新一次，并保存轮换结果', async () => {
  const file=await location(); await writeFile(file,JSON.stringify({partner_id:123,shop_id_list:[11],access_token:'old',refresh_token:'refresh-old',expires_at:new Date(clock-day).toISOString()}));
  let refreshed=0;
  const client=createAdsClient({file,env:fixtureEnv,now:()=>clock,fetchImpl:async(address,options)=>{
    if(options.method==='POST'){refreshed++;assert.equal(JSON.parse(options.body).shop_id,11);return ok({shop_id:11,access_token:'new-access',refresh_token:'new-refresh',expire_in:14400});}
    assert.equal(new URL(address).searchParams.get('access_token'),'new-access');return ok({response:{}});
  }});
  await Promise.all([client.get('balance',11),client.get('shop',11)]);
  assert.equal(refreshed,1); const saved=JSON.parse(await readFile(file,'utf8'));assert.equal(saved.shop_tokens[11].refresh_token,'new-refresh');assert.equal(saved.shop_tokens[11].refresh_pending,undefined);
});
test('商品广告白名单按官方GET/POST读取，并使用店铺签名', async () => {
  const file=await location();await writeFile(file,JSON.stringify({partner_id:123,shop_id_list:[11],access_token:'fixture-access',expires_at:new Date(clock+day).toISOString()}));
  const calls=[],bodies=[];const client=createAdsClient({file,env:fixtureEnv,now:()=>clock,fetchImpl:async(address,options)=>{const url=new URL(address);assert.equal(options.method,url.pathname.includes('/get_gms_')?'POST':'GET');assert.equal(options.redirect,'error');assert.equal(url.origin,'https://partner.shopeemobile.com');assert.equal(url.searchParams.get('shop_id'),'11');assert.equal(url.searchParams.get('sign'),createHmac('sha256','fixture-key').update(`123${url.pathname}${clock/1000}fixture-access11`).digest('hex'));calls.push(url);if(options.body)bodies.push(JSON.parse(options.body));return ok({response:{}});}});
  await client.get('campaignIndex',11,{ad_type:'all',offset:'0',limit:'50'});
  await client.get('campaignSettings',11,{info_type_list:'1',campaign_id_list:'1234'});
  await client.get('campaignDaily',11,{start_date:dates[0],end_date:dates[6],campaign_id_list:'1234'});
  await client.get('gmsItems',11,{start_date:dates[0],end_date:dates[6],limit:20,offset:0});
  await client.get('gmsCampaign',11,{campaign_id:1234,start_date:dates[0],end_date:dates[6]});
  assert.deepEqual(calls.map(url=>url.pathname),['/api/v2/ads/get_product_level_campaign_id_list','/api/v2/ads/get_product_level_campaign_setting_info','/api/v2/ads/get_product_campaign_daily_performance','/api/v2/ads/get_gms_item_performance','/api/v2/ads/get_gms_campaign_performance']);assert.equal(calls[0].searchParams.get('limit'),'50');assert.equal(calls[1].searchParams.get('campaign_id_list'),'1234');assert.equal(calls[2].searchParams.get('start_date'),dates[0]);assert.equal(bodies[0].limit,20);assert.equal(bodies[0].start_date,dates[0]);assert.equal(bodies[1].campaign_id,1234);assert.equal(calls[3].searchParams.has('start_date'),false);
});
test('刷新超时后保留待核对状态，不重复使用一次性刷新令牌', async () => {
  const file=await location();await writeFile(file,JSON.stringify({partner_id:123,shop_id_list:[11],refresh_token:'fixture-refresh',expires_at:new Date(clock-day).toISOString()}));let calls=0;
  const client=createAdsClient({file,env:fixtureEnv,now:()=>clock,fetchImpl:async()=>{calls++;throw new Error('secret');}});
  await assert.rejects(client.get('balance',11),/请求未完成/);await assert.rejects(client.get('balance',11),/刷新状态待核对/);assert.equal(calls,1);
});
test('订单利润试读仅允许订单与收入GET，参数不申请买家敏感字段', async () => {
  const file=await location();await writeFile(file,JSON.stringify({partner_id:123,shop_id_list:[11],access_token:'fixture-access',expires_at:new Date(clock+day).toISOString()}));const calls=[];
  const client=createAdsClient({file,env:fixtureEnv,now:()=>clock,fetchImpl:async(address,options)=>{const url=new URL(address);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(url.origin,'https://partner.shopeemobile.com');assert.equal(url.searchParams.get('sign'),createHmac('sha256','fixture-key').update(`123${url.pathname}${clock/1000}fixture-access11`).digest('hex'));calls.push(url);return ok({response:{}});}});
  await client.get('orderList',11,{time_range_field:'create_time',time_from:'1',time_to:'2',page_size:'100',response_optional_fields:'order_status'});
  await client.get('orderDetail',11,{order_sn_list:'fixture-order',response_optional_fields:'item_list,total_amount,fulfillment_flag'});
  await client.get('escrow',11,{order_sn:'fixture-order'});
  await client.get('warehouse',11,{warehouse_type:'1'});
  assert.equal(calls[0].pathname,'/api/v2/order/get_order_list');assert.equal(calls[1].pathname,'/api/v2/order/get_order_detail');assert.equal(calls[2].pathname,'/api/v2/payment/get_escrow_detail');assert.equal(calls[2].searchParams.get('order_sn'),'fixture-order');assert.equal(calls[3].pathname,'/api/v2/shop/get_warehouse_detail');assert.equal(calls[3].searchParams.get('warehouse_type'),'1');assert.equal(/recipient_address|buyer_username|phone/.test(calls[1].searchParams.get('response_optional_fields')),false);
});
test('监控检查保存真实余额25、7日70、日均10与可用2.5天', async () => {
  const file=await location();const monitor=createAdsMonitor({file,client:fixtureClient(),now:()=>clock});const result=await monitor.check();
  assert.equal(result.shops.length,1);assert.equal(result.shops[0].balance,25);assert.equal(result.shops[0].spendTotal,70);assert.equal(result.shops[0].dailyAverage,10);assert.equal(result.shops[0].days,2.5);assert.equal(result.shops[0].low,true);
  assert.equal(result.nextCheckAt,new Date(clock+day).toISOString());assert.equal((await createAdsMonitor({file,now:()=>clock}).snapshot()).shops[0].currency,'THB');
});
test('部分店铺失败仍保留其他店铺结果，历史余额标记失败不估算', async () => {
  const file=await location();let failed=false;
  const base=fixtureClient();const client=fixtureClient({shops:async()=>[11,12],get:async(kind,id)=>{if(id===12||failed)throw new Error('权限待核对');return base.get(kind,id);}});
  const monitor=createAdsMonitor({file,client,now:()=>clock});let result=await monitor.check();assert.equal(result.shops[0].balance,25);assert.equal(result.shops[1].balance,null);assert.equal(result.shops[1].status,'failed');failed=true;result=await monitor.check();assert.equal(result.shops[0].balance,25);assert.equal(result.shops[0].days,null);assert.equal(result.shops[0].status,'failed');
});
test('后台到期检查：首次执行，未到24小时重启不重复请求', async () => {
  const file=await location();let calls=0;const client=fixtureClient({shops:async()=>{calls++;return [];}});const monitor=createAdsMonitor({file,client,now:()=>clock});monitor.start();
  for(let i=0;i<40&&!calls;i++)await new Promise(resolve=>setTimeout(resolve,5));
  await monitor.check();monitor.stop();const before=calls;const next=createAdsMonitor({file,client,now:()=>clock+day-1});next.start();await new Promise(resolve=>setTimeout(resolve,30));next.stop();assert.equal(calls,before);
});
test('授权列表读取失败保留历史余额但停止估算，不沿用成功状态', async () => {
  let failed=false; const client=fixtureClient({shops:async()=>{if(failed)throw new Error('fixture-secret');return [11];}});
  const monitor=createAdsMonitor({file:await location(),client,now:()=>clock});await monitor.check();failed=true;
  const result=await monitor.check();assert.equal(result.shops[0].balance,25);assert.equal(result.shops[0].dailyAverage,null);assert.deepEqual(result.shops[0].spendDates,[]);assert.equal(result.shops[0].days,null);assert.equal(result.shops[0].low,false);assert.equal(result.shops[0].status,'failed');assert.equal(JSON.stringify(result).includes('fixture-secret'),false);
});
test('HTTP快照不调用远端；手动检查回传结果，响应无凭据', async t => {
  const monitor=createAdsMonitor({file:await location(),client:fixtureClient(),now:()=>clock});const server=createApp({adsMonitor:monitor}).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>server.close());const address=`http://127.0.0.1:${server.address().port}`;
  let response=await fetch(address+'/api/ads-monitor');assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).shops.length,0);
  response=await fetch(address+'/api/ads-monitor/check',{method:'POST'});const result=await response.json();assert.equal(result.shops[0].days,2.5);assert.equal(/access_token|refresh_token|partner_key/i.test(JSON.stringify(result)),false);
});
test('损坏记录拒绝读取且不覆盖原文件', async()=>{
  const file=await location();await writeFile(file,'{invalid');const monitor=createAdsMonitor({file,client:fixtureClient(),now:()=>clock});await assert.rejects(monitor.check(),/原文件未覆盖/);assert.equal(await readFile(file,'utf8'),'{invalid');
});
