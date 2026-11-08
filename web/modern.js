// Modern: the same receding diagonal as Classic, built the way you'd build it now. Real 3D
// cards on the GPU, textured with high-resolution rendered documents; a soft key light
// whose shadows fall from each card onto the ones behind it; depth of field that keeps
// what you're looking at sharp and melts the rest of the stack into bokeh; spring physics
// for every motion; hover pulls a card out of the stack toward you (the glance, in 3D);
// subtle parallax; and frosted-glass chrome with a timeline built from the stream itself.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { drawContent, TYPE_COLOR, TYPE_ICON } from './formats.js';

const CW = 1, CH = 1.294;                                  // a letter page
const SLICE = 44;                                          // cards in the stack
const STEP = new THREE.Vector3(-0.8, 0.42, -1.0);          // each older card: up, left, back
const EXIT = new THREE.Vector3(0.75, -0.9, 1.4);           // newer than the front: flies past you
const GLANCE = new THREE.Vector3(-1.55, 0.38, 1.2);        // where a hovered card is pulled to
const BASE_YAW = 0.2;
const K = 190, DAMP = 25;                                  // spring stiffness / damping
const MAX_TEX = 200, THUMB_CONCURRENCY = 4;

export function createModern(el, cb) {
  // ---------- renderer & post ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.className = 'md-gl';
  el.appendChild(renderer.domElement);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 80);
  // the camera sits to the right, looking up the diagonal, so the front card lands bottom right
  const camBase = new THREE.Vector3(2.0, 0.05, 3.9), look = new THREE.Vector3(-1.85, 0.55, -2.5);
  const parallax = { x: 0, y: 0, tx: 0, ty: 0 };

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bokeh = new BokehPass(scene, camera, { focus: 4.4, aperture: 0.0018, maxblur: 0.006 });
  composer.addPass(bokeh);
  composer.addPass(new OutputPass());

  // ---------- light: soft key from the front right, shadows falling back down the stack ----------
  const hemi = new THREE.HemisphereLight(0xffffff, 0xd8d2c8, 1.55);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 1.35);
  key.position.set(3.2, 4.6, 6.2);
  key.target.position.set(-2.5, 1.5, -5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 30 });
  key.shadow.bias = -0.0006; key.shadow.normalBias = 0.02;
  key.shadow.intensity = 0.42;   // soft: paper shadows, not slabs
  key.shadow.radius = 6;
  scene.add(key, key.target);
  // a ground that only shows the shadows of the front cards
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: 0.14 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -CH / 2 - 0.06; ground.receiveShadow = true;
  scene.add(ground);

  // selection glow: a soft accent halo that sits behind the selected card
  const haloTex = canvasTex(haloCanvas());
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(CW * 1.5, CH * 1.42), new THREE.MeshBasicMaterial({ map: haloTex, transparent: true, opacity: 0.75, depthWrite: false }));
  halo.visible = false; scene.add(halo);

  const geo = new THREE.PlaneGeometry(CW, CH);
  const placeholders = new Map();

  // ---------- HUD: frosted glass ----------
  const hud = document.createElement('div');
  hud.className = 'md-hud';
  hud.innerHTML = `
    <div class="lg md-stream">
      <div class="md-kicker">Lifestream</div>
      <div class="md-title"></div>
      <div class="md-sub"></div>
      <div class="md-stats"></div>
    </div>
    <nav class="lg md-tabs" aria-label="Show">${Object.entries(GROUPS).map(([k, g]) => `<button data-filter="${k}" title="${g.label}" aria-label="${g.label}">${g.icon}<span>${g.label}</span></button>`).join('')}</nav>
    <div class="lg md-focus"><div class="md-ftype"></div><div class="md-ftitle"></div><div class="md-fmeta"></div></div>
    <div class="lg md-ornament">
      <button class="lg-btn round" data-step="8" aria-label="Older">${ICONS.back}</button>
      <div class="md-tl">
        <div class="md-trange"><span class="md-from"></span><span class="md-count"></span><span class="md-to"></span></div>
        <div class="md-track"><canvas class="md-hist"></canvas><div class="md-thumb"></div></div>
      </div>
      <button class="lg-btn round" data-step="-8" aria-label="Newer">${ICONS.fwd}</button>
      <i class="md-sep"></i>
      <button class="lg-btn" data-act="now">${ICONS.now}<span>Now</span></button>
      <button class="lg-btn" data-act="future"></button>
    </div>
    <div class="md-hint">scroll or drag to move through time · hover to pull a document out · click to open</div>`;
  el.appendChild(hud);

  // ---------- state ----------
  let list = [], byId = new Map(), cards = new Map();
  let head = 0, headF = 0, headV = 0, headGoal = 0;
  let filter = 'all';
  let hoverId = null, selId = null, raf = 0, destroyed = false, last = performance.now(), idleSnap = 0;
  const thumbs = new Map(), pending = new Map(); let inflight = 0;
  let C = {};

  function theme() {
    const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    const dark = cb.dark();
    C = { dark, bg: css('--bg') || '#f6f5f2', accent: css('--accent') || '#c2410c' };
    scene.background = canvasTex(meshGradient(dark));
    scene.fog = null;                                   // depth comes from blur and fade, not fog
    hemi.intensity = dark ? 1.15 : 1.55; key.intensity = dark ? 1.0 : 1.35;
    ground.material.opacity = dark ? 0.3 : 0.1;
    halo.material.color = new THREE.Color(C.accent);
  }

  // ---------- data ----------
  function update(docs, { sel, anim } = {}) {
    theme();
    const now = cb.now();
    const atNow = !list.length || Math.round(headGoal) === list.indexOf(newestPast(list, now));
    const keep = list[Math.round(headGoal)]?.id;
    list = docs;
    byId = new Map(list.map((d, i) => [d.id, i]));
    if (sel !== undefined) selId = sel;
    const np = Math.max(0, list.indexOf(newestPast(list, now)));
    const target = atNow || !keep ? np : Math.max(0, byId.get(keep) ?? np);
    if (!cards.size) { headF = headGoal = target; } else headGoal = target;
    if (anim?.id && cards.get(anim.id)) cards.get(anim.id).entering = true;
    for (const [id, c] of cards) if (!byId.has(id)) removeCard(id, c);
    renderStatic();
    request();
  }
  const newestPast = (l, now) => l.find(d => d.created <= now);

  function cardFor(d) {
    let c = cards.get(d.id);
    if (c) return c;
    // paper stays paper-white under the lights: the texture also drives a little emission
    const mat = new THREE.MeshStandardMaterial({ map: placeholder(d), emissiveMap: placeholder(d), emissive: 0xffffff, emissiveIntensity: 0.42,
      roughness: 0.7, metalness: 0, transparent: true, alphaTest: 0.04 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: mat.map, alphaTest: 0.5 });
    mesh.userData.id = d.id;
    scene.add(mesh);
    c = { mesh, doc: d, p: new THREE.Vector3(), v: new THREE.Vector3(), yaw: BASE_YAW, yawV: 0, s: 1, sV: 0, o: 0, oV: 0, texScale: 0, born: true };
    cards.set(d.id, c);
    return c;
  }
  function removeCard(id, c) {
    scene.remove(c.mesh);
    if (c.mesh.material.map && !c.mesh.material.map.userData.shared) c.mesh.material.map.dispose();
    c.mesh.material.dispose(); c.mesh.customDepthMaterial.dispose();
    cards.delete(id);
  }

  // ---------- frame ----------
  function request() { if (!raf && !destroyed) raf = requestAnimationFrame(frame); }

  function frame(t) {
    raf = 0;
    // integrate the real elapsed time in small steps, so motion settles on time even when
    // frames are throttled (background tabs) instead of crawling
    const elapsed = Math.min(0.6, (t - last) / 1000 || 0.016); last = t;
    const steps = Math.max(1, Math.ceil(elapsed / (1 / 90))), dt = elapsed / steps;
    let moving = false;

    // the stack's position in time, on a spring
    for (let k = 0; k < steps; k++) { const a = K * 0.6 * (headGoal - headF) - DAMP * 0.75 * headV; headV += a * dt; headF += headV * dt; }
    if (Math.abs(headGoal - headF) > 1e-3 || Math.abs(headV) > 1e-3) moving = true; else { headF = headGoal; headV = 0; }
    head = Math.round(headF);

    // which documents are on stage
    const lo = Math.max(0, Math.floor(headF - 1.8)), hi = Math.min(list.length, Math.ceil(headF + SLICE));
    const live = new Set();
    for (let i = lo; i < hi; i++) {
      const d = list[i], c = cardFor(d);
      c.doc = d; live.add(d.id);
      const rel = i - headF;
      // targets
      const tp = rel >= 0 ? STEP.clone().multiplyScalar(rel) : EXIT.clone().multiplyScalar(-rel);   // newer: out toward you
      let tyaw = BASE_YAW, ts = 1;
      let to = rel >= 0 ? (rel > SLICE - 10 ? Math.max(0, (SLICE - rel) / 10) : 1) : Math.max(0, 1 + rel * 1.25);
      const dimmed = filter !== 'all' && !GROUPS[filter].types.has(d.type);
      if (dimmed) to = Math.min(to, 0.1);
      c.mesh.material.emissiveIntensity = d.id === hoverId ? 0.62 : 0.42;   // hovered cards brighten
      if (d.id === hoverId) {
        const pull = rel < 0.5 ? 0.25 : Math.min(0.9, 0.45 + rel * 0.03);
        tp.lerp(GLANCE.clone().add(new THREE.Vector3(0, 0, 0)), pull);
        tyaw = 0.05; ts = 1.06; to = 1;
      }
      if (c.born) {                             // first appearance: start one step further back
        c.p.copy(c.entering ? tp.clone().add(new THREE.Vector3(1.4, -2.2, 2.4)) : STEP.clone().multiplyScalar(rel + 1));
        c.o = 0; c.born = false; c.entering = false;
      }
      // integrate springs
      for (let k = 0; k < steps; k++) {
        const ax = K * (tp.x - c.p.x) - DAMP * c.v.x, ay = K * (tp.y - c.p.y) - DAMP * c.v.y, az = K * (tp.z - c.p.z) - DAMP * c.v.z;
        c.v.x += ax * dt; c.v.y += ay * dt; c.v.z += az * dt;
        c.p.addScaledVector(c.v, dt);
        [c.yaw, c.yawV] = spring(c.yaw, c.yawV, tyaw, dt);
        [c.s, c.sV] = spring(c.s, c.sV, ts, dt);
        [c.o, c.oV] = spring(c.o, c.oV, to, dt, 120, 22);
      }
      if (c.v.lengthSq() > 1e-6 || Math.abs(c.yawV) > 1e-4 || Math.abs(c.sV) > 1e-4 || Math.abs(c.oV) > 1e-4) moving = true;
      c.mesh.position.copy(c.p);
      c.mesh.rotation.set(0, c.yaw, 0);
      c.mesh.scale.setScalar(c.s);
      const o = Math.max(0, Math.min(1, c.o));
      c.mesh.material.opacity = o;
      c.mesh.visible = o > 0.01;
      c.mesh.renderOrder = -i;
      wantTexture(c, rel);
    }
    for (const [id, c] of cards) if (!live.has(id)) removeCard(id, c);

    // selection halo follows the selected card
    const sc = selId && cards.get(selId);
    halo.visible = !!(sc && sc.mesh.visible);
    if (halo.visible) { halo.position.copy(sc.p).add(new THREE.Vector3(0, 0, -0.02)); halo.rotation.y = sc.yaw; halo.scale.setScalar(sc.s); }

    // camera: parallax toward the cursor
    const ease = 1 - Math.pow(1 - 0.08, elapsed * 60);   // frame-rate independent easing
    parallax.x += (parallax.tx - parallax.x) * ease; parallax.y += (parallax.ty - parallax.y) * ease;
    if (Math.abs(parallax.tx - parallax.x) + Math.abs(parallax.ty - parallax.y) > 1e-3) moving = true;
    camera.position.set(camBase.x + parallax.x * 0.35, camBase.y - parallax.y * 0.22, camBase.z);
    camera.lookAt(look);

    // depth of field: focus on what you're looking at
    const fc = (hoverId && cards.get(hoverId)) || cards.get(list[head]?.id);
    if (fc) {
      const want = camera.position.distanceTo(fc.p);
      const cur = bokeh.uniforms.focus.value;
      bokeh.uniforms.focus.value = cur + (want - cur) * (1 - Math.pow(0.85, elapsed * 60));
      if (Math.abs(want - cur) > 0.01) moving = true;
    }

    composer.render(elapsed);
    hudFrame();
    cb.onView?.();
    // after scrolling stops, settle on the nearest whole document
    if (!moving && Math.abs(headGoal - Math.round(headGoal)) > 1e-3 && performance.now() - idleSnap > 140) { headGoal = Math.round(headGoal); moving = true; }
    if (moving || inflight || pending.size) request();
  }

  // ---------- textures: rendered documents, sharper as they come forward ----------
  function wantTexture(c, rel) {
    const want = rel < 1.5 ? 2.2 : rel < 8 ? 1.2 : rel < 20 ? 0.7 : 0.45;
    if (c.texScale >= want) return;
    const prev = pending.get(c.doc.id) || 0;
    if (want > prev) pending.set(c.doc.id, want);
    pump();
  }
  function pump() {
    while (inflight < THUMB_CONCURRENCY && pending.size) {
      // nearest the front first
      const [id, scale] = [...pending.entries()].sort((a, b) => Math.abs((byId.get(a[0]) ?? 1e9) - headF) - Math.abs((byId.get(b[0]) ?? 1e9) - headF))[0];
      pending.delete(id);
      const c = cards.get(id);
      if (!c || c.texScale >= scale) continue;
      inflight++;
      const canvas = document.createElement('canvas');
      drawContent(canvas, c.doc, { dark: C.dark, scale, now: cb.now() })   // the document itself, full bleed
        .then(() => {
          const cc = cards.get(id);
          if (destroyed || !cc) return;
          const tex = canvasTex(canvas);
          tex.anisotropy = maxAniso;
          const old = cc.mesh.material.map;
          cc.mesh.material.map = tex; cc.mesh.material.emissiveMap = tex; cc.mesh.material.needsUpdate = true;
          cc.mesh.customDepthMaterial.map = tex; cc.mesh.customDepthMaterial.needsUpdate = true;
          if (old && !old.userData.shared) old.dispose();
          cc.texScale = scale;
          evict();
        })
        .catch(() => {})
        .finally(() => { inflight--; pump(); request(); });
    }
  }
  function evict() {
    const withTex = [...cards.values()].filter(c => c.texScale > 0);
    if (withTex.length <= MAX_TEX) return;
    withTex.sort((a, b) => Math.abs((byId.get(b.doc.id) ?? 0) - headF) - Math.abs((byId.get(a.doc.id) ?? 0) - headF));
    for (const c of withTex.slice(0, withTex.length - MAX_TEX)) {
      const old = c.mesh.material.map; c.mesh.material.map = c.mesh.material.emissiveMap = placeholder(c.doc); c.mesh.material.needsUpdate = true;
      c.mesh.customDepthMaterial.map = c.mesh.material.map;
      if (old && !old.userData.shared) old.dispose();
      c.texScale = 0;
    }
  }
  function placeholder(d) {
    const key = d.type + (C.dark ? 'd' : 'l');
    if (placeholders.has(key)) return placeholders.get(key);
    const cv = document.createElement('canvas'); cv.width = 160; cv.height = 207;
    const g = cv.getContext('2d');
    g.fillStyle = C.dark ? '#26251f' : '#ffffff'; g.beginPath(); g.roundRect(0, 0, 160, 207, 10); g.fill();
    g.fillStyle = TYPE_COLOR[d.type] || '#888'; g.fillRect(0, 0, 160, 4);
    g.font = '38px ui-sans-serif'; g.textAlign = 'center'; g.globalAlpha = 0.35; g.fillText(TYPE_ICON[d.type] || '•', 80, 118);
    const t = canvasTex(cv); t.userData.shared = true;
    placeholders.set(key, t);
    return t;
  }

  // ---------- HUD ----------
  function renderStatic() {
    const lbl = cb.label?.() || { stream: 'me', sub: 'Main stream' };
    const now = cb.now();
    hud.querySelector('.md-title').textContent = lbl.stream;
    hud.querySelector('.md-sub').textContent = lbl.sub || 'Main stream';
    const unread = list.filter(d => d.unread).length, upcoming = list.filter(d => d.created > now).length;
    hud.querySelector('.md-stats').innerHTML = `<b>${list.length.toLocaleString()}</b> documents${unread ? ` · <b>${unread}</b> unread` : ''}${upcoming ? ` · <b>${upcoming}</b> upcoming` : ''}`;
    drawHistogram();
  }
  let lastFocus = null;
  function hudFrame() {
    const d = list[Math.max(0, Math.min(list.length - 1, hoverId ? byId.get(hoverId) : head))];
    if (d && d.id !== lastFocus) {
      lastFocus = d.id;
      const f = hud.querySelector('.md-focus');
      f.style.setProperty('--c', TYPE_COLOR[d.type] || '#888');
      hud.querySelector('.md-ftype').textContent = `${TYPE_ICON[d.type] || ''} ${(d.file?.ext || d.type).toUpperCase()}`;
      hud.querySelector('.md-ftitle').textContent = d.title;
      hud.querySelector('.md-fmeta').textContent = `${d.author === 'me' ? 'You' : d.author} · ${new Date(d.created).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
    }
    const slice = list.slice(head, head + SLICE);
    if (slice.length) {
      hud.querySelector('.md-from').textContent = shortDate(slice.at(-1).created);
      hud.querySelector('.md-to').textContent = shortDate(slice[0].created);
      hud.querySelector('.md-count').textContent = `${slice.length} in view`;
      const t0 = list.at(-1).created, t1 = list[0].created, span = Math.max(1, t1 - t0);
      const a = (slice.at(-1).created - t0) / span, b = (slice[0].created - t0) / span, w = Math.max(0.03, b - a);
      const th = hud.querySelector('.md-thumb');
      th.style.left = Math.min(1 - w, Math.max(0, a)) * 100 + '%'; th.style.width = w * 100 + '%';
    }
    const n = list.filter(x => x.created > cb.now()).length, inFuture = list[head]?.created > cb.now();
    const fb = hud.querySelector('[data-act="future"]');
    fb.innerHTML = inFuture ? `${ICONS.down}<span>Back to now</span>` : `${ICONS.up}<span>${n} upcoming</span>`;
    fb.hidden = !n && !inFuture;
  }
  function drawHistogram() {
    const c = hud.querySelector('.md-hist'), r = c.getBoundingClientRect();
    if (!r.width || !list.length) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = r.width * dpr; c.height = r.height * dpr;
    const g = c.getContext('2d'); g.scale(dpr, dpr);
    const t0 = list.at(-1).created, t1 = list[0].created, span = Math.max(1, t1 - t0);
    const bins = Math.max(24, Math.floor(r.width / 4)), counts = new Array(bins).fill(0);
    for (const d of list) counts[Math.min(bins - 1, Math.floor((d.created - t0) / span * bins))]++;
    const max = Math.max(...counts), bw = r.width / bins;
    const grad = g.createLinearGradient(0, r.height, 0, 0);
    grad.addColorStop(0, C.dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.14)'); grad.addColorStop(1, C.dark ? 'rgba(255,255,255,.5)' : 'rgba(0,0,0,.38)');
    g.fillStyle = grad;
    counts.forEach((v, i) => { if (v) { const h = Math.max(2, Math.sqrt(v / max) * (r.height - 8)); g.beginPath(); g.roundRect(i * bw + 0.75, r.height - 4 - h, Math.max(1.2, bw - 1.5), h, 1.2); g.fill(); } });
    const nx = (cb.now() - t0) / span * r.width;
    g.fillStyle = C.accent; if (nx > 0 && nx < r.width) { g.fillRect(nx - 0.75, 3, 1.5, r.height - 6); }
  }

  // ---------- interaction ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pick(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const meshes = [...cards.values()].filter(c => c.mesh.visible && c.o > 0.3).map(c => c.mesh);
    const hit = ray.intersectObjects(meshes, false)[0];
    return hit ? hit.object.userData.id : null;
  }
  const clampGoal = () => { headGoal = Math.max(0, Math.min(Math.max(0, list.length - 1), headGoal)); };
  const onWheel = e => { e.preventDefault(); headGoal += (e.deltaY + e.deltaX) * 0.012; clampGoal(); idleSnap = performance.now(); request(); };
  let drag = null;
  const onDown = e => {
    if (e.target.closest('.md-hud button, .md-ornament, .md-tabs')) return;
    drag = { y: e.clientY, g: headGoal, moved: false };
    renderer.domElement.setPointerCapture?.(e.pointerId);
  };
  const onMove = e => {
    const r = el.getBoundingClientRect();
    parallax.tx = ((e.clientX - r.left) / r.width - 0.5) * 2; parallax.ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
    if (drag) {
      const dy = e.clientY - drag.y;
      if (Math.abs(dy) > 5) drag.moved = true;
      if (drag.moved) { headGoal = drag.g - dy * 0.03; clampGoal(); idleSnap = performance.now(); }
      request(); return;
    }
    if (e.target.closest('.md-hud .lg')) { if (hoverId) { hoverId = null; } request(); return; }
    const id = pick(e);
    if (id !== hoverId) {
      hoverId = id; renderer.domElement.style.cursor = id ? 'pointer' : 'default';
      const d = id && list[byId.get(id)];
      if (d) cb.onHover?.(d);
    }
    request();
  };
  const onUp = e => {
    const d = drag; drag = null;
    if (d && !d.moved) {
      const id = pick(e);
      if (id) { selId = id; const doc = list[byId.get(id)]; if (doc) cb.onOpen?.(doc); request(); }
    }
  };
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointerleave', () => { hoverId = null; parallax.tx = parallax.ty = 0; request(); });
  hud.querySelector('.md-tabs').onclick = e => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    filter = b.dataset.filter;
    hud.querySelectorAll('.md-tabs button').forEach(x => x.classList.toggle('on', x === b));
    request();
  };
  hud.querySelector('.md-tabs [data-filter="all"]').classList.add('on');
  hud.querySelector('.md-ornament').onclick = e => {
    const st = e.target.closest('[data-step]');
    if (st) { headGoal = Math.round(headGoal) + Number(st.dataset.step); clampGoal(); request(); return; }
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'now') home();
    if (a === 'future') { headGoal = list[head]?.created > cb.now() ? Math.max(0, list.indexOf(newestPast(list, cb.now()))) : 0; request(); }
  };
  // the timeline: click or drag to travel
  const track = hud.querySelector('.md-track');
  const trackTo = e => {
    if (!list.length) return;
    const r = track.getBoundingClientRect(), f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const t = list.at(-1).created + f * (list[0].created - list.at(-1).created);
    let best = 0; list.forEach((d, i) => { if (Math.abs(d.created - t) < Math.abs(list[best].created - t)) best = i; });
    headGoal = best; request();
  };
  let trackDrag = false;
  track.addEventListener('pointerdown', e => { trackDrag = true; track.setPointerCapture(e.pointerId); trackTo(e); });
  track.addEventListener('pointermove', e => trackDrag && trackTo(e));
  track.addEventListener('pointerup', () => { trackDrag = false; });
  const onKey = e => {
    if (e.target.closest?.('input, textarea, select')) return;
    const d = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1, PageDown: 10, PageUp: -10 }[e.key];
    if (e.key === '0') return home();
    if (e.key === 'Enter' && list[head]) { selId = list[head].id; return cb.onOpen?.(list[head]); }
    if (d) { e.preventDefault(); headGoal = Math.round(headGoal) + d; clampGoal(); request(); }
  };
  window.addEventListener('keydown', onKey);
  const ro = new ResizeObserver(() => {
    const r = el.getBoundingClientRect();
    renderer.setSize(r.width, r.height, false); composer.setSize(r.width, r.height);
    camera.aspect = r.width / Math.max(1, r.height);
    // narrow screens: pull back so the stack still fits
    camBase.set(r.width < 600 ? 1.4 : 2.0, r.width < 600 ? 0.6 : 0.05, r.width < 600 ? 7.2 : 3.9 + Math.max(0, 1.25 - camera.aspect) * 2.6);
    camera.updateProjectionMatrix();
    drawHistogram(); request();
  });
  ro.observe(el);
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const onTheme = () => { theme(); for (const c of cards.values()) c.texScale = 0; placeholders.clear(); request(); };
  mq.addEventListener('change', onTheme);

  function home() { headGoal = Math.max(0, list.indexOf(newestPast(list, cb.now()))); request(); }
  theme();

  return {
    update, home,
    reveal: id => { const i = byId.get(id); if (i !== undefined) { headGoal = i; selId = id; request(); } },
    select: id => { selId = id; request(); },
    scrubTo: t => { let best = 0; list.forEach((d, i) => { if (Math.abs(d.created - t) < Math.abs(list[best].created - t)) best = i; }); headGoal = best; request(); },
    visibleTimes: () => list.slice(head, head + SLICE).map(d => d.created),
    destroy() {
      destroyed = true; cancelAnimationFrame(raf); ro.disconnect();
      window.removeEventListener('keydown', onKey); mq.removeEventListener('change', onTheme);
      for (const [id, c] of cards) removeCard(id, c);
      for (const t of placeholders.values()) t.dispose();
      haloTex.dispose(); geo.dispose(); composer.dispose?.(); renderer.dispose(); el.innerHTML = '';
    },
  };
}

// kinds of documents for the tab bar
const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  all: svg('<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>'),
  mail: svg('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/>'),
  docs: svg('<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>'),
  media: svg('<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>'),
  time: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  money: svg('<rect x="3" y="6" width="18" height="12" rx="3"/><circle cx="12" cy="12" r="2.5"/><path d="M7 9.5v5M17 9.5v5"/>'),
  back: svg('<path d="m15 6-6 6 6 6"/>'), fwd: svg('<path d="m9 6 6 6-6 6"/>'),
  up: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'), down: svg('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  now: svg('<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8.5"/>'),
};
const GROUPS = {
  all: { label: 'All', icon: ICONS.all, types: null },
  mail: { label: 'Mail', icon: ICONS.mail, types: new Set(['email']) },
  docs: { label: 'Docs', icon: ICONS.docs, types: new Set(['file', 'note', 'summary', 'turn', 'bookmark', 'code', 'data']) },
  media: { label: 'Media', icon: ICONS.media, types: new Set(['photo', 'image', 'audio', 'video']) },
  time: { label: 'Time', icon: ICONS.time, types: new Set(['reminder', 'event', 'todo', 'wakeup']) },
  money: { label: 'Money', icon: ICONS.money, types: new Set(['expense', 'sheet']) },
};

// ---------- helpers ----------
function meshGradient(dark) {
  // soft luminous blobs, the kind of backdrop spatial interfaces float over
  const c = document.createElement('canvas'); c.width = 1024; c.height = 640;
  const g = c.getContext('2d');
  g.fillStyle = dark ? '#0a0b12' : '#f4f1f8'; g.fillRect(0, 0, 1024, 640);
  const blobs = dark
    ? [['#3d2a9a', 0.1, 0.12, 0.62], ['#0e7d86', 0.92, 0.1, 0.58], ['#9a2e78', 0.78, 0.98, 0.62], ['#1f4aa8', 0.05, 0.95, 0.55], ['#5a3fd0', 0.5, 0.45, 0.35]]
    : [['#ffd6c0', 0.08, 0.1, 0.6], ['#d7d0ff', 0.9, 0.12, 0.62], ['#c4eaff', 0.82, 0.98, 0.6], ['#ffe2f0', 0.06, 0.95, 0.55], ['#fff4d6', 0.48, 0.5, 0.4]];
  for (const [col, x, y, r] of blobs) {
    const gr = g.createRadialGradient(x * 1024, y * 640, 0, x * 1024, y * 640, r * 1024);
    gr.addColorStop(0, col + 'ee'); gr.addColorStop(0.55, col + '55'); gr.addColorStop(1, col + '00');
    g.fillStyle = gr; g.fillRect(0, 0, 1024, 640);
  }
  return c;
}
function spring(x, v, target, dt, k = K, c = DAMP) { const a = k * (target - x) - c * v; v += a * dt; return [x + v * dt, v]; }
function canvasTex(cv) {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
function backdrop(bg, dark) {
  const c = document.createElement('canvas'); c.width = 16; c.height = 512;
  const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 512);
  gr.addColorStop(0, dark ? '#0d0d0c' : '#ffffff'); gr.addColorStop(0.55, bg); gr.addColorStop(1, dark ? '#1b1a17' : '#e9e5dc');
  g.fillStyle = gr; g.fillRect(0, 0, 16, 512);
  return c;
}
function haloCanvas() {
  const c = document.createElement('canvas'); c.width = 192; c.height = 256;
  const g = c.getContext('2d'); g.filter = 'blur(14px)'; g.fillStyle = '#fff'; g.beginPath(); g.roundRect(34, 38, 124, 180, 12); g.fill();
  return c;
}
const shortDate = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(t).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
