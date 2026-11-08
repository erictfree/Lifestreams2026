// Hall: a pseudo-3D gallery corridor through time, drawn with nothing but Canvas 2D.
// You stand at Now looking down the hall into the past; documents hang on the left and
// right walls as fully rendered thumbnails, the floor is marked with days and months,
// and the future waits behind you past the NOW gate. Walls are texture-mapped the old
// way — each card is projected as a run of thin vertical strips, each scaled for its depth —
// with distance fog and a glossy floor reflection.

import { drawThumb, TYPE_COLOR, TYPE_ICON } from './formats.js';

const WALL = 1.65, FLOOR = -0.95, CEIL = 1.45;     // corridor half-width, floor and ceiling height
const CARD_Z = 1.0, CARD_H = 1.25, CARD_Y = 0.12;   // card length along the wall, height, center
const SLOT = 1.45, DAY_GAP = 0.7, NOW_Z = 0;        // spacing along the hall
const NEAR = 0.25, FAR = 48, STRIPS = 22;
const THUMB_CONCURRENCY = 3, MAX_THUMBS = 260;
const HOME = 0.15;                                  // standing just inside the NOW gate, facing the past

export function createHall(el, cb) {
  const canvas = document.createElement('canvas');
  canvas.className = 'hall-cv';
  el.appendChild(canvas);
  const g = canvas.getContext('2d');
  const hud = document.createElement('div');
  hud.className = 'hall-hud';
  hud.innerHTML = `<div class="h-when"><div class="h-day"></div><div class="h-rel"></div></div>
    <div class="h-buttons"><button class="op small" data-act="future"></button><button class="op small" data-act="now">Now</button></div>
    <div class="h-help">scroll, drag or <kbd>↑</kbd><kbd>↓</kbd> to walk through time · click a document to open it</div>`;
  el.appendChild(hud);

  let W = 0, H = 0, dpr = 1, f = 1, cx = 0, hy = 0;
  let items = [], byId = new Map(), days = [], futureCount = 0, minZ = 0, maxZ = 10;
  let zc = HOME, goal = HOME, vel = 0, selId = null, hoverId = null, raf = 0, destroyed = false;
  let quads = [];                                    // hit-testing: what was drawn where, near-last
  const thumbs = new Map();                          // id -> { c, scale, used }
  const pending = new Set(); let inflight = 0;
  const placeholders = new Map();
  const C = {};

  function theme() {
    const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    Object.assign(C, { bg: css('--bg') || '#f6f5f2', ink: css('--ink') || '#1d1c1a', muted: css('--muted') || '#77736b', accent: css('--accent') || '#c2410c', dark: cb.dark() });
    C.wall = C.dark ? '#22211e' : '#ebe8e1';
    C.floor = C.dark ? '#191816' : '#dcd8cf';
    C.ceil = C.dark ? '#121110' : '#f3f1ec';
    C.fog = C.bg;
  }

  // ---------- layout: time → depth ----------
  function update(list, { sel, anim } = {}) {
    theme();
    const now = cb.now();
    const past = list.filter(d => d.created <= now);                 // newest first
    const future = list.filter(d => d.created > now).reverse();      // soonest first
    futureCount = future.length;
    items = []; days = [];
    const place = (docs, dir) => {
      let z = dir > 0 ? NOW_Z + 1.4 : NOW_Z - 1.4, side = 0, lastDay = null, slotUsed = 0;
      for (const d of docs) {
        const key = dayKey(d.created);
        if (key !== lastDay) {
          if (lastDay !== null) z += dir * (slotUsed ? SLOT : 0) + dir * DAY_GAP;
          days.push({ z: z - dir * CARD_Z * 0.45, t: d.created, label: dayLabel(d.created), month: monthLabel(d.created), future: dir < 0 });
          lastDay = key; side = 0; slotUsed = 0;
        } else if (side === 0) { z += dir * SLOT; slotUsed = 0; }
        items.push({ doc: d, side: side ? 1 : -1, z: dir > 0 ? z : z - CARD_Z });
        slotUsed = 1; side ^= 1;
      }
      return z;
    };
    maxZ = place(past, 1) + 2;
    minZ = place(future, -1) - 2;
    byId = new Map(items.map(it => [it.doc.id, it]));
    // months: mark the first day of each month (going back in time)
    let lastMonth = monthLabel(now);
    for (const day of days.filter(x => !x.future)) { day.newMonth = day.month !== lastMonth; lastMonth = day.month; }
    if (sel !== undefined) selId = sel;
    if (anim?.id && byId.has(anim.id)) { const it = byId.get(anim.id); it.pop = 0; }
    for (const id of [...thumbs.keys()]) if (!byId.has(id)) thumbs.delete(id);
    request();
  }

  // ---------- projection ----------
  const depth = z => z - zc;
  const sx = (x, d) => cx + (x * f) / d;
  const sy = (y, d) => hy - (y * f) / d;

  function resize() {
    const r = el.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    f = W < 600 ? W * 0.95 : Math.min(W * 0.62, H * 0.95);   // narrow screens: a longer lens so cards stay readable
    cx = W / 2; hy = H * 0.46;
    request();
  }

  // ---------- frame ----------
  function request() { if (!raf && !destroyed) raf = requestAnimationFrame(frame); }

  function frame() {
    raf = 0;
    // motion: inertia from the wheel, easing toward a goal for jumps
    let moving = false;
    if (Math.abs(vel) > 0.002) { goal += vel; vel *= 0.86; moving = true; } else vel = 0;
    goal = Math.max(minZ - 1, Math.min(maxZ - 3, goal));
    const dz = goal - zc;
    if (Math.abs(dz) > 0.002) { zc += dz * 0.16; moving = true; } else zc = goal;

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawRoom();
    quads = [];

    const visible = items.filter(it => { const d = depth(it.z); return d + CARD_Z > NEAR && d < FAR; })
      .sort((a, b) => depth(b.z) - depth(a.z));         // painter's order: far → near
    const markers = days.filter(m => { const d = depth(m.z); return d > NEAR && d < FAR; });
    // floor markings first (they sit under everything), then the gate and cards by depth
    for (const m of markers) drawDayMarker(m);
    let gateDrawn = false;
    for (const it of visible) {
      if (!gateDrawn && depth(it.z) < depth(NOW_Z)) { drawGate(); gateDrawn = true; }
      drawCard(it);
      if (it.pop !== undefined && it.pop < 1) { it.pop = Math.min(1, it.pop + 0.06); moving = true; }
    }
    if (!gateDrawn) drawGate();
    vignette();
    hudUpdate();
    scheduleThumbs(visible);
    cb.onView?.();
    if (moving || inflight) request();
  }

  function drawRoom() {
    // ceiling, floor and the far wall as gradients toward the vanishing point
    const vp = hy;
    let gr = g.createLinearGradient(0, 0, 0, vp);
    gr.addColorStop(0, C.ceil); gr.addColorStop(1, mix(C.ceil, C.fog, 0.85));
    g.fillStyle = gr; g.fillRect(0, 0, W, vp);
    gr = g.createLinearGradient(0, vp, 0, H);
    gr.addColorStop(0, mix(C.floor, C.fog, 0.9)); gr.addColorStop(1, C.floor);
    g.fillStyle = gr; g.fillRect(0, vp, W, H - vp);
    // side walls: trapezoids from the near plane to FAR
    for (const s of [-1, 1]) {
      const n = NEAR + 0.05, fz = FAR;
      const x1 = sx(s * WALL, n), x2 = sx(s * WALL, fz);
      const wg = g.createLinearGradient(x1, 0, x2, 0);
      wg.addColorStop(0, C.wall); wg.addColorStop(1, mix(C.wall, C.fog, 0.9));
      g.fillStyle = wg;
      g.beginPath();
      g.moveTo(x1, sy(CEIL, n)); g.lineTo(x2, sy(CEIL, fz)); g.lineTo(x2, sy(FLOOR, fz)); g.lineTo(x1, sy(FLOOR, n));
      g.closePath(); g.fill();
      // baseboard and picture rail
      for (const y of [FLOOR + 0.05, CARD_Y + CARD_H / 2 + 0.16]) {
        g.strokeStyle = C.dark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.07)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(x1, sy(y, n)); g.lineTo(x2, sy(y, fz)); g.stroke();
      }
    }
    // floor boards converging to the vanishing point
    g.strokeStyle = C.dark ? 'rgba(255,255,255,.035)' : 'rgba(0,0,0,.05)';
    for (let x = -WALL + 0.35; x < WALL; x += 0.35) {
      g.beginPath(); g.moveTo(sx(x, NEAR + 0.05), sy(FLOOR, NEAR + 0.05)); g.lineTo(sx(x, FAR), sy(FLOOR, FAR)); g.stroke();
    }
    // ceiling light strip
    const lg = g.createLinearGradient(0, sy(CEIL, NEAR + 0.05), 0, sy(CEIL, FAR));
    lg.addColorStop(0, C.dark ? 'rgba(255,240,220,.10)' : 'rgba(255,255,255,.9)'); lg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = lg;
    g.beginPath();
    g.moveTo(sx(-0.35, NEAR + 0.05), sy(CEIL, NEAR + 0.05)); g.lineTo(sx(0.35, NEAR + 0.05), sy(CEIL, NEAR + 0.05));
    g.lineTo(sx(0.35, FAR), sy(CEIL, FAR)); g.lineTo(sx(-0.35, FAR), sy(CEIL, FAR)); g.closePath(); g.fill();
  }

  function drawDayMarker(m) {
    const d = depth(m.z);
    const y = sy(FLOOR, d), xl = sx(-WALL, d), xr = sx(WALL, d);
    const fog = fogAt(d);
    g.globalAlpha = 1 - fog;
    g.strokeStyle = m.future ? '#0090ff' : m.newMonth ? C.accent : (C.dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.16)');
    g.lineWidth = Math.max(0.5, (m.newMonth ? 6 : 2.5) / d);
    g.beginPath(); g.moveTo(xl, y); g.lineTo(xr, y); g.stroke();
    // the date painted on the floor, squashed by perspective
    const scale = Math.min(f / d / 100, 1.1);
    if (scale > 0.06) {
      g.globalAlpha = (1 - fog) * Math.min(1, (d - 0.6) / 1.6);
      g.save();
      g.translate(cx, y + 2);
      g.scale(scale, scale * 0.42);
      g.fillStyle = m.future ? '#0090ff' : m.newMonth ? C.accent : C.muted;
      g.textAlign = 'center'; g.textBaseline = 'top';
      g.font = `700 ${m.newMonth ? 44 : 30}px ui-sans-serif, -apple-system, sans-serif`;
      g.fillText(m.newMonth ? m.month : m.label, 0, 6);
      if (m.newMonth) { g.font = '600 26px ui-sans-serif, -apple-system, sans-serif'; g.fillText(m.label, 0, 60); }
      g.restore();
    }
    g.globalAlpha = 1;
  }

  function drawGate() {
    const d = depth(NOW_Z);
    if (d < NEAR || d > FAR) return;
    const xl = sx(-WALL, d), xr = sx(WALL, d), yt = sy(CEIL, d), yb = sy(FLOOR, d);
    g.globalAlpha = 1 - fogAt(d) * 0.8;
    g.strokeStyle = C.accent; g.lineWidth = Math.max(1.5, 16 / d);
    g.strokeRect(xl, yt, xr - xl, yb - yt);
    g.fillStyle = C.accent;
    g.fillRect(xl, yt, xr - xl, Math.max(2, 4 / d));
    const fs = Math.max(8, 40 / d);
    g.font = `800 ${fs}px ui-sans-serif, -apple-system, sans-serif`;
    const label = 'NOW', tw = g.measureText(label).width;
    g.beginPath(); g.roundRect(cx - tw / 2 - fs * 0.6, yt + fs * 0.4, tw + fs * 1.2, fs * 1.5, fs * 0.75); g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, cx, yt + fs * 1.15);
    // a faint glow across the gate
    const gl = g.createLinearGradient(0, yt, 0, yb);
    gl.addColorStop(0, 'rgba(194,65,12,0)'); gl.addColorStop(1, 'rgba(194,65,12,.08)');
    g.fillStyle = gl; g.fillRect(xl, yt, xr - xl, yb - yt);
    g.globalAlpha = 1;
  }

  // A card on a side wall, texture-mapped strip by strip.
  function drawCard(it) {
    const src = thumbFor(it);
    const z0 = it.z, s = it.side, x = s * (WALL - 0.02);
    const pop = it.pop ?? 1, ease = 1 - (1 - pop) ** 3;
    const h = CARD_H * (0.6 + 0.4 * ease), yc = CARD_Y + (1 - ease) * 0.6;
    const top = yc + h / 2, bot = yc - h / 2;
    const sw = src.width / STRIPS;
    const corners = [];
    let any = false;
    for (let i = 0; i < STRIPS; i++) {
      // turn to face the wall: on the right wall the card's left edge is the far end,
      // on the left wall it's the near end
      const za = z0 + (s > 0 ? (STRIPS - i - 1) : i) * CARD_Z / STRIPS;
      const zb = za + CARD_Z / STRIPS;
      const da = depth(za), db = depth(zb);
      if (Math.min(da, db) < NEAR) continue;
      const dm = (da + db) / 2;
      const xa = sx(x, da), xb = sx(x, db);
      const left = Math.min(xa, xb), w = Math.abs(xb - xa) + 0.6;
      const yt = sy(top, dm), yb = sy(bot, dm);
      g.drawImage(src, i * sw, 0, sw, src.height, left, yt, w, yb - yt);
      // glossy floor reflection, close cards only
      if (dm < 14) {
        const ry = sy(FLOOR, dm), rh = (yb - yt) * 0.55;
        g.globalAlpha = (C.dark ? 0.10 : 0.13) * (1 - dm / 14);
        g.save(); g.translate(0, ry + (ry - yb)); g.scale(1, -1);
        g.drawImage(src, i * sw, src.height * 0.45, sw, src.height * 0.55, left, -rh, w, rh);
        g.restore();
        g.globalAlpha = 1;
      }
      const fog = fogAt(dm);
      if (fog > 0.01) { g.globalAlpha = fog; g.fillStyle = C.fog; g.fillRect(left, yt - 1, w, yb - yt + 2); g.globalAlpha = 1; }
      any = true;
    }
    if (!any) return;
    // quad corners for hit testing and highlight (near end, far end)
    const dn = Math.max(NEAR, depth(z0)), dfar = depth(z0 + CARD_Z);
    const xn = sx(x, dn), xf = sx(x, dfar);
    const q = [[xn, sy(top, dn)], [xf, sy(top, dfar)], [xf, sy(bot, dfar)], [xn, sy(bot, dn)]];
    corners.push(...q);
    quads.push({ id: it.doc.id, q, d: dn });
    if (it.doc.id === selId || it.doc.id === hoverId) {
      g.strokeStyle = it.doc.id === selId ? C.accent : (C.dark ? 'rgba(255,255,255,.7)' : 'rgba(0,0,0,.45)');
      g.lineWidth = it.doc.id === selId ? 3 : 2;
      g.beginPath(); q.forEach(([a, b], k) => k ? g.lineTo(a, b) : g.moveTo(a, b)); g.closePath(); g.stroke();
    }
  }

  function vignette() {
    const r = g.createRadialGradient(cx, hy, Math.min(W, H) * 0.3, cx, hy, Math.max(W, H) * 0.75);
    r.addColorStop(0, 'rgba(0,0,0,0)'); r.addColorStop(1, C.dark ? 'rgba(0,0,0,.45)' : 'rgba(60,40,20,.12)');
    g.fillStyle = r; g.fillRect(0, 0, W, H);
  }

  const fogAt = d => Math.max(0, Math.min(0.92, (d - 7) / (FAR - 10)));

  // ---------- thumbnails: rendered documents, sharper when near ----------
  function thumbFor(it) {
    const t = thumbs.get(it.doc.id);
    if (t) { t.used = performance.now(); return t.c; }
    return placeholder(it.doc);
  }
  function placeholder(d) {
    const key = d.type + (C.dark ? 'd' : 'l');
    if (placeholders.has(key)) return placeholders.get(key);
    const c = document.createElement('canvas'); c.width = 160; c.height = 200;
    const p = c.getContext('2d');
    p.fillStyle = C.dark ? '#26251f' : '#ffffff'; p.beginPath(); p.roundRect(0, 0, 160, 200, 10); p.fill();
    p.fillStyle = TYPE_COLOR[d.type] || '#888'; p.fillRect(0, 0, 160, 5);
    p.font = '40px ui-sans-serif'; p.textAlign = 'center'; p.globalAlpha = 0.5; p.fillText(TYPE_ICON[d.type] || '•', 80, 115);
    placeholders.set(key, c);
    return c;
  }
  function scheduleThumbs(visible) {
    const want = visible.slice().reverse();          // nearest first
    for (const it of want) {
      const d = depth(it.z), scale = d < 4 ? 1.6 : d < 14 ? 0.9 : 0.5;
      const t = thumbs.get(it.doc.id);
      if ((!t || t.scale < scale) && !pending.has(it.doc.id)) { it.wantScale = scale; pending.add(it.doc.id); }
    }
    while (inflight < THUMB_CONCURRENCY && pending.size) {
      // nearest pending first
      const id = [...pending].sort((a, b) => depth(byId.get(a)?.z ?? 1e9) - depth(byId.get(b)?.z ?? 1e9))[0];
      pending.delete(id);
      const it = byId.get(id);
      if (!it) continue;
      inflight++;
      const c = document.createElement('canvas');
      drawThumb(c, it.doc, { dark: C.dark, scale: it.wantScale || 0.9, now: cb.now() })
        .then(() => {
          if (destroyed) return;
          const prev = thumbs.get(id);
          if (!prev || prev.scale < (it.wantScale || 0.9)) thumbs.set(id, { c, scale: it.wantScale || 0.9, used: performance.now() });
          if (thumbs.size > MAX_THUMBS) {
            const old = [...thumbs.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, thumbs.size - MAX_THUMBS);
            for (const [k] of old) thumbs.delete(k);
          }
        })
        .catch(() => {})
        .finally(() => { inflight--; request(); });
    }
  }

  // ---------- HUD ----------
  function hudUpdate() {
    // "where you are": the day of the nearest document still in front of you
    let here = null;
    for (const it of items) { const d = depth(it.z + CARD_Z); if (d > 0.4 && (!here || d < depth(here.z + CARD_Z))) here = it; }
    const t = here?.doc.created;
    const behindGate = zc < NOW_Z - 0.3;
    hud.querySelector('.h-day').textContent = t ? fullDate(t) : '';
    hud.querySelector('.h-rel').textContent = t ? rel(t, cb.now()) + (behindGate ? ' · walking toward now' : '') : '';
    const fb = hud.querySelector('[data-act="future"]');
    fb.textContent = behindGate ? '▼ Into the past' : `▲ ${futureCount} upcoming`;
    fb.hidden = !futureCount && !behindGate;
  }
  hud.querySelector('.h-buttons').onclick = e => {
    const a = e.target.dataset.act;
    if (a === 'now') home();
    if (a === 'future') { goal = zc < NOW_Z - 0.3 ? HOME : Math.max(minZ + 1, NOW_Z - 1.4 - Math.min(futureCount, 8) * SLOT / 2 - 3); vel = 0; request(); }
  };

  // ---------- interaction ----------
  function hit(e) {
    const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    for (let i = quads.length - 1; i >= 0; i--) if (inQuad(px, py, quads[i].q)) return quads[i].id;
    return null;
  }
  const onWheel = e => { e.preventDefault(); vel += (e.deltaY + e.deltaX) * 0.0022; request(); };
  let drag = null;
  const onDown = e => { if (e.target.closest('.hall-hud button')) return; drag = { y: e.clientY, x: e.clientX, g: goal, moved: false }; el.setPointerCapture(e.pointerId); };
  const onMove = e => {
    if (drag) {
      const dy = e.clientY - drag.y;
      if (Math.abs(dy) + Math.abs(e.clientX - drag.x) > 5) drag.moved = true;
      if (drag.moved) { goal = drag.g - dy * 0.03; vel = 0; request(); }
      return;
    }
    const id = hit(e);
    if (id !== hoverId) {
      hoverId = id; el.style.cursor = id ? 'pointer' : 'ns-resize';
      if (id) cb.onHover?.(byId.get(id).doc);
      request();
    }
  };
  const onUp = e => {
    const d = drag; drag = null;
    if (d && !d.moved) {
      const id = hit(e);
      if (id) { reveal(id); selId = id; cb.onOpen?.(byId.get(id).doc); }
    }
  };
  const onKey = e => {
    if (e.target.closest?.('input, textarea, select')) return;
    if (e.key === 'ArrowUp' || e.key === 'w') { goal += SLOT; e.preventDefault(); request(); }
    if (e.key === 'ArrowDown' || e.key === 's') { goal -= SLOT; e.preventDefault(); request(); }
    if (e.key === 'PageUp') { goal += SLOT * 8; request(); }
    if (e.key === 'PageDown') { goal -= SLOT * 8; request(); }
    if (e.key === '0') home();
  };
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointerleave', () => { if (hoverId) { hoverId = null; request(); } });
  window.addEventListener('keydown', onKey);
  const ro = new ResizeObserver(resize); ro.observe(el);
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const onTheme = () => { theme(); thumbs.clear(); placeholders.clear(); request(); };
  mq.addEventListener('change', onTheme);

  function home() { goal = HOME; vel = 0; request(); }
  function reveal(id) { const it = byId.get(id); if (it) { goal = it.z - 1.9; vel = 0; selId = id; request(); } }

  theme(); resize();
  return {
    update, home, reveal,
    select: id => { selId = id; request(); },
    scrubTo: t => {
      let best = null;
      for (const it of items) if (!best || Math.abs(it.doc.created - t) < Math.abs(best.doc.created - t)) best = it;
      if (best) { goal = best.z - 2; vel = 0; request(); }
    },
    visibleTimes: () => items.filter(it => { const d = depth(it.z); return d > 0.5 && d < 14; }).map(it => it.doc.created),
    destroy() {
      destroyed = true; cancelAnimationFrame(raf); ro.disconnect();
      window.removeEventListener('keydown', onKey); mq.removeEventListener('change', onTheme);
      thumbs.clear(); el.innerHTML = '';
    },
  };
}

// ---------- helpers ----------
function inQuad(x, y, q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c !== 0) { if (sign && Math.sign(c) !== sign) return false; sign = Math.sign(c); }
  }
  return true;
}
function mix(a, b, t) {
  const p = h => { h = h.replace('#', ''); if (h.length === 3) h = h.replace(/./g, c => c + c); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
  try { const [A, B] = [p(a), p(b)]; return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join(''); }
  catch { return a; }
}
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const dayLabel = t => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const monthLabel = t => new Date(t).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const fullDate = t => new Date(t).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
function rel(t, now) {
  const days = Math.round((new Date(t).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 864e5);
  if (days === 0) return 'today';
  if (days === -1) return 'yesterday';
  if (days === 1) return 'tomorrow';
  const a = Math.abs(days), s = a < 60 ? `${a} days` : a < 730 ? `${Math.round(a / 30)} months` : `${Math.round(a / 365)} years`;
  return days < 0 ? `${s} ago` : `in ${s}`;
}
