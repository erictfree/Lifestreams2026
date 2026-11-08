// Classic: the 1997 X Windows interface, kept faithful and brought up to date. A diagonal
// stack of ~40 pages — the newest at the bottom right, each older page one step up and to
// the left, so you read the stream by the header strips that peek out. Hover a page and a
// large copy pops out to the left (the original "glance"); the stream name and count sit
// above a time slider whose thumb is the visible slice, labelled with the slice's dates on
// top and the whole stream's range below. Unread pages have red borders, writable pages
// thick ones, and pages slide one slot as you move through time.

import { drawThumb, TYPE_COLOR } from './formats.js';

const SLICE = 40, THUMB_CONCURRENCY = 4, MAX_THUMBS = 260;

export function createClassic(el, cb) {
  el.innerHTML = `<div class="cl-stage"></div>
    <div class="cl-glance" hidden></div>
    <div class="cl-info"><div class="cl-stream"></div><div class="cl-sub"></div><div class="cl-count"></div></div>
    <div class="cl-slider">
      <div class="cl-range"></div>
      <div class="cl-track"><button class="cl-arrow" data-d="1" aria-label="Older">◀</button><div class="cl-rail"><div class="cl-thumb"></div></div><button class="cl-arrow" data-d="-1" aria-label="Newer">▶</button></div>
      <div class="cl-ends"><span></span><span></span></div>
    </div>`;
  const stage = el.querySelector('.cl-stage'), glanceEl = el.querySelector('.cl-glance');
  const pages = new Map();            // id -> { node, canvasReady }
  const thumbs = new Map();           // id -> { c, used }
  const pending = []; let inflight = 0;
  let list = [], head = 0, selId = null, hoverId = null, destroyed = false, label = { stream: '', sub: '' };
  let geo = { W: 0, H: 0, pw: 200, ph: 250, dx: 12, dy: 9, fx: 0, fy: 0 };

  // ---------- data ----------
  function update(docs, { sel, anim } = {}) {
    const now = cb.now();
    const wasAtNow = !list.length || list[head]?.id === newestPast(list, now)?.id;
    const keep = list[head]?.id;
    list = docs;                                             // newest first, future first
    if (sel !== undefined) selId = sel;
    const np = list.indexOf(newestPast(list, now));
    head = wasAtNow || !keep ? Math.max(0, np) : Math.max(0, list.findIndex(d => d.id === keep));
    if (head < 0) head = 0;
    if (anim?.id) pages.get(anim.id)?.node.classList.add('cl-new');
    label = cb.label?.() || { stream: 'Your Lifestream', sub: '' };
    layout(); render();
  }
  const newestPast = (l, now) => l.find(d => d.created <= now);

  // ---------- geometry ----------
  function layout() {
    const r = el.getBoundingClientRect();
    const W = r.width, H = r.height, narrow = W < 560;
    const pw = Math.round(Math.min(narrow ? W * 0.5 : 230, W * 0.3)), ph = Math.round(pw * 1.25);
    const fx = W - pw - (narrow ? 14 : 32), fy = H - ph - (narrow ? 96 : 36);          // front page
    // the stack runs corner to corner, about 45°, leaving the lower-left triangle for the
    // stream name and slider; the glance pops out over the older pages, as in the original
    const left = narrow ? 8 : 18, top = 46;
    const dx = Math.max(4, (fx - left) / (SLICE - 1)), dy = Math.max(3, (fy - top) / (SLICE - 1));
    geo = { W, H, pw, ph, dx, dy, fx, fy, narrow };
  }

  // ---------- render ----------
  function render() {
    if (destroyed) return;
    const slice = list.slice(head, head + SLICE);
    const seen = new Set();
    const now = cb.now();
    slice.forEach((d, i) => {
      seen.add(d.id);
      let p = pages.get(d.id);
      if (!p) {
        const node = document.createElement('div');
        node.className = 'cl-page';
        node.dataset.id = d.id;
        // a one-line header at the very top edge — the part of each page that peeks out
        node.innerHTML = `<div class="cl-head"><b></b><span></span></div><div class="cl-body"><div class="cl-fallback"><b></b><span></span></div></div>`;
        // new pages enter from where they belong: one slot further along
        const j = Math.min(i + 1, SLICE);
        node.style.transform = `translate(${geo.fx - j * geo.dx}px, ${geo.fy - j * geo.dy}px)`;
        node.style.opacity = 0;
        stage.appendChild(node);
        p = { node, canvas: null };
        pages.set(d.id, p);
        requestAnimationFrame(() => { node.style.opacity = ''; });
      }
      const n = p.node;
      n.style.width = geo.pw + 'px'; n.style.height = geo.ph + 'px';
      n.style.transform = `translate(${geo.fx - i * geo.dx}px, ${geo.fy - i * geo.dy}px)`;
      n.style.zIndex = SLICE - i;
      n.classList.toggle('unread', !!d.unread);
      n.classList.toggle('writable', !d.frozen && d.created <= now);
      n.classList.toggle('future', d.created > now);
      n.classList.toggle('sel', d.id === selId);
      n.classList.toggle('hover', d.id === hoverId);
      n.classList.toggle('far', i > SLICE * 0.7);
      const hd = n.querySelector('.cl-head');
      hd.firstChild.textContent = d.title; hd.lastChild.textContent = fmtShort(d.created);
      hd.style.setProperty('--c', typeColor(d));
      const fb = n.querySelector('.cl-fallback');
      if (fb) { fb.firstChild.textContent = d.title; fb.lastChild.textContent = `${d.author} · ${fmtShort(d.created)}`; }
      attachThumb(d, p);
    });
    for (const [id, p] of pages) if (!seen.has(id)) { p.node.remove(); pages.delete(id); }
    renderDayTags(slice);
    renderChrome(slice);
    cb.onView?.();
  }

  // day labels under the first page of each day, as in the original ("Wed 10/30/96")
  function renderDayTags(slice) {
    stage.querySelectorAll('.cl-day').forEach(n => n.remove());
    slice.forEach((d, i) => {
      const older = slice[i + 1] || list[head + i + 1];
      if (older && dayKey(older.created) === dayKey(d.created)) return;
      const t = document.createElement('div');
      t.className = 'cl-day' + (d.created > cb.now() ? ' fut' : '');
      t.textContent = fmtShort(d.created);
      // in the open space just below-left of the page's bottom-left corner
      t.style.transform = `translate(calc(${geo.fx - i * geo.dx - 6}px - 100%), ${geo.fy - i * geo.dy + geo.ph - 12}px)`;
      t.style.zIndex = SLICE + 5;
      if (geo.fx - i * geo.dx > 90) stage.appendChild(t);
    });
  }

  function renderChrome(slice) {
    el.querySelector('.cl-stream').textContent = `Stream: ${label.stream}`;
    el.querySelector('.cl-sub').textContent = label.sub || 'Main stream';
    el.querySelector('.cl-count').textContent = `${list.length.toLocaleString()} documents`;
    const range = el.querySelector('.cl-range');
    if (slice.length) range.textContent = `${fmtShort(slice.at(-1).created)} to ${fmtShort(slice[0].created)}`;
    const ends = el.querySelectorAll('.cl-ends span');
    if (list.length) { ends[0].textContent = fmtShort(list.at(-1).created); ends[1].textContent = fmtShort(list[0].created); }
    // the thumb: its size is the visible fraction, its place is where the slice sits in time
    const rail = el.querySelector('.cl-rail'), th = el.querySelector('.cl-thumb');
    const n = Math.max(1, list.length), frac = Math.min(1, SLICE / n);
    const pos = n <= SLICE ? 0 : 1 - (head + Math.min(SLICE, n - head)) / n;     // left = oldest
    th.style.width = Math.max(6, frac * 100) + '%';
    th.style.left = Math.max(0, Math.min(1 - frac, pos)) * 100 + '%';
    rail.title = `${slice.length} of ${n} documents visible`;
  }

  // ---------- thumbnails (rendered documents) ----------
  function attachThumb(d, p) {
    const t = thumbs.get(d.id);
    if (t) {
      t.used = performance.now();
      if (p.canvas !== t.c) { const body = p.node.querySelector('.cl-body'); body.replaceChildren(t.c); p.canvas = t.c; }
      return;
    }
    if (!pending.includes(d.id)) pending.push(d.id);
    pump();
  }
  function pump() {
    // nearest the front first
    pending.sort((a, b) => order(a) - order(b));
    while (inflight < THUMB_CONCURRENCY && pending.length) {
      const id = pending.shift();
      const d = list.find(x => x.id === id);
      if (!d || order(id) > SLICE) continue;
      inflight++;
      const c = document.createElement('canvas');
      c.className = 'cl-canvas';
      drawThumb(c, d, { dark: cb.dark(), scale: 0.85, now: cb.now() })
        .then(() => {
          if (destroyed) return;
          thumbs.set(id, { c, used: performance.now() });
          if (thumbs.size > MAX_THUMBS) for (const [k] of [...thumbs.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, thumbs.size - MAX_THUMBS)) if (!pages.has(k)) thumbs.delete(k);
          const p = pages.get(id);
          if (p) attachThumb(d, p);
        })
        .catch(() => {})
        .finally(() => { inflight--; pump(); });
    }
  }
  const order = id => { const i = list.findIndex(d => d.id === id); return i < head ? 1e9 : i - head; };

  // ---------- glance: the big page that pops out to the left ----------
  async function showGlance(d, pageNode) {
    if (geo.narrow) return;
    glanceEl.hidden = false;
    const gw = Math.min(300, geo.fx * 0.55), gh = gw * 1.25;
    const r = pageNode.getBoundingClientRect(), er = el.getBoundingClientRect();
    const x = Math.max(12, Math.min(r.left - er.left - gw * 0.55, geo.W - gw - 12));
    const y = Math.max(44, Math.min(r.top - er.top - gh * 0.25, geo.H - gh - 120));
    glanceEl.style.width = gw + 'px'; glanceEl.style.height = gh + 'px';
    glanceEl.style.transform = `translate(${x}px, ${y}px)`;
    glanceEl.dataset.id = d.id;
    const c = document.createElement('canvas');
    await drawThumb(c, d, { dark: cb.dark(), scale: 1.4, now: cb.now() }).catch(() => {});
    if (glanceEl.dataset.id !== d.id) return;
    glanceEl.replaceChildren(c);
  }
  function hideGlance() { glanceEl.hidden = true; glanceEl.dataset.id = ''; }

  // ---------- interaction ----------
  function move(delta) {
    const h = Math.max(0, Math.min(Math.max(0, list.length - 1), head + delta));
    if (h !== head) { head = h; hideGlance(); render(); }
  }
  let acc = 0;
  const onWheel = e => {
    if (e.target.closest('.cl-slider')) return;
    e.preventDefault();
    acc += e.deltaY;
    const step = 40;
    while (Math.abs(acc) >= step) { move(acc > 0 ? 1 : -1); acc -= Math.sign(acc) * step; }   // down = older
  };
  const onOver = e => {
    const p = e.target.closest('.cl-page');
    const id = p?.dataset.id || null;
    if (id === hoverId) return;
    hoverId = id;
    stage.querySelectorAll('.cl-page.hover').forEach(n => n.classList.remove('hover'));
    if (!p) { hideGlance(); return; }
    p.classList.add('hover');
    const d = list.find(x => x.id === id);
    if (d) { showGlance(d, p); cb.onHover?.(d); }
  };
  const onClick = e => {
    const p = e.target.closest('.cl-page');
    if (!p) return;
    const d = list.find(x => x.id === p.dataset.id);
    if (d) { selId = d.id; render(); cb.onOpen?.(d); }
  };
  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('mouseover', onOver);
  stage.addEventListener('mouseleave', () => { hoverId = null; hideGlance(); stage.querySelectorAll('.cl-page.hover').forEach(n => n.classList.remove('hover')); });
  stage.addEventListener('click', onClick);
  el.querySelectorAll('.cl-arrow').forEach(b => b.onclick = () => move(+b.dataset.d * 8));
  // dragging the thumb (or clicking the rail) travels through time
  const rail = el.querySelector('.cl-rail');
  const railTo = e => {
    const r = rail.getBoundingClientRect(), frac = Math.min(1, SLICE / Math.max(1, list.length));
    const pos = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width - frac / 2));
    head = Math.max(0, Math.min(list.length - 1, Math.round((1 - pos - frac) * list.length)));
    hideGlance(); render();
  };
  let railDrag = false;
  rail.addEventListener('pointerdown', e => { railDrag = true; rail.setPointerCapture(e.pointerId); railTo(e); });
  rail.addEventListener('pointermove', e => railDrag && railTo(e));
  rail.addEventListener('pointerup', () => { railDrag = false; });
  let touchY = null;
  stage.addEventListener('touchstart', e => { touchY = e.touches[0].clientY; }, { passive: true });
  stage.addEventListener('touchmove', e => { if (touchY === null) return; const dy = touchY - e.touches[0].clientY; if (Math.abs(dy) > 24) { move(dy > 0 ? 1 : -1); touchY = e.touches[0].clientY; } }, { passive: true });
  const onKey = e => {
    if (e.target.closest?.('input, textarea, select')) return;
    const d = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1, PageDown: SLICE / 2, PageUp: -SLICE / 2 }[e.key];
    if (e.key === '0') return home();
    if (e.key === 'Enter' && list[head]) return cb.onOpen?.(list[head]);
    if (d) { e.preventDefault(); move(d); }
  };
  window.addEventListener('keydown', onKey);
  const ro = new ResizeObserver(() => { layout(); render(); }); ro.observe(el);

  function home() {
    const i = list.indexOf(newestPast(list, cb.now()));
    head = Math.max(0, i); hideGlance(); render();
  }

  return {
    update, home,
    reveal: id => { const i = list.findIndex(d => d.id === id); if (i >= 0) { head = i; selId = id; render(); } },
    select: id => { selId = id; render(); },
    scrubTo: t => {
      let best = 0;
      list.forEach((d, i) => { if (Math.abs(d.created - t) < Math.abs(list[best].created - t)) best = i; });
      head = best; hideGlance(); render();
    },
    visibleTimes: () => list.slice(head, head + SLICE).map(d => d.created),
    destroy() { destroyed = true; ro.disconnect(); window.removeEventListener('keydown', onKey); thumbs.clear(); el.innerHTML = ''; },
  };
}

const typeColor = d => TYPE_COLOR[d.type] || '#888';
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
// the original's terse style: "Wed 10/30/96"
const fmtShort = t => { const d = new Date(t); return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`; };
