import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { businessConfig } from './business-config.mjs';

// 部件用途（鞋 / 配件）：决定海外仓“按双运输费”和跨境“每双处理费”。
// 已人工核对的 SPU 记在 .local/sku-roles.json；未核对的按 config/business.json 的 SPU 前缀推定并在页面标注，其余保持待核。
export const ROLES = ['shoe_pair', 'accessory'];

/** @returns {{ role: 'shoe_pair'|'accessory'|null, basis: 'reviewed'|'prefix'|null }} */
export function roleOf(spu, reviewed = {}, prefixes = businessConfig.skuPrefixes) {
  const key = typeof spu === 'string' ? spu.trim() : '';
  if (!key) return { role: null, basis: null };
  if (ROLES.includes(reviewed[key])) return { role: reviewed[key], basis: 'reviewed' };
  if (prefixes?.shoe?.test(key)) return { role: 'shoe_pair', basis: 'prefix' };
  if (prefixes?.accessory?.test(key)) return { role: 'accessory', basis: 'prefix' };
  return { role: null, basis: null };
}

export function createSkuRoles({ file = fileURLToPath(new URL('../.local/sku-roles.json', import.meta.url)) } = {}) {
  let cache = null;
  return {
    /** 读取已核对清单；文件缺失时只用前缀推定，文件损坏时给出 error 且不覆盖。 */
    async load() {
      let mtime;
      try { mtime = (await stat(file)).mtimeMs; } catch { return { roles: {}, stamp: 0, count: 0, error: '' }; }
      if (cache?.stamp === mtime) return cache;
      try {
        const saved = JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''));
        if (saved?.version !== 1 || !saved.roles || typeof saved.roles !== 'object') throw new Error();
        const roles = Object.fromEntries(Object.entries(saved.roles).filter(([, role]) => ROLES.includes(role)));
        cache = { roles, stamp: mtime, count: Object.keys(roles).length, error: '' };
      } catch { cache = { roles: {}, stamp: mtime, count: 0, error: '部件用途清单格式异常，暂只按 SPU 前缀推定' }; }
      return cache;
    }
  };
}
