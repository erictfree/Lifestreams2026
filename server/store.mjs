// The lifestream on disk. Files are the source of truth; everything in memory and under
// .index/ is derived and can be rebuilt by restarting.
//
//   <root>/stream/YYYY/MM/DD/<id>.md     documents (future-dated ones included)
//   <root>/substreams/<id>.yaml          persistent substreams
//   <root>/agents/<name>.md              agents: frontmatter config + instructions
//   <root>/summarizers/<name>.md         summarizers: test query + prompt
//   <root>/.index/                       derived state (read marks, semantic expansions)

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { parse, serialize } from './docfile.mjs';
import { compile } from './query.mjs';

const DOC_ATTRS = ['id', 'created', 'type', 'author', 'title', 'frozen', 'derived_from', 'from', 'to', 'mime'];

export class Store extends EventEmitter {
  constructor(root) {
    super();
    this.root = path.resolve(root);
    this.docs = new Map();          // id -> doc
    this.sorted = null;             // cached newest-first array
    this.subs = new Map();          // id -> { id, query, label, parent, persistent, created }
    this.semantic = new Map();      // phrase -> expanded terms
    this.state = { read: {}, lastClock: 0 };
    this.ownWrites = new Set();
    this.compiled = new Map();
    this.clockOffset = 0;
  }

  dir(...p) { return path.join(this.root, ...p); }
  now() { return Date.now() + this.clockOffset; }

  load() {
    for (const d of ['stream', 'substreams', 'agents', 'summarizers', '.index']) fs.mkdirSync(this.dir(d), { recursive: true });
    for (const file of walk(this.dir('stream'))) if (file.endsWith('.md')) this.loadDoc(file);
    for (const f of fs.readdirSync(this.dir('substreams'))) {
      if (!f.endsWith('.yaml')) continue;
      const { attrs } = parse('---\n' + fs.readFileSync(this.dir('substreams', f), 'utf8') + '\n---\n');
      const id = attrs.id || f.replace(/\.yaml$/, '');
      this.subs.set(id, { id, query: String(attrs.query ?? ''), label: attrs.label || attrs.query, parent: attrs.parent || 'all', persistent: true, created: attrs.created });
    }
    this.state = { ...this.state, ...readJSON(this.dir('.index', 'state.json')) };
    for (const [k, v] of Object.entries(readJSON(this.dir('.index', 'semantic.json')))) this.semantic.set(k, v);
    try { this.clockOffset = Date.parse(fs.readFileSync(this.dir('clock'), 'utf8').trim()) - Date.now() || 0; } catch {}
    this.watch();
    return this;
  }

  loadDoc(file) {
    const { attrs, body } = parse(fs.readFileSync(file, 'utf8'));
    const id = attrs.id || path.basename(file, '.md');
    const created = typeof attrs.created === 'number' ? attrs.created : Date.parse(attrs.created);
    if (!Number.isFinite(created)) return null;
    const doc = {
      id, created, type: attrs.type || 'note', author: attrs.author || 'me', title: attrs.title || '',
      frozen: !!attrs.frozen, derived_from: attrs.derived_from || [], from: attrs.from || null, to: attrs.to || null,
      mime: attrs.mime, body, path: file, mtime: fs.statSync(file).mtimeMs,
    };
    const existed = this.docs.has(id);
    this.docs.set(id, doc);
    this.sorted = null;
    return { doc, existed };
  }

  // Pick up documents written by other tools (an editor, a mail fetcher, `cp`).
  watch() {
    let timer, pending = new Set();
    try {
      fs.watch(this.dir('stream'), { recursive: true }, (_ev, rel) => {
        if (!rel || !rel.endsWith('.md')) return;
        pending.add(path.join(this.dir('stream'), rel));
        clearTimeout(timer);
        timer = setTimeout(() => {
          for (const file of pending) {
            if (!fs.existsSync(file)) {          // deleted outside the app: drop it from the stream
              this.ownWrites.delete(file);
              const gone = [...this.docs.values()].find(d => d.path === file);
              if (gone) { this.docs.delete(gone.id); this.sorted = null; this.emit('remove', gone); }
              continue;
            }
            if (this.ownWrites.delete(file)) continue;
            const r = this.loadDoc(file);
            if (r) this.emit(r.existed ? 'update' : 'append', r.doc);
          }
          pending = new Set();
        }, 150);
      });
    } catch (e) { console.warn('file watching unavailable:', e.message); }
  }

  // ---- documents ----

  all() {
    return this.sorted ??= [...this.docs.values()].sort((a, b) => b.created - a.created);
  }
  get(id) { return this.docs.get(id); }

  newId(t) {
    return new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-' + Math.random().toString(36).slice(2, 6);
  }

  append({ type = 'note', author = 'me', title = '', body = '', created, derived_from = [], from, to, frozen = false }) {
    const t = created ? (typeof created === 'number' ? created : Date.parse(created)) : this.now();
    if (!Number.isFinite(t)) throw new Error('bad created time');
    const id = this.newId(t);
    const d = new Date(t);
    const file = this.dir('stream', String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()), id + '.md');
    const doc = { id, created: t, type, author, title, frozen, derived_from, from: from || null, to: to || null, body, path: file, mtime: Date.now() };
    this.writeDoc(doc);
    this.docs.set(id, doc);
    this.sorted = null;
    if (author === 'me') this.markRead(id);
    this.emit('append', doc);
    return doc;
  }

  update(id, patch) {
    const doc = this.get(id);
    if (!doc) throw httpError(404, 'no such document');
    if (doc.frozen) throw httpError(409, 'document is frozen — clone it to make an editable copy');
    for (const k of ['title', 'body', 'type']) if (patch[k] !== undefined) doc[k] = patch[k];
    delete doc._hay; delete doc._words;
    doc.mtime = Date.now();
    this.writeDoc(doc);
    this.emit('update', doc);
    return doc;
  }

  freeze(id) {
    const doc = this.get(id);
    if (!doc || doc.frozen) return doc;
    doc.frozen = true;
    this.writeDoc(doc);
    this.emit('update', doc);
    return doc;
  }

  writeDoc(doc) {
    fs.mkdirSync(path.dirname(doc.path), { recursive: true });
    const attrs = {};
    for (const k of DOC_ATTRS) {
      let v = k === 'created' ? new Date(doc.created).toISOString() : doc[k];
      if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
      attrs[k] = v;
    }
    attrs.frozen = !!doc.frozen;
    this.ownWrites.add(doc.path);
    fs.writeFileSync(doc.path, serialize(attrs, doc.body));
  }

  isUnread(doc) { return doc.author !== 'me' && !this.state.read[doc.id] && doc.created <= this.now(); }
  markRead(id) { this.state.read[id] = 1; this.saveState(); }
  saveState() { writeJSON(this.dir('.index', 'state.json'), this.state); }

  // Freeze documents nobody has touched for a while — the 1997 nightly freeze.
  autoFreeze(days = 14) {
    const cutoff = this.now() - days * 864e5;
    let n = 0;
    for (const d of this.docs.values()) {
      if (!d.frozen && d.created < cutoff && d.mtime < Date.now() - days * 864e5) { this.freeze(d.id); n++; }
    }
    return n;
  }

  // ---- substreams ----

  ctx() { return { now: this.now(), semantic: this.semantic, docById: id => this.get(id) }; }

  pred(query) {
    if (!this.compiled.has(query)) this.compiled.set(query, compile(query));
    return this.compiled.get(query);
  }

  chain(subId) {
    const out = [];
    for (let s = this.subs.get(subId); s; s = this.subs.get(s.parent)) out.unshift(s);
    return out;
  }

  matches(doc, query) { return this.pred(query)(doc, this.ctx()); }

  // A child substream is the AND of its ancestors' queries.
  members(subId = 'all') {
    const preds = this.chain(subId).map(s => this.pred(s.query));
    const c = this.ctx();
    return this.all().filter(d => preds.every(p => p(d, c)));
  }

  find(query, within = 'all') {
    const p = this.pred(query), c = this.ctx();
    return this.members(within).filter(d => p(d, c));
  }

  addSub({ query, label, parent = 'all', persistent = false }) {
    if (parent !== 'all' && !this.subs.has(parent)) parent = 'all';
    const id = slug(label || query) + '-' + Math.random().toString(36).slice(2, 5);
    const sub = { id, query, label: label || query, parent, persistent, created: new Date(this.now()).toISOString() };
    this.subs.set(id, sub);
    if (persistent) this.saveSub(sub);
    this.emit('substreams');
    return sub;
  }

  setPersistent(id, persistent) {
    const sub = this.subs.get(id);
    if (!sub) throw httpError(404, 'no such substream');
    sub.persistent = persistent;
    if (persistent) { for (const s of this.chain(id)) { s.persistent = true; this.saveSub(s); } }
    else for (const s of this.descendants(id)) { s.persistent = false; fs.rmSync(this.dir('substreams', s.id + '.yaml'), { force: true }); }
    this.emit('substreams');
    return sub;
  }

  descendants(id) {
    const out = [this.subs.get(id)].filter(Boolean);
    for (const s of this.subs.values()) if (s.parent === id) out.push(...this.descendants(s.id));
    return out;
  }

  removeSub(id) {
    for (const s of this.descendants(id)) {
      this.subs.delete(s.id);
      fs.rmSync(this.dir('substreams', s.id + '.yaml'), { force: true });
    }
    this.emit('substreams');
  }

  saveSub(s) {
    const text = serialize({ id: s.id, label: s.label, query: s.query, parent: s.parent, created: s.created }).replace(/^---\n|---\n$/g, '');
    fs.writeFileSync(this.dir('substreams', s.id + '.yaml'), text);
  }

  setSemantic(phrase, terms) {
    this.semantic.set(phrase, terms);
    for (const d of this.docs.values()) delete d._hay;
    writeJSON(this.dir('.index', 'semantic.json'), Object.fromEntries(this.semantic));
    this.emit('substreams');
  }

  // ---- agents & summarizers (definition files) ----

  readDefs(kind) {
    const out = [];
    for (const f of fs.readdirSync(this.dir(kind))) {
      if (!f.endsWith('.md')) continue;
      const { attrs, body } = parse(fs.readFileSync(this.dir(kind, f), 'utf8'));
      out.push({ name: attrs.name || f.replace(/\.md$/, ''), ...attrs, instructions: body.trim(), file: this.dir(kind, f) });
    }
    return out;
  }

  // Another person's (or agent's) lifestream: a sibling directory.
  sibling(name) {
    const clean = name.replace(/[^\w.@+-]/g, '_');
    const s = new Store(path.join(path.dirname(this.root), clean));
    for (const d of ['stream', '.index']) fs.mkdirSync(s.dir(d), { recursive: true });
    return s;
  }
}

export function header(store, d, withBody = false) {
  return {
    id: d.id, created: d.created, type: d.type, author: d.author, title: d.title || firstLine(d.body),
    frozen: d.frozen, unread: store.isUnread(d), derived_from: d.derived_from, from: d.from, to: d.to,
    snippet: d.body.replace(/[*_`#>]+|\[([0-9]{8}T[0-9]{6}Z-[a-z0-9]+)\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 220),
    ...(withBody ? { body: d.body, path: path.relative(store.root, d.path) } : {}),
  };
}

export function firstLine(s) { return (s || '').split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').slice(0, 90) || '(untitled)'; }
export function httpError(status, message) { return Object.assign(new Error(message), { status }); }
function pad(n) { return String(n).padStart(2, '0'); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'sub'; }
function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } }
function writeJSON(f, v) { fs.writeFileSync(f, JSON.stringify(v, null, 1)); }
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}
