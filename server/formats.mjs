import zlib from 'node:zlib';

// Well-known file formats: how a file maps to a document type, its MIME type, and what
// text (if any) we can pull out of it so `find` works on its contents.

export const MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', svg: 'image/svg+xml',
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', ics: 'text/calendar',
  eml: 'message/rfc822', html: 'text/html', htm: 'text/html', txt: 'text/plain', md: 'text/markdown',
  js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', py: 'text/x-python', rb: 'text/plain',
  go: 'text/plain', rs: 'text/plain', java: 'text/plain', c: 'text/plain', cpp: 'text/plain', sh: 'text/plain',
  css: 'text/css', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

const CODE = new Set(['js', 'mjs', 'ts', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'sh', 'css']);

export function typeFor(ext) {
  if (ext === 'pdf' || ext === 'docx' || ext === 'pptx') return 'file';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic'].includes(ext)) return 'photo';
  if (ext === 'svg') return 'image';
  if (['wav', 'mp3', 'm4a', 'ogg', 'flac'].includes(ext)) return 'audio';
  if (['mp4', 'mov', 'webm'].includes(ext)) return 'video';
  if (['csv', 'tsv', 'xlsx'].includes(ext)) return 'sheet';
  if (ext === 'ics') return 'event';
  if (ext === 'eml') return 'email';
  if (ext === 'html' || ext === 'htm') return 'bookmark';
  if (CODE.has(ext)) return 'code';
  if (ext === 'json' || ext === 'xml' || ext === 'yaml' || ext === 'yml') return 'data';
  if (ext === 'md' || ext === 'txt') return 'note';
  return 'file';
}

export function isText(ext) {
  return CODE.has(ext) || ['csv', 'tsv', 'json', 'ics', 'eml', 'html', 'htm', 'txt', 'md', 'xml', 'yaml', 'yml', 'svg'].includes(ext);
}

// Pull attributes and searchable text out of a file's bytes.
export function extract(ext, buf, name) {
  const out = { title: name, body: '' };
  if (ext === 'pdf') { out.body = pdfText(buf).slice(0, 8000); return out; }
  if (!isText(ext)) return out;
  let text = buf.subarray(0, 64 * 1024).toString('utf8');
  if (ext === 'eml') {
    const [head, ...rest] = text.split(/\r?\n\r?\n/);
    const h = k => head.match(new RegExp(`^${k}:\\s*(.+)$`, 'mi'))?.[1]?.trim();
    out.title = h('Subject') || name;
    const from = h('From');
    if (from) out.author = (from.match(/<([^>]+)>/)?.[1] || from).toLowerCase();
    const date = Date.parse(h('Date') || '');
    if (Number.isFinite(date)) out.created = date;
    text = rest.join('\n\n');
  } else if (ext === 'ics') {
    const g = k => text.match(new RegExp(`^${k}[^:]*:(.+)$`, 'm'))?.[1]?.trim();
    out.title = g('SUMMARY') || name;
    const dt = g('DTSTART');
    const m = dt?.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?/);
    if (m) out.at = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4] || '09'}:${m[5] || '00'}:${m[6] || '00'}${m[7] || ''}`);
    text = [g('SUMMARY'), g('LOCATION') && `Location: ${g('LOCATION')}`, g('DESCRIPTION')?.replace(/\\n/g, '\n')].filter(Boolean).join('\n');
  } else if (ext === 'html' || ext === 'htm') {
    out.title = text.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() || name;
    text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ');
  } else if (ext === 'svg') {
    out.title = text.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() || name;
    text = [...text.matchAll(/<text[^>]*>([^<]*)<\/text>/gi)].map(m => m[1]).join(' · ');
  } else if (ext === 'md') {
    out.title = text.match(/^#\s+(.+)$/m)?.[1] || name;
  }
  out.body = text.trim().slice(0, 8000);
  return out;
}

// Text from a PDF's content streams: inflate FlateDecode streams, then collect the strings
// shown by Tj / TJ / ' operators. Good enough for search on most text PDFs; fonts with
// custom encodings come out garbled, and scanned PDFs have no text at all.
export function pdfText(buf) {
  const src = buf.toString('latin1'), out = [];
  const re = /<<([^]*?)>>\s*stream\r?\n/g;
  let m;
  while ((m = re.exec(src)) && out.length < 4000) {
    const start = m.index + m[0].length, end = src.indexOf('endstream', start);
    if (end < 0) break;
    let data = buf.subarray(start, end);
    if (/\/FlateDecode/.test(m[1])) { try { data = zlib.inflateSync(data); } catch { continue; } }
    else if (/\/Filter/.test(m[1])) continue;
    const text = data.toString('latin1');
    if (!/T[Jj*']|'/.test(text)) continue;
    for (const t of text.matchAll(/\[((?:\\.|[^\]])*)\]\s*TJ|\(((?:\\.|[^\\)])*)\)\s*(?:Tj|')|(T\*|Td|TD|ET)/g)) {
      if (t[3]) { out.push('\n'); continue; }
      const s = t[1] !== undefined ? [...t[1].matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map(x => x[1]).join('') : t[2];
      out.push(s.replace(/\\([nrt()\\])/g, (_, c) => ({ n: '\n', r: '', t: ' ' })[c] ?? c).replace(/\\\d{3}/g, ' '));
    }
    re.lastIndex = end;
  }
  return out.join('').replace(/\n{3,}/g, '\n\n').replace(/[^\S\n]+/g, ' ').trim();
}
