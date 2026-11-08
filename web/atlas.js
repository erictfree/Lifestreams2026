// Atlas: the whole stream on the GPU. Every document is a card on a wall laid out by time —
// one column per day, past on the left, future on the right of the Now line. Zoomed out it
// is a map of colored tiles (one color per format); zoom in and the tiles resolve into the
// documents themselves (PDF pages, photos, waveforms, spreadsheets, invites, mail, code),
// rendered on demand and uploaded as textures, sharper the closer you get.

import * as THREE from '/vendor/three/three.module.js';
import { drawThumb, TYPE_COLOR, TYPE_ICON } from './formats.js';

const CW = 1, CH = 1.25, GAP = 0.14, COLW = 1.32, NOW_GAP = 0.9;
const FOV = 40, TAN = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
const MAX_TEX = 420, CONCURRENCY = 3;

export function createAtlas(el, cb) {
  // ---------- renderer ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.className = 'atlas-gl';
  el.appendChild(renderer.domElement);
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).replace(/^ANGLE \((.*)\)$/, '$1').replace(/ANGLE \w+ Renderer: /, '').replace(/^[^,]+, (.+)$/, '$1').replace(/, Unspecified Version| \(0x[0-9A-F]+\)|Direct3D11 vs_5_0 ps_5_0, D3D11/g, '').slice(0, 60);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 600);
  const cam = { x: 0, y: -2, z: 10 }, goal = { ...cam };

  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const bg = new THREE.Color(css('--bg') || '#f6f5f2');
  scene.background = bg;

  // shared resources
  const geo = new THREE.PlaneGeometry(CW, CH);
  const roundTex = canvasTex(roundedMask(128, 160, 18, '#fff'));
  const shadowTex = canvasTex(shadowCanvas());
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, opacity: cb.dark() ? 0.55 : 0.28, depthWrite: false });
  const typeMats = new Map();
  const typeMat = t => typeMats.get(t) || typeMats.set(t, new THREE.MeshBasicMaterial({ map: roundTex, color: new THREE.Color(TYPE_COLOR[t] || '#888').convertSRGBToLinear(), transparent: true })).get(t);
  const selMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(css('--accent') || '#c2410c'), map: roundTex, transparent: true });

  // background: a faint dot grid
  const grid = new THREE.Mesh(new THREE.PlaneGeometry(4000, 400), new THREE.MeshBasicMaterial({ map: dotTex(cb.dark()), transparent: true, depthWrite: false }));
  grid.material.map.wrapS = grid.material.map.wrapT = THREE.RepeatWrapping;
  grid.material.map.repeat.set(4000 / 2, 400 / 2);
  grid.position.z = -0.05;
  scene.add(grid);

  const world = new THREE.Group(); scene.add(world);
  const labels = new THREE.Group(); scene.add(labels);
  const nowBar = new THREE.Mesh(new THREE.PlaneGeometry(0.035, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color(css('--accent') || '#c2410c') }));
  scene.add(nowBar);
  const selFrame = new THREE.Mesh(new THREE.PlaneGeometry(CW + 0.035, CH + 0.035), selMat);
  selFrame.visible = false; scene.add(selFrame);

  // ---------- HUD ----------
  const hud = document.createElement('div');
  hud.className = 'atlas-hud';
  hud.innerHTML = `<div class="a-range"></div><div class="a-legend"></div>
    <div class="a-info"><span class="a-gpu"></span><span class="a-stats"></span></div>
    <div class="a-help">scroll / pinch to zoom · drag to pan · click a card to open · <kbd>0</kbd> now</div>`;
  el.appendChild(hud);
  hud.querySelector('.a-gpu').textContent = `WebGL2 · ${gpu}`;
  const filter = new Set();
  hud.querySelector('.a-legend').onclick = e => {
    const t = e.target.closest('[data-type]')?.dataset.type;
    if (!t) return;
    filter.has(t) ? filter.delete(t) : filter.add(t);
    applyFilter(); renderLegend(); requestRender();
  };

  // ---------- state ----------
  let docs = [], byId = new Map(), cards = new Map(), cols = [], nowX = 0, bounds = { minX: 0, maxX: 1, minY: -5 };
  let hovered = null, selId = null, raf = 0, destroyed = false;
  const queue = new Set(); let inflight = 0, texCount = 0;
  let frames = 0, fpsT = performance.now(), fps = 0;

  // ---------- layout ----------
  function update(list, { sel, anim } = {}) {
    docs = [...list].reverse();                       // oldest → newest
    byId = new Map(docs.map(d => [d.id, d]));
    const now = cb.now();
    cols = [];
    let x = 0, nowPlaced = false;
    for (const d of docs) {
      const fut = d.created > now;
      if (fut && !nowPlaced) { nowX = x + (cols.length ? -COLW / 2 + NOW_GAP / 2 : 0); x += NOW_GAP; nowPlaced = true; }
      const key = dayKey(d.created) + (fut ? 'f' : 'p');
      if (cols.at(-1)?.key !== key) { cols.push({ key, t: d.created, x, fut, docs: [] }); x += COLW; }
      cols.at(-1).docs.push(d);
    }
    if (!nowPlaced) nowX = x - COLW / 2 + NOW_GAP / 2;
    let minY = 0;
    const seen = new Set();
    for (const c of cols) {
      c.docs.reverse().forEach((d, k) => {           // newest at the top of its day
        const y = -k * (CH + GAP) - CH / 2;
        minY = Math.min(minY, y - CH / 2);
        seen.add(d.id);
        let card = cards.get(d.id);
        if (!card) {
          card = makeCard(d);
          const fresh = anim?.id === d.id;
          card.group.position.set(c.x, fresh ? y + 2 : y, 0);
          card.group.scale.setScalar(fresh ? 0.2 : 1);
          cards.set(d.id, card);
          world.add(card.group);
        } else if (rev(card.doc) !== rev(d)) {        // content changed: redraw its texture
          dropTexture(card); card.mesh.material = typeMat(d.type);
        }
        card.doc = d;
        card.target = new THREE.Vector3(c.x, y, d.created > now ? 0.02 : 0);
      });
    }
    for (const [id, card] of cards) if (!seen.has(id)) { world.remove(card.group); dropTexture(card); cards.delete(id); }
    bounds = { minX: -COLW, maxX: Math.max(x, nowX + 1), minY };
    nowBar.scale.y = Math.max(4, -minY + 1.6); nowBar.position.set(nowX, 0.8 - nowBar.scale.y / 2, 0.03);
    buildLabels();
    selId = sel ?? selId;
    applyFilter(); renderLegend();
    requestRender();
  }

  function makeCard(d) {
    const group = new THREE.Group();
    const shadow = new THREE.Mesh(geo, shadowMat);
    shadow.scale.set(1.12, 1.1, 1); shadow.position.set(0.03, -0.05, -0.01);
    const mesh = new THREE.Mesh(geo, typeMat(d.type));
    mesh.userData.id = d.id;
    group.add(shadow, mesh);
    return { group, mesh, shadow, doc: d, tex: null, texScale: 0, pending: 0, used: 0, hover: 0 };
  }

  function buildLabels() {
    for (const m of [...labels.children]) { labels.remove(m); m.material.map.dispose(); m.material.dispose(); }
    let lastMonth = '';
    for (const c of cols) {
      const d = new Date(c.t);
      const day = textMesh(`${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.getDate()}`, { size: 30, color: c.fut ? '#0090ff' : css('--muted') || '#77736b', weight: 600 });
      day.position.set(c.x - CW / 2 + day.userData.w / 2, 0.22, 0); day.userData.kind = 'day';
      labels.add(day);
      const month = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      if (month !== lastMonth) {
        const m = textMesh(month, { size: 64, color: css('--ink') || '#1d1c1a', weight: 700 });
        m.position.set(c.x - CW / 2 + m.userData.w / 2, 0.75, 0); m.userData.kind = 'month';
        labels.add(m); lastMonth = month;
      }
    }
    const now = textMesh('NOW', { size: 34, color: '#ffffff', weight: 800, bg: css('--accent') || '#c2410c' });
    now.position.set(nowX, 1.0, 0.04); now.userData.kind = 'now';
    labels.add(now);
  }

  function applyFilter() { requestRender(); }

  function renderLegend() {
    const counts = {};
    for (const d of docs) counts[d.type] = (counts[d.type] || 0) + 1;
    hud.querySelector('.a-legend').innerHTML = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) =>
      `<button data-type="${t}" class="${filter.size && !filter.has(t) ? 'off' : ''}"><i style="background:${TYPE_COLOR[t] || '#888'}"></i>${TYPE_ICON[t] || ''} ${t} <b>${n}</b></button>`).join('');
  }

  // ---------- textures: level of detail ----------
  function view() {
    const r = el.getBoundingClientRect();
    const halfH = cam.z * TAN, halfW = halfH * (r.width / Math.max(1, r.height));
    return { r, halfH, halfW, pxPerUnit: r.height / (2 * halfH) };
  }

  function scheduleTextures() {
    const v = view();
    const cardPx = CH * v.pxPerUnit;
    const want = cardPx < 34 ? 0 : cardPx < 380 ? 1 : 2.5;     // tiles → cards → full detail
    const visible = [];
    for (const card of cards.values()) {
      const p = card.group.position;
      if (Math.abs(p.x - cam.x) < v.halfW + CW && Math.abs(p.y - cam.y) < v.halfH + CH) {
        card.used = performance.now();
        visible.push(card);
      }
    }
    if (want) {
      for (const card of visible) if (card.texScale < want && !card.pending) queue.add(card);
    }
    const sorted = [...queue].filter(c => cards.has(c.doc.id)).sort((a, b) => dist(a) - dist(b));
    queue.clear(); sorted.slice(0, 60).forEach(c => queue.add(c));
    while (inflight < CONCURRENCY && queue.size) {
      const card = [...queue][0]; queue.delete(card);
      const scale = want || 1;
      if (card.texScale >= scale) continue;
      inflight++; card.pending = scale;
      const canvas = document.createElement('canvas');
      drawThumb(canvas, card.doc, { dark: cb.dark(), scale, now: cb.now() }).then(() => {
        if (destroyed || !cards.has(card.doc.id)) return;
        const tex = canvasTex(canvas);
        tex.anisotropy = maxAniso;
        dropTexture(card);
        card.tex = tex; card.texScale = scale; texCount++;
        card.mesh.material = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
        evict();
      }).catch(() => {}).finally(() => { inflight--; card.pending = 0; requestRender(); });
    }
    return visible;
  }
  const dist = c => Math.hypot(c.group.position.x - cam.x, c.group.position.y - cam.y);

  function dropTexture(card) {
    if (!card.tex) return;
    card.mesh.material.dispose(); card.tex.dispose();
    card.tex = null; card.texScale = 0; texCount--;
  }
  function evict() {
    if (texCount <= MAX_TEX) return;
    const withTex = [...cards.values()].filter(c => c.tex).sort((a, b) => a.used - b.used);
    for (const c of withTex.slice(0, texCount - MAX_TEX)) { dropTexture(c); c.mesh.material = typeMat(c.doc.type); }
  }

  // ---------- frame ----------
  function requestRender() { if (!raf && !destroyed) raf = requestAnimationFrame(frame); }

  function frame() {
    raf = 0;
    let moving = false;
    for (const k of ['x', 'y', 'z']) {
      const d = goal[k] - cam[k];
      if (Math.abs(d) > (k === 'z' ? 0.002 * cam.z : 0.0005 * cam.z)) { cam[k] += d * 0.18; moving = true; } else cam[k] = goal[k];
    }
    camera.position.set(cam.x, cam.y, cam.z);
    camera.lookAt(cam.x, cam.y, 0);

    for (const card of cards.values()) {
      const g = card.group, t = card.target;
      if (!t) continue;
      const hv = card === hovered ? 1 : 0;
      card.hover += (hv - card.hover) * 0.25;
      const s = 1 + card.hover * 0.05;
      const tz = t.z + card.hover * 0.08;
      if (g.position.distanceToSquared(t) > 1e-6 || Math.abs(g.position.z - tz) > 1e-4 || Math.abs(g.scale.x - s) > 1e-3 || Math.abs(card.hover - hv) > 1e-3) {
        g.position.lerp(new THREE.Vector3(t.x, t.y, tz), 0.2);
        g.scale.setScalar(g.scale.x + (s - g.scale.x) * 0.2);
        moving = true;
      }
      const dimmed = filter.size && !filter.has(card.doc.type);
      if (card.tex) { card.mesh.material.opacity = dimmed ? 0.12 : 1; card.shadow.visible = !dimmed; card.group.visible = true; }
      else card.group.visible = !dimmed;
    }
    // label detail follows zoom
    const v = view();
    const showDays = v.pxPerUnit > 26;
    for (const l of labels.children) l.visible = l.userData.kind !== 'day' || showDays;

    const sc = selId && cards.get(selId);
    selFrame.visible = !!sc;
    if (sc) { selFrame.position.copy(sc.group.position).setZ(sc.group.position.z - 0.005); selFrame.scale.copy(sc.group.scale); }

    const visible = scheduleTextures();
    renderer.render(scene, camera);

    // HUD
    frames++;
    const t = performance.now();
    if (t - fpsT > 500) { fps = Math.round(frames * 1000 / (t - fpsT)); frames = 0; fpsT = t; }
    const ts = visible.map(c => c.doc.created);
    if (ts.length) {
      const a = new Date(Math.min(...ts)), b = new Date(Math.max(...ts));
      hud.querySelector('.a-range').textContent = a.toDateString() === b.toDateString() ? fmt(a, true) : `${fmt(a, a.getFullYear() !== b.getFullYear())} – ${fmt(b, true)}`;
    }
    hud.querySelector('.a-stats').textContent = ` · ${cards.size} cards · ${texCount} textures${moving ? ` · ${fps} fps` : ''}`;
    if (moving || inflight || queue.size) requestRender();
    cb.onView?.();
  }

  // ---------- interaction ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pick(e) {
    const r = el.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([...cards.values()].filter(c => c.group.visible).map(c => c.mesh), false)[0];
    return hit ? cards.get(hit.object.userData.id) : null;
  }
  function worldAt(clientX, clientY) {
    const r = el.getBoundingClientRect(), v = view();
    return { x: cam.x + ((clientX - r.left) / r.width * 2 - 1) * v.halfW, y: cam.y - ((clientY - r.top) / r.height * 2 - 1) * v.halfH };
  }
  const clampGoal = () => {
    goal.z = Math.min(140, Math.max(1.1, goal.z));
    goal.x = Math.min(bounds.maxX + 2, Math.max(bounds.minX - 2, goal.x));
    goal.y = Math.min(1.5, Math.max(bounds.minY - 1, goal.y));
  };

  const onWheel = e => {
    e.preventDefault();
    if (e.shiftKey || (Math.abs(e.deltaX) > Math.abs(e.deltaY) && !e.ctrlKey)) {
      const k = (2 * cam.z * TAN) / el.clientHeight;
      goal.x += (e.shiftKey ? e.deltaY : e.deltaX) * k; clampGoal(); requestRender(); return;
    }
    const before = worldAt(e.clientX, e.clientY);
    const f = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0016));
    goal.z = cam.z * f; clampGoal();
    // zoom toward the cursor: keep the world point under it fixed
    const r = el.getBoundingClientRect(), nx = (e.clientX - r.left) / r.width * 2 - 1, ny = (e.clientY - r.top) / r.height * 2 - 1;
    const halfH = goal.z * TAN, halfW = halfH * r.width / r.height;
    goal.x = before.x - nx * halfW; goal.y = before.y + ny * halfH;
    clampGoal(); requestRender();
  };
  let drag = null;
  const onHud = e => e.target.closest?.('.atlas-hud button, .atlas-hud a');
  const onDown = e => { if (onHud(e)) return; drag = { x: e.clientX, y: e.clientY, gx: goal.x, gy: goal.y, moved: false }; el.setPointerCapture(e.pointerId); };
  const onMove = e => {
    if (!drag && onHud(e)) return;
    if (drag) {
      const k = (2 * cam.z * TAN) / el.clientHeight;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 4) drag.moved = true;
      if (drag.moved) { goal.x = drag.gx - dx * k; goal.y = drag.gy + dy * k; cam.x = goal.x; cam.y = goal.y; clampGoal(); requestRender(); }
      return;
    }
    const c = pick(e);
    if (c !== hovered) {
      hovered = c; el.style.cursor = c ? 'pointer' : 'grab';
      if (c) cb.onHover?.(c.doc);
      requestRender();
    }
  };
  const onUp = e => {
    const d = drag; drag = null;
    if (d && !d.moved) {
      const c = pick(e);
      if (c) { flyTo(c.doc.id); selId = c.doc.id; cb.onOpen?.(c.doc); }
    }
  };
  const onDbl = e => { if (!pick(e)) { goal.z = Math.min(140, cam.z * 2.5); requestRender(); } };
  const onKey = e => {
    if (e.target.closest?.('input, textarea, select')) return;
    const k = (2 * cam.z * TAN) / el.clientHeight * 120;
    const map = { ArrowLeft: [-k, 0, 1], ArrowRight: [k, 0, 1], ArrowUp: [0, k, 1], ArrowDown: [0, -k, 1], '=': [0, 0, 0.7], '+': [0, 0, 0.7], '-': [0, 0, 1.4] };
    if (e.key === '0') { home(); e.preventDefault(); return; }
    const m = map[e.key];
    if (!m) return;
    e.preventDefault();
    goal.x += m[0]; goal.y += m[1]; goal.z *= m[2]; clampGoal(); requestRender();
  };
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('dblclick', onDbl);
  el.addEventListener('pointerleave', () => { if (hovered) { hovered = null; requestRender(); } });
  window.addEventListener('keydown', onKey);
  const ro = new ResizeObserver(() => {
    const r = el.getBoundingClientRect();
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / Math.max(1, r.height); camera.updateProjectionMatrix();
    requestRender();
  });
  ro.observe(el);

  // ---------- navigation API ----------
  function flyTo(id, fill = 0.82) {
    const c = cards.get(id);
    if (!c || !c.target) return;
    const r = el.getBoundingClientRect();
    const zH = CH / fill / (2 * TAN), zW = CW / fill / (2 * TAN * (r.width / r.height));
    goal.x = c.target.x; goal.y = c.target.y; goal.z = Math.max(zH, zW);
    requestRender();
  }
  function home() {
    const r = el.getBoundingClientRect();
    goal.z = Math.max(6, (COLW * 7) / (2 * TAN * (r.width / Math.max(1, r.height))));
    goal.x = nowX - COLW * 2; goal.y = -goal.z * TAN + 1.0 + 150 * (2 * goal.z * TAN) / Math.max(1, r.height);  // leave room for the HUD
    clampGoal(); requestRender();
  }

  return {
    update,
    home,
    reveal: id => { selId = id; flyTo(id); },
    select: id => { selId = id; requestRender(); },
    scrubTo: t => {
      let best = cols[0];
      for (const c of cols) if (Math.abs(c.t - t) < Math.abs(best.t - t)) best = c;
      if (best) { goal.x = best.x; requestRender(); }
    },
    visibleTimes: () => {
      const v = view(), out = [];
      for (const c of cards.values()) { const p = c.group.position; if (Math.abs(p.x - cam.x) < v.halfW && Math.abs(p.y - cam.y) < v.halfH) out.push(c.doc.created); }
      return out;
    },
    destroy() {
      destroyed = true; cancelAnimationFrame(raf); ro.disconnect();
      window.removeEventListener('keydown', onKey);
      for (const c of cards.values()) dropTexture(c);
      for (const m of labels.children) { m.material.map.dispose(); m.material.dispose(); }
      for (const m of typeMats.values()) m.dispose();
      [roundTex, shadowTex, grid.material.map].forEach(t => t.dispose());
      geo.dispose(); renderer.dispose(); el.innerHTML = '';
    },
  };

  // ---------- helpers ----------
  function textMesh(text, { size = 32, color = '#000', weight = 600, bg } = {}) {
    const c = document.createElement('canvas'), g = c.getContext('2d');
    const font = `${weight} ${size}px ui-sans-serif, -apple-system, "Segoe UI", sans-serif`;
    g.font = font;
    const pad = bg ? size * 0.5 : 2, w = Math.ceil(g.measureText(text).width + pad * 2), h = Math.ceil(size * 1.4);
    c.width = w; c.height = h;
    g.font = font; g.textBaseline = 'middle';
    if (bg) { g.fillStyle = bg; g.beginPath(); g.roundRect(0, 0, w, h, h / 2); g.fill(); }
    g.fillStyle = color; g.fillText(text, pad, h / 2 + 1);
    const tex = canvasTex(c);
    const worldH = size / 100 * 0.32, worldW = worldH * w / h;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(worldW, worldH), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    m.userData.w = worldW;
    return m;
  }
}

function canvasTex(c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
function roundedMask(w, h, r, color) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.fillStyle = color; g.beginPath(); g.roundRect(0, 0, w, h, r); g.fill();
  return c;
}
function shadowCanvas() {
  const c = document.createElement('canvas'); c.width = 160; c.height = 190;
  const g = c.getContext('2d'); g.filter = 'blur(10px)'; g.fillStyle = '#000'; g.beginPath(); g.roundRect(20, 20, 120, 150, 14); g.fill();
  return c;
}
function dotTex(dark) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'); g.fillStyle = dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.07)';
  g.beginPath(); g.arc(32, 32, 2.2, 0, 7); g.fill();
  return canvasTex(c);
}
function dayKey(t) { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function rev(d) { return `${d.title}|${d.snippet}|${d.frozen}|${d.unread}`; }
function fmt(d, year) { return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: year ? 'numeric' : undefined }); }
