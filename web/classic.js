// Classic: the 1997 X Windows interface, rebuilt. Pages recede in true perspective toward
// a vanishing point at the top left — the newest large at the bottom right, older pages
// smaller and fainter as they go back — so the stream reads by the header line of each
// page that peeks out above the one in front. Hover a page and its glance animates out of
// the stack; the stream's name and size sit in the open corner above a time slider whose
// track is the stream's own density histogram. Unread pages ring red, writable pages
// have a stronger edge, and every move slides the stack one page through time.

import { drawThumb, TYPE_COLOR } from './formats.js';

const SLICE = 40;                    // pages in the stack
const PERSPECTIVE = 1100;            // px, CSS perspective distance
const BACK_SCALE = 0.4;              // how small the last page appears
const THUMB_CONCURRENCY = 4, MAX_THUMBS = 260;

export function createClassic(el, cb) {
  el.innerHTML = `
    <div class="cl-stage"><div class="cl-vp"></div></div>
    <div class="cl-glance" hidden></div>
    <div class="cl-info">
      <div class="cl-kicker">Stream</div>
      <div class="cl-stream"></div>
      <div class="cl-sub"></div>
      <div class="cl-count"></div>
    </div>
    <div class="cl-slider">
      <div class="cl-range"><span class="cl-from"></span><span class="cl-to"></span></div>
      <div class="cl-track">
        <button class="cl-arrow" data-d="8" aria-label="Older">‹</button>
        <div class="cl-rail"><canvas class="cl-hist"></canvas><div class="cl-thumb"></div></div>
        <button class="cl-arrow" data-d="-8" aria-label="Newer">›</button>
      </div>
      <div class="cl-ends"><span></span><span></span></div>
    </div>`;
  const stage = el.querySelector('.cl-stage'), glanceEl = el.querySelector('.cl-glance');
  const pages = new Map();            // id -> { node, scale }
  const thumbs = new Map();           // id -> { c, scale, used }
  const pending = new Map(); let inflight = 0;
  let list = [], head = 0, selId = null, hoverId = null, destroyed = false, label = { stream: '', sub: '' };
  let geo = {};
  const fresh = new Set();

  // ---------- data ----------
  function update(docs, { sel, anim } = {}) {
    const now = cb.now();
    const wasAtNow = !list.length || list[head]?.id === newestPast(list, now)?.id;
    const keep = list[head]?.id;
    list = docs;                                            // newest first; future first
    if (sel !== undefined) selId = sel;
    const np = list.indexOf(newestPast(list, now));
    head = wasAtNow || !keep ? Math.max(0, np) : Math.max(0, list.findIndex(d => d.id === keep));
    label = cb.label?.() || { stream: 'me', sub: 'Main stream' };
    if (anim?.id) fresh.add(anim.id);
    layout(); render(); drawHistogram();
  }
  const newestPast = (l, now) => l.find(d => d.created <= now);

  // ---------- geometry: a vanishing point at the top left ----------
  function layout() {
    const r = el.getBoundingClientRect();
    const W = r.width, H = r.height, narrow = W < 560;
    const pw = Math.round(Math.max(140, Math.min(narrow ? W * 0.46 : W * 0.3, 300)));
    const ph = Math.round(pw * 1.294);                        // a US letter page
    // on a phone the stack sits above the stream info and slider
    const fx = W - pw - (narrow ? 14 : 40), fy = H - ph - (narrow ? 210 : 40);
    // vanishing point beyond the top-left corner, so the stack spans the whole diagonal
    const vx = narrow ? W * 0.02 : -W * 0.12, vy = narrow ? 20 : -H * 0.16;
    // depth step so the last page shrinks to BACK_SCALE
    const dz = PERSPECTIVE * (1 / BACK_SCALE - 1) / (SLICE - 1);
    geo = { W, H, pw, ph, fx, fy, vx, vy, dz, narrow };
    stage.style.perspective = PERSPECTIVE + 'px';
    stage.style.perspectiveOrigin = `${vx}px ${vy}px`;
  }
  // where a page lands on screen (for labels)
  function projected(i) {
    const s = PERSPECTIVE / (PERSPECTIVE + i * geo.dz);
    const x = geo.vx + (geo.fx - geo.vx) * s, y = geo.vy + (geo.fy - geo.vy) * s;
    return { x, y, w: geo.pw * s, h: geo.ph * s, s };
  }

  // ---------- render ----------
  function render() {
    if (destroyed) return;
    const vp = stage.firstChild;
    const slice = list.slice(head, head + SLICE);
    const now = cb.now(), seen = new Set();
    slice.forEach((d, i) => {
      seen.add(d.id);
      let p = pages.get(d.id);
      if (!p) {
        const node = document.createElement('div');
        node.className = 'cl-page';
        node.dataset.id = d.id;
        node.innerHTML = `<div class="cl-head"><i></i><b></b><span></span></div><div class="cl-body"><div class="cl-fallback"></div></div>`;
        // enter from one page further back (or drop in from above if it's brand new)
        node.style.transform = fresh.has(d.id) ? xf(i, -geo.ph * 0.6, 120) : xf(i + 1);
        node.style.opacity = 0;
        vp.appendChild(node);
        p = { node, scale: 0 };
        pages.set(d.id, p);
        fresh.delete(d.id);
        requestAnimationFrame(() => requestAnimationFrame(() => { node.style.transform = xf(i); node.style.opacity = fade(i); }));
      } else {
        p.node.style.transform = xf(i);
        p.node.style.opacity = fade(i);
      }
      const n = p.node;
      n.style.width = geo.pw + 'px'; n.style.height = geo.ph + 'px';
      n.style.zIndex = SLICE - i;
      n.style.setProperty('--c', TYPE_COLOR[d.type] || '#888');
      n.classList.toggle('unread', !!d.unread);
      n.classList.toggle('writable', !d.frozen && d.created <= now);
      n.classList.toggle('future', d.created > now);
      n.classList.toggle('sel', d.id === selId);
      n.classList.toggle('front', i === 0);
      const hd = n.querySelector('.cl-head');
      hd.children[1].textContent = d.title;
      hd.children[2].textContent = fmtShort(d.created);
      const fb = n.querySelector('.cl-fallback');
      if (fb) fb.textContent = d.snippet || '';
      attachThumb(d, p, i);
    });
    for (const [id, p] of pages) if (!seen.has(id)) { p.node.remove(); pages.delete(id); }
    renderDayTags(slice);
    renderChrome(slice);
    cb.onView?.();
  }
  const xf = (i, dy = 0, dzExtra = 0) => `translate3d(${geo.fx}px, ${geo.fy + dy}px, ${-i * geo.dz + dzExtra}px)`;
  const fade = i => (1 - Math.pow(i / SLICE, 1.6) * 0.62).toFixed(3);

  // day labels: pills in the open space to the left of the first page of each day
  function renderDayTags(slice) {
    stage.querySelectorAll('.cl-day').forEach(n => n.remove());
    if (geo.narrow) return;
    slice.forEach((d, i) => {
      const older = list[head + i + 1];
      if (older && dayKey(older.created) === dayKey(d.created)) return;
      const p = projected(i);
      if (p.x < 110) return;
      const t = document.createElement('div');
      t.className = 'cl-day' + (d.created > cb.now() ? ' fut' : '');
      t.textContent = fmtShort(d.created);
      t.style.transform = `translate(calc(${p.x - 10}px - 100%), ${p.y + p.h - 18}px)`;
      t.style.opacity = Math.max(0.35, p.s);
      stage.appendChild(t);
    });
  }

  function renderChrome(slice) {
    el.querySelector('.cl-stream').textContent = label.stream;
    el.querySelector('.cl-sub').textContent = label.sub || 'Main stream';
    el.querySelector('.cl-count').textContent = `${list.length.toLocaleString()} documents`;
    if (slice.length) {
      el.querySelector('.cl-from').textContent = fmtShort(slice.at(-1).created);
      el.querySelector('.cl-to').textContent = fmtShort(slice[0].created);
    }
    const ends = el.querySelectorAll('.cl-ends span');
    if (list.length) { ends[0].textContent = fmtShort(list.at(-1).created); ends[1].textContent = fmtShort(list[0].created); }
    // thumb: placed by time (where the slice sits in the stream), sized by its span
    const th = el.querySelector('.cl-thumb');
    if (list.length && slice.length) {
      const t0 = list.at(-1).created, t1 = list[0].created, span = Math.max(1, t1 - t0);
      const a = (slice.at(-1).created - t0) / span, b = (slice[0].created - t0) / span;
      const w = Math.max(0.035, b - a);
      th.style.left = Math.min(1 - w, Math.max(0, a)) * 100 + '%';
      th.style.width = w * 100 + '%';
    }
  }

  // density of the whole stream over time, drawn into the slider's track
  function drawHistogram() {
    const c = el.querySelector('.cl-hist'), r = c.getBoundingClientRect();
    if (!r.width || !list.length) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = r.width * dpr; c.height = r.height * dpr;
    const g = c.getContext('2d'); g.scale(dpr, dpr);
    const t0 = list.at(-1).created, t1 = list[0].created, span = Math.max(1, t1 - t0);
    const bins = Math.max(20, Math.floor(r.width / 3)), counts = new Array(bins).fill(0);
    for (const d of list) counts[Math.min(bins - 1, Math.floor((d.created - t0) / span * bins))]++;
    const max = Math.max(...counts), bw = r.width / bins;
    const css = getComputedStyle(document.documentElement);
    g.fillStyle = css.getPropertyValue('--muted').trim() || '#888';
    g.globalAlpha = 0.45;
    counts.forEach((n, i) => { if (n) { const h = Math.max(1.5, Math.sqrt(n / max) * (r.height - 6)); g.fillRect(i * bw + 0.5, r.height - 3 - h, Math.max(1, bw - 1), h); } });
    const nowX = (cb.now() - t0) / span * r.width;
    g.globalAlpha = 1; g.fillStyle = css.getPropertyValue('--accent').trim() || '#c2410c';
    if (nowX > 0 && nowX < r.width) g.fillRect(nowX, 2, 1.5, r.height - 4);
  }

  // ---------- thumbnails: rendered documents, sharper at the front ----------
  function attachThumb(d, p, i) {
    const want = i < 3 ? 1.7 : i < 12 ? 1 : 0.6;
    const t = thumbs.get(d.id);
    if (t) {
      t.used = performance.now();
      if (p.scale !== t.scale) { p.node.querySelector('.cl-body').replaceChildren(t.c); p.scale = t.scale; }
    }
    if (!t || t.scale < want) { pending.set(d.id, Math.max(want, pending.get(d.id) || 0)); pump(); }
  }
  function pump() {
    const order = id => { const i = list.findIndex(d => d.id === id); return i < head || i >= head + SLICE ? 1e9 : i - head; };
    for (const id of [...pending.keys()]) if (order(id) === 1e9) pending.delete(id);
    while (inflight < THUMB_CONCURRENCY && pending.size) {
      const [id, scale] = [...pending.entries()].sort((a, b) => order(a[0]) - order(b[0]))[0];
      pending.delete(id);
      const d = list.find(x => x.id === id);
      if (!d) continue;
      inflight++;
      const c = document.createElement('canvas');
      c.className = 'cl-canvas';
      drawThumb(c, d, { dark: cb.dark(), scale, now: cb.now() })
        .then(() => {
          if (destroyed) return;
          const prev = thumbs.get(id);
          if (!prev || prev.scale < scale) thumbs.set(id, { c, scale, used: performance.now() });
          if (thumbs.size > MAX_THUMBS) for (const [k] of [...thumbs.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, thumbs.size - MAX_THUMBS)) if (!pages.has(k)) thumbs.delete(k);
          const p = pages.get(id);
          if (p) attachThumb(d, p, Math.max(0, list.findIndex(x => x.id === id) - head));
        })
        .catch(() => {})
        .finally(() => { inflight--; pump(); });
    }
  }

  // ---------- glance: grows out of the hovered page ----------
  let glanceToken = 0;
  async function showGlance(d, node) {
    if (geo.narrow) return;
    const token = ++glanceToken;
    const gw = Math.min(380, Math.max(260, geo.W * 0.3)), gh = gw * 1.294;
    const er = el.getBoundingClientRect(), pr = node.getBoundingClientRect();
    const gx = Math.max(20, Math.min(pr.left - er.left - gw * 0.7, geo.W - gw - 20));
    const gy = Math.max(48, Math.min(pr.top - er.top - gh * 0.3, geo.H - gh - 150));
    const c = document.createElement('canvas');
    await drawThumb(c, d, { dark: cb.dark(), scale: 1.9, now: cb.now() }).catch(() => {});
    if (token !== glanceToken) return;
    glanceEl.replaceChildren(c);
    glanceEl.style.width = gw + 'px'; glanceEl.style.height = gh + 'px';
    // FLIP: start exactly over the page, then grow into place
    glanceEl.style.transition = 'none';
    glanceEl.style.transform = `translate(${pr.left - er.left}px, ${pr.top - er.top}px) scale(${pr.width / gw})`;
    glanceEl.style.opacity = 0.6;
    glanceEl.hidden = false;
    glanceEl.getBoundingClientRect();
    glanceEl.style.transition = '';
    glanceEl.style.transform = `translate(${gx}px, ${gy}px) scale(1)`;
    glanceEl.style.opacity = 1;
  }
  function hideGlance() { glanceToken++; glanceEl.hidden = true; }

  // ---------- interaction ----------
  function move(delta) {
    const h = Math.max(0, Math.min(Math.max(0, list.length - 1), head + delta));
    if (h !== head) { head = h; hideGlance(); render(); }
  }
  let acc = 0;
  const onWheel = e => {
    e.preventDefault();
    acc += e.deltaY;
    while (Math.abs(acc) >= 40) { move(acc > 0 ? 1 : -1); acc -= Math.sign(acc) * 40; }   // down = older
  };
  const onOver = e => {
    const p = e.target.closest('.cl-page'), id = p?.dataset.id || null;
    if (id === hoverId) return;
    hoverId = id;
    stage.querySelectorAll('.cl-page.hover').forEach(n => n.classList.remove('hover'));
    if (!p) return hideGlance();
    p.classList.add('hover');
    const d = list.find(x => x.id === id);
    if (d) { showGlance(d, p); cb.onHover?.(d); }
  };
  const onClick = e => {
    const p = e.target.closest('.cl-page');
    const d = p && list.find(x => x.id === p.dataset.id);
    if (d) { selId = d.id; render(); cb.onOpen?.(d); }
  };
  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('mouseover', onOver);
  stage.addEventListener('mouseleave', () => { hoverId = null; hideGlance(); stage.querySelectorAll('.cl-page.hover').forEach(n => n.classList.remove('hover')); });
  stage.addEventListener('click', onClick);
  el.querySelectorAll('.cl-arrow').forEach(b => b.onclick = () => move(+b.dataset.d));
  const rail = el.querySelector('.cl-rail');
  const railTo = e => {
    if (!list.length) return;
    const r = rail.getBoundingClientRect(), f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const t = list.at(-1).created + f * (list[0].created - list.at(-1).created);
    let best = 0;
    list.forEach((d, i) => { if (Math.abs(d.created - t) < Math.abs(list[best].created - t)) best = i; });
    head = best; hideGlance(); render();
  };
  let railDrag = false;
  rail.addEventListener('pointerdown', e => { railDrag = true; rail.setPointerCapture(e.pointerId); railTo(e); });
  rail.addEventListener('pointermove', e => railDrag && railTo(e));
  rail.addEventListener('pointerup', () => { railDrag = false; });
  let touchY = null;
  stage.addEventListener('touchstart', e => { touchY = e.touches[0].clientY; }, { passive: true });
  stage.addEventListener('touchmove', e => {
    if (touchY === null) return;
    const dy = touchY - e.touches[0].clientY;
    if (Math.abs(dy) > 22) { move(dy > 0 ? 1 : -1); touchY = e.touches[0].clientY; }
  }, { passive: true });
  const onKey = e => {
    if (e.target.closest?.('input, textarea, select')) return;
    const d = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1, PageDown: SLICE / 2, PageUp: -SLICE / 2 }[e.key];
    if (e.key === '0') return home();
    if (e.key === 'Enter' && list[head]) return cb.onOpen?.(list[head]);
    if (d) { e.preventDefault(); move(d); }
  };
  window.addEventListener('keydown', onKey);
  const ro = new ResizeObserver(() => { layout(); render(); drawHistogram(); }); ro.observe(el);

  function home() { head = Math.max(0, list.indexOf(newestPast(list, cb.now()))); hideGlance(); render(); }

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

const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
// the original's terse style: "Wed 10/30/96"
const fmtShort = t => { const d = new Date(t); return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`; };
