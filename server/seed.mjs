// Seed a sample lifestream: ~18 months of fake documents, a few future ones, substreams,
// agents and summarizers. Usage: npm run seed [-- --force]   (LIFESTREAM_DIR to choose where)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.LIFESTREAM_DIR || path.join(here, '..', 'lifestreams', 'me');

if (fs.existsSync(path.join(ROOT, 'stream')) && fs.readdirSync(path.join(ROOT, 'stream')).length) {
  if (!process.argv.includes('--force')) { console.log(`${ROOT} already has documents; use --force to wipe and reseed.`); process.exit(0); }
  fs.rmSync(ROOT, { recursive: true, force: true });
}

const store = new Store(ROOT);
for (const d of ['stream', 'substreams', 'agents', 'summarizers', '.index']) fs.mkdirSync(store.dir(d), { recursive: true });
store.watch = () => {};

let seed = 11;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = a => a[Math.floor(rnd() * a.length)];
const NOW = Date.now();
const DAY = 864e5;

// [type, author, title, body] — ${x} pieces are filled per instance
const T = {
  renovation: [
    ['email', 'alice@studio-kitchens.com', 'Re: cabinet samples', 'Hi — the samples are in. We have the white oak in a natural finish and a painted "Swiss coffee" white. Lead time is about 6 weeks for either. Can you let me know by Friday which one so we hold the slot?\n\nAlice'],
    ['email', 'bob@harborelectric.co', 'Electrical quote', 'Following up on the walkthrough. Panel upgrade to 200A plus four new kitchen circuits and under-cabinet lighting: $3,400 total, two days on site. Permit is pulled by us. We could start as early as the 17th.\n\n— Bob'],
    ['email', 'permits@town.gov', 'Permit application received — #22-1187', 'Your building permit application #22-1187 (kitchen renovation, interior) has been received and is under review. Typical review time is 10 business days.'],
    ['email', 'bob@harborelectric.co', 'Re: start date', 'Inspector found knob-and-tube in the east wall. Remediation adds about $900. I can send a revised quote.'],
    ['note', 'me', 'Kitchen: decisions list', '- Island: 7ft, seating on the long side\n- Range: induction (36")\n- Sink under window, not in island\n- Need to decide: cabinet finish, backsplash tile, pendant lights'],
    ['photo', 'me', 'IMG_${n}.heic', 'Photo: kitchen east wall opened up; old knob-and-tube wiring visible near the window.'],
    ['file', 'me', 'Quote_HarborElectric.pdf', 'Scanned quote from Harbor Electric, 2 pages. Panel upgrade, 4 circuits, lighting. $3,400.'],
    ['bookmark', 'me', 'Kitchen layout planner', 'https://example.com/planner — saved for the island measurements (7ft x 3.5ft, 42" aisles).'],
    ['expense', 'me', 'Home Depot — $${amt}', 'Receipt. Drywall screws, joint compound, painter\'s tape, 2 sheets of 1/2" drywall. Category: renovation.'],
    ['email', 'alice@studio-kitchens.com', 'Backsplash tile options', 'Three tile options attached: zellige in white, a 2x8 handmade in sage, and a plain 3x6 subway. The zellige is the most expensive (~$38/sqft).'],
  ],
  book: [
    ['email', 'editor@harbor-press.com', 'Chapter ${ch} edits', 'Comments attached. Mostly about the agents section — I think it needs one worked example before the formal definition. Otherwise in good shape.'],
    ['file', 'me', 'chapter${ch}-draft.md', '# Chapter ${ch}\n\nDraft, about ${words} words. Open issues: the worked example, figure numbering, and the summary at the end.'],
    ['note', 'me', 'Book: idea for chapter ${ch}', 'Open with the receding-stack image, then explain why time is the one attribute every document already has.'],
    ['email', 'editor@harbor-press.com', 'Schedule check-in', 'Just checking we\'re still on track for the chapter ${ch} draft by the end of the month. No pressure — let me know if you need more time.'],
  ],
  lifestreams: [
    ['note', 'me', 'Ideas: the stream as a harness', 'Conversation = documents. Memory = the stream itself. Compaction = summarize. Scheduling = future documents. Hand-off = transfer.'],
    ['bookmark', 'me', 'Linda coordination language', 'cs.yale.edu — tuple spaces; in / out / rd / eval. Nice fit for describing stream operations.'],
    ['note', 'me', 'Substream accuracy', 'Old user study: substream success 78–95%. People asked for concept-based search and "find more like this". Both are cheap now.'],
    ['email', 'nick@cs.example.edu', 'Re: Lifestreams revisited', 'Read your note — agree the agent part is the interesting bit now. Happy to look at a draft of the design.'],
  ],
  family: [
    ['email', 'elisabeth', 'dinner Saturday?', 'The Hendersons can do 7. Want to book the place on Chapel?'],
    ['email', 'elisabeth', 'flights for Thanksgiving', 'Found two options: Wed 6pm nonstop or Thu 7am. The Wednesday one is $80 more each. Thoughts?'],
    ['note', 'me', 'Gift ideas', 'For Mom: the photo book from the summer trip. For Sam: climbing shoes (size 9).'],
    ['photo', 'me', 'IMG_${n}.heic', 'Photo: everyone on the porch after dinner.'],
  ],
  misc: [
    ['email', 'newsletter@techweekly.io', 'This week in AI', 'Headlines: new context-window records, agent benchmarks, and a long read on personal knowledge tools.'],
    ['note', 'me', 'Toaster oven research', 'Breville vs Cuisinart — Breville has better convection and the dial UI is nicer. ~$280.'],
    ['expense', 'me', 'Receipt — ${vendor} $${amt}', 'Receipt from ${vendor}. Category: household.'],
    ['bookmark', 'me', 'Article: ${topic}', 'Saved to read later: a long piece on ${topic}.'],
    ['email', 'accounts@utility.example.com', 'Your statement is ready', 'Your monthly statement is available. Amount due: $${amt}. Due in 21 days.'],
  ],
};
const WEIGHT = { renovation: 3, book: 2, lifestreams: 1.2, family: 1.5, misc: 2 };
const TOPICS = ['personal information management', 'time-based interfaces', 'the history of the desktop metaphor', 'agent memory systems', 'zooming user interfaces'];
const VENDORS = ['Whole Foods', 'Amazon', 'Hardware Co', 'Pharmacy'];

function fill(s) {
  return s.replace(/\$\{(\w+)\}/g, (_, k) => ({
    n: 4400 + Math.floor(rnd() * 600), amt: (20 + rnd() * 280).toFixed(2), ch: 1 + Math.floor(rnd() * 9),
    words: 3000 + Math.floor(rnd() * 5000), vendor: pick(VENDORS), topic: pick(TOPICS),
  })[k]);
}

function topicAt(ageDays) {
  // the renovation is recent; the book runs through the whole period
  const w = { ...WEIGHT, renovation: ageDays < 70 ? WEIGHT.renovation : 0.05 };
  let r = rnd() * Object.values(w).reduce((a, b) => a + b, 0);
  for (const [k, v] of Object.entries(w)) if ((r -= v) < 0) return k;
  return 'misc';
}

let n = 0;
for (let i = 0; i < 650; i++) {
  const age = Math.pow(rnd(), 1.8) * 540 + 0.02;
  const [type, author, title, body] = pick(T[topicAt(age)]);
  const t = NOW - age * DAY;
  store.append({ type, author, title: fill(title), body: fill(body), created: t, frozen: age > 14 });
  n++;
}

// a little conversation history and some agent output
const ago = h => NOW - h * 3600e3;
const q = store.append({ type: 'turn', author: 'me', title: 'when is the permit review due?', body: 'when is the permit review due?', created: ago(30) });
const permit = store.find('permit type:email')[0];
store.append({ type: 'turn', author: 'claude', title: 'Around ten business days from the application.', body: `The town said review typically takes 10 business days from when they received it [${permit?.id}], so expect an answer late next week. Want a reminder to call if you haven't heard by then?`, created: ago(29.9), derived_from: [q.id, permit?.id].filter(Boolean) });
const edits = store.find('type:email edits')[0];
store.append({ type: 'reminder', author: 'agent:inbox-triage', title: 'Reply to editor about chapter edits', body: 'Your editor asked for a response on the agents-section comments.', created: ago(3), derived_from: edits ? [edits.id] : [] });

// the future
const at = (days, hour) => { const d = new Date(NOW + days * DAY); d.setHours(hour, 0, 0, 0); return d.getTime(); };
store.append({ type: 'reminder', author: 'me', title: 'Dinner with the Hendersons, 7pm', body: 'Place on Chapel St.', created: at(1, 17) });
store.append({ type: 'reminder', author: 'agent:inbox-triage', title: 'Pick a cabinet finish (Alice needs it Friday)', body: 'From Alice\'s email about the cabinet samples: white oak vs painted white, 6-week lead time.', created: at(2, 9) });
store.append({ type: 'wakeup', author: 'agent:followup', title: 'Check: did Bob send the revised quote?', body: 'Look for a revised quote from Harbor Electric covering the knob-and-tube remediation. If none, add a reminder to nudge Bob.', created: at(3, 10) });
store.append({ type: 'reminder', author: 'me', title: 'Call the permit office about #22-1187', body: 'If no word on the permit by today, call.', created: at(4, 11) });
const sunday = (() => { const d = new Date(NOW); d.setDate(d.getDate() + ((7 - d.getDay()) % 7 || 7)); d.setHours(18, 0, 0, 0); return d.getTime(); })();
store.append({ type: 'wakeup', author: 'agent:weekly-review', title: 'Weekly review', body: 'Time for the weekly review.', created: sunday });
store.append({ type: 'todo', author: 'me', title: 'Chapter draft due to editor', body: '', created: at(12, 9) });

// substreams
const sub = (id, query, label, parent = 'all') => store.saveSub({ id, query, label, parent, created: new Date(NOW).toISOString() });
sub('email', 'type:email', 'type:email');
sub('renovation', '~"house renovation"', '~"house renovation"');
sub('contractors', 'from:harborelectric OR from:studio-kitchens OR from:permits', 'contractors', 'renovation');
sub('book', '~"the book"', '~"the book"');
sub('upcoming', 'future:true', 'upcoming');
fs.writeFileSync(store.dir('.index', 'semantic.json'), JSON.stringify({
  'house renovation': ['renovation', 'kitchen', 'cabinet', 'permit', 'electric', 'drywall', 'contractor', 'backsplash', 'tile', 'island', 'knob-and-tube', 'quote', 'remodel'],
  'the book': ['chapter', 'editor', 'manuscript', 'harbor-press', 'the book'],
}, null, 1));
const read = Object.fromEntries(store.all().filter(d => d.created < NOW - 2 * DAY).map(d => [d.id, 1]));
fs.writeFileSync(store.dir('.index', 'state.json'), JSON.stringify({ read, lastClock: NOW }));

// agents
fs.writeFileSync(store.dir('agents', 'inbox-triage.md'), `---
name: inbox-triage
description: Turns incoming mail into reminders and expense records
watch: type:email NOT from:me
tools: ["find", "read", "new_document"]
max_actions: 4
---
When new mail arrives, decide whether it needs something from me.

- If it asks me for a decision or reply by a certain time, add a \`reminder\` dated a day before that time (9am local), with a one-line note saying what's needed and why.
- If it is a receipt or bill, add an \`expense\` document with the vendor, amount, and a category.
- Newsletters and FYIs need nothing. Doing nothing is the usual outcome.
`);
fs.writeFileSync(store.dir('agents', 'weekly-review.md'), `---
name: weekly-review
description: Writes a weekly review every Sunday evening, then schedules the next one
watch: type:wakeup from:agent:weekly-review
tools: ["find", "read", "new_document", "summarize"]
max_actions: 10
---
When your wake-up arrives, write a weekly review as a \`summary\` document titled "Weekly review — <dates>": what happened this week (by project), what's still open, and what's coming up in the next 7 days (future documents). Cite document ids in [brackets].

Then schedule your next run: a \`wakeup\` document 7 days after this one, at the same time.
`);
fs.writeFileSync(store.dir('agents', 'followup.md'), `---
name: followup
description: Watches contractor threads and nudges when promised things don't arrive
watch: from:harborelectric OR from:studio-kitchens
tools: ["find", "read", "new_document"]
max_actions: 5
---
You keep the renovation moving. When a contractor email arrives that promises something ("I'll send…", "we could start…"), schedule a \`wakeup\` for yourself a few days later to check it happened.

When one of your wake-ups arrives, look for the promised thing with find. If it arrived, do nothing. If not, add a \`reminder\` for me (9am tomorrow) to nudge them, naming what's missing.
`);

// summarizers
fs.writeFileSync(store.dir('summarizers', 'todo-list.md'), `---
name: todo-list
label: To-do list
test: type:reminder OR type:todo OR type:wakeup
min_fraction: 0.4
---
Produce a prioritized to-do list from these documents. Group by when it's due (overdue, this week, later). One line per item, linking the source document id in [brackets].
`);
fs.writeFileSync(store.dir('summarizers', 'email-digest.md'), `---
name: email-digest
label: Email digest
test: type:email
min_fraction: 0.5
---
Write a digest of this mail: group by thread or correspondent, one or two lines each, and finish with a short "needs a reply" list. Cite ids in [brackets].
`);
fs.writeFileSync(store.dir('summarizers', 'expenses.md'), `---
name: expenses
label: Expenses
test: type:expense OR receipt OR statement
min_fraction: 0.2
---
Total the expenses in these documents by category and by month, as a small markdown table, then note anything unusual. Cite ids in [brackets].
`);

console.log(`Seeded ${n + 9} documents into ${ROOT}`);
