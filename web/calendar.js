// Calendar: the traditional month grid over the same stream. Every document lands on its
// day — mail and notes in the past, reminders and events in the future — so the calendar
// is just another view of time, not a separate app. Pick a day for its agenda; click an
// empty moment in the future to put a reminder there (a future document is a calendar entry).

import { TYPE_COLOR, TYPE_ICON, escHtml } from './formats.js';

const CHIPS = 4;                       // entries shown per day cell before "+N more"
const EMPHASIS = new Set(['reminder', 'event', 'todo', 'wakeup']);

export function createCalendar(el, cb) {
  el.innerHTML = `<div class="cal-wrap">
    <div class="cal-main">
      <div class="cal-head">
        <div class="cal-title"></div>
        <div class="cal-nav"><button class="op small" data-nav="-1" aria-label="Previous month">‹</button><button class="op small" data-nav="0">Today</button><button class="op small" data-nav="1" aria-label="Next month">›</button></div>
      </div>
      <div class="cal-dow"></div>
      <div class="cal-grid"></div>
    </div>
    <aside class="cal-agenda"></aside>
  </div>`;
  const grid = el.querySelector('.cal-grid'), agenda = el.querySelector('.cal-agenda');
  let docs = [], byDay = new Map(), month = startOfMonth(cb.now()), day = dayKey(cb.now()), selId = null;

  // weekday header, in the locale's order (Sunday-first here)
  el.querySelector('.cal-dow').innerHTML = [...Array(7)].map((_, i) => `<div>${new Date(2026, 1, 1 + i).toLocaleDateString(undefined, { weekday: 'short' })}</div>`).join('');

  function update(list, { sel } = {}) {
    docs = list;
    if (sel !== undefined) selId = sel;
    byDay = new Map();
    for (const d of list) { const k = dayKey(d.created); (byDay.get(k) || byDay.set(k, []).get(k)).push(d); }
    for (const v of byDay.values()) v.sort((a, b) => a.created - b.created);
    render();
  }

  function render() {
    const now = cb.now(), today = dayKey(now);
    const m = new Date(month);
    el.querySelector('.cal-title').innerHTML = `${m.toLocaleDateString(undefined, { month: 'long' })} <span>${m.getFullYear()}</span>`;
    const first = new Date(m.getFullYear(), m.getMonth(), 1);
    const start = new Date(first); start.setDate(1 - first.getDay());
    const weeks = Math.ceil((first.getDay() + daysIn(m)) / 7);
    let html = '';
    for (let i = 0; i < weeks * 7; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const k = dayKey(d), list = byDay.get(k) || [];
      const inMonth = d.getMonth() === m.getMonth(), future = d.setHours(0, 0, 0, 0) > new Date(now).setHours(0, 0, 0, 0);
      // put reminders/events first in the cell, then everything else by time
      const shown = [...list.filter(x => EMPHASIS.has(x.type)), ...list.filter(x => !EMPHASIS.has(x.type))].slice(0, CHIPS);
      html += `<div class="cal-day${inMonth ? '' : ' out'}${k === today ? ' today' : ''}${k === day ? ' picked' : ''}${future ? ' future' : ''}" data-day="${k}" data-t="${+d}">
        <div class="cal-num"><span>${d.getDate()}</span>${list.length ? `<i class="cal-density" style="--n:${Math.min(1, list.length / 12)}"></i>` : ''}</div>
        ${shown.map(x => chip(x)).join('')}
        ${list.length > CHIPS ? `<div class="cal-more">+${list.length - CHIPS} more</div>` : ''}
      </div>`;
    }
    grid.style.gridTemplateRows = `repeat(${weeks}, minmax(0, 1fr))`;
    grid.innerHTML = html;
    renderAgenda();
    cb.onView?.();
  }

  function chip(d) {
    const em = EMPHASIS.has(d.type);
    return `<button class="cal-chip${em ? ' em' : ''}${d.id === selId ? ' sel' : ''}${d.unread ? ' unread' : ''}" data-id="${d.id}" style="--c:${TYPE_COLOR[d.type] || '#888'}" title="${escHtml(d.title)}">
      ${em ? `<b>${fmtTime(d.created)}</b>` : `<i></i>`}<span>${escHtml(d.title)}</span></button>`;
  }

  function renderAgenda() {
    const [y, mo, dd] = day.split('-').map(Number), d = new Date(y, mo, dd);
    const list = byDay.get(day) || [];
    const future = d.setHours(0, 0, 0, 0) > new Date(cb.now()).setHours(0, 0, 0, 0) || day === dayKey(cb.now());
    agenda.innerHTML = `<div class="ag-head"><div class="ag-date">${new Date(y, mo, dd).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
      <div class="dim">${list.length ? `${list.length} document${list.length === 1 ? '' : 's'}` : 'Nothing on this day'}</div>
      ${future ? `<button class="op small ag-new" data-new="${+new Date(y, mo, dd, 9)}">+ Reminder</button>` : ''}</div>
      <div class="ag-list">${list.map(x => `<button class="ag-item${x.id === selId ? ' sel' : ''}" data-id="${x.id}">
        <span class="ag-time">${fmtTime(x.created)}</span><span class="ag-dot" style="background:${TYPE_COLOR[x.type] || '#888'}"></span>
        <span class="ag-body"><b>${TYPE_ICON[x.type] || ''} ${escHtml(x.title)}</b><small>${escHtml(x.author === 'me' ? x.type : x.author)}</small></span></button>`).join('')}</div>`;
  }

  // ---------- interaction ----------
  el.querySelector('.cal-nav').onclick = e => {
    const n = e.target.dataset.nav;
    if (n === undefined) return;
    if (n === '0') return home();
    const m = new Date(month); m.setMonth(m.getMonth() + Number(n)); month = +m; render();
  };
  grid.addEventListener('click', e => {
    const c = e.target.closest('.cal-chip');
    if (c) { const d = docs.find(x => x.id === c.dataset.id); if (d) { selId = d.id; day = dayKey(d.created); render(); cb.onOpen?.(d); } return; }
    const cell = e.target.closest('.cal-day');
    if (!cell) return;
    if (e.target.closest('.cal-more') || cell.dataset.day !== day) { day = cell.dataset.day; render(); return; }
  });
  grid.addEventListener('dblclick', e => {
    const cell = e.target.closest('.cal-day');
    if (!cell || e.target.closest('.cal-chip')) return;
    const t = new Date(+cell.dataset.t); t.setHours(9, 0, 0, 0);
    if (t > cb.now()) cb.onNewAt?.(+t);
  });
  grid.addEventListener('mouseover', e => {
    const c = e.target.closest('.cal-chip');
    if (c) { const d = docs.find(x => x.id === c.dataset.id); if (d) cb.onHover?.(d); }
  });
  agenda.addEventListener('click', e => {
    const n = e.target.closest('[data-new]');
    if (n) return cb.onNewAt?.(+n.dataset.new);
    const it = e.target.closest('.ag-item');
    if (it) { const d = docs.find(x => x.id === it.dataset.id); if (d) { selId = d.id; render(); cb.onOpen?.(d); } }
  });
  agenda.addEventListener('mouseover', e => {
    const it = e.target.closest('.ag-item');
    if (it) { const d = docs.find(x => x.id === it.dataset.id); if (d) cb.onHover?.(d); }
  });
  let wheelAcc = 0;
  el.querySelector('.cal-main').addEventListener('wheel', e => {
    if (e.target.closest('.cal-day')?.scrollHeight > e.target.closest('.cal-day')?.clientHeight) return;
    e.preventDefault();
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) > 120) { const m = new Date(month); m.setMonth(m.getMonth() + Math.sign(wheelAcc)); month = +m; wheelAcc = 0; render(); }
  }, { passive: false });
  const onKey = e => {
    if (e.target.closest?.('input, textarea, select')) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (e.key === '0' || e.key === 't') return home();
    if (e.key === 'PageUp' || e.key === 'PageDown') { const m = new Date(month); m.setMonth(m.getMonth() + (e.key === 'PageUp' ? -1 : 1)); month = +m; render(); return; }
    if (!step) return;
    e.preventDefault();
    const [y, mo, dd] = day.split('-').map(Number), d = new Date(y, mo, dd + step);
    day = dayKey(d); month = startOfMonth(d); render();
  };
  window.addEventListener('keydown', onKey);

  function home() { month = startOfMonth(cb.now()); day = dayKey(cb.now()); render(); }
  function goTo(t) { month = startOfMonth(t); day = dayKey(t); render(); }

  return {
    update, home,
    reveal: id => { const d = docs.find(x => x.id === id); if (d) { selId = id; goTo(d.created); } },
    select: id => { selId = id; render(); },
    scrubTo: t => goTo(t),
    visibleTimes: () => {
      const m = new Date(month);
      return docs.filter(d => { const x = new Date(d.created); return x.getMonth() === m.getMonth() && x.getFullYear() === m.getFullYear(); }).map(d => d.created);
    },
    destroy() { window.removeEventListener('keydown', onKey); el.innerHTML = ''; },
  };
}

const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const startOfMonth = t => { const d = new Date(t); return +new Date(d.getFullYear(), d.getMonth(), 1); };
const daysIn = d => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
const fmtTime = t => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
