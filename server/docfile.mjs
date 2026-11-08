// Reading and writing the on-disk formats: markdown with a small frontmatter header.
// Values are plain scalars, or JSON for anything that needs quoting (arrays, objects,
// strings with special characters), so the files stay readable and grep-able.

export function parse(text) {
  const attrs = {};
  let body = text;
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 4);
    if (end !== -1) {
      for (const line of text.slice(4, end).split('\n')) {
        const m = line.match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
        if (m) attrs[m[1]] = parseValue(m[2]);
      }
      body = text.slice(end + 4).replace(/^\r?\n/, '');
    }
  }
  return { attrs, body };
}

function parseValue(v) {
  v = v.trim();
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^[[{"]/.test(v)) {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

export function serialize(attrs, body = '') {
  const lines = ['---'];
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    lines.push(`${k}: ${formatValue(v)}`);
  }
  lines.push('---');
  return lines.join('\n') + '\n' + (body ?? '') + (body && !body.endsWith('\n') ? '\n' : '');
}

function formatValue(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    const plain = v !== '' && !/^[\s[{"#]|\n|: | #|:$|\s$/.test(v) && !/^(true|false|null|-?\d+(\.\d+)?)$/.test(v);
    return plain ? v : JSON.stringify(v);
  }
  return JSON.stringify(v);
}
