// The stream as an LLM harness: the five Lifestreams operations (plus read) are the
// model's tools, every model output is appended as a document, agents wake on stream
// events, and future-dated documents are how anything (person or agent) schedules itself.

import { EventEmitter } from 'node:events';
import path from 'node:path';
import * as llm from './llm.mjs';
import { header, firstLine, httpError } from './store.mjs';
import { words, semanticPhrases } from './query.mjs';

const TOOL_DEFS = {
  find: {
    description: 'Search the lifestream. Returns matching documents newest-first (id, time, type, author, title, snippet). Query syntax: words are ANDed; OR / NOT; "phrases"; type:email from:alice after:2026-01-01 before:… future:true frozen:false; ~"concept" for fuzzy topical match; like:<doc id> for similar docs.',
    input_schema: { type: 'object', additionalProperties: false, required: ['query'], properties: {
      query: { type: 'string' }, limit: { type: 'integer', description: 'max results, default 15' } } },
  },
  read: {
    description: 'Read the full text and attributes of one document by id.',
    input_schema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
  },
  new_document: {
    description: 'Append a new document to the head of the stream. Set `at` to a future ISO time to create a reminder or scheduled item that will arrive on the stream at that time. Use type "reminder" for reminders, "todo" for tasks, "note" for notes, "wakeup" to schedule yourself to run again later.',
    input_schema: { type: 'object', additionalProperties: false, required: ['type', 'title', 'body'], properties: {
      type: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' },
      at: { type: 'string', description: 'ISO 8601 time; omit for now' },
      derived_from: { type: 'array', items: { type: 'string' }, description: 'ids of documents this was based on' } } },
  },
  clone: {
    description: 'Make an editable copy of a document at the head of the stream, optionally with a new body.',
    input_schema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' }, body: { type: 'string' } } },
  },
  transfer: {
    description: "Copy a document (frozen) onto another person's or agent's lifestream.",
    input_schema: { type: 'object', additionalProperties: false, required: ['id', 'to'], properties: { id: { type: 'string' }, to: { type: 'string' } } },
  },
  summarize: {
    description: 'Compress the documents matching a query into one overview document appended to the stream.',
    input_schema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string' } } },
  },
};

export class Harness extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.queue = Promise.resolve();
    this.agentState = {};   // name -> { status, lastRun, runs: [timestamps], error }
    this.timer = null;
  }

  status() { return llm.status(); }

  // ---------- tools ----------

  tools(names) { return names.filter(n => TOOL_DEFS[n]).map(n => ({ name: n, ...TOOL_DEFS[n] })); }

  executor({ author, trigger, used }) {
    const s = this.store;
    return async (name, input) => {
      switch (name) {
        case 'find': {
          const hits = s.find(input.query).slice(0, Math.min(input.limit || 15, 40));
          hits.forEach(d => used.add(d.id));
          return hits.length ? hits.map(d => line(d)).join('\n') : 'No documents matched.';
        }
        case 'read': {
          const d = s.get(input.id);
          if (!d) throw new Error('no document with id ' + input.id);
          used.add(d.id);
          return `id: ${d.id}\ncreated: ${iso(d.created)}\ntype: ${d.type}\nauthor: ${d.author}\ntitle: ${d.title}\nfrozen: ${d.frozen}\nderived_from: ${d.derived_from.join(', ') || '-'}\n\n${d.body}`;
        }
        case 'new_document': {
          const derived = [...new Set([...(input.derived_from || []), ...(trigger ? [trigger] : [])])].filter(id => s.get(id));
          const d = s.append({ type: input.type, title: input.title, body: input.body, author, created: input.at || undefined, derived_from: derived });
          return `created ${d.id}${d.created > s.now() ? ` (arrives ${iso(d.created)})` : ''}`;
        }
        case 'clone': return 'created ' + this.clone(input.id, author, input.body).id;
        case 'transfer': return this.transfer(input.id, input.to);
        case 'summarize': {
          const sub = s.addSub({ query: input.query, label: input.query });
          const doc = await this.summarize(sub.id);
          s.removeSub(sub.id);
          return 'created summary ' + doc.id;
        }
        default: throw new Error('unknown tool ' + name);
      }
    };
  }

  // ---------- the five operations ----------

  clone(id, author = 'me', body) {
    const src = this.store.get(id);
    if (!src) throw httpError(404, 'no such document');
    return this.store.append({ type: src.type, title: src.title, body: body ?? src.body, author, derived_from: [src.id] });
  }

  transfer(id, to) {
    const src = this.store.get(id);
    if (!src) throw httpError(404, 'no such document');
    this.store.freeze(id);
    const other = this.store.sibling(to);
    const me = path.basename(this.store.root);
    other.append({ type: src.type, title: src.title, body: src.body, author: src.author === 'me' ? me : src.author, from: me, to, frozen: true, derived_from: [src.id] });
    return `transferred a frozen copy of ${id} to ${to}'s lifestream`;
  }

  summarizers() {
    const defs = this.store.readDefs('summarizers');
    if (!defs.some(d => d.name === 'overview')) defs.push({ name: 'overview', label: 'Overview', test: '*', min_fraction: 0, instructions: 'Write a concise overview of these documents: the main threads, what changed recently, open questions, and anything that needs action. Cite document ids in [brackets].' });
    return defs;
  }

  // Which summarizers apply to a substream — the 1997 test() half of the plugin API.
  applicable(subId) {
    const docs = this.store.members(subId).slice(0, 200);
    const out = [];
    for (const s of this.summarizers()) {
      if (!docs.length) break;
      const frac = docs.filter(d => this.store.matches(d, String(s.test ?? '*'))).length / docs.length;
      if (frac >= (s.min_fraction ?? 0.5)) out.push({ name: s.name, label: s.label || s.name, fraction: frac });
    }
    return out.sort((a, b) => (a.name === 'overview') - (b.name === 'overview') || b.fraction - a.fraction);
  }

  // The summarize() half: compress a substream into one overview document.
  async summarize(subId, name) {
    const s = this.store;
    const def = this.summarizers().find(x => x.name === (name || this.applicable(subId)[0]?.name)) || this.summarizers().at(-1);
    const sub = s.subs.get(subId);
    const subLabel = sub ? sub.label : 'Your Lifestream';
    const now = s.now();
    const past = s.members(subId).filter(d => d.created <= now && d.type !== 'summary');
    const future = s.members(subId).filter(d => d.created > now).reverse();
    const docs = [...future.slice(0, 20), ...past.slice(0, 80)];
    let body;
    try {
      body = await llm.text({
        system: `You write overview documents for a personal lifestream (a time-ordered stream of documents). Now is ${iso(now)}. Output markdown only, no preamble. Cite source documents by id in [brackets].`,
        prompt: `${def.instructions}\n\nSubstream: ${subLabel}\n${docs.length} documents (future items first, then newest past):\n\n` +
          docs.map(d => `[${d.id}] ${iso(d.created)} ${d.type} from ${d.author}${d.created > now ? ' (FUTURE)' : ''}\n${d.title}\n${d.body.slice(0, 700)}`).join('\n\n---\n\n'),
        effort: 'medium',
      });
    } catch (e) {
      if (!e.offline) throw e;
      body = offlineSummary(docs, past, future, now) + `\n\n_Written without a model: ${e.message}._`;
    }
    return s.append({ type: 'summary', author: 'agent:summarize', title: `${def.label || def.name}: ${subLabel}`, body, derived_from: docs.map(d => d.id) });
  }

  // ---------- ask: the find box as a conversation ----------

  async ask(question, subId = 'all') {
    const s = this.store;
    const q = s.append({ type: 'turn', author: 'me', title: question.slice(0, 120), body: question });
    const used = new Set();
    let answer;
    try {
      answer = await llm.runTools({
        system: this.systemPrompt(subId),
        prompt: question,
        tools: this.tools(['find', 'read', 'new_document', 'clone', 'summarize']),
        execute: this.executor({ author: 'claude', trigger: q.id, used }),
        effort: 'medium',
      });
    } catch (e) {
      if (!e.offline) { answer = `Sorry — that failed: ${e.message}`; }
      else {
        const hits = keywordHits(s, question).slice(0, 5);
        hits.forEach(d => used.add(d.id));
        answer = (hits.length
          ? `Closest matches in your stream:\n\n` + hits.map(d => `- [${d.id}] ${d.body.replace(/\s+/g, ' ').slice(0, 140)}`).join('\n')
          : `Nothing in the stream matched those words.`) +
          `\n\n_Keyword search only — no model is configured (${e.message})._`;
      }
    }
    const cited = [...answer.matchAll(/\[([0-9]{8}T[0-9]{6}Z-[a-z0-9]+)\]/g)].map(m => m[1]);
    const derived = [q.id, ...new Set([...cited, ...used])].filter(id => s.get(id)).slice(0, 30);
    return s.append({ type: 'turn', author: 'claude', title: firstLine(answer).slice(0, 120), body: answer, derived_from: derived });
  }

  systemPrompt(subId) {
    const s = this.store, now = s.now();
    const sub = s.subs.get(subId);
    const head = s.members(subId).filter(d => d.created <= now).slice(0, 25);
    const future = s.all().filter(d => d.created > now).reverse().slice(0, 10);
    const turns = s.all().filter(d => d.type === 'turn' && d.created <= now).slice(1, 9).reverse();
    return `You are the assistant inside the user's Lifestreams system: a single time-ordered stream of documents (email, notes, files, bookmarks, reminders, conversation turns, summaries) that serves as their storage, their memory and yours. There are no folders; organization is by query ("substreams"). The past is history; documents dated in the future are reminders/scheduled items that arrive when their time comes.

Now: ${iso(now)} (user's local time ${new Date(now).toString()}).
${sub ? `The user is focused on the substream "${sub.label}" (query: ${s.chain(subId).map(x => x.query).join(' AND ')}).` : 'The user is looking at their whole lifestream.'}

How to work:
- Answer from the stream. Use find and read rather than guessing; cite documents you rely on as [id].
- Your memory is the stream. To remember something, or when the user asks for a reminder or follow-up, use new_document (with \`at\` in the future for reminders). Never claim to have saved something you didn't.
- Be concise; this answer becomes a document on the stream.

Recent documents in focus (newest first):
${head.map(line).join('\n') || '(none)'}

Upcoming (future) documents:
${future.map(line).join('\n') || '(none)'}

Recent conversation turns (oldest first):
${turns.map(d => `${d.author === 'me' ? 'User' : 'You'}: ${d.body.slice(0, 400)}`).join('\n') || '(none)'}`;
  }

  // ---------- agents ----------

  agents() {
    return this.store.readDefs('agents').map(a => ({
      name: a.name, watch: a.watch, tools: a.tools || ['find', 'read', 'new_document'], enabled: a.enabled !== false,
      description: a.description || firstLine(a.instructions), ...(this.agentState[a.name] || { status: 'idle' }),
    }));
  }

  // Called for every document that appears on the stream "now": appended in the
  // present, or a future document whose time has arrived.
  dispatch(doc) {
    const s = this.store;
    if (doc.created > s.now()) return;
    for (const a of this.store.readDefs('agents')) {
      if (a.enabled === false) continue;
      const self = doc.author === `agent:${a.name}`;
      const selfWakeup = self && doc.type === 'wakeup';
      if (self && !selfWakeup) continue;                          // agents don't react to their own output
      if (!selfWakeup && (!a.watch || !s.matches(doc, String(a.watch)))) continue;
      if (!selfWakeup && agentDepth(s, doc) >= 2) continue;     // no agent → agent → agent chains
      const st = this.agentState[a.name] ??= { status: 'idle', runs: [] };
      st.runs = (st.runs || []).filter(t => t > Date.now() - 3600e3);
      if (st.runs.length >= (a.max_runs_per_hour ?? 30)) continue;
      st.runs.push(Date.now());
      this.queue = this.queue.then(() => this.runAgent(a, doc)).catch(() => {});
    }
  }

  async runAgent(a, doc) {
    const st = this.agentState[a.name];
    const set = (status, extra = {}) => { Object.assign(st, { status, ...extra }); this.emit('agent', { name: a.name, ...st }); };
    if (!llm.status().available) return set('offline', { error: llm.status().reason });
    set('running', { trigger: doc.id });
    try {
      await llm.runTools({
        system: `You are "${a.name}", an agent attached to the user's lifestream (a time-ordered stream of documents that is their storage and memory). Now: ${iso(this.store.now())}. Everything you produce must be appended to the stream with your tools; you cannot edit or delete existing documents. Do only what your instructions say; doing nothing is fine when nothing is needed.\n\nYour instructions:\n${a.instructions}`,
        prompt: `${doc.type === 'wakeup' && doc.author === `agent:${a.name}` ? 'A wake-up you scheduled has arrived' : 'A document just arrived on your watched substream'}:\n\nid: ${doc.id}\ncreated: ${iso(doc.created)}\ntype: ${doc.type}\nauthor: ${doc.author}\ntitle: ${doc.title}\n\n${doc.body.slice(0, 6000)}`,
        tools: this.tools(a.tools || ['find', 'read', 'new_document']),
        execute: this.executor({ author: `agent:${a.name}`, trigger: doc.id, used: new Set() }),
        effort: a.effort || 'low',
        maxSteps: a.max_actions ?? 6,
      });
      set('idle', { lastRun: Date.now(), error: null });
    } catch (e) {
      set(e.offline ? 'offline' : 'error', { error: e.message, lastRun: Date.now() });
    }
  }

  // ---------- semantic predicates ----------

  async expandSemantic(query) {
    for (const phrase of semanticPhrases(query)) {
      if (this.store.semantic.has(phrase)) continue;
      try {
        const out = await llm.text({
          system: 'You expand a topic into search terms for keyword matching over personal documents (email, notes, files).',
          prompt: `Topic: "${phrase}"\n\nList 15-25 lowercase words or short phrases that documents about this topic are likely to contain (synonyms, specific entities, jargon). One per line, nothing else.`,
          effort: 'low', max_tokens: 2000,
        });
        const terms = [...new Set([...words(phrase), ...out.split('\n').map(t => t.replace(/^[-*\d.\s]+/, '').trim().toLowerCase()).filter(t => t.length > 2 && t.length < 40)])];
        this.store.setSemantic(phrase, terms);
      } catch (e) { if (!e.offline) console.warn('semantic expansion failed:', e.message); }
    }
  }

  // ---------- the clock: future documents arrive ----------

  startClock() {
    const s = this.store;
    if (!s.state.lastClock) { s.state.lastClock = s.now(); s.saveState(); }
    this.tick();
  }

  tick() {
    const s = this.store, now = s.now(), last = s.state.lastClock;
    const arrived = s.all().filter(d => d.created > last && d.created <= now).reverse();
    for (const d of arrived) { this.emit('arrive', d); this.dispatch(d); }
    if (now > last) { s.state.lastClock = now; s.saveState(); }
    clearTimeout(this.timer);
    const next = s.all().filter(d => d.created > now).at(-1);
    const wait = next ? Math.min(next.created - now + 50, 2 ** 31 - 1) : 3600e3;
    this.timer = setTimeout(() => this.tick(), Math.max(wait, 50));
  }
}

// ---------- helpers ----------

function iso(t) { return new Date(t).toISOString(); }
function line(d) { return `[${d.id}] ${iso(d.created).slice(0, 16)} ${d.type} · ${d.author} · ${d.title || firstLine(d.body)} — ${d.body.replace(/\s+/g, ' ').slice(0, 120)}`; }

function agentDepth(s, doc, seen = 0) {
  if (!doc || !doc.author.startsWith('agent:') || seen > 4) return 0;
  return 1 + Math.max(0, ...doc.derived_from.map(id => agentDepth(s, s.get(id), seen + 1)));
}

function keywordHits(s, text) {
  const ws = words(text);
  const now = s.now();
  return s.all()
    .filter(d => d.type !== 'turn' && d.created <= now)
    .map(d => { const h = `${d.title} ${d.body}`.toLowerCase(); return [d, ws.filter(w => h.includes(w.slice(0, 6))).length]; })
    .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([d]) => d);
}

function offlineSummary(docs, past, future, now) {
  const by = (k) => Object.entries(past.reduce((m, d) => (m[d[k]] = (m[d[k]] || 0) + 1, m), {})).sort((a, b) => b[1] - a[1]);
  const fmt = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return [
    past.length ? `**${past.length} documents** from ${fmt(past.at(-1).created)} to ${fmt(past[0].created)}.` : '',
    past.length ? `**By type:** ${by('type').map(([k, n]) => `${k} ${n}`).join(' · ')}` : '',
    past.length ? `**Most active:** ${by('author').slice(0, 5).map(([k, n]) => `${k} (${n})`).join(', ')}` : '',
    future.length ? `\n**Coming up**\n${future.slice(0, 12).map(d => `- ${fmt(d.created)} — [${d.id}]`).join('\n')}` : '',
    past.length ? `\n**Most recent**\n${past.slice(0, 10).map(d => `- [${d.id}]`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

export { header };
