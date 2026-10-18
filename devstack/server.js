// 本機開發／測試閘道（不是正式環境）：模擬 Supabase 的 /rest/v1、/auth/v1、/realtime/v1，並提供靜態檔案。
//   /rest/v1/*      → 反向代理到本機 PostgREST（真的會執行 RLS 與 RPC）
//   /auth/v1/token  → 以 users.json 驗證帳密，簽發 HS256 JWT（role=authenticated）
//   /realtime/v1    → 最小 Phoenix websocket：private channel 授權 + 轉發 realtime.send 的 Broadcast
//   其他            → /home/user/zhongxin-sites 靜態檔
// 另外記錄每個請求的回應位元組與 websocket 下行位元組，供 Egress 量測（GET /__meter）
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { Client } = require('pg');

const PORT = +process.env.PORT || 8080;
const ROOT = path.resolve(__dirname, '..');
const SECRET = fs.readFileSync(path.join(__dirname, '.jwt_secret'), 'utf8').trim();
const USERS = JSON.parse(fs.readFileSync(path.join(__dirname, 'users.json'), 'utf8'));
const DB = process.env.ZX_DB || 'zxdev';

const meter = { started: Date.now(), http: {}, ws: { frames: 0, bytes: 0, heartbeats: 0, broadcasts: 0, connections: 0 } };
function record(key, bytes) {
  const m = meter.http[key] || (meter.http[key] = { calls: 0, bytes: 0 });
  m.calls++; m.bytes += bytes;
}

const ANON_KEY = jwt.sign({ role: 'anon', iss: 'zx-dev' }, SECRET, { expiresIn: '10y' });
fs.writeFileSync(path.join(__dirname, '.anon_key'), ANON_KEY);

// 匿名登入（Supabase signInAnonymously）：裝置專屬 user id，不需帳密；重啟閘道後由 refresh token 還原
const crypto = require('crypto');
function findUser(id) {
  return USERS.find(x => x.id === id) || (/^[0-9a-f-]{36}$/.test(id) ? { id, email: '', anonymous: true } : null);
}

function issue(user) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const access_token = jwt.sign({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', exp,
                                  is_anonymous: !!user.anonymous }, SECRET);
  return {
    access_token, token_type: 'bearer', expires_in: 3600, expires_at: exp,
    refresh_token: Buffer.from(user.id).toString('base64'),
    user: { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, is_anonymous: !!user.anonymous,
            app_metadata: { provider: user.anonymous ? 'anonymous' : 'email' }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }
  };
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Profile, Range-Unit');
}

function readBody(req) {
  return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
}

function sendJson(res, code, obj, key) {
  const body = obj === null ? '' : JSON.stringify(obj);
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
  if (key) record(key, Buffer.byteLength(body));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.xlsx': 'application/octet-stream' };

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  if (u.pathname === '/__meter') return sendJson(res, 200, meter);
  if (u.pathname === '/__realtime/down') { wsBlocked = true; for (const ws of sockets) ws.terminate(); return sendJson(res, 200, { down: true }); }
  if (u.pathname === '/__realtime/up') { wsBlocked = false; return sendJson(res, 200, { down: false }); }
  if (u.pathname === '/__dev_config') return sendJson(res, 200, { url: 'http://' + req.headers.host, anonKey: ANON_KEY });
  if (u.pathname === '/__meter/reset') { meter.started = Date.now(); meter.http = {}; Object.assign(meter.ws, { frames: 0, bytes: 0, heartbeats: 0, broadcasts: 0 }); return sendJson(res, 200, { ok: true }); }

  if (u.pathname.startsWith('/auth/v1/')) {
    const ep = u.pathname.slice(9);
    if (ep === 'token') {
      const body = JSON.parse((await readBody(req)) || '{}');
      let user;
      if (u.query.grant_type === 'password') user = USERS.find(x => x.email === body.email && x.password === body.password);
      else if (u.query.grant_type === 'refresh_token') {
        const id = Buffer.from(body.refresh_token || '', 'base64').toString();
        user = findUser(id);
      }
      if (!user) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials' }, 'POST /auth/token');
      return sendJson(res, 200, issue(user), 'POST /auth/token');
    }
    if (ep === 'user') {
      try {
        const claims = jwt.verify((req.headers.authorization || '').replace(/^Bearer /, ''), SECRET);
        const user = findUser(claims.sub);
        return sendJson(res, 200, issue(user).user, 'GET /auth/user');
      } catch (e) { return sendJson(res, 401, { msg: 'invalid token' }); }
    }
    if (ep === 'signup') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.email) return sendJson(res, 422, { msg: 'email signup not supported in dev stack' });
      const user = { id: crypto.randomUUID(), email: '', anonymous: true };
      try { await pg.query('insert into auth.users(id) values ($1) on conflict do nothing', [user.id]); }
      catch (e) { return sendJson(res, 500, { msg: 'db not ready' }); }
      return sendJson(res, 200, issue(user), 'POST /auth/signup');
    }
    if (ep === 'logout') { cors(res); res.writeHead(204); return res.end(); }
    return sendJson(res, 404, { msg: 'not implemented in dev stack' });
  }

  if (u.pathname.startsWith('/rest/v1') || u.pathname.startsWith('/old/rest/v1')) {
    // /old/rest/v1 → 第二個 PostgREST（模擬舊專案，測試搬移工具用）
    const oldProject = u.pathname.startsWith('/old/');
    const target = u.path.replace(/^(\/old)?\/rest\/v1/, '') || '/';
    const body = ['GET', 'HEAD'].includes(req.method) ? null : await readBody(req);
    const headers = Object.assign({}, req.headers, { host: 'localhost:3001' });
    delete headers['content-length'];
    // Supabase 的 API gateway 會把 anon key 當成 JWT；開發閘道照做
    if (!headers.authorization && headers.apikey) headers.authorization = 'Bearer ' + headers.apikey;
    // 與 Supabase 相同：在 x-forwarded-for 帶上用戶端 IP（測試可用 X-Forwarded-For 標頭模擬不同 IP）
    headers['x-forwarded-for'] = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const p = http.request({ host: '127.0.0.1', port: oldProject ? 3002 : 3001, path: target, method: req.method, headers }, pr => {
      const chunks = [];
      pr.on('data', c => chunks.push(c));
      pr.on('end', () => {
        const buf = Buffer.concat(chunks);
        cors(res);
        const h = Object.assign({}, pr.headers);
        delete h['transfer-encoding']; delete h['connection'];
        res.writeHead(pr.statusCode, h);
        res.end(buf);
        const key = req.method + ' ' + target.split('?')[0];
        record(key, buf.length);
      });
    });
    p.on('error', e => sendJson(res, 502, { message: 'PostgREST unreachable: ' + e.message }));
    if (body) p.write(body);
    p.end();
    return;
  }

  // 靜態檔
  let file = path.join(ROOT, decodeURIComponent(u.pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

// ---------------- realtime（Phoenix v1 JSON 協定的最小子集） ----------------
const wss = new WebSocketServer({ noServer: true });
const sockets = new Set();

function wsSend(ws, msg) {
  const s = JSON.stringify(msg);
  ws.send(s);
  meter.ws.frames++; meter.ws.bytes += Buffer.byteLength(s);
}

let pg = null;
function onNotify(n) {
  const msg = JSON.parse(n.payload);
  const topic = 'realtime:' + msg.topic;
  for (const ws of sockets) {
    if (!ws.topics.has(topic) || ws.paused) continue;
    meter.ws.broadcasts++;
    wsSend(ws, { topic, event: 'broadcast', payload: { type: 'broadcast', event: msg.event, payload: msg.payload }, ref: null });
  }
}
async function connectPg() {
  const c = new Client({ host: '/var/tmp/zxsock', port: 5544, user: 'postgres', database: DB });
  c.on('error', e => { console.warn('pg error, reconnecting:', e.message); setTimeout(connectPg, 1000); });
  c.on('notification', onNotify);
  try { await c.connect(); await c.query('listen zx_rt'); pg = c; console.log('pg listen ok'); }
  catch (e) { console.warn('pg connect failed, retrying:', e.message); setTimeout(connectPg, 1000); }
}

async function isMember(token) {
  try {
    const claims = jwt.verify(token, SECRET);
    const r = await pg.query('select 1 from public.app_members where user_id = $1 and is_active', [claims.sub]);
    return r.rowCount > 0;
  } catch (e) { return false; }
}

let wsBlocked = false;   // 測試：模擬 Realtime 服務中斷（API 仍正常）
server.on('upgrade', (req, sock, head) => {
  if (!req.url.startsWith('/realtime/v1/websocket') || wsBlocked) return sock.destroy();
  wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', ws => {
  meter.ws.connections++;
  ws.topics = new Map();   // topic → { private, token }
  sockets.add(ws);
  ws.on('close', () => sockets.delete(ws));
  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const reply = (payload) => wsSend(ws, { topic: m.topic, event: 'phx_reply', payload, ref: m.ref, join_ref: m.join_ref });
    if (m.topic === 'phoenix' && m.event === 'heartbeat') { meter.ws.heartbeats++; return reply({ status: 'ok', response: {} }); }
    if (m.event === 'phx_join') {
      const cfg = (m.payload && m.payload.config) || {};
      const token = m.payload && m.payload.access_token;
      if (cfg.private && !(await isMember(token))) {
        return reply({ status: 'error', response: { reason: 'Unauthorized: You do not have permissions to read from this Channel topic' } });
      }
      ws.topics.set(m.topic, { private: !!cfg.private, token });
      return reply({ status: 'ok', response: { postgres_changes: [] } });
    }
    if (m.event === 'access_token') { const t = ws.topics.get(m.topic); if (t) t.token = m.payload.access_token; return; }
    if (m.event === 'phx_leave') { ws.topics.delete(m.topic); return reply({ status: 'ok', response: {} }); }
  });
});

connectPg();
server.listen(PORT, () => console.log('dev gateway on http://localhost:' + PORT + '  anon key in devstack/.anon_key'));

// 測試用：暫停／恢復所有 websocket 推播（模擬 Realtime 斷線但 API 正常）
process.on('SIGUSR1', () => { for (const ws of sockets) ws.paused = !ws.paused; console.log('realtime paused toggled'); });
