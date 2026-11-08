// Lifestreams browser client. All state lives on the server (files on disk); this page
// renders a substream as a time-ordered stream and listens for live events.

const $ = id => document.getElementById(id);
import { TYPE_ICON as ICON, mountViewer, isTextFile } from './formats.js';

const S = {
  cur: localGet('cur') || 'all', subs: [], docs: [], chain: [], titles: new Map(),
  sel: null, editing: false, pending: null, agents: [], summarizers: [], offset: 0, status: null,
  view: localGet('view') || 'feed',
  cursor: null, atHead: true, stackEls: new Map(),   // stack view: id of the front page
};
const liveNow = () => Date.now() + S.offset;
const isFut = d => d.created > liveNow();

// ---------- api ----------
async function api(method, url, body) {
  const res = await fetch('/api' + url, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

async function loadStatus() {
  S.status = await api('GET', '/status');
  S.offset = S.status.now - Date.now();
  const llm = S.status.llm, el = $('llm');
  el.textContent = llm.available ? `✦ ${llm.model}` : '✦ model offline';
  el.className = 'pill' + (llm.available ? ' on' : '');
  el.title = llm.available ? 'Ask, summarize, agents and ~"semantic" substreams use Claude.' : `${llm.reason}. Everything else works; ask and summarize fall back to non-LLM versions.`;
  $('status').textContent = `${S.status.docs} docs · ${S.status.root.split('/').slice(-2).join('/')}`;
}

async function loadSubs() {
  S.subs = await api('GET', '/substreams');
  if (!S.subs.some(s => s.id === S.cur)) S.cur = 'all';
  const all = S.subs.find(s => s.id === 'all');
  if (all && S.status) $('status').textContent = `${all.count} docs · ${S.status.root.split('/').slice(-2).join('/')}`;
  renderSubs();
}

async function loadStream(anim) {
  const cur = S.cur;
  const r = await api('GET', `/stream?sub=${encodeURIComponent(cur)}`);
  if (cur !== S.cur) return;
  S.docs = r.docs; S.chain = r.chain; S.offset = r.now - Date.now();
  for (const d of r.docs) S.titles.set(d.id, d.title);
  renderStream(anim);
}

async function loadAgents() { S.agents = await api('GET', '/agents'); renderAgents(); }

async function loadSummarizers() {
  S.summarizers = await api('GET', `/summarizers?sub=${encodeURIComponent(S.cur)}`);
  const first = S.summarizers[0];
  $('opSum').textContent = first ? `Summarize: ${first.label}` : 'Summarize';
  $('opSum').disabled = !first;
  $('opSumMore').disabled = S.summarizers.length < 2;
}

// ---------- rail ----------
function renderSubs() {
  const box = $('subs');
  box.innerHTML = '';
  const byParent = {};
  for (const s of S.subs) (byParent[s.parent ?? 'root'] ??= []).push(s);
  const walk = (pid, depth) => (byParent[pid] || []).forEach(s => {
    const row = document.createElement('div');
    row.className = 'sub' + (s.id === S.cur ? ' active' : '');
    row.style.paddingLeft = 8 + depth * 14 + 'px';
    const pin = s.id === 'all' ? '●' : s.persistent ? '◆' : '◇';
    row.innerHTML = `<button class="pin" title="${s.id === 'all' ? '' : s.persistent ? 'Persistent: keeps collecting new matches. Click to make temporary.' : 'Temporary. Click to keep it.'}">${pin}</button>
      <span class="q" title="${esc(s.query || 'everything')}">${esc(s.label)}</span>
      ${agentWatching(s) ? '<span class="badge" title="An agent watches this">✦</span>' : ''}
      <span class="n">${s.unread ? `<b>${s.unread}</b> · ` : ''}${s.count}</span>
      ${s.id === 'all' ? '' : '<button class="x" title="Remove substream">×</button>'}`;
    row.onclick = e => {
      if (e.target.classList.contains('pin') && s.id !== 'all') return api('PATCH', `/substreams/${s.id}`, { persistent: !s.persistent }).then(loadSubs);
      if (e.target.classList.contains('x')) return api('DELETE', `/substreams/${s.id}`).then(() => { if (S.cur === s.id) focusSub(s.parent || 'all'); loadSubs(); });
      focusSub(s.id);
    };
    box.appendChild(row);
    walk(s.id, depth + 1);
  });
  walk('root', 0);
}

function agentWatching(s) { return S.agents.some(a => a.watch && s.query && a.watch.replace(/\s+/g, '') === s.query.replace(/\s+/g, '')); }

function renderAgents() {
  $('agents').innerHTML = S.agents.length ? S.agents.map(a => `
    <div class="agent-row" data-agent="${esc(a.name)}" title="${esc(a.description || '')}${a.error ? '\n\n' + esc(a.error) : ''}\n\nwatches: ${esc(a.watch || '—')}">
      <span class="dotst ${a.status}"></span><span class="name">${esc(a.name)}</span>
      <small>${a.status === 'running' ? 'running…' : a.lastRun ? ago(a.lastRun) : a.status}</small>
    </div>`).join('') : '<div class="help">No agents yet — add one in agents/.</div>';
  renderSubs();
}

$('agents').onclick = async e => {
  const row = e.target.closest('[data-agent]');
  if (!row) return;
  const query = `from:agent:${row.dataset.agent}`;
  const existing = S.subs.find(s => s.query === query);
  focusSub(existing ? existing.id : (await api('POST', '/substreams', { query, label: `✦ ${row.dataset.agent}`, parent: 'all' })).id);
  loadSubs();
};

// ---------- stream: three views of the same documents ----------
function renderStream(anim) {
  const sv = $('stream');
  if (sv.dataset.view !== S.view) {          // switching views: rebuild from scratch
    sv.dataset.view = S.view;
    sv.className = 'stream v-' + S.view;
    S.atlas?.destroy(); S.atlas = null;
    sv.innerHTML = '';
    S.stackEls.clear();
  }
  if (S.view === 'stack') renderStack(anim);
  else if (S.view === 'river') renderRiver(anim);
  else if (S.view === 'atlas') renderAtlas(anim);
  else renderFeed(anim);
  drawMini();
}

function focusLabel() {
  const past = S.docs.filter(d => !isFut(d));
  const chain = S.chain.length ? S.chain.map(s => esc(s.label)).join(' › ') : 'Your Lifestream';
  return `Focused on <b>${chain}</b><span>· ${S.docs.length} docs${past.length ? ` · since ${fmtDay(past.at(-1).created)}` : ''}</span>`;
}

function setView(v) {
  S.view = v; localSet('view', v);
  document.querySelectorAll('#views button').forEach(b => b.setAttribute('aria-selected', b.dataset.view === v));
  S.atHead = true;
  renderStream();
  scrollToNow();
}

// Feed: vertical, future above the Now line, past below — the default.
function renderFeed(anim) {
  const now = liveNow();
  const future = S.docs.filter(isFut).reverse();          // soonest nearest the Now line
  const past = S.docs.filter(d => !isFut(d));
  let h = `<div class="focus-label">${focusLabel()}</div>`;
  if (future.length) {
    h += '<div class="zone">future · arriving</div>';
    let last = '';
    for (const d of future) { const k = fmtDay(d.created); if (k !== last) { h += `<div class="day">${k}</div>`; last = k; } h += card(d); }
  }
  h += `<div class="now" id="nowline"><span>NOW · ${fmtTime(now)}</span></div>`;
  if (S.pending) h += `<div class="card agent pending"><div class="ic">💬</div><div><div class="t">${esc(S.pending)}</div><div class="s">thinking…</div></div><div class="m"></div></div>`;
  let last = '';
  past.forEach((d, i) => {
    const k = fmtDay(d.created);
    if (k !== last) { h += `<div class="day">${k}</div>`; last = k; }
    h += card(d, i > 80 ? 'oldest' : i > 25 ? 'older' : '');
  });
  if (!S.docs.length) h += '<div class="empty">Nothing matches this substream yet. Persistent substreams keep collecting as documents arrive.</div>';
  const sv = $('stream'), keep = sv.scrollTop;
  sv.innerHTML = h;
  if (anim) {
    const el = sv.querySelector(`[data-id="${anim.id}"]`);
    if (el) { el.classList.add(anim.kind); }
  }
  sv.scrollTop = keep;
}

function card(d, age = '') {
  const agent = d.author.startsWith('agent:') || d.author === 'claude';
  const cls = ['card', isFut(d) && 'future', agent && 'agent', !d.frozen && !isFut(d) && 'writable', d.id === S.sel && 'sel', age].filter(Boolean).join(' ');
  const who = agent ? `<span class="badge">✦ ${esc(d.author.replace('agent:', ''))}</span> · ` : d.author === 'me' ? '' : esc(d.author) + ' · ';
  return `<div class="${cls}" data-id="${d.id}">
    <div class="ic">${ICON[d.type] || '•'}</div>
    <div style="min-width:0"><div class="t">${d.file ? `<span class="ext">${esc(d.file.ext)}</span>` : ''}${esc(d.title)}${d.unread ? '<span class="dot"></span>' : ''}</div><div class="s">${who}${esc(d.snippet)}</div></div>
    <div class="m">${fmtTime(d.created)}${d.frozen ? '<br>🔒' : ''}</div></div>`;
}

// Atlas: the GPU view (web/atlas.js, loaded on first use).
let atlasLoading = false;
async function renderAtlas(anim) {
  const sv = $('stream');
  if (!$('atlas')) sv.innerHTML = '<div class="focus-label atlas-label"></div><div class="atlas" id="atlas"></div>';
  sv.querySelector('.atlas-label').innerHTML = focusLabel();
  if (S.atlas) return S.atlas.update(S.docs, { sel: S.sel, anim });
  if (atlasLoading) return;
  atlasLoading = true;
  const el = $('atlas');
  try {
    const { createAtlas } = await import('./atlas.js');
    if (S.view !== 'atlas' || $('atlas') !== el) return;
    S.atlas = createAtlas(el, {
      dark: isDark, now: liveNow,
      onHover: d => glance(d),
      onOpen: d => openDoc(d.id),
      onView: () => { if (!miniQueued) { miniQueued = true; setTimeout(() => { miniQueued = false; drawMini(); }, 120); } },
    });
    S.atlas.update(S.docs, { sel: S.sel });
    S.atlas.home();
  } catch (e) {
    el.innerHTML = `<div class="empty">The Atlas needs WebGL: ${esc(e.message)}</div>`;
  } finally { atlasLoading = false; }
}
let miniQueued = false;
function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}

function scrollToNow() {
  if (S.view === 'atlas') { S.atlas?.home(); return; }
  if (S.view === 'stack') { S.atHead = true; S.cursor = null; renderStack(); drawMini(); return; }
  if (S.view === 'river') { const n = $('nowcol'), r = $('river'); if (n && r) r.scrollLeft = Math.max(0, n.offsetLeft - r.clientWidth * 0.6); drawMini(); return; }
  const n = $('nowline');
  if (n) $('stream').scrollTop = Math.max(0, n.offsetTop - 160);
}

// Bring a document into view in whichever view is showing.
function reveal(id) {
  if (S.view === 'atlas') { S.atlas?.reveal(id); return; }
  if (S.view === 'stack') { if (S.docs.some(d => d.id === id)) { S.cursor = id; S.atHead = false; renderStack(); drawMini(); } return; }
  document.querySelector(`.card[data-id="${id}"]`)?.scrollIntoView({ block: 'center', inline: 'center' });
}

// Stack: the 1997 interface — pages receding into the past, the present at the front.
// Wheel / arrows / drag the minimap to travel; the front page is "where you are" in time.
const DEPTH = 36;
function stackOrder() { return [...S.docs].reverse(); }       // oldest → newest, future at the end
function headIndex(asc) { let i = asc.length - 1; while (i > 0 && isFut(asc[i])) i--; return i; }

function renderStack(anim) {
  const sv = $('stream');
  if (!$('stage')) {
    sv.innerHTML = `<div class="focus-label stack-label"></div>
      <div class="stage" id="stage"></div>
      <div class="hud" id="hud"></div>
      <button class="op small newer" id="newer"></button>`;
    $('newer').onclick = () => scrollToNow();
    $('stage').addEventListener('wheel', e => { e.preventDefault(); wheelStack(e.deltaY); }, { passive: false });
    // touch: swipe up/down to move through time, like scrolling
    let lastY = null;
    $('stage').addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse') lastY = e.clientY; });
    $('stage').addEventListener('pointermove', e => { if (lastY !== null) { wheelStack((lastY - e.clientY) * 1.5); lastY = e.clientY; } });
    for (const ev of ['pointerup', 'pointercancel']) $('stage').addEventListener(ev, () => { lastY = null; });
  }
  sv.querySelector('.stack-label').innerHTML = focusLabel();
  const asc = stackOrder();
  let idx = S.atHead || !S.cursor ? headIndex(asc) : asc.findIndex(d => d.id === S.cursor);
  if (idx < 0) idx = headIndex(asc);
  const front = asc[idx];
  S.cursor = front?.id || null;

  const keep = new Set();
  for (let j = Math.max(0, idx - DEPTH); j <= idx; j++) {
    const d = asc[j], depth = idx - j;
    keep.add(d.id);
    let el = S.stackEls.get(d.id);
    const fresh = !el;
    if (fresh) {
      el = document.createElement('div');
      el.dataset.id = d.id;
      S.stackEls.set(d.id, el);
      $('stage').appendChild(el);
      // enter from where it "comes from": new → drops from above, incoming → slides from the left
      el.style.transform = anim?.id === d.id ? (anim.kind === 'drop' ? 'translate3d(0,-260px,120px)' : 'translate3d(-420px,0,0)') : pageTransform(depth + 1);
      el.style.opacity = 0;
    }
    const firstOfDay = j === 0 || dayKey(asc[j - 1].created) !== dayKey(d.created);
    el.className = 'card page' + (isFut(d) ? ' future' : '') + (d.author.startsWith('agent:') || d.author === 'claude' ? ' agent' : '') +
      (d.unread ? ' unread' : '') + (!d.frozen && !isFut(d) ? ' writable' : '') + (d.id === S.sel ? ' sel' : '') + (depth === 0 ? ' front' : '');
    if (fresh || el.dataset.rev !== rev(d)) {
      el.dataset.rev = rev(d);
      el.innerHTML = `<div class="ph"><span class="ic">${ICON[d.type] || '•'}</span><span class="t">${esc(d.title)}</span>${d.frozen ? '<span class="lock">🔒</span>' : ''}</div>
        <div class="pm">${d.author.startsWith('agent:') || d.author === 'claude' ? `<span class="badge">✦ ${esc(d.author.replace('agent:', ''))}</span>` : esc(d.author)} · ${fmtTime(d.created)}</div>
        <div class="pb">${esc(d.snippet)}</div>
        ${firstOfDay ? `<div class="daytag">${fmtDay(d.created)}</div>` : ''}`;
    } else if (!firstOfDay) el.querySelector('.daytag')?.remove();
    el.style.zIndex = 1000 - depth;
    const target = pageTransform(depth), op = depth > DEPTH - 8 ? Math.max(0, (DEPTH - depth) / 8) : 1;
    if (fresh) requestAnimationFrame(() => requestAnimationFrame(() => { el.style.transform = target; el.style.opacity = op; }));
    else { el.style.transform = target; el.style.opacity = op; }
  }
  for (const [id, el] of S.stackEls) if (!keep.has(id)) { el.remove(); S.stackEls.delete(id); }

  // HUD: where you are in time, relative to now
  const newer = asc.length - 1 - idx, futureCount = asc.filter(isFut).length;
  $('hud').innerHTML = front ? `<div class="when">${fmtDay(front.created)}</div>
    <div class="rel">${relTime(front.created)}${isFut(front) ? ' · <b>future</b>' : ''}</div>
    <div class="keys"><kbd>↑</kbd><kbd>↓</kbd> or scroll to move through time</div>` : '<div class="rel">Nothing here yet.</div>';
  const atNowHead = idx === headIndex(asc);
  $('newer').hidden = atNowHead && !futureCount;
  $('newer').textContent = atNowHead ? `▲ ${futureCount} coming up` : idx > headIndex(asc) ? '▼ back to now' : `▲ ${newer - futureCount} newer · back to now`;
  $('newer').onclick = atNowHead ? () => moveStack(1) : () => scrollToNow();
}

function pageTransform(depth) {
  return `translate3d(${depth * 26}px, ${-depth * 24}px, ${-depth * 80}px)`;
}
function rev(d) { return `${d.title}|${d.snippet}|${d.frozen}|${d.unread}`; }

let wheelAcc = 0;
function wheelStack(dy) {
  wheelAcc += dy;
  const step = 70;
  while (Math.abs(wheelAcc) >= step) { moveStack(wheelAcc > 0 ? -1 : 1); wheelAcc -= Math.sign(wheelAcc) * step; }
}
// +1 = toward the future, -1 = into the past
function moveStack(delta) {
  const asc = stackOrder();
  const i = Math.max(0, Math.min(asc.length - 1, asc.findIndex(d => d.id === S.cursor) + delta));
  S.cursor = asc[i]?.id; S.atHead = false;
  renderStack(); drawMini();
  if (asc[i]) glance(asc[i]);
}

// River: days as columns flowing left (past) to right (future), the Now line between.
function renderRiver(anim) {
  const sv = $('stream');
  const prev = $('river'), keepLeft = prev?.scrollLeft, first = !prev;
  const asc = stackOrder();
  const cols = [];
  let nowPlaced = false;
  for (const d of asc) {
    if (!nowPlaced && isFut(d)) { cols.push({ now: true }); nowPlaced = true; }
    const key = dayKey(d.created) + (isFut(d) ? 'f' : 'p');
    if (cols.at(-1)?.key !== key) cols.push({ key, t: d.created, fut: isFut(d), docs: [] });
    cols.at(-1).docs.push(d);
  }
  if (!nowPlaced) cols.push({ now: true });
  const html = cols.map(c => c.now
    ? `<div class="nowcol" id="nowcol"><span>NOW · ${fmtTime(liveNow())}</span></div>`
    : `<section class="col${c.fut ? ' fut' : ''}"><h5>${fmtDay(c.t)}<small>${c.docs.length}</small></h5>
        <div class="cards">${[...c.docs].reverse().map(d => card(d, 'compact')).join('')}</div></section>`).join('');
  sv.innerHTML = `<div class="focus-label">${focusLabel()}</div><div class="river" id="river">${html}</div>`;
  const r = $('river');
  r.addEventListener('wheel', e => {
    if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;           // trackpad sideways swipe: native
    const c = e.target.closest('.cards');
    const canScroll = c && (e.deltaY > 0 ? c.scrollTop + c.clientHeight < c.scrollHeight - 1 : c.scrollTop > 0);
    if (!canScroll) { e.preventDefault(); r.scrollLeft += e.deltaY; }  // otherwise wheel travels through time
  }, { passive: false });
  r.addEventListener('scroll', () => requestAnimationFrame(drawMini));
  if (anim) sv.querySelector(`[data-id="${anim.id}"]`)?.classList.add(anim.kind);
  if (first) scrollToNow(); else r.scrollLeft = keepLeft;
}

function dayKey(t) { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function relTime(t) {
  const m = Math.round((t - liveNow()) / 60000), a = Math.abs(m);
  const s = a < 60 ? `${a} min` : a < 1440 ? `${Math.round(a / 60)} hours` : a < 60 * 24 * 60 ? `${Math.round(a / 1440)} days` : a < 60 * 24 * 730 ? `${Math.round(a / 43200)} months` : `${Math.round(a / 525600)} years`;
  return a < 1 ? 'now' : m < 0 ? `${s} ago` : `in ${s}`;
}

async function focusSub(id) {
  S.cur = id; localSet('cur', id); S.atHead = true;
  renderSubs();
  await loadStream();
  scrollToNow();
  loadSummarizers();
  $('rail').classList.remove('show');
}

// ---------- the pane: glance, open, edit, compose ----------
function placeholder() {
  $('pane').innerHTML = `<div class="placeholder">Hover a document to glance at it.<br>Click to open it here.<br><br><kbd>⌘K</kbd> find or ask · <kbd>N</kbd> new · <kbd>J</kbd>/<kbd>K</kbd> move</div>`;
}

function glance(d) {
  if (S.sel || S.editing) return;
  $('pane').innerHTML = `<div class="hint">${ICON[d.type] || ''} ${d.type} · glance</div><h2>${esc(d.title)}</h2>
    <div class="attrs">${fmtFull(d.created)} · ${esc(d.author)}${d.frozen ? ' · frozen' : ''}</div><div class="body">${esc(d.snippet)}${d.snippet.length >= 220 ? '…' : ''}</div>`;
}

async function openDoc(id, { scroll } = {}) {
  S.sel = id; S.editing = false;
  S.atlas?.select(id);
  document.querySelectorAll('.card.sel').forEach(c => c.classList.remove('sel'));
  const el = document.querySelector(`.card[data-id="${id}"]`);
  el?.classList.add('sel');
  if (scroll) reveal(id);
  $('opClone').disabled = $('opXfer').disabled = false;
  let d;
  try { d = await api('GET', `/docs/${id}`); } catch (e) { return toast(e.message); }
  if (S.sel !== id) return;
  if (d.unread) { api('POST', `/docs/${id}/read`); el?.querySelector('.dot')?.remove(); }
  for (const x of [...d.derived, ...d.children]) S.titles.set(x.id, x.title);
  S.titles.set(d.id, d.title);
  renderDoc(d);
  $('pane').classList.add('show');
}

function renderDoc(d) {
  const writable = !d.frozen;
  const rel = list => list.map(x => `<div>${ICON[x.type] || '•'} <a data-open="${x.id}">${esc(x.title)}</a> <span class="hint">${fmtDay(x.created)}${x.author !== 'me' ? ' · ' + esc(x.author) : ''}</span></div>`).join('');
  $('pane').innerHTML = `
    <div class="hint">${ICON[d.type] || ''} ${d.type}${d.author.startsWith('agent:') ? ' · written by agent' : ''} <a class="closePane" style="float:right">✕</a></div>
    <h2>${esc(d.title)}</h2>
    <div class="tools">
      ${writable ? '<button class="op small" data-act="edit">Edit</button>' : ''}
      <button class="op small" data-act="clone">Clone</button>
      ${writable ? '<button class="op small" data-act="freeze">Freeze</button>' : ''}
      <button class="op small" data-act="transfer">Transfer</button>
      <button class="op small" data-act="like" title="Substream by instance">More like this</button>
    </div>
    <div class="attrs">id       ${d.id}
created  ${fmtFull(d.created)}${isFut(d) ? '  (future — arrives then)' : ''}
author   ${esc(d.author)}${d.from ? `\nfrom     ${esc(d.from)}` : ''}${d.to ? `\nto       ${esc(d.to)}` : ''}
frozen   ${d.frozen ? 'yes 🔒' : 'no'}
file     ${esc(d.path)}</div>
    ${d.file ? '<div class="viewer" id="viewer"></div>' : ''}
    ${d.file && isTextFile(d) ? '' : `<div class="body">${md(d.body) || (d.file ? '' : '<p class="hint">(empty)</p>')}</div>`}
    <h4>In substreams</h4><div class="rel">${d.substreams.map(s => `<a data-sub="${s.id}">${esc(s.label)}</a>`).join(' · ') || '—'}</div>
    <h4>Provenance</h4><div class="rel">${d.author.startsWith('agent:') ? `Written by <b>${esc(d.author.slice(6))}</b>.<br>` : ''}${d.derived.length ? 'Derived from:' + rel(d.derived) : 'Original document.'}</div>
    ${d.children.length ? `<h4>Derived since</h4><div class="rel">${rel(d.children)}</div>` : ''}`;
  if (d.file) mountViewer($('viewer'), d);
  $('pane').querySelector('.tools').onclick = e => {
    const act = e.target.dataset.act;
    if (act === 'edit') editDoc(d);
    if (act === 'clone') cloneSel();
    if (act === 'freeze') api('POST', `/docs/${d.id}/freeze`).then(() => openDoc(d.id));
    if (act === 'transfer') transferSel();
    if (act === 'like') api('POST', '/substreams', { query: `like:${d.id}`, label: `like “${d.title.slice(0, 24)}”`, parent: 'all' }).then(s => { loadSubs(); focusSub(s.id); });
  };
}

function editDoc(d) {
  S.editing = true;
  $('pane').innerHTML = `<div class="hint">editing · ${d.type}</div>
    <form id="ed"><label>Title<input name="title" value="${esc(d.title)}"></label>
    <label>Body<textarea name="body">${esc(d.body)}</textarea></label>
    <div class="tools"><button class="op primary small">Save</button><button type="button" class="op small" id="cancel">Cancel</button></div></form>`;
  $('cancel').onclick = () => openDoc(d.id);
  $('ed').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try { await api('PUT', `/docs/${d.id}`, { title: f.get('title'), body: f.get('body') }); openDoc(d.id); }
    catch (err) { toast(err.message); }
  };
  $('ed').body.focus();
}

function compose(defaults = {}) {
  S.sel = null; S.editing = true;
  document.querySelectorAll('.card.sel').forEach(c => c.classList.remove('sel'));
  $('pane').classList.add('show');
  $('pane').innerHTML = `<div class="hint">new document · lands at the head of the stream — no name or folder needed</div>
    <form id="cmp">
      <label>Type<select name="type">${['note', 'reminder', 'todo', 'bookmark'].map(t => `<option ${t === defaults.type ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>Title (optional)<input name="title"></label>
      <label>Body<textarea name="body" style="min-height:160px"></textarea></label>
      <label>Arrives (leave empty for now; a future time makes it a reminder)<input type="datetime-local" name="at"></label>
      <label>…or add files — any format (you can also drop files anywhere)<input type="file" name="files" multiple></label>
      <div class="tools"><button class="op primary small">Add to stream</button><button type="button" class="op small" id="cancel">Cancel</button></div>
    </form>`;
  $('cancel').onclick = () => { S.editing = false; placeholder(); };
  $('cmp').type.onchange = e => { if (e.target.value === 'reminder' && !$('cmp').at.value) { const t = new Date(liveNow() + 864e5); t.setHours(9, 0, 0, 0); $('cmp').at.value = localInput(t); } };
  $('cmp').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const files = [...e.target.files.files];
    if (files.length && !f.get('body').trim()) { S.editing = false; return uploadFiles(files); }
    const at = f.get('at') ? new Date(f.get('at')).toISOString() : undefined;
    try {
      const d = await api('POST', '/docs', { type: f.get('type'), title: f.get('title'), body: f.get('body'), at });
      S.editing = false;
      await loadStream({ id: d.id, kind: 'drop' });
      if (at) toast(`Scheduled for ${fmtFull(d.created)}`);
      else if (!S.docs.some(x => x.id === d.id)) toast('Added to your lifestream — it doesn’t match the substream you’re focused on.');
      openDoc(d.id, { scroll: true });
    } catch (err) { toast(err.message); }
  };
  $('cmp').body.focus();
}

async function cloneSel() {
  if (!S.sel) return;
  const d = await api('POST', `/docs/${S.sel}/clone`);
  await loadStream({ id: d.id, kind: 'drop' });
  openDoc(d.id, { scroll: true });
}

async function transferSel() {
  if (!S.sel) return;
  const to = prompt("Transfer to whose lifestream? (a sibling folder next to yours)", 'alice');
  if (!to) return;
  try { toast((await api('POST', `/docs/${S.sel}/transfer`, { to })).message); openDoc(S.sel); } catch (e) { toast(e.message); }
}

async function summarize(name) {
  const btn = $('opSum'), label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Summarizing…';
  try {
    const d = await api('POST', '/summarize', { sub: S.cur, name });
    await loadStream({ id: d.id, kind: 'slide' });
    openDoc(d.id, { scroll: true });
  } catch (e) { toast(e.message); }
  btn.disabled = false; btn.textContent = label;
}

// ---------- find or ask ----------
function looksLikeQuestion(t) {
  t = t.trim();
  if (/\b\w+:\S/.test(t) || /~"/.test(t) || /\b(AND|OR|NOT)\b/.test(t)) return false;
  return /\?$/.test(t) || /^(what|who|whom|when|where|why|how|which|did|does|do|is|are|was|were|can|could|should|would|will|show|tell|remind|summarize|find me|list|give)\b/i.test(t) || t.split(/\s+/).length > 5;
}

$('q').addEventListener('input', e => {
  const ask = looksLikeQuestion(e.target.value);
  $('mode').textContent = ask ? 'ask' : 'find';
  $('mode').className = 'mode' + (ask ? ' ask' : '');
});

$('q').addEventListener('keydown', async e => {
  if (e.key === 'Escape') return e.target.blur();
  if (e.key !== 'Enter') return;
  const text = e.target.value.trim();
  if (!text) return;
  e.target.value = ''; $('mode').textContent = 'find'; $('mode').className = 'mode';
  if (e.metaKey || e.ctrlKey || looksLikeQuestion(text)) {
    S.pending = text;
    if (S.view !== 'feed') toast('Asking…');
    await loadStream();
    scrollToNow();
    try {
      const d = await api('POST', '/ask', { text, sub: S.cur });
      S.pending = null;
      await loadStream({ id: d.id, kind: 'slide' });
      openDoc(d.id, { scroll: true });
    } catch (err) { S.pending = null; loadStream(); toast(err.message); }
  } else {
    const sub = await api('POST', '/substreams', { query: text, label: text, parent: S.cur });
    await loadSubs();
    focusSub(sub.id);
  }
});

// ---------- minimap: the 1997 scrollbar as a density histogram ----------
let mapGeom = null;
function drawMini() {
  const cv = $('cv'), box = $('mini'), dpr = devicePixelRatio || 1;
  const W = box.clientWidth, H = box.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const cs = getComputedStyle(document.documentElement), col = v => cs.getPropertyValue(v).trim();
  if (!S.docs.length) { mapGeom = null; return; }
  const ts = S.docs.map(d => d.created);
  const t0 = Math.min(...ts), t1 = Math.max(liveNow(), ...ts), span = t1 - t0 || 1;
  const y = t => 8 + (1 - (t - t0) / span) * (H - 16);
  const bins = Math.max(20, Math.floor((H - 16) / 4)), counts = new Array(bins).fill(0);
  for (const t of ts) counts[Math.min(bins - 1, Math.floor((t - t0) / span * bins))]++;
  const max = Math.max(...counts), bh = (H - 16) / bins;
  g.fillStyle = col('--muted'); g.globalAlpha = .45;
  counts.forEach((c, i) => { if (c) { const w = 3 + c / max * (W - 12); g.fillRect(W - 3 - w, y(t0 + (i + 1) / bins * span), w, Math.max(1, bh - 1)); } });
  g.globalAlpha = 1;
  g.fillStyle = col('--accent'); g.fillRect(0, y(liveNow()) - 1, W, 2);
  g.fillStyle = col('--muted'); g.font = '10px ui-sans-serif';
  for (let yr = new Date(t0).getFullYear() + 1; yr <= new Date(t1).getFullYear(); yr++) {
    const yy = y(+new Date(yr, 0, 1)); g.fillRect(0, yy, 6, 1); g.fillText(String(yr).slice(2), 2, yy - 2);
  }
  const tsv = visibleTimes();
  if (tsv.length) {
    const ya = y(Math.max(...tsv)), yb = y(Math.min(...tsv));
    g.strokeStyle = col('--ink'); g.lineWidth = 2; g.strokeRect(2, ya - 2, W - 4, yb - ya + 4);
  }
  mapGeom = { t0, span, H };
}

// Times of the documents currently "in view", for the minimap bracket.
function visibleTimes() {
  const byId = id => S.docs.find(d => d.id === id)?.created;
  if (S.view === 'atlas') return S.atlas?.visibleTimes() || [];
  if (S.view === 'stack') {
    const asc = stackOrder(), i = asc.findIndex(d => d.id === S.cursor);
    return i < 0 ? [] : asc.slice(Math.max(0, i - 12), i + 1).map(d => d.created);
  }
  if (S.view === 'river') {
    const r = $('river');
    if (!r) return [];
    return [...r.querySelectorAll('.col')].filter(c => c.offsetLeft + c.offsetWidth > r.scrollLeft && c.offsetLeft < r.scrollLeft + r.clientWidth)
      .flatMap(c => [...c.querySelectorAll('.card[data-id]')].map(x => byId(x.dataset.id))).filter(Boolean);
  }
  const sv = $('stream');
  return [...sv.querySelectorAll('.card[data-id]')].filter(c => c.offsetTop + c.offsetHeight > sv.scrollTop && c.offsetTop < sv.scrollTop + sv.clientHeight)
    .map(c => byId(c.dataset.id)).filter(Boolean);
}

function scrubTo(clientY) {
  if (!mapGeom) return;
  const { t0, span, H } = mapGeom;
  const f = 1 - (clientY - $('mini').getBoundingClientRect().top - 8) / (H - 16);
  const t = t0 + Math.min(1, Math.max(0, f)) * span;
  if (S.view === 'atlas') return S.atlas?.scrubTo(t);
  if (S.view === 'stack') {
    const asc = stackOrder();
    let bi = 0;
    asc.forEach((d, i) => { if (Math.abs(d.created - t) < Math.abs(asc[bi].created - t)) bi = i; });
    if (asc[bi] && asc[bi].id !== S.cursor) { S.cursor = asc[bi].id; S.atHead = false; renderStack(); drawMini(); }
    return;
  }
  let best = null, bd = Infinity;
  for (const c of $('stream').querySelectorAll('.card[data-id]')) {
    const d = S.docs.find(x => x.id === c.dataset.id);
    const k = Math.abs(d.created - t);
    if (k < bd) { bd = k; best = c; }
  }
  if (!best) return;
  if (S.view === 'river') { const col = best.closest('.col'), r = $('river'); r.scrollLeft = col.offsetLeft - r.clientWidth / 2 + col.offsetWidth / 2; }
  else $('stream').scrollTop = best.offsetTop - 80;
}

// ---------- live events ----------
let reloadTimer, reloadAnim;
function scheduleReload(anim) {
  if (anim) reloadAnim = anim;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    const a = reloadAnim; reloadAnim = null;
    await loadStream(a);
    loadSubs();
    if (S.sel && a?.id === S.sel && !S.editing) openDoc(S.sel);
  }, 120);
}

function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = m => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'append') scheduleReload({ id: ev.doc.id, kind: ev.doc.author === 'me' ? 'drop' : 'slide' });
    else if (ev.type === 'remove') scheduleReload();
    else if (ev.type === 'update') { scheduleReload(); if (ev.doc.id === S.sel && !S.editing) openDoc(S.sel); }
    else if (ev.type === 'arrive') { toast(`${ICON[ev.doc.type] || '•'} Arrived: ${ev.doc.title}`); scheduleReload({ id: ev.doc.id, kind: 'slide' }); }
    else if (ev.type === 'substreams') { loadSubs(); scheduleReload(); loadSummarizers(); }
    else if (ev.type === 'agent') {
      const a = S.agents.find(x => x.name === ev.agent.name);
      if (a) Object.assign(a, ev.agent); else S.agents.push(ev.agent);
      renderAgents();
      if (ev.agent.status === 'error') toast(`✦ ${ev.agent.name}: ${ev.agent.error}`);
    }
  };
  es.onerror = () => { $('status').textContent = 'reconnecting…'; };
  es.onopen = () => loadStatus();
}

// ---------- wiring ----------
const sv = $('stream');
sv.addEventListener('mouseover', e => {
  const c = e.target.closest('.card[data-id]');
  if (c) { const d = S.docs.find(x => x.id === c.dataset.id); if (d) glance(d); }
});
sv.addEventListener('click', e => {
  const c = e.target.closest('.card[data-id]');
  if (!c) return;
  if (S.view === 'stack' && c.dataset.id !== S.cursor) { S.cursor = c.dataset.id; S.atHead = false; renderStack(); drawMini(); return; }
  openDoc(c.dataset.id);
});
sv.addEventListener('scroll', () => requestAnimationFrame(drawMini));
$('pane').addEventListener('click', e => {
  const o = e.target.closest('[data-open]'), s = e.target.closest('[data-sub]');
  if (e.target.closest('.closePane')) { S.sel = null; $('pane').classList.remove('show'); placeholder(); document.querySelectorAll('.card.sel').forEach(c => c.classList.remove('sel')); }
  if (o) {
    if (!S.docs.some(d => d.id === o.dataset.open)) focusSub('all').then(() => openDoc(o.dataset.open, { scroll: true }));
    else openDoc(o.dataset.open, { scroll: true });
  }
  if (s) focusSub(s.dataset.sub);
});
let dragging = false;
$('mini').addEventListener('pointerdown', e => { dragging = true; $('mini').setPointerCapture(e.pointerId); scrubTo(e.clientY); });
$('mini').addEventListener('pointermove', e => dragging && scrubTo(e.clientY));
$('mini').addEventListener('pointerup', () => { dragging = false; });
addEventListener('resize', drawMini);

$('opNew').onclick = () => compose();
$('opClone').onclick = cloneSel;
$('opXfer').onclick = transferSel;
$('opSum').onclick = () => summarize(S.summarizers[0]?.name);
$('opSumMore').onclick = e => {
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = S.summarizers.map(s => `<button data-name="${esc(s.name)}">${esc(s.label)}</button>`).join('');
  const r = e.target.getBoundingClientRect();
  Object.assign(m.style, { left: r.left + 'px', bottom: innerHeight - r.top + 6 + 'px' });
  document.body.appendChild(m);
  const close = ev => { if (ev.target.dataset.name) summarize(ev.target.dataset.name); m.remove(); removeEventListener('click', close, true); };
  setTimeout(() => addEventListener('click', close, true));
};
$('views').onclick = e => { const v = e.target.dataset.view; if (v) setView(v); };
$('menuBtn').onclick = () => $('rail').classList.toggle('show');

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); $('q').focus(); return; }
  if (e.target.closest('input, textarea, select')) return;
  if (e.key === 'n') { e.preventDefault(); compose(); }
  if (S.view === 'atlas' && e.key !== 'Escape') return;   // the Atlas handles its own keys
  if (['1', '2', '3', '4'].includes(e.key)) return setView(['feed', 'stack', 'river', 'atlas'][e.key - 1]);
  if (S.view === 'stack' && ['ArrowUp', 'ArrowDown', 'j', 'k', 'Enter'].includes(e.key)) {
    e.preventDefault();
    if (e.key === 'Enter') return S.cursor && openDoc(S.cursor);
    return moveStack(e.key === 'ArrowUp' || e.key === 'k' ? 1 : -1);
  }
  if (e.key === 'j' || e.key === 'k') {
    const cards = [...sv.querySelectorAll('.card[data-id]')];
    const i = cards.findIndex(c => c.dataset.id === S.sel);
    const next = cards[Math.max(0, Math.min(cards.length - 1, i < 0 ? cards.findIndex(c => !c.classList.contains('future')) : i + (e.key === 'j' ? 1 : -1)))];
    if (next) openDoc(next.dataset.id, { scroll: true });
  }
  if (e.key === 'Escape') { S.sel = null; S.editing = false; placeholder(); S.atlas?.select(null); $('pane').classList.remove('show'); }
});

setInterval(() => { $('clock').textContent = new Date(liveNow()).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }, 1000);
setInterval(() => renderStream(), 60000);   // keep the Now line honest

// ---------- files: drop anything onto the page to add it to the stream ----------
async function uploadFiles(files) {
  let last = null;
  for (const f of files) {
    try {
      const res = await fetch('/api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || res.statusText);
      last = d;
      toast(`Added ${f.name}`);
    } catch (e) { toast(`${f.name}: ${e.message}`); }
  }
  if (last) { await loadStream({ id: last.id, kind: 'slide' }); openDoc(last.id, { scroll: true }); }
}
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dropping'); } });
addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', e => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dropping');
  uploadFiles([...e.dataTransfer.files]);
});

// ---------- helpers ----------
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
function md(src) {
  const out = []; let list = false, pre = false;
  const close = () => { if (list) { out.push('</ul>'); list = false; } };
  for (const raw of esc(src).split('\n')) {
    if (raw.startsWith('```')) { close(); out.push(pre ? '</pre>' : '<pre>'); pre = !pre; continue; }
    if (pre) { out.push(raw + '\n'); continue; }
    let m;
    if ((m = raw.match(/^#{1,4}\s+(.*)/))) { close(); out.push(`<h3>${inline(m[1])}</h3>`); continue; }
    if ((m = raw.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/))) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    close();
    if (raw.trim().startsWith('|')) { out.push(`<code style="display:block;white-space:pre;overflow:auto">${raw}</code>`); continue; }
    if (raw.trim()) out.push(`<p>${inline(raw)}</p>`);
  }
  close();
  return out.join('');
}
function inline(s) {
  return s.replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_([^_]+)_(?=$|[^\w])/g, '$1<i>$2</i>')
    .replace(/\[([0-9]{8}T[0-9]{6}Z-[a-z0-9]+)\]/g, (_, id) => `<a data-open="${id}" title="${id}">↗ ${esc((S.titles.get(id) || id.slice(-4)).slice(0, 40))}</a>`)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}
function fmtDay(t) {
  const d = new Date(t), diff = Math.round((new Date(t).setHours(0, 0, 0, 0) - new Date(liveNow()).setHours(0, 0, 0, 0)) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  if (diff === 1) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() !== new Date(liveNow()).getFullYear() ? 'numeric' : undefined });
}
function fmtTime(t) { return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
function fmtFull(t) { return new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); }
function ago(t) { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; }
function localInput(d) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3200); }
function localGet(k) { try { return localStorage.getItem('ls:' + k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem('ls:' + k, v); } catch {} }

// ---------- start ----------
placeholder();
document.querySelectorAll('#views button').forEach(b => b.setAttribute('aria-selected', b.dataset.view === S.view));
await loadStatus();
await loadAgents();
await loadSubs();
await focusSub(S.cur);
connect();
