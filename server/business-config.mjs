import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 经营参数（履约费用、跨境处理费、头程天数、SKU 前缀等）统一放在 config/business.json，本地填写、不提交到仓库。
// 文件缺失或某项留空时一律视为“未设置”：毛利显示待补，绝不按 0 计算。
export const SITES = ['MY', 'TH', 'VN', 'PH'];
const defaultFile = process.env.WORKBENCH_BUSINESS_CONFIG || fileURLToPath(new URL('../config/business.json', import.meta.url));
const num = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const regex = value => { if (typeof value !== 'string' || !value.trim()) return null; try { return new RegExp(value.trim()); } catch { return null; } };

export function parseBusinessConfig(raw = {}) {
  const fees = {};
  for (const site of SITES) {
    const rule = raw.overseasFees?.[site], packing = num(rule?.packingPerOrder), transport = num(rule?.transportPerPair);
    if (packing !== null && transport !== null) fees[site] = { currency: 'CNY', packingPerOrder: packing, transportPerPair: transport };
  }
  const leadDays = {};
  for (const site of SITES) { const v = raw.leadDays?.[site]; if (Number.isInteger(v) && v >= 1 && v <= 120) leadDays[site] = v; }
  const safety = raw.safetyDays;
  const knownAdCampaignIds = {};
  for (const [site, ids] of Object.entries(raw.knownAdCampaignIds || {})) { const list = Array.isArray(ids) ? ids.filter(id => Number.isSafeInteger(id) && id > 0) : []; if (list.length) knownAdCampaignIds[site] = list; }
  return {
    overseasFees: fees,
    crossBorderPerPair: num(raw.crossBorderPerPair),
    leadDays,
    safetyDays: Number.isInteger(safety) && safety >= 0 && safety <= 30 ? safety : 3,
    skuPrefixes: { shoe: regex(raw.skuPrefixes?.shoe), accessory: regex(raw.skuPrefixes?.accessory) },
    knownAdCampaignIds
  };
}

export function loadBusinessConfig(file = defaultFile) {
  let raw = {};
  try { raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (error) { if (error.code !== 'ENOENT') console.warn(`config/business.json 读取失败，按“未设置”处理：${error.message}`); }
  return parseBusinessConfig(raw);
}

export const businessConfig = loadBusinessConfig();
