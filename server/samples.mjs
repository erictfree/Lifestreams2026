// Real files in well-known formats for the sample lifestream — generated, so the repo
// carries no binaries: PNG photos, PDF documents, WAV voice memos, SVG drawings, CSV,
// iCalendar, RFC 822 email, HTML pages and code.

import zlib from 'node:zlib';

// ---------- PNG ----------
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = clamp(r); raw[o + 1] = clamp(g); raw[o + 2] = clamp(b);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
const mix = (a, b, t) => a + (b - a) * t;
function hash(x, y, s) { const n = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return n - Math.floor(n); }
function smooth(x, y, s) {   // value noise
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return mix(mix(hash(xi, yi, s), hash(xi + 1, yi, s), u), mix(hash(xi, yi + 1, s), hash(xi + 1, yi + 1, s), u), v);
}

// Scenes, deterministic per seed.
export const scenes = {
  // an opened-up wall: studs, insulation, old wiring
  wall(seed, w = 480, h = 360) {
    return png(w, h, (x, y) => {
      const n = smooth(x / 18, y / 18, seed) * 30 + hash(x, y, seed) * 10;
      const stud = (x + seed * 37) % 120 < 22;
      if (stud) return [168 + n, 122 + n * .8, 76 + n * .5];
      const wire = Math.abs(y - (140 + Math.sin(x / 40 + seed) * 30)) < 2.5 || Math.abs(y - (230 + Math.cos(x / 55 + seed) * 20)) < 2;
      if (wire) return [40, 36, 30];
      const k = smooth(x / 6, y / 30, seed + 3);
      return [222 + n - k * 40, 196 + n - k * 50, 120 + n - k * 40];   // insulation
    });
  },
  // golden-hour porch photo
  porch(seed, w = 480, h = 360) {
    const sun = 120 + (seed % 5) * 50;
    return png(w, h, (x, y) => {
      const t = y / h, d = Math.hypot(x - sun, y - 150);
      let r = mix(255, 120, t), g = mix(170, 60, t), b = mix(90, 90, t);
      r += Math.max(0, 60 - d * .5); g += Math.max(0, 50 - d * .5);
      const roof = y < 40 + x * .08;
      const rail = y > 250 && (x % 34 < 5 || (y > 250 && y < 258));
      const people = [90, 170, 260, 340].some((px, i) => { const hx = px + (seed * 13 + i * 7) % 20; return (Math.hypot(x - hx, y - 205) < 16) || (Math.abs(x - hx) < 22 && y > 222 && y < 330); });
      if (roof || rail) return [52, 38, 34];
      if (people) return [60 + hash(x, y, seed) * 10, 42, 48];
      if (y > 330) return [96, 70, 52];
      return [r, g, b];
    });
  },
  // a tiled backsplash sample
  tile(seed, w = 480, h = 360) {
    const hue = [[214, 228, 222], [196, 214, 190], [236, 232, 222]][seed % 3];
    return png(w, h, (x, y) => {
      const tx = x % 80, ty = y % 40, grout = tx < 3 || ty < 3;
      if (grout) return [180, 176, 168];
      const n = smooth((x + (Math.floor(y / 40) % 2) * 40) / 30, y / 20, seed) * 26 - 13 + hash(x, y, seed) * 6;
      return [hue[0] + n, hue[1] + n, hue[2] + n];
    });
  },
};

// ---------- PDF ----------
const esc = s => String(s).replace(/[\\()]/g, m => '\\' + m).replace(/[^\x20-\x7e]/g, '-');
function wrap(text, n = 92) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/)) { if ((line + ' ' + w).trim().length > n) { out.push(line); line = w; } else line = (line + ' ' + w).trim(); }
    out.push(line);
  }
  return out;
}
// pages: [{ title, subtitle, lines: [...], table: [[...cells]], total }]
export function pdf(pages) {
  const objs = [];
  const add = s => { objs.push(s); return objs.length; };
  const catalog = add(null), pagesId = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const kids = [];
  for (const pg of pages) {
    let c = '';
    if (pg.letterhead) c += `0.76 0.25 0.05 rg 0 752 612 40 re f 1 1 1 rg BT /F2 16 Tf 72 766 Td (${esc(pg.letterhead)}) Tj ET 0 0 0 rg\n`;
    let y = pg.letterhead ? 710 : 730;
    c += `BT /F2 20 Tf 72 ${y} Td (${esc(pg.title || '')}) Tj ET\n`; y -= 20;
    if (pg.subtitle) { c += `0.45 g BT /F1 10 Tf 72 ${y} Td (${esc(pg.subtitle)}) Tj ET 0 g\n`; y -= 14; }
    c += `0.85 g 72 ${y} 468 0.8 re f 0 g\n`; y -= 22;
    for (const l of wrap((pg.lines || []).join('\n'))) { c += `BT /F1 11 Tf 72 ${y} Td (${esc(l)}) Tj ET\n`; y -= 15; if (y < 80) break; }
    if (pg.table) {
      y -= 8;
      pg.table.forEach((row, i) => {
        if (i === 0) c += `0.94 g 72 ${y - 5} 468 18 re f 0 g\n`;
        c += `BT /${i === 0 ? 'F2' : 'F1'} 10 Tf 78 ${y} Td (${esc(row[0])}) Tj ET BT /${i === 0 ? 'F2' : 'F1'} 10 Tf 470 ${y} Td (${esc(row[1])}) Tj ET\n`;
        y -= 18;
      });
      if (pg.total) { c += `72 ${y + 8} 468 0.8 re f BT /F2 12 Tf 78 ${y - 8} Td (Total) Tj ET BT /F2 12 Tf 462 ${y - 8} Td (${esc(pg.total)}) Tj ET\n`; }
    }
    if (pg.footer) c += `0.5 g BT /F1 8 Tf 72 40 Td (${esc(pg.footer)}) Tj ET\n`;
    const content = add(`<< /Length ${Buffer.byteLength(c)} >>\nstream\n${c}endstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---------- WAV: a "voice memo" — voiced syllables with formants and pauses ----------
export function voiceMemo(seed, seconds = 4, rate = 16000) {
  const n = Math.floor(seconds * rate);
  const data = Buffer.alloc(n * 2);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const syl = Math.floor(t * 4.2), st = t * 4.2 - syl;
    const voiced = hash(syl, 1, seed) > 0.18 && !(syl % 7 === 6);
    const env = voiced ? Math.sin(Math.PI * st) ** 1.5 : 0;
    const f0 = 120 + 40 * hash(syl, 2, seed) + 10 * Math.sin(t * 3);
    phase += 2 * Math.PI * f0 / rate;
    const f1 = 500 + 400 * hash(syl, 3, seed), f2 = 1400 + 900 * hash(syl, 4, seed);
    let s = 0;
    for (let k = 1; k <= 18; k++) { const fk = f0 * k; s += Math.sin(phase * k) * (Math.exp(-(((fk - f1) / 220) ** 2)) + 0.6 * Math.exp(-(((fk - f2) / 300) ** 2)) + 0.05 / k); }
    s = s * env * 0.28 + (hash(i, 9, seed) - 0.5) * 0.01;
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(s * 32767))), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// ---------- SVG: kitchen floor plan ----------
export function kitchenPlan(variant = 0) {
  const island = variant % 2 ? { x: 150, y: 150, w: 200, h: 90 } : { x: 140, y: 160, w: 220, h: 80 };
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 400" width="520" height="400">
<title>Kitchen plan v${variant + 1}</title>
<rect width="520" height="400" fill="#f8f7f3"/>
<g stroke="#2b2a27" stroke-width="8" fill="none"><path d="M30 30 H490 V370 H300 M220 370 H30 Z"/></g>
<g fill="#e7dccb" stroke="#8a7a62" stroke-width="2">
 <rect x="38" y="38" width="444" height="64"/><rect x="38" y="102" width="64" height="200"/>
 <rect x="${island.x}" y="${island.y}" width="${island.w}" height="${island.h}" fill="#d9c6a5"/>
</g>
<rect x="210" y="44" width="90" height="52" rx="6" fill="#cfe0ea" stroke="#5b7a8c" stroke-width="2"/>
<g fill="#2b2a27" stroke="none"><circle cx="400" cy="70" r="9"/><circle cx="430" cy="70" r="9"/><circle cx="400" cy="90" r="0"/></g>
<g font-family="Helvetica, Arial" font-size="13" fill="#2b2a27">
 <text x="232" y="74">Sink</text><text x="388" y="118">Range (36&quot; induction)</text>
 <text x="${island.x + 50}" y="${island.y + 46}">Island ${island.w / 30 | 0}ft, seating</text>
 <text x="44" y="330">Pantry</text><text x="236" y="392">Door to dining</text>
 <text x="330" y="300" fill="#8a7a62">42&quot; aisles</text>
</g>
<g stroke="#c2410c" stroke-width="1.5" stroke-dasharray="4 4"><path d="M${island.x} ${island.y + island.h + 30} H${island.x + island.w}"/></g>
</svg>`);
}

// ---------- text formats ----------
export function csvExpenses(month, rows) {
  return Buffer.from('date,vendor,category,amount\n' + rows.map(r => `${month}-${String(r.d).padStart(2, '0')},${r.v},${r.c},${r.a.toFixed(2)}`).join('\n') + '\n');
}
export function ics({ uid, start, minutes = 90, summary, location, description }) {
  const f = t => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return Buffer.from(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Lifestreams//Sample//EN', 'BEGIN:VEVENT', `UID:${uid}`,
    `DTSTAMP:${f(Date.now())}`, `DTSTART:${f(start)}`, `DTEND:${f(start + minutes * 60000)}`, `SUMMARY:${summary}`,
    location && `LOCATION:${location}`, description && `DESCRIPTION:${description.replace(/\n/g, '\\n')}`, 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n') + '\r\n');
}
export function eml({ from, to, subject, date, body }) {
  return Buffer.from(`From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${new Date(date).toUTCString()}\r\nMessage-ID: <${date}.${subject.length}@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`);
}
export function articleHtml(title, paras) {
  return Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><article><h1>${title}</h1>${paras.map(p => `<p>${p}</p>`).join('')}</article></body></html>`);
}
