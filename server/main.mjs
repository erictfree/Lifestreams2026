// lifestreamd — a small local server: the file store, the harness, a JSON API, server-sent
// events for live updates, and the browser UI from ../web.
//
//   LIFESTREAM_DIR   the lifestream directory (default ./lifestreams/me)
//   PORT             default 4747
//   ANTHROPIC_API_KEY  enables ask / summarize / agents / semantic substreams

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, header, httpError } from './store.mjs';
import { Harness } from './harness.mjs';
import { looksLikeQuestion } from './query.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(here, '..', 'web');
// Third-party browser modules, served from node_modules so the app works offline.
const VENDOR = {
  three: path.join(here, '..', 'node_modules', 'three', 'build'),
  pdfjs: path.join(here, '..', 'node_modules', 'pdfjs-dist', 'build'),
  pdfjsdata: path.join(here, '..', 'node_modules', 'pdfjs-dist'),   // standard_fonts/, cmaps/, wasm/
};
const ROOT = process.env.LIFESTREAM_DIR || path.join(here, '..', 'lifestreams', 'me');
const PORT = Number(process.env.PORT || 4747);

const store = new Store(ROOT).load();
const harness = new Harness(store);

// ---- live events ----
const clients = new Set();
function broadcast(ev) {
  const msg = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(msg);
}
store.on('append', d => {
  broadcast({ type: 'append', doc: header(store, d) });
  if (d.created > store.now()) harness.tick(); else harness.dispatch(d);
});
store.on('update', d => broadcast({ type: 'update', doc: header(store, d) }));
store.on('remove', d => broadcast({ type: 'remove', id: d.id }));
store.on('substreams', () => broadcast({ type: 'substreams' }));
harness.on('arrive', d => broadcast({ type: 'arrive', doc: header(store, d) }));
harness.on('agent', a => broadcast({ type: 'agent', agent: a }));

// ---- API ----
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/api/status', () => ({
  llm: harness.status(), root: store.root, docs: store.docs.size, now: store.now(),
  clockOffset: store.clockOffset,
}));

route('GET', '/api/stream', ({ q }) => {
  const sub = q.get('sub') || 'all';
  if (sub !== 'all' && !store.subs.has(sub)) throw httpError(404, 'no such substream');
  return { sub, chain: store.chain(sub), now: store.now(), docs: store.members(sub).map(d => header(store, d)) };
});

route('GET', '/api/docs/:id', ({ p }) => {
  const d = store.get(p.id);
  if (!d) throw httpError(404, 'no such document');
  const inSubs = [...store.subs.values()].filter(s => store.members(s.id).includes(d)).map(s => ({ id: s.id, label: s.label }));
  const children = store.all().filter(x => x.derived_from.includes(d.id)).map(x => header(store, x));
  const parents = d.derived_from.map(id => store.get(id)).filter(Boolean).map(x => header(store, x));
  return { ...header(store, d, true), substreams: inSubs, derived: parents, children };
});

route('POST', '/api/docs', ({ body }) => header(store, store.append({
  type: body.type || 'note', title: body.title || '', body: body.body || '', created: body.at || undefined, author: 'me',
}), true));
route('PUT', '/api/docs/:id', ({ p, body }) => header(store, store.update(p.id, body), true));
route('GET', '/api/files/:id', ({ p, res }) => {
  const d = store.get(p.id);
  if (!d?.attachment || !fs.existsSync(d.attachment.path)) throw httpError(404, 'no file');
  res.writeHead(200, { 'content-type': d.attachment.mime, 'content-length': fs.statSync(d.attachment.path).size,
    'content-disposition': `inline; filename="${encodeURIComponent(d.file || path.basename(d.attachment.path))}"`, 'cache-control': 'max-age=3600' });
  fs.createReadStream(d.attachment.path).pipe(res);
  return RAW;
});
route('POST', '/api/upload', async ({ q, req }) => {
  const name = q.get('name');
  if (!name) throw httpError(400, 'upload needs ?name=');
  const chunks = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > 200e6) throw httpError(413, 'file too large'); chunks.push(c); }
  return header(store, store.importFile(Buffer.concat(chunks), path.basename(name)), true);
});
route('POST', '/api/docs/:id/read', ({ p }) => { store.markRead(p.id); return { ok: true }; });
route('POST', '/api/docs/:id/freeze', ({ p }) => header(store, store.freeze(p.id), true));
route('POST', '/api/docs/:id/clone', ({ p }) => header(store, harness.clone(p.id), true));
route('POST', '/api/docs/:id/transfer', ({ p, body }) => {
  if (!body.to) throw httpError(400, 'transfer needs a recipient');
  return { message: harness.transfer(p.id, body.to) };
});

route('GET', '/api/substreams', () => {
  const now = store.now();
  return [...store.subs.values()].map(s => {
    const m = store.members(s.id);
    return { ...s, count: m.length, unread: m.filter(d => store.isUnread(d)).length, future: m.filter(d => d.created > now).length };
  }).concat([{ id: 'all', label: 'Your Lifestream', query: '', parent: null, count: store.docs.size, unread: store.all().filter(d => store.isUnread(d)).length }]);
});
route('POST', '/api/substreams', ({ body }) => {
  const sub = store.addSub({ query: body.query, label: body.label, parent: body.parent || 'all', persistent: !!body.persistent });
  harness.expandSemantic(body.query);   // async; the substream refreshes when terms arrive
  return sub;
});
route('PATCH', '/api/substreams/:id', ({ p, body }) => store.setPersistent(p.id, !!body.persistent));
route('DELETE', '/api/substreams/:id', ({ p }) => { store.removeSub(p.id); return { ok: true }; });

route('GET', '/api/summarizers', ({ q }) => harness.applicable(q.get('sub') || 'all'));
route('POST', '/api/summarize', async ({ body }) => header(store, await harness.summarize(body.sub || 'all', body.name), true));

route('POST', '/api/ask', async ({ body }) => header(store, await harness.ask(String(body.text || ''), body.sub || 'all'), true));
route('POST', '/api/classify', ({ body }) => ({ question: looksLikeQuestion(String(body.text || '')) }));

route('GET', '/api/agents', () => harness.agents());

// ---- server ----
const RAW = Symbol('raw response');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.mjs': 'text/javascript', '.map': 'application/json', '.wasm': 'application/wasm' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': hello\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const r = routes.find(r => r.method === req.method && r.re.test(url.pathname));
      if (!r) throw httpError(404, 'not found');
      const raw = url.pathname === '/api/upload';
      const body = !raw && ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const out = await r.fn({ p: url.pathname.match(r.re).groups || {}, q: url.searchParams, body, req, res });
      if (out === RAW) return;
      return send(res, 200, out);
    }
    const vm = url.pathname.match(/^\/vendor\/(\w+)\/(.+)$/);
    const base = vm ? VENDOR[vm[1]] : WEB;
    const file = vm ? (base && path.join(base, path.normalize(vm[2]))) : path.join(WEB, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!base || !file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) throw httpError(404, 'not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.message });
  }
});

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(httpError(400, 'bad JSON')); } });
  });
}

const frozen = store.autoFreeze();
setInterval(() => store.autoFreeze(), 3600e3);
harness.startClock();
server.listen(PORT, '127.0.0.1', () => {
  const st = harness.status();
  console.log(`Lifestreams on http://localhost:${PORT}`);
  console.log(`  stream: ${store.root} (${store.docs.size} docs${frozen ? `, froze ${frozen}` : ''})`);
  console.log(`  model:  ${st.available ? st.model : 'offline — ' + st.reason}`);
});
