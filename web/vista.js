// Vista: the 1997 diagonal, made legible. Each day is a row of documents standing on a
// tilted plane; today is in front, and every older day sits one step further back and to
// the right, so the past recedes along a diagonal into the distance. Documents face you
// (rendered thumbnails, readable), ordered through the day left to right. The camera glides
// along the diagonal as you scroll; the future waits in front of the Now line.
// Plain Canvas 2D with a real perspective camera (yaw + pitch), no WebGL.

import { drawThumb, TYPE_COLOR, TYPE_ICON } from './formats.js';

const CW = 1.0, CH = 1.25, GAPX = 0.16;            // card size and spacing in a row
const ROW = 2.7, SHEAR = 0.9, PER_ROW = 14;        // depth per day, rightward step per day, cards per sub-row
const SUB = 1.25, LEAN = 0.92;                     // extra depth for overflow sub-rows; how far cards lean back (radians)
const YAW = -0.3, PITCH = 0.56, CAM_BACK = 5.3, CAM_UP = 3.9;
const NEAR = 0.4, FAR = 70, AHEAD = 30;            // rows drawn ahead of the focus
const THUMB_CONCURRENCY = 5, MAX_THUMBS = 300;

export function createVista(el, cb) {
  const canvas = document.createElement('canvas');
  canvas.className = 'vista-cv';
  el.appendChild(canvas);
  const g = canvas.getContext('2d');
  const hud = document.createElement('div');
  hud.className = 'vista-hud';
  hud.innerHTML = `<div class="v-when"><div class="v-day"></div><div class="v-rel"></div></div>
    <div class="v-buttons"><button class="op small" data-act="future"></button><button class="op small" data-act="now">Now</button></div>
    <div class="v-help">scroll or <kbd>↑</kbd><kbd>↓</kbd> to move through days · <kbd>←</kbd><kbd>→</kbd> along a day · click to open</div>`;
  el.appendChild(hud);

  let W = 0, H = 0, dpr = 1, f = 1, cx = 0, cy = 0;
  let rows = [], cards = [], byId = new Map(), headK = 0, minK = 0, maxK = 0;
  let focus = 0, goal = 0, vel = 0, lane = 0, laneGoal = 0;
  let selId = null, hoverId = null, raf = 0, destroyed = false, drawn = [];
  const cam = { x: 0, y: 0, z: 0, sy: Math.sin(YAW), cyw: Math.cos(YAW), sp: Math.sin(PITCH), cp: Math.cos(PITCH) };
  const thumbs = new Map(), pending = new Map(), placeholders = new Map();
  let inflight = 0;
  const C = {};

  function theme() {
    const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    Object.assign(C, { bg: css('--bg') || '#f6f5f2', ink: css('--ink') || '#1d1c1a', muted: css('--muted') || '#77736b', accent: css('--accent') || '#c2410c', dark: cb.dark() });
    C.plane = C.dark ? '#1c1b18' : '#ece9e2';
    C.grid = C.dark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.06)';
    C.shadow = C.dark ? 'rgba(0,0,0,.55)' : 'rgba(40,30,20,.18)';
  }

  // ---------- layout: one row per day ----------
  function update(list, { sel, anim } = {}) {
    theme();
    const now = cb.now();
    const groups = new Map();
    for (const d of list) {                                   // list is newest first
      const key = dayKey(d.created) + (d.created > now ? 'f' : 'p');
      if (!groups.has(key)) groups.set(key, { t: d.created, future: d.created > now, docs: [] });
      groups.get(key).docs.push(d);
    }
    const past = [...groups.values()].filter(r => !r.future);             // newest day first
    const future = [...groups.values()].filter(r => r.future).reverse();  // soonest first
    rows = [];
    past.forEach((r, i) => rows.push({ ...r, k: i }));
    future.forEach((r, i) => rows.push({ ...r, k: -(i + 1) }));
    cards = []; byId = new Map();
    let lastMonth = monthLabel(now);
    for (const r of rows.sort((a, b) => a.k - b.k)) {
      r.docs.sort((a, b) => a.created - b.created);            // through the day, left → right
      r.z = r.k * ROW; r.x0 = r.k * SHEAR;
      r.subRows = Math.ceil(r.docs.length / PER_ROW);
      r.width = Math.min(r.docs.length, PER_ROW) * (CW + GAPX) - GAPX;
      if (!r.future) { const m = monthLabel(r.t); r.newMonth = m !== lastMonth; r.month = m; lastMonth = m; }
      r.docs.forEach((d, i) => {
        const sub = Math.floor(i / PER_ROW), col = i % PER_ROW;
        const c = { doc: d, row: r, col, x: r.x0 + col * (CW + GAPX) + sub * (CW + GAPX) / 2, z: r.z + sub * SUB };
        const prev = cardIndex.get(d.id);
        c.lift = prev?.lift ?? 0;
        c.pop = anim?.id === d.id ? 0 : prev?.pop ?? 1;
        cards.push(c); byId.set(d.id, c);
      });
    }
    cardIndex = byId;
    headK = 0; minK = Math.min(0, ...rows.map(r => r.k)); maxK = Math.max(0, ...rows.map(r => r.k));
    if (sel !== undefined) selId = sel;
    for (const id of [...thumbs.keys()]) if (!byId.has(id)) thumbs.delete(id);
    request();
  }
  let cardIndex = new Map();

  // ---------- camera & projection ----------
  function placeCamera() {
    // look at the focused row, from behind and above, along the diagonal
    const r = rowAt(focus);
    const lx = (r ? r.x0 : focus * SHEAR) + Math.min(lane, Math.max(0, (r?.width ?? 0) - CW)) + 1.2;
    const lz = focus * ROW;
    cam.x = lx - Math.sin(YAW) * CAM_BACK * Math.cos(PITCH) - 0.6;
    cam.z = lz - Math.cos(YAW) * CAM_BACK * Math.cos(PITCH);
    cam.y = CAM_UP;
  }
  function rowAt(k) {
    let best = null;
    for (const r of rows) if (!best || Math.abs(r.k - k) < Math.abs(best.k - k)) best = r;
    return best;
  }
  // world → camera space: translate, yaw around Y, pitch around X
  function toCam(x, y, z) {
    let dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
    const x1 = dx * cam.cyw - dz * cam.sy, z1 = dx * cam.sy + dz * cam.cyw;
    const y2 = dy * cam.cp + z1 * cam.sp, z2 = -dy * cam.sp + z1 * cam.cp;
    return [x1, y2, z2];
  }
  function project(x, y, z) {
    const [a, b, c] = toCam(x, y, z);
    if (c < NEAR) return null;
    return [cx + a * f / c, cy - b * f / c, c];
  }

  function resize() {
    const r = el.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    f = W < 600 ? W * 1.15 : Math.min(W * 0.85, H * 1.2);
    cx = W * 0.34; cy = H * 0.58;
    request();
  }

  // ---------- frame ----------
  function request() { if (!raf && !destroyed) raf = requestAnimationFrame(frame); }

  function frame() {
    raf = 0;
    let moving = false;
    if (Math.abs(vel) > 0.002) { goal += vel; vel *= 0.84; moving = true; } else vel = 0;
    goal = Math.max(minK, Math.min(maxK, goal));
    if (Math.abs(goal - focus) > 0.002) { focus += (goal - focus) * 0.15; moving = true; } else focus = goal;
    if (Math.abs(laneGoal - lane) > 0.002) { lane += (laneGoal - lane) * 0.18; moving = true; } else lane = laneGoal;
    placeCamera();

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawSky();
    drawPlane();
    const visibleRows = rows.filter(r => r.k > focus - 2.2 && r.k < focus + AHEAD);
    for (const r of [...visibleRows].sort((a, b) => b.k - a.k)) drawRowMarks(r);
    drawNowLine();

    // cards: painter's order, far → near
    drawn = [];
    const vis = cards.filter(c => c.row.k > focus - 2.2 && c.row.k < focus + AHEAD)
      .map(c => ({ c, p: project(c.x + CW / 2, CH / 2, c.z) })).filter(o => o.p)
      .sort((a, b) => b.p[2] - a.p[2]);
    for (const o of vis) { if (drawCard(o.c)) moving = true; }
    hudUpdate();
    scheduleThumbs(vis.map(o => o.c).reverse());
    cb.onView?.();
    if (moving || inflight) request();
  }

  function drawSky() {
    const gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, C.bg); gr.addColorStop(1, mix(C.bg, C.plane, 0.6));
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
  }

  // The plane: a grid you can read time against — lines along the diagonal and one per day.
  function drawPlane() {
    g.lineWidth = 1; g.strokeStyle = C.grid;
    const k0 = Math.floor(focus - 3), k1 = Math.ceil(focus + AHEAD);
    for (let s = -6; s <= 14; s++) {          // lines running back along the diagonal
      line3(k0 * SHEAR + s - 1, 0, k0 * ROW, k1 * SHEAR + s - 1, 0, k1 * ROW);
    }
    // horizon fade
    const hz = project(cam.x + Math.sin(YAW) * 400, 0, cam.z + Math.cos(YAW) * 400);
    if (hz) {
      const gr = g.createLinearGradient(0, hz[1] - 40, 0, hz[1] + 80);
      gr.addColorStop(0, mix(C.bg, C.plane, 0.2)); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(0, 0, W, hz[1] + 80);
    }
  }

  function drawRowMarks(r) {
    const fog = fogFor(r.k);
    g.globalAlpha = 1 - fog;
    // the day line under the row, from the left margin through the row
    const xa = r.x0 - 1.4, xb = r.x0 + r.width + 0.6, z = r.z - 0.35;
    g.strokeStyle = r.future ? '#0090ff' : r.newMonth ? C.accent : (C.dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.13)');
    g.lineWidth = r.newMonth ? 2.5 : 1.2;
    line3(xa, 0, z, xb, 0, z);
    // the date, lying on the plane at the start of the row
    const p0 = project(xa, 0, z), px = project(xa + 1, 0, z), pz = project(xa, 0, z + 1);
    if (p0 && px && pz) {
      const s = 1 / 100;
      g.save();
      g.setTransform(dpr * (px[0] - p0[0]) * s, dpr * (px[1] - p0[1]) * s, dpr * (p0[0] - pz[0]) * s, dpr * (p0[1] - pz[1]) * s, dpr * p0[0], dpr * p0[1]);
      g.fillStyle = r.future ? '#0090ff' : r.newMonth ? C.accent : C.muted;
      g.font = `700 ${r.newMonth ? 34 : 26}px ui-sans-serif, -apple-system, sans-serif`;
      g.textBaseline = 'bottom';
      g.fillText(r.newMonth ? `${r.month}` : dayLabel(r.t), 4, -8);
      if (r.newMonth) { g.font = '600 22px ui-sans-serif, -apple-system, sans-serif'; g.fillText(dayLabel(r.t), 4, -48); }
      g.restore();
    }
    g.globalAlpha = 1;
  }

  function drawNowLine() {
    const z = -ROW / 2 - 0.2;
    const a = project(-8, 0, z), b = project(14, 0, z);
    if (!a || !b) return;
    g.strokeStyle = C.accent; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    const tag = project(-1.6, 0, z);
    if (tag) {
      const fs = Math.max(10, Math.min(16, 70 / tag[2] * 2));
      g.font = `800 ${fs}px ui-sans-serif, -apple-system, sans-serif`;
      const w = g.measureText('NOW').width + fs;
      g.fillStyle = C.accent; g.beginPath(); g.roundRect(tag[0] - w / 2, tag[1] - fs * 0.8, w, fs * 1.6, fs * 0.8); g.fill();
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('NOW', tag[0], tag[1]); g.textAlign = 'left';
    }
  }

  // A card leaning back on the plane like a page on a drafting table, so it faces the
  // raised camera and doesn't hide the rows behind it. Texture-mapped as two triangles.
  function drawCard(c) {
    let animating = false;
    const want = c.doc.id === selId ? 0.28 : c.doc.id === hoverId ? 0.12 : 0;
    if (Math.abs(c.lift - want) > 0.002) { c.lift += (want - c.lift) * 0.25; animating = true; }
    if (c.pop < 1) { c.pop = Math.min(1, c.pop + 0.05); animating = true; }
    const ease = 1 - (1 - c.pop) ** 3;
    const lean = LEAN - c.lift * 0.9;                 // selected cards sit up a little
    const h = CH * ease, y0 = c.lift * 0.6;
    const zt = c.z + h * Math.sin(lean), yt = y0 + h * Math.cos(lean);
    const bl = project(c.x, y0, c.z), br = project(c.x + CW, y0, c.z);
    const tr = project(c.x + CW, yt, zt), tl = project(c.x, yt, zt);
    if (!bl || !br || !tr || !tl) return animating;
    const fog = fogFor(c.row.k);
    // shadow: the card's footprint on the plane, nudged back
    const s0 = project(c.x + 0.05, 0, c.z + 0.06), s1 = project(c.x + CW + 0.08, 0, c.z + 0.06), s2 = project(c.x + CW + 0.08, 0, zt + 0.12), s3 = project(c.x + 0.05, 0, zt + 0.12);
    if (s0 && s1 && s2 && s3) {
      g.globalAlpha = (1 - fog) * (0.55 + c.lift);
      g.fillStyle = C.shadow;
      g.beginPath(); [s0, s1, s2, s3].forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath(); g.fill();
      g.globalAlpha = 1;
    }
    const pxPerUnit = Math.hypot(br[0] - bl[0], br[1] - bl[1]) / CW;
    const src = thumbFor(c, pxPerUnit);
    const sw = src.width, sh = src.height;
    // image corners → screen corners (top-left, top-right, bottom-right, bottom-left)
    tri(src, 0, 0, sw, 0, 0, sh, tl, tr, bl);
    tri(src, sw, 0, sw, sh, 0, sh, tr, br, bl);
    const quad = [tl, tr, br, bl];
    if (fog > 0.01) { g.globalAlpha = fog; g.fillStyle = C.bg; poly(quad); g.fill(); g.globalAlpha = 1; }
    if (c.doc.id === selId || c.doc.id === hoverId) {
      g.strokeStyle = c.doc.id === selId ? C.accent : (C.dark ? 'rgba(255,255,255,.75)' : 'rgba(0,0,0,.5)');
      g.lineWidth = c.doc.id === selId ? 3 : 2;
      poly(quad); g.stroke();
    }
    drawn.push({ id: c.doc.id, q: quad.map(p => [p[0], p[1]]) });
    return animating;
  }

  // Draw the triangle (s0,s1,s2) of the image onto the screen triangle (d0,d1,d2) with an
  // affine transform, clipped to the triangle (slightly grown to hide the seam).
  function tri(img, sx0, sy0, sx1, sy1, sx2, sy2, d0, d1, d2) {
    const [x0, y0] = d0, [x1, y1] = d1, [x2, y2] = d2;
    const mx = (x0 + x1 + x2) / 3, my = (y0 + y1 + y2) / 3, grow = (x, m) => x + Math.sign(x - m) * 0.6;
    g.save();
    g.beginPath(); g.moveTo(grow(x0, mx), grow(y0, my)); g.lineTo(grow(x1, mx), grow(y1, my)); g.lineTo(grow(x2, mx), grow(y2, my)); g.closePath(); g.clip();
    const den = sx0 * (sy2 - sy1) - sx1 * sy2 + sx2 * sy1 + (sx1 - sx2) * sy0;
    if (Math.abs(den) < 1e-6) { g.restore(); return; }
    const a = -(sy0 * (x2 - x1) - sy1 * x2 + sy2 * x1 + (sy1 - sy2) * x0) / den;
    const b = (sy1 * y2 + sy0 * (y1 - y2) - sy2 * y1 + (sy2 - sy1) * y0) / den;
    const c = (sx0 * (x2 - x1) - sx1 * x2 + sx2 * x1 + (sx1 - sx2) * x0) / den;
    const d = -(sx1 * y2 + sx0 * (y1 - y2) - sx2 * y1 + (sx2 - sx1) * y0) / den;
    const e = (sx0 * (sy2 * x1 - sy1 * x2) + sy0 * (sx1 * x2 - sx2 * x1) + (sx2 * sy1 - sx1 * sy2) * x0) / den;
    const ff = (sx0 * (sy2 * y1 - sy1 * y2) + sy0 * (sx1 * y2 - sx2 * y1) + (sx2 * sy1 - sx1 * sy2) * y0) / den;
    g.transform(a, b, c, d, e, ff);
    g.drawImage(img, 0, 0);
    g.restore();
  }
  function poly(q) { g.beginPath(); q.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath(); }

  // fog grows with distance from the focused row; the focused row is crisp
  const fogFor = k => k < focus - 0.5 ? Math.min(0.88, (focus - k) * 0.75)       // rows in front of you (newer) fade away
    : Math.max(0, Math.min(0.9, (k - focus - 2.5) / 22));

  function line3(x1, y1, z1, x2, y2, z2) {
    // clip against the near plane in camera space, then draw
    let a = toCam(x1, y1, z1), b = toCam(x2, y2, z2);
    if (a[2] < NEAR && b[2] < NEAR) return;
    if (a[2] < NEAR || b[2] < NEAR) {
      const t = (NEAR - a[2]) / (b[2] - a[2]);
      const m = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR];
      if (a[2] < NEAR) a = m; else b = m;
    }
    g.beginPath();
    g.moveTo(cx + a[0] * f / a[2], cy - a[1] * f / a[2]);
    g.lineTo(cx + b[0] * f / b[2], cy - b[1] * f / b[2]);
    g.stroke();
  }

  // ---------- thumbnails ----------
  function thumbFor(c, pxPerUnit) {
    const t = thumbs.get(c.doc.id);
    const want = pxPerUnit * CW > 300 ? 1.8 : pxPerUnit * CW > 110 ? 1 : 0.5;
    if (!t || t.scale < want) { if (!pending.has(c.doc.id) || pending.get(c.doc.id) < want) pending.set(c.doc.id, want); }
    if (t) { t.used = performance.now(); return t.c; }
    return placeholder(c.doc);
  }
  function placeholder(d) {
    const key = d.type + (C.dark ? 'd' : 'l');
    if (placeholders.has(key)) return placeholders.get(key);
    const c = document.createElement('canvas'); c.width = 160; c.height = 200;
    const p = c.getContext('2d');
    p.fillStyle = C.dark ? '#26251f' : '#ffffff'; p.beginPath(); p.roundRect(0, 0, 160, 200, 10); p.fill();
    p.fillStyle = TYPE_COLOR[d.type] || '#888'; p.fillRect(0, 0, 160, 5);
    p.font = '40px ui-sans-serif'; p.textAlign = 'center'; p.globalAlpha = 0.45; p.fillText(TYPE_ICON[d.type] || '•', 80, 115);
    placeholders.set(key, c);
    return c;
  }
  let order = new Map();
  function scheduleThumbs(nearFirst) {
    order = new Map(nearFirst.map((c, i) => [c.doc.id, i]));
    for (const id of [...pending.keys()]) if (!order.has(id)) pending.delete(id);
    pump();
  }
  // Start renders up to the concurrency limit; each finished render starts the next one
  // directly, so loading doesn't wait on animation frames (throttled in background tabs).
  function pump() {
    while (inflight < THUMB_CONCURRENCY && pending.size) {
      const [id, scale] = [...pending.entries()].sort((a, b) => order.get(a[0]) - order.get(b[0]))[0];
      pending.delete(id);
      const c = byId.get(id);
      if (!c) continue;
      inflight++;
      const canvas = document.createElement('canvas');
      drawThumb(canvas, c.doc, { dark: C.dark, scale, now: cb.now() })
        .then(() => {
          if (destroyed) return;
          const prev = thumbs.get(id);
          if (!prev || prev.scale < scale) thumbs.set(id, { c: canvas, scale, used: performance.now() });
          if (thumbs.size > MAX_THUMBS) for (const [k] of [...thumbs.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, thumbs.size - MAX_THUMBS)) thumbs.delete(k);
        })
        .catch(() => {})
        .finally(() => { inflight--; pump(); request(); });
    }
  }

  // ---------- HUD ----------
  function hudUpdate() {
    const r = rowAt(Math.round(focus));
    hud.querySelector('.v-day').textContent = r ? fullDate(r.t) : '';
    hud.querySelector('.v-rel').textContent = r ? `${rel(r.t, cb.now())} · ${r.docs.length} document${r.docs.length === 1 ? '' : 's'}` : '';
    const fb = hud.querySelector('[data-act="future"]');
    const inFuture = focus < -0.5, n = rows.filter(x => x.future).length;
    fb.textContent = inFuture ? '▼ Back to the past' : `▲ ${n} upcoming day${n === 1 ? '' : 's'}`;
    fb.hidden = !n && !inFuture;
  }
  hud.querySelector('.v-buttons').onclick = e => {
    const a = e.target.dataset.act;
    if (a === 'now') home();
    if (a === 'future') { goal = focus < -0.5 ? 0 : minK; vel = 0; laneGoal = 0; request(); }
  };

  // ---------- interaction ----------
  function hit(e) {
    const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    for (let i = drawn.length - 1; i >= 0; i--) if (inQuad(px, py, drawn[i].q)) return drawn[i].id;
    return null;
  }
  const onWheel = e => {
    e.preventDefault();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { laneGoal = Math.max(0, laneGoal + e.deltaX * 0.01); request(); return; }
    vel += e.deltaY * 0.0016; request();
  };
  let drag = null;
  const onDown = e => { if (e.target.closest('.vista-hud button')) return; drag = { x: e.clientX, y: e.clientY, g: goal, l: laneGoal, moved: false }; el.setPointerCapture(e.pointerId); };
  const onMove = e => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
      if (drag.moved) { goal = drag.g - dy * 0.012; laneGoal = Math.max(0, drag.l - dx * 0.012); vel = 0; request(); }
      return;
    }
    const id = hit(e);
    if (id !== hoverId) { hoverId = id; el.style.cursor = id ? 'pointer' : 'grab'; if (id) cb.onHover?.(byId.get(id).doc); request(); }
  };
  const onUp = e => {
    const d = drag; drag = null;
    if (d && !d.moved) { const id = hit(e); if (id) { reveal(id); cb.onOpen?.(byId.get(id).doc); } }
  };
  const onKey = e => {
    if (e.target.closest?.('input, textarea, select')) return;
    const step = { ArrowUp: [-1, 0], k: [-1, 0], ArrowDown: [1, 0], j: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageUp: [-7, 0], PageDown: [7, 0] }[e.key];
    if (e.key === '0') return home();
    if (!step) return;
    e.preventDefault();
    // ↑ is toward now (newer), ↓ is further into the past
    goal = Math.round(goal) + step[0]; vel = 0;
    if (step[1]) laneGoal = Math.max(0, Math.round(laneGoal / (CW + GAPX)) * (CW + GAPX) + step[1] * (CW + GAPX));
    if (step[0]) laneGoal = 0;
    request();
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

  function home() { goal = headK; vel = 0; laneGoal = 0; request(); }
  function reveal(id) {
    const c = byId.get(id);
    if (!c) return;
    goal = c.row.k; vel = 0; laneGoal = Math.max(0, c.x - c.row.x0 - CW * 1.2); selId = id; request();
  }

  theme(); resize();
  return {
    update, home, reveal,
    select: id => { selId = id; request(); },
    scrubTo: t => {
      let best = null;
      for (const r of rows) if (!best || Math.abs(r.t - t) < Math.abs(best.t - t)) best = r;
      if (best) { goal = best.k; vel = 0; laneGoal = 0; request(); }
    },
    visibleTimes: () => rows.filter(r => r.k >= Math.round(focus) - 0.5 && r.k < focus + 6).flatMap(r => r.docs.map(d => d.created)),
    destroy() {
      destroyed = true; cancelAnimationFrame(raf); ro.disconnect();
      window.removeEventListener('keydown', onKey); mq.removeEventListener('change', onTheme);
      thumbs.clear(); el.innerHTML = '';
    },
  };
}

function inQuad(x, y, q) {
  let sign = 0;
  for (let i = 0; i < q.length; i++) {
    const [ax, ay] = q[i], [bx, by] = q[(i + 1) % q.length];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c !== 0) { if (sign && Math.sign(c) !== sign) return false; sign = Math.sign(c); }
  }
  return true;
}
function mix(a, b, t) {
  const p = h => { h = h.replace('#', ''); if (h.length === 3) h = h.replace(/./g, c => c + c); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
  try { const [A, B] = [p(a), p(b)]; if (A.some(isNaN) || B.some(isNaN)) return a; return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join(''); }
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
