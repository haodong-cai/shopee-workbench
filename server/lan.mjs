import { randomInt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

// 局域网访问：服务监听全部网卡，本机始终可用；同一网络的其他电脑在主机开启后直接打开地址即可（默认不设访问码，可在主机上开启）。
// 可选访问码：主机上勾选后同事需输入 6 位码，浏览器记住 30 天。开关、访问码只能在主机上修改。
const COOKIE = 'wb_lan', DAY = 86400000, SESSION_DAYS = 30, MAX_SESSIONS = 200;
const strip = ip => String(ip || '').replace(/^::ffff:/i, '').toLowerCase();
const hash = token => createHash('sha256').update(token).digest('hex');
const newCode = () => String(randomInt(0, 1000000)).padStart(6, '0');

export function interfaceAddresses() {
  const set = new Set(['127.0.0.1', '::1']);
  for (const list of Object.values(os.networkInterfaces())) for (const row of list || []) set.add(strip(row.address));
  return set;
}
/** 同事可以用的地址：本机非回环 IPv4（排除 169.254 自动地址）。 */
export function lanUrls(port) {
  const urls = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const row of list || [])
    if ((row.family === 'IPv4' || row.family === 4) && !row.internal && !row.address.startsWith('169.254.')) urls.push({ name, url: `http://${row.address}:${port}` });
  return urls;
}
function hostnameOf(host) {
  const text = String(host || '').trim().toLowerCase();
  if (text.startsWith('[')) return text.slice(1, text.indexOf(']'));
  return text.replace(/:\d+$/, '');
}
function cookieOf(req) {
  for (const part of String(req.headers.cookie || '').split(';')) { const [key, ...rest] = part.trim().split('='); if (key === COOKIE) return rest.join('='); }
  return '';
}
const sameText = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

export function loginPage(message = '') {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>输入访问码 · 虾皮控制中台</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f3ef;font:15px/1.6 "Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:#1d1f24}
form{box-sizing:border-box;width:min(340px,calc(100vw - 32px));background:#fff;border:1px solid #e3e1da;border-radius:14px;padding:28px 24px;box-shadow:0 8px 30px rgba(0,0,0,.06)}
.mark{width:40px;height:40px;border-radius:11px;background:#ee4d2d;color:#fff;display:grid;place-items:center;font-weight:800;font-size:20px;margin-bottom:14px}
h1{font-size:18px;margin:0 0 4px}p{margin:0 0 18px;color:#6b6f78;font-size:13px}
input{width:100%;box-sizing:border-box;font:600 24px/1 "Bahnschrift",monospace;letter-spacing:.3em;text-align:center;padding:12px;border:1px solid #d6d3cb;border-radius:10px;margin-bottom:12px}
button{width:100%;padding:11px;border:0;border-radius:10px;background:#ee4d2d;color:#fff;font:600 15px inherit;cursor:pointer}.err{color:#c4320a;font-size:13px;min-height:20px;margin:0 0 6px}
@media (prefers-color-scheme:dark){body{background:#15171c;color:#eceef2}form{background:#1d2026;border-color:#2c3038}input{background:#15171c;color:#eceef2;border-color:#3a3f48}p{color:#9aa0aa}}</style></head>
<body><form id="f"><div class="mark">虾</div><h1>虾皮控制中台</h1><p>请输入主机电脑上“数据与接入 → 局域网访问”显示的 6 位访问码。</p>
<input id="c" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="······" autofocus aria-label="访问码"><div class="err" id="e">${message}</div><button>进入工作台</button></form>
<script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;const el=document.getElementById('e');el.textContent='';
try{const r=await fetch('/api/lan/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:document.getElementById('c').value.trim()})});const d=await r.json().catch(()=>({}));if(r.ok){location.reload();return}el.textContent=d.error||'访问码不正确'}catch{el.textContent='连接失败，请确认主机电脑开着工作台'}b.disabled=false}</script></body></html>`;
}

export function createLanAccess({ file = fileURLToPath(new URL('../.local/lan.json', import.meta.url)), port = 8787, now = Date.now, addressOf = req => req.socket?.remoteAddress, interfaces = interfaceAddresses, urls = () => lanUrls(port), hostname = os.hostname() } = {}) {
  let data, saving = Promise.resolve();
  const failures = new Map();
  async function read() {
    if (data) return data;
    try { const saved = JSON.parse(await readFile(file, 'utf8')); if (saved.version !== 1 || !/^\d{6}$/.test(saved.code) || !Array.isArray(saved.sessions)) throw new Error(); data = saved; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('局域网访问设置读取失败，原文件未覆盖。'); data = { version: 1, enabled: true, requireCode: false, code: newCode(), sessions: [] }; await save(); }
    return data;
  }
  async function save() {
    const text = JSON.stringify(data, null, 2);
    saving = saving.catch(() => {}).then(async () => { await mkdir(dirname(file), { recursive: true }); await writeFile(`${file}.tmp`, text, { encoding: 'utf8', mode: 0o600 }); await rename(`${file}.tmp`, file); });
    await saving;
  }
  const isLocal = req => interfaces().has(strip(addressOf(req)));
  const ipOf = req => strip(addressOf(req));
  /** 只接受用本机名、localhost 或本机 IP 访问，防止借用其他域名绕过本机信任（DNS 重绑定）。 */
  function hostAllowed(req) {
    const name = hostnameOf(req.headers.host), host = String(hostname || '').toLowerCase();
    return Boolean(name) && (name === 'localhost' || name === host || name === `${host}.local` || interfaces().has(name));
  }
  function activeSession(state, req) {
    const token = cookieOf(req);
    if (!token) return null;
    const row = state.sessions.find(s => s.hash === hash(token));
    return row && now() - Date.parse(row.lastSeen) < SESSION_DAYS * DAY ? row : null;
  }
  const deny = (req, res, status, text, extra = {}) => req.path.startsWith('/api/') ? res.status(status).json({ error: text, ...extra }) : res.status(status).type('html').send(status === 401 ? loginPage() : `<!doctype html><meta charset="utf-8"><title>无法访问</title><p style="font:15px system-ui;padding:40px">${text}</p>`);

  return {
    async guard(req, res, next) {
      try {
        if (!hostAllowed(req)) return deny(req, res, 403, '请用主机 IP 地址或 localhost 访问工作台。');
        if (isLocal(req)) { req.lan = { local: true }; return next(); }
        const state = await read();
        if (!state.enabled) return deny(req, res, 403, '主机电脑未开启局域网访问，请在主机的“数据与接入 → 局域网访问”中开启。');
        if (req.path === '/api/lan/login' && req.method === 'POST') { req.lan = { local: false }; return next(); }
        if (!state.requireCode) { req.lan = { local: false }; return next(); }
        const session = activeSession(state, req);
        if (!session) return deny(req, res, 401, '需要访问码', { needCode: true });
        if (now() - Date.parse(session.lastSeen) > 10 * 60000) { session.lastSeen = new Date(now()).toISOString(); session.ip = ipOf(req); save().catch(() => {}); }
        req.lan = { local: false };
        next();
      } catch (error) { next(error); }
    },
    async login(req, res) {
      const ip = ipOf(req), t = now(), record = failures.get(ip) || { count: 0, since: t };
      if (t - record.since > 10 * 60000) { record.count = 0; record.since = t; }
      if (record.count >= 8) return res.status(429).json({ error: '尝试次数过多，请 10 分钟后再试' });
      const state = await read();
      if (!sameText(String(req.body?.code ?? '').trim(), state.code)) { record.count++; failures.set(ip, record); return res.status(401).json({ error: '访问码不正确' }); }
      failures.delete(ip);
      const token = randomBytes(24).toString('base64url'), stamp = new Date(t).toISOString();
      state.sessions = [...state.sessions.filter(s => t - Date.parse(s.lastSeen) < SESSION_DAYS * DAY), { hash: hash(token), createdAt: stamp, lastSeen: stamp, ip }].slice(-MAX_SESSIONS);
      await save();
      res.set('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`).json({ ok: true });
    },
    async status(req) {
      const state = await read(), local = Boolean(req.lan?.local ?? isLocal(req)), t = now();
      const active = state.sessions.filter(s => t - Date.parse(s.lastSeen) < SESSION_DAYS * DAY);
      return { available: true, local, enabled: state.enabled, requireCode: state.requireCode, port, urls: urls(),
        ...(local ? { code: state.code, devices: active.length, recent: active.filter(s => t - Date.parse(s.lastSeen) < DAY).length } : {}) };
    },
    async configure(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置无效');
      const state = await read();
      for (const key of ['enabled', 'requireCode']) if (key in patch) { if (typeof patch[key] !== 'boolean') throw new Error('开关值无效'); state[key] = patch[key]; }
      await save();
    },
    /** 换新访问码，已登录的同事全部需要重新输入。 */
    async regenerate() { const state = await read(); state.code = newCode(); state.sessions = []; await save(); },
    isLocal
  };
}
