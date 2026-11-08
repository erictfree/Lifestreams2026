// The find/substream query language.
//
//   kitchen permit            words are ANDed (1997 "keyword mode")
//   a OR b, NOT c, -c         boolean mode
//   "exact phrase"
//   type:email from:alice     attribute filters (from: matches author)
//   after:2026-01-01 before:2026-06-01 frozen:false future:true
//   ~"house renovation"       semantic predicate — matched via LLM-expanded terms when
//                             available, else the phrase's own words
//   like:<doc id>             substream by instance: docs sharing vocabulary with that doc

const STOP = new Set('the a an and or of to in on for with from about this that what when where who how is are was were be it my me i you your our we at by as did does do'.split(' '));

export function words(text) {
  return (text.toLowerCase().match(/[a-z0-9$][a-z0-9$'.-]*/g) || [])
    .map(w => w.replace(/[.'-]+$/, ''))
    .filter(w => w.length > 2 && !STOP.has(w));
}

function tokenize(q) {
  return q.match(/-?~?"[^"]*"|\S+/g) || [];
}

// Compile a query string into a predicate (doc, ctx) => boolean.
// ctx = { now, semantic: Map(phrase -> terms[]), docById }
export function compile(q) {
  q = (q || '').trim();
  if (!q || q === '*') return () => true;
  const clauses = q.split(/\s+OR\s+/).map(clause => {
    const preds = [];
    let negate = false;
    for (let tok of tokenize(clause)) {
      if (tok === 'AND') continue;
      if (tok === 'NOT') { negate = true; continue; }
      if (tok.startsWith('-') && tok.length > 1) { negate = true; tok = tok.slice(1); }
      const p = term(tok);
      preds.push(negate ? (d, c) => !p(d, c) : p);
      negate = false;
    }
    return (d, c) => preds.every(p => p(d, c));
  });
  return (d, c) => clauses.some(f => f(d, c));
}

function haystack(d) {
  return d._hay ??= `${d.title || ''}\n${d.body || ''}\n${d.author || ''}\n${d.type}`.toLowerCase();
}

function term(tok) {
  let m;
  if ((m = tok.match(/^type:(\S+)$/))) return d => d.type === m[1];
  if ((m = tok.match(/^(?:from|author):(\S+)$/))) {
    const v = m[1].toLowerCase();
    return d => (d.author || '').toLowerCase().includes(v) || (d.from || '').toLowerCase().includes(v);
  }
  if ((m = tok.match(/^after:(\S+)$/))) { const t = Date.parse(m[1]); return d => d.created >= t; }
  if ((m = tok.match(/^before:(\S+)$/))) { const t = Date.parse(m[1]); return d => d.created < t; }
  if ((m = tok.match(/^frozen:(true|false)$/))) { const v = m[1] === 'true'; return d => !!d.frozen === v; }
  if ((m = tok.match(/^future:(true|false)$/))) { const v = m[1] === 'true'; return (d, c) => (d.created > c.now) === v; }
  if ((m = tok.match(/^id:(\S+)$/))) return d => d.id === m[1];
  if ((m = tok.match(/^like:(\S+)$/))) {
    const id = m[1];
    return (d, c) => {
      const src = c.docById(id);
      if (!src || src.id === d.id) return false;
      const want = (src._words ??= new Set(words(`${src.title} ${src.body}`)));
      const have = (d._words ??= new Set(words(`${d.title} ${d.body}`)));
      let n = 0;
      for (const w of want) if (have.has(w) && ++n >= 3) return true;
      return false;
    };
  }
  if ((m = tok.match(/^~"?([^"]*)"?$/))) {
    const phrase = m[1].trim().toLowerCase();
    const own = words(phrase);
    let cachedTerms, res;
    return (d, c) => {
      const terms = c.semantic.get(phrase) || own;
      if (terms !== cachedTerms) {   // match at word starts, so "book" doesn't hit "bookmark"
        cachedTerms = terms;
        res = terms.map(t => new RegExp('(^|[^a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:s|es)?(?![a-z])'));
      }
      const h = `${d.title || ''}\n${d.body || ''}\n${d.author || ''}`.toLowerCase();
      return res.some(r => r.test(h));
    };
  }
  const text = tok.replace(/^"|"$/g, '').toLowerCase();
  return d => haystack(d).includes(text);
}

// Semantic predicates in a query, so the server can expand them.
export function semanticPhrases(q) {
  return [...(q || '').matchAll(/~"?([^"\s][^"]*)"?/g)].map(m => m[1].trim().toLowerCase());
}

// Heuristic used by the find/ask box: does this look like a query or a question?
export function looksLikeQuestion(text) {
  const t = text.trim();
  if (/\b\w+:\S/.test(t) || /~"/.test(t) || /\b(AND|OR|NOT)\b/.test(t)) return false;
  return /\?$/.test(t) || /^(what|who|whom|when|where|why|how|which|did|does|do|is|are|was|were|can|could|should|would|will|show|tell|remind|summarize|find me|list|give)\b/i.test(t) || t.split(/\s+/).length > 5;
}
