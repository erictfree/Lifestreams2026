// Format-aware rendering, shared by the document pane (full viewers) and the Atlas view
// (canvas thumbnails that become GPU textures). One place that knows what a PDF, a WAV,
// a CSV, an iCalendar invite or an email looks like.

export const TYPE_COLOR = {
  email: '#3b82f6', note: '#d4a017', turn: '#8b5cf6', file: '#e5484d', photo: '#12a594', image: '#0d9488',
  audio: '#f76b15', video: '#d6409f', sheet: '#30a46c', event: '#0090ff', bookmark: '#6e56cf', code: '#8e4ec6',
  summary: '#7c3aed', reminder: '#0891b2', todo: '#0891b2', wakeup: '#6366f1', expense: '#65a30d', data: '#78716c',
};
export const TYPE_ICON = {
  email: '✉', note: '📝', turn: '💬', file: '📄', bookmark: '🔖', summary: '✦', reminder: '⏰', todo: '☐', wakeup: '⏱',
  expense: '🧾', photo: '🖼', image: '📐', audio: '🎙', video: '🎬', sheet: '📊', event: '📅', code: '⌨', data: '{}',
};
export const fileUrl = d => `/api/files/${d.id}`;
const TEXTY = new Set(['csv', 'tsv', 'json', 'ics', 'eml', 'html', 'htm', 'txt', 'md', 'xml', 'yaml', 'yml', 'js', 'mjs', 'ts', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'sh', 'css']);
export const isTextFile = d => d.file && TEXTY.has(d.file.ext);

// ---------- loaders (cached) ----------
const cache = new Map();
const once = (key, fn) => { if (!cache.has(key)) cache.set(key, fn().catch(e => { cache.delete(key); throw e; })); return cache.get(key); };
export const fetchText = d => once('t:' + d.id, () => fetch(fileUrl(d)).then(r => r.text()));
export const loadImage = d => once('i:' + d.id, () => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = fileUrl(d); }));
let pdfjs;
export function pdfLib() {
  return pdfjs ??= import('/vendor/pdfjs/pdf.min.mjs').then(m => { m.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs'; return m; });
}
export const loadPdf = d => once('p:' + d.id, async () => (await pdfLib()).getDocument({ url: fileUrl(d) }).promise);
let actx;
export const loadPeaks = d => once('a:' + d.id, async () => {
  actx ??= new (window.AudioContext || window.webkitAudioContext)();
  const buf = await actx.decodeAudioData(await (await fetch(fileUrl(d))).arrayBuffer());
  const ch = buf.getChannelData(0), n = 160, step = Math.floor(ch.length / n), peaks = [];
  for (let i = 0; i < n; i++) { let m = 0; for (let j = i * step; j < (i + 1) * step; j += 4) m = Math.max(m, Math.abs(ch[j])); peaks.push(m); }
  const max = Math.max(...peaks, 1e-3);
  return { peaks: peaks.map(p => p / max), duration: buf.duration };
});

export async function renderPdfPage(doc, pageNo, canvas, cssWidth) {
  const page = await doc.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const scale = (cssWidth / base.width) * (window.devicePixelRatio || 1);
  const vp = page.getViewport({ scale });
  canvas.width = vp.width; canvas.height = vp.height;
  canvas.style.width = cssWidth + 'px';
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
}

// ---------- parsers ----------
export function parseCsv(text, max = 60) {
  return text.trim().split(/\r?\n/).slice(0, max).map(l => {
    const out = []; let cur = '', q = false;
    for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; }
    out.push(cur); return out;
  });
}
export function parseIcs(text) {
  const g = k => text.match(new RegExp(`^${k}[^:]*:(.+)$`, 'm'))?.[1]?.trim();
  const dt = v => { const m = v?.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?/); return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}${m[7] || ''}`) : null; };
  return { summary: g('SUMMARY'), location: g('LOCATION'), description: g('DESCRIPTION')?.replace(/\\n/g, '\n'), start: dt(g('DTSTART')), end: dt(g('DTEND')) };
}
export function parseEml(text) {
  const [head, ...rest] = text.split(/\r?\n\r?\n/);
  const h = k => head.match(new RegExp(`^${k}:\\s*(.+)$`, 'mi'))?.[1]?.trim();
  return { from: h('From'), to: h('To'), subject: h('Subject'), date: h('Date'), body: rest.join('\n\n') };
}
const KW = /\b(def|class|return|if|else|elif|for|while|import|from|as|with|const|let|var|function|async|await|export|new|in|of|true|false|None|True|False|null)\b/g;
export function highlight(code) {
  const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  return code.split('\n').map(line => {
    const ci = line.search(/(^|\s)(#|\/\/)/);
    const [src, com] = ci >= 0 ? [line.slice(0, ci), line.slice(ci)] : [line, ''];
    return esc(src).replace(/(&quot;|"[^"]*"|'[^']*')/g, '<span class="s">$1</span>').replace(KW, '<span class="k">$1</span>').replace(/(@\w+)/g, '<span class="d">$1</span>')
      + (com ? `<span class="c">${esc(com)}</span>` : '');
  }).join('\n');
}
const fmtSize = n => n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B';

// ---------- full viewers for the document pane ----------
export async function mountViewer(el, d) {
  const f = d.file;
  const chip = `<div class="filechip"><b>${f.ext.toUpperCase()}</b><span>${escHtml(f.name)}</span><span class="dim">${fmtSize(f.size)} · ${f.mime}</span><a href="${fileUrl(d)}" target="_blank" rel="noopener">Open original ↗</a></div>`;
  el.innerHTML = chip + '<div class="vbody"><div class="dim">Loading…</div></div>';
  const body = el.querySelector('.vbody');
  try {
    if (f.mime.startsWith('image/')) {
      body.innerHTML = `<img class="vimg" src="${fileUrl(d)}" alt="${escHtml(f.name)}">`;
    } else if (f.ext === 'pdf') {
      const pdf = await loadPdf(d);
      body.innerHTML = `<div class="dim">${pdf.numPages} page${pdf.numPages > 1 ? 's' : ''}</div>`;
      for (let i = 1; i <= Math.min(pdf.numPages, 12); i++) {
        const c = document.createElement('canvas'); c.className = 'vpage';
        body.appendChild(c);
        await renderPdfPage(pdf, i, c, Math.min(body.clientWidth || 340, 900));
      }
    } else if (f.mime.startsWith('audio/')) {
      body.innerHTML = `<canvas class="vwave" height="70"></canvas><audio controls preload="metadata" src="${fileUrl(d)}"></audio>`;
      const c = body.querySelector('canvas'), audio = body.querySelector('audio');
      const { peaks } = await loadPeaks(d);
      const draw = () => drawWave(c, peaks, audio.duration ? audio.currentTime / audio.duration : 0);
      draw();
      audio.addEventListener('timeupdate', draw);
      c.onclick = e => { if (audio.duration) { audio.currentTime = (e.offsetX / c.clientWidth) * audio.duration; audio.play(); } };
    } else if (f.mime.startsWith('video/')) {
      body.innerHTML = `<video class="vimg" controls src="${fileUrl(d)}"></video>`;
    } else if (f.ext === 'csv' || f.ext === 'tsv') {
      const rows = parseCsv(await fetchText(d));
      const num = v => /^-?\$?[\d,]+(\.\d+)?$/.test(v.trim());
      const total = rows[0]?.findIndex(h => /amount|total|price/i.test(h));
      const sum = total >= 0 ? rows.slice(1).reduce((s, r) => s + (parseFloat(String(r[total]).replace(/[$,]/g, '')) || 0), 0) : null;
      body.innerHTML = `<div class="vtable"><table><thead><tr>${rows[0].map(h => `<th>${escHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map(r => `<tr>${r.map(v => `<td class="${num(v) ? 'n' : ''}">${escHtml(v)}</td>`).join('')}</tr>`).join('')}</tbody>
        ${sum !== null ? `<tfoot><tr>${rows[0].map((_, i) => `<td class="${i === total ? 'n' : ''}">${i === 0 ? '<b>Total</b>' : i === total ? `<b>${sum.toFixed(2)}</b>` : ''}</td>`).join('')}</tr></tfoot>` : ''}</table></div>`;
    } else if (f.ext === 'ics') {
      const ev = parseIcs(await fetchText(d));
      const s = ev.start;
      body.innerHTML = `<div class="vcal"><div class="cal"><div class="mo">${s?.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}</div><div class="dd">${s?.getDate()}</div><div class="wd">${s?.toLocaleDateString(undefined, { weekday: 'short' })}</div></div>
        <div><div class="sum">${escHtml(ev.summary || '')}</div><div class="dim">${s?.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}${ev.end ? ' – ' + ev.end.toLocaleString(undefined, { weekday: ev.end.toDateString() !== s?.toDateString() ? 'short' : undefined, hour: 'numeric', minute: '2-digit' }) : ''}</div>
        ${ev.location ? `<div>📍 ${escHtml(ev.location)}</div>` : ''}${ev.description ? `<div class="desc">${escHtml(ev.description)}</div>` : ''}
        <a href="${fileUrl(d)}" download="${escHtml(f.name)}">Add to calendar</a></div></div>`;
    } else if (f.ext === 'eml') {
      const m = parseEml(await fetchText(d));
      body.innerHTML = `<div class="vmail"><div><span class="dim">From</span> ${escHtml(m.from || '')}</div><div><span class="dim">To</span> ${escHtml(m.to || '')}</div><div><span class="dim">Date</span> ${escHtml(m.date || '')}</div><div class="subj">${escHtml(m.subject || '')}</div><pre>${escHtml(m.body.trim())}</pre></div>`;
    } else if (f.ext === 'html' || f.ext === 'htm') {
      body.innerHTML = `<div class="vbrowser"><div class="bar"><i></i><i></i><i></i><span>${escHtml(f.name)}</span></div><iframe sandbox src="${fileUrl(d)}"></iframe></div>`;
    } else if (TEXTY.has(f.ext)) {
      body.innerHTML = `<pre class="vcode">${highlight(await fetchText(d))}</pre>`;
    } else {
      body.innerHTML = `<div class="dim">No preview for .${f.ext} — use Open original.</div>`;
    }
  } catch (e) {
    body.innerHTML = `<div class="dim">Couldn’t render this file: ${escHtml(e.message)}</div>`;
  }
}

export function drawWave(c, peaks, progress = 0) {
  const dpr = window.devicePixelRatio || 1, W = c.clientWidth || 320, H = c.clientHeight || 70;
  c.width = W * dpr; c.height = H * dpr;
  const g = c.getContext('2d'); g.scale(dpr, dpr);
  const bw = W / peaks.length;
  peaks.forEach((p, i) => {
    g.fillStyle = i / peaks.length < progress ? '#f76b15' : 'rgba(247,107,21,.35)';
    const h = Math.max(2, p * (H - 6));
    g.fillRect(i * bw + 0.5, (H - h) / 2, Math.max(1, bw - 1.5), h);
  });
}

// ---------- thumbnails for the Atlas (drawn to a canvas, uploaded as a GPU texture) ----------
// w×h canvas; `scale` lets the Atlas ask for a sharper version when you zoom in close.
export async function drawThumb(canvas, d, { dark = false, scale = 1, now = Date.now() } = {}) {
  const W = 320, H = 400;
  canvas.width = W * scale; canvas.height = H * scale;
  const g = canvas.getContext('2d');
  g.scale(scale, scale);
  const C = dark ? { bg: '#1f1e1b', ink: '#efeee9', mut: '#9a958b', line: '#34322d', soft: '#2a2925' } : { bg: '#ffffff', ink: '#1d1c1a', mut: '#7b766d', line: '#e7e4dc', soft: '#f5f3ee' };
  const col = TYPE_COLOR[d.type] || '#888';
  const future = d.created > now;
  // card
  roundRect(g, 0, 0, W, H, 18); g.fillStyle = future ? mixHex(C.bg, '#0090ff', 0.07) : C.bg; g.fill();
  g.save(); roundRect(g, 0, 0, W, H, 18); g.clip();
  g.fillStyle = col; g.fillRect(0, 0, W, 6);
  // header
  g.font = '600 13px ui-sans-serif, -apple-system, sans-serif'; g.fillStyle = col;
  g.fillText(`${TYPE_ICON[d.type] || '•'}  ${(d.file?.ext || d.type).toUpperCase()}`, 16, 30);
  g.fillStyle = C.mut; g.font = '12px ui-sans-serif, -apple-system, sans-serif'; g.textAlign = 'right';
  g.fillText(new Date(d.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' + new Date(d.created).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }), W - 16, 30);
  g.textAlign = 'left';
  g.fillStyle = C.ink; g.font = '700 18px ui-sans-serif, -apple-system, sans-serif';
  let y = wrapText(g, d.title, 16, 58, W - 32, 22, 2);
  g.fillStyle = C.mut; g.font = '12px ui-sans-serif, -apple-system, sans-serif';
  g.fillText(d.author.length > 40 ? d.author.slice(0, 38) + '…' : d.author, 16, y + 2);
  y += 16;
  const box = { x: 12, y, w: W - 24, h: H - y - 12 };
  try { await drawBody(g, d, box, C, col); } catch { textBlock(g, d.snippet, box, C); }
  if (d.unread) { g.strokeStyle = '#e5484d'; g.lineWidth = 6; roundRect(g, 3, 3, W - 6, H - 6, 16); g.stroke(); }
  g.restore();
  if (future) { g.setLineDash([10, 8]); g.strokeStyle = '#0090ff'; g.lineWidth = 3; roundRect(g, 1.5, 1.5, W - 3, H - 3, 17); g.stroke(); }
  return canvas;
}

async function drawBody(g, d, b, C, col) {
  const f = d.file;
  g.save(); roundRect(g, b.x, b.y, b.w, b.h, 10); g.clip();
  if (f && f.mime.startsWith('image/')) {
    const img = await loadImage(d);
    const r = Math.max(b.w / img.width, b.h / img.height);
    g.fillStyle = C.soft; g.fillRect(b.x, b.y, b.w, b.h);
    if (f.ext === 'svg') { const s = Math.min(b.w / img.width, b.h / img.height); g.drawImage(img, b.x + (b.w - img.width * s) / 2, b.y + (b.h - img.height * s) / 2, img.width * s, img.height * s); }
    else g.drawImage(img, b.x + (b.w - img.width * r) / 2, b.y + (b.h - img.height * r) / 2, img.width * r, img.height * r);
  } else if (f?.ext === 'pdf') {
    const pdf = await loadPdf(d), page = await pdf.getPage(1);
    const vp1 = page.getViewport({ scale: 1 }), s = (b.w * 2) / vp1.width, vp = page.getViewport({ scale: s });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await page.render({ canvas: c, canvasContext: c.getContext('2d'), viewport: vp }).promise;
    g.fillStyle = '#e9e6df'; g.fillRect(b.x, b.y, b.w, b.h);
    g.drawImage(c, b.x + 8, b.y + 8, b.w - 16, (b.w - 16) * vp.height / vp.width);
    if (pdf.numPages > 1) { g.fillStyle = 'rgba(0,0,0,.6)'; roundRect(g, b.x + b.w - 70, b.y + b.h - 30, 60, 22, 11); g.fill(); g.fillStyle = '#fff'; g.font = '600 11px ui-sans-serif'; g.fillText(`${pdf.numPages} pages`, b.x + b.w - 62, b.y + b.h - 15); }
  } else if (f && f.mime.startsWith('audio/')) {
    const { peaks, duration } = await loadPeaks(d);
    g.fillStyle = C.soft; g.fillRect(b.x, b.y, b.w, b.h);
    const mid = b.y + b.h / 2 - 10, bw = b.w / 64;
    for (let i = 0; i < 64; i++) { const p = peaks[Math.floor(i * peaks.length / 64)], h = Math.max(3, p * b.h * 0.6); g.fillStyle = col; g.globalAlpha = .85; roundRect(g, b.x + i * bw + 1, mid - h / 2, bw - 2, h, 2); g.fill(); }
    g.globalAlpha = 1; g.fillStyle = col; g.beginPath(); g.arc(b.x + 34, b.y + b.h - 30, 18, 0, 7); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.moveTo(b.x + 28, b.y + b.h - 40); g.lineTo(b.x + 43, b.y + b.h - 30); g.lineTo(b.x + 28, b.y + b.h - 20); g.fill();
    g.fillStyle = C.mut; g.font = '600 13px ui-sans-serif'; g.fillText(`0:${String(Math.round(duration)).padStart(2, '0')}`, b.x + 62, b.y + b.h - 25);
  } else if (f?.ext === 'csv' || f?.ext === 'tsv') {
    const rows = parseCsv(await fetchText(d), 14), cw = b.w / rows[0].length;
    rows.forEach((r, i) => {
      const yy = b.y + i * 22;
      g.fillStyle = i === 0 ? mixHex(C.bg, col, .18) : i % 2 ? C.soft : C.bg; g.fillRect(b.x, yy, b.w, 22);
      g.fillStyle = i === 0 ? C.ink : C.mut; g.font = `${i === 0 ? '600 ' : ''}11px ui-sans-serif`;
      r.forEach((v, j) => g.fillText(String(v).slice(0, 13), b.x + j * cw + 6, yy + 15));
    });
    g.strokeStyle = C.line; for (let j = 1; j < rows[0].length; j++) { g.beginPath(); g.moveTo(b.x + j * cw, b.y); g.lineTo(b.x + j * cw, b.y + b.h); g.stroke(); }
  } else if (f?.ext === 'ics') {
    const ev = parseIcs(await fetchText(d)), s = ev.start || new Date(d.created);
    g.fillStyle = C.soft; g.fillRect(b.x, b.y, b.w, b.h);
    const cx = b.x + 20, cy = b.y + 18;
    g.fillStyle = '#ffffff'; roundRect(g, cx, cy, 110, 120, 14); g.fill();
    g.fillStyle = '#e5484d'; g.fillRect(cx, cy, 110, 30);
    g.fillStyle = '#fff'; g.font = '700 14px ui-sans-serif'; g.textAlign = 'center'; g.fillText(s.toLocaleDateString(undefined, { month: 'short' }).toUpperCase(), cx + 55, cy + 21);
    g.fillStyle = '#1d1c1a'; g.font = '700 54px ui-sans-serif'; g.fillText(String(s.getDate()), cx + 55, cy + 92);
    g.font = '12px ui-sans-serif'; g.fillStyle = '#7b766d'; g.fillText(s.toLocaleDateString(undefined, { weekday: 'long' }), cx + 55, cy + 112); g.textAlign = 'left';
    g.fillStyle = C.ink; g.font = '600 14px ui-sans-serif';
    wrapText(g, s.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + (ev.location ? ' · ' + ev.location : ''), cx, cy + 150, b.w - 40, 18, 2);
  } else if (f?.ext === 'eml' || d.type === 'email') {
    const m = f?.ext === 'eml' ? parseEml(await fetchText(d)) : { from: d.author, subject: d.title, body: d.snippet };
    g.fillStyle = C.soft; g.fillRect(b.x, b.y, b.w, 52);
    g.fillStyle = col; g.beginPath(); g.arc(b.x + 24, b.y + 26, 15, 0, 7); g.fill();
    g.fillStyle = '#fff'; g.font = '700 14px ui-sans-serif'; g.textAlign = 'center'; g.fillText((m.from || '?').replace(/^"|^\W+/, '')[0].toUpperCase(), b.x + 24, b.y + 31); g.textAlign = 'left';
    g.fillStyle = C.ink; g.font = '600 12px ui-sans-serif'; g.fillText((m.from || '').slice(0, 34), b.x + 48, b.y + 22);
    g.fillStyle = C.mut; g.font = '11px ui-sans-serif'; g.fillText('to me', b.x + 48, b.y + 38);
    textBlock(g, m.body, { x: b.x, y: b.y + 60, w: b.w, h: b.h - 60 }, C);
  } else if (f && (f.ext === 'html' || f.ext === 'htm')) {
    g.fillStyle = C.soft; g.fillRect(b.x, b.y, b.w, 26);
    ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => { g.fillStyle = c; g.beginPath(); g.arc(b.x + 14 + i * 14, b.y + 13, 4.5, 0, 7); g.fill(); });
    g.fillStyle = C.bg; roundRect(g, b.x + 60, b.y + 5, b.w - 70, 16, 8); g.fill();
    g.fillStyle = C.mut; g.font = '10px ui-sans-serif'; g.fillText(f.name.slice(0, 30), b.x + 70, b.y + 16);
    textBlock(g, d.snippet, { x: b.x, y: b.y + 32, w: b.w, h: b.h - 32 }, C, 'serif');
  } else if (f && TEXTY.has(f.ext)) {
    const text = await fetchText(d);
    g.fillStyle = '#16151a'; g.fillRect(b.x, b.y, b.w, b.h);
    g.font = '11px ui-monospace, Menlo, monospace';
    text.split('\n').slice(0, 20).forEach((l, i) => {
      const yy = b.y + 18 + i * 15;
      g.fillStyle = /^\s*(#|\/\/)/.test(l) ? '#7c7a85' : /\b(def|class|import|from|return|const|function)\b/.test(l) ? '#c792ea' : /["']/.test(l) ? '#c3e88d' : '#e4e2ea';
      g.fillText(l.slice(0, 44), b.x + 10, yy);
    });
  } else if (d.type === 'turn' || d.type === 'summary') {
    const bubble = d.author === 'me' ? C.soft : mixHex(C.bg, col, .12);
    g.fillStyle = bubble; roundRect(g, b.x, b.y, b.w, b.h, 14); g.fill();
    textBlock(g, d.snippet, { x: b.x + 4, y: b.y + 4, w: b.w - 8, h: b.h - 8 }, C);
  } else {
    textBlock(g, d.snippet, b, C);
  }
  g.restore();
}

function textBlock(g, text, b, C, family = 'ui-sans-serif, -apple-system, sans-serif') {
  g.fillStyle = C.ink; g.globalAlpha = .82; g.font = `13px ${family}`;
  wrapText(g, text || '', b.x + 6, b.y + 18, b.w - 12, 18, Math.floor((b.h - 8) / 18));
  g.globalAlpha = 1;
}
function wrapText(g, text, x, y, w, lh, maxLines) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  let line = '', n = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? line + ' ' + words[i] : words[i];
    if (g.measureText(test).width > w && line) {
      n++;
      if (n === maxLines) { g.fillText(line.replace(/.{0,2}$/, '') + '…', x, y); return y + lh; }
      g.fillText(line, x, y); y += lh; line = words[i];
    } else line = test;
  }
  if (line) { g.fillText(line, x, y); y += lh; }
  return y;
}
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }
function mixHex(a, b, t) {
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [A, B] = [p(a), p(b)];
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
export function escHtml(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
