import './helpers/test-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEcb, parseVietcombank, vcbDate, createFxMonitor, ECB_URL, VCB_URL } from '../server/fx.mjs';

const ecbXml = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
<gesmes:subject>Reference rates</gesmes:subject><Cube><Cube time='2026-10-19'>
<Cube currency='USD' rate='1.0845'/><Cube currency='BRL' rate='6.1234'/><Cube currency='CNY' rate='7.4991'/>
<Cube currency='MYR' rate='4.5826'/><Cube currency='PHP' rate='70.715'/><Cube currency='THB' rate='37.665'/>
</Cube></Cube></gesmes:Envelope>`;
const vcbXml = `<?xml version="1.0" encoding="utf-8"?><ExrateList><DateTime>10/20/2026 10:27:26 AM</DateTime>
<Exrate CurrencyCode="AUD" CurrencyName="AUSTRALIAN DOLLAR" Buy="16,800.00" Transfer="16,900.00" Sell="17,400.00" />
<Exrate CurrencyCode="CNY" CurrencyName="YUAN RENMINBI" Buy="3,750.12" Transfer="3,788.00" Sell="3,935.54" />
<Source>Joint Stock Commercial Bank for Foreign Trade of Vietnam - Vietcombank</Source></ExrateList>`;
const ok = text => ({ ok: true, status: 200, text: async () => text });
async function tempFile(t) { const dir = await mkdtemp(path.join(tmpdir(), 'fx-')); t.after(() => rm(dir, { recursive: true, force: true })); return path.join(dir, 'fx.json'); }

test('parses ECB cross rates and Vietcombank CNY sell quote', () => {
  const ecb = parseEcb(ecbXml);
  assert.equal(ecb.date, '2026-10-19');
  assert.equal(ecb.eur.MYR, 4.5826);
  const vcb = parseVietcombank(vcbXml);
  assert.equal(vcb.vndPerCnySell, 3935.54);
  assert.equal(vcbDate(vcb.quotedAt), '2026-10-20');
  assert.throws(() => parseEcb('<Cube time="2026-10-19"><Cube currency="USD" rate="1"/></Cube>'), /CNY/);
  assert.throws(() => parseVietcombank('<ExrateList><DateTime>x</DateTime></ExrateList>'), /CNY/);
});

test('refresh stores CNY-per-unit rates matching the original trial method', async t => {
  const file = await tempFile(t);
  const fx = createFxMonitor({ file, now: () => Date.parse('2026-10-20T05:00:00Z'), fetchImpl: async url => ok(url === ECB_URL ? ecbXml : vcbXml) });
  const snap = await fx.refresh();
  assert.ok(Math.abs(snap.rates.MYR.cnyPerUnit - 1.6364291013834942) < 1e-12);
  assert.ok(Math.abs(snap.rates.THB.cnyPerUnit - 0.19909996017522902) < 1e-12);
  assert.ok(Math.abs(snap.rates.VND.cnyPerUnit - 1 / 3935.54) < 1e-15);
  assert.equal(snap.rates.BRL.status, 'ok');
  assert.equal(snap.rates.VND.date, '2026-10-20');
  assert.equal(snap.history.length, 1);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 1);
});

test('a failed source keeps the previous rates and reports the error; nothing is invented', async t => {
  const file = await tempFile(t);
  let fail = false, clock = Date.parse('2026-10-20T05:00:00Z');
  const fx = createFxMonitor({ file, now: () => clock, fetchImpl: async url => { if (fail && url === VCB_URL) throw new Error('timeout'); return ok(url === ECB_URL ? ecbXml : vcbXml); } });
  await fx.refresh();
  fail = true; clock += 6 * 3600000;
  const snap = await fx.refresh();
  assert.equal(snap.rates.VND.status, 'kept');
  assert.match(snap.rates.VND.error, /timeout/);
  assert.equal(snap.rates.VND.cnyPerUnit, 1 / 3935.54);
  assert.equal(snap.rates.MYR.status, 'ok');
});

test('no data yet and all sources down → rates stay missing, rates become stale after 4 days', async t => {
  const file = await tempFile(t);
  let clock = Date.parse('2026-10-20T05:00:00Z'), down = true;
  const fx = createFxMonitor({ file, now: () => clock, fetchImpl: async url => { if (down) return { ok: false, status: 503, text: async () => '' }; return ok(url === ECB_URL ? ecbXml : vcbXml); } });
  let snap = await fx.refresh();
  assert.equal(snap.rates.MYR.status, 'missing');
  assert.equal(snap.rates.MYR.cnyPerUnit, undefined);
  assert.equal(snap.lastSuccessAt, null);
  down = false; await fx.refresh();
  clock = Date.parse('2026-10-25T05:00:00Z');
  snap = await fx.snapshot();
  assert.equal(snap.rates.MYR.status, 'stale');
});
