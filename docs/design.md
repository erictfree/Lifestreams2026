# Lifestreams 2026 — design notes

A modern Lifestreams: the time-ordered stream as the storage model, the memory, and the
harness for an LLM. Simple first: plain files and folders, a small local server, a
browser UI.

## 1. What we're carrying forward from the 1997 work

Source: *The Lifestreams Software Architecture* (E. Freeman, Yale, May 1997), plus the
SIGMOD Record '96 and CHI '96 papers.

| 1997 concept | What it was | Why it matters now |
|---|---|---|
| **Stream** | One time-ordered stream of documents, a "diary of your electronic life". Every doc you create or receive lands at the head. No names, no folders, storage is implicit. | This is exactly the shape of an LLM's working memory: an append-only log with recency. |
| **Past / present / future** | The tail holds the oldest docs. Docs dated in the future are reminders, calendar items, and to-dos, and they "arrive" when the clock reaches them. | Gives an agent a built-in way to schedule its own follow-ups. |
| **Freeze** | Docs become read-only over time (manually, or e.g. nightly / after two weeks idle). To edit a frozen doc you *clone* it. | Immutable history makes provenance and audit easy, and lets LLM judgements be cached forever. |
| **Five operations** | `new`, `clone`, `transfer`, `find`, `summarize` | A tiny, complete tool set for a model. |
| **Substreams** | `find` builds a *view* (a virtual directory). Substreams can overlap, nest (a child is the AND of its parent), and persist: a persistent one keeps collecting new matching docs, so it doubles as a filter or mailbox. | Saved queries become the organizing layer, and they are also where agents attach. |
| **Summarize** | Compresses a substream into one *overview document* that is appended to the stream. Each summarizer was a plugin with `test(substream) → bool` and `summarize(substream) → doc`, and the UI relabelled the button to whichever summarizer applied. The dissertation explicitly left the distilling itself out of scope ("NLP, data mining"). | **An LLM is that missing summarizer.** The plugin API carries over unchanged. |
| **Agents** | "Embedded computation" (Tcl) attached to documents, streams, or the UI, and fired on events (doc appended, opened, read). Examples: receipt and subscription agents. Server-side stream agents were designed but never built. | Agents become LLM prompts plus tools, fired by stream events. We finally build the stream agents. |
| **Interface** | A slice of about 40 docs receding into the past. Date shown only on the first doc of each day. A scrollbar whose slider size equals the visible fraction, with date endpoints. The clock can be set into the future. Unread docs have red borders, writable docs thick borders, and open docs are offset to the side. New docs drop from the top, and incoming docs slide in from the left with a "swoosh". | Keep the time-first navigation and modernize the rendering. |

The evaluation results in §6 are worth keeping in mind. Users "got" chronology right away
and said it should "definitely be the default". Their main complaint was search:
substream accuracy ran 78–95%, and users asked for "concept and category-based
searching" and "creating substreams by instance". Semantic matching by an LLM answers
both requests directly.

## 2. The core idea: the stream *is* the harness

Most agent harnesses today keep their pieces separate: a chat transcript, a memory store
(vector DB or a notes file), a task scheduler, and a tool-call log. Lifestreams folds them
into one structure:

- **Conversation = documents.** Each user message, model reply, and tool result is a
  document on the stream (`type: turn`). A "chat session" is just a substream such as
  `thread:renovation`. There is no separate history store, and talking to the model is
  just another way of adding to your lifestream.
- **Memory = the stream itself.** The model doesn't "save a memory" somewhere else. It
  `new`s a note, which lands at the head like everything else. Recall is `find`.
- **Compaction = summarize.** When a slice gets too big for context, the harness
  summarizes it into an overview doc. Originals are never deleted; they just recede.
  Every overview links back to its sources (`derived_from`).
- **Scheduling = future documents.** "Remind me Tuesday" or "check whether the PR merged
  tomorrow morning" is a `new` with `created` in the future. When the clock passes it,
  the doc arrives and fires the agents watching that substream.
- **Multi-agent / sharing = transfer.** Each person or agent can have its own lifestream.
  `transfer` copies a frozen doc onto another stream's head, recording the sender and
  receiver. That covers messaging, delegation, and hand-off with one primitive.
- **Branching = clone.** A cloned doc is a new editable copy at the head, and the original
  stays frozen.

### Model tool set

The model gets the 1997 operations almost verbatim, plus `read`:

```
find(query, within?)              -> substream id + slice of matching docs
read(doc_id | substream_id, range?)
new(type, body, attrs?, at?)      # `at` in the future = reminder/scheduled wake-up
clone(doc_id, edits?)
transfer(doc_id, to_stream)
summarize(substream_id, kind?)    -> overview doc appended to stream
```

The model has no `delete` and cannot `write` to frozen docs. Anything an agent does is an
append, so the stream is a full audit log of the agent's behavior.

### The loop

```
event  (user input | doc appended | clock passes a future doc | doc opened)
  └─▶ match: which persistent substreams does the event's doc fall into?
        └─▶ agents attached to those substreams (and to the UI/user) wake
              └─▶ assemble context:
                    agent instructions
                  + the triggering doc
                  + head of the agent's substream (recent N, within token budget)
                  + overview docs for older slices (instead of raw docs)
                  + results of any find() the agent issues
              └─▶ LLM call with the tool set above
              └─▶ every output (reply, note, reminder, summary) is appended as a doc
                    └─▶ ...which is itself an event (guarded, see §6)
```

Context assembly is the 1997 "slice" idea applied to tokens instead of pixels: the
newest docs are shown in full and older ones are represented by their summaries,
because "the value of information is likely to decrease over time."

## 3. Storage v0: files and folders

Everything is plain text in a directory you can `ls -t`, grep, git, and back up.

```
~/lifestream/
  stream/
    2026/11/07/
      20261107T190412Z-k3f9.md        # a document
      20261107T191530Z-p2aa.md
    2026/11/11/
      20261111T140000Z-r7q1.md        # a FUTURE doc (reminder) — arrives Nov 11
  substreams/
    email.yaml
    renovation.yaml
    renovation/contractors.yaml       # nested: child ANDs its parent's query
  agents/
    weekly-review.md
    inbox-triage.md
  summarizers/
    todo-list.md
    expenses.md
  .index/                             # derived & disposable; rebuild any time
    membership/<substream>.jsonl      # cached doc→substream matches
    fts.sqlite                        # (v1) full-text index
    embeddings.sqlite                 # (v1)
  clock                               # optional override for "time travel"
```

### A document

```markdown
---
id: 20261107T190412Z-k3f9
created: 2026-11-07T19:04:12Z
type: note            # note | email | turn | summary | reminder | bookmark | file | …
author: eric          # or agent:inbox-triage, or alice@example.com
frozen: false
title: Hotel near SEA # optional — names are never required
derived_from: []      # provenance for clones, summaries, agent output
transferred: { from: null, to: null }
mime: text/markdown   # non-text docs: body is a pointer to an attachment file
---
Remember to check on hotels near Seattle airport for the CHI trip.
```

- **Path = time.** The filename is the timestamp plus a short random suffix. `created`
  in the frontmatter is the source of truth, and the path is a convenience that keeps
  `ls` chronological.
- **Freezing** is setting `frozen: true` (and optionally `chmod a-w`). A nightly job
  freezes anything untouched for N days.
- **Attachments** (PDFs, images) sit next to their doc as
  `20261107T190412Z-k3f9.pdf`, and the `.md` holds the metadata plus extracted text.

### A substream

```yaml
# substreams/renovation.yaml
query: 'kitchen OR contractor OR permit ~"the house renovation project"'
persistent: true
created: 2026-10-02T09:00:00Z
```

Query language, deliberately small:

- bare words are ANDed, as in the 1997 keyword mode; `AND`, `OR`, and `NOT` work as in
  boolean mode
- attribute filters: `type:email`, `from:alice`, `after:2026-01-01`, `before:…`,
  `frozen:false`, `future:true`
- `~"…"` is a **semantic predicate** that the LLM (or embeddings, in v1) decides per
  document. This is the "concept-based searching" users asked for.
- `like:<doc_id>` means "substream by instance": find docs similar to this one.

**Why semantic predicates are affordable:** a frozen doc never changes, so its answer to
a given predicate never changes either. Membership is computed once, when the doc is
appended (the 1997 *incremental filter*), and cached in `.index/membership/`. You pay
the LLM per new doc per persistent semantic substream, never again.

### An agent

```markdown
---
name: inbox-triage
watch: 'type:email NOT from:me'    # a substream query; fires on append
also_on: []                        # e.g. ["clock: daily 07:00", "open"]
tools: [find, read, new, transfer]
model: claude-sonnet-5-5
max_actions: 5
---
When new mail arrives, decide if it needs a reply from me this week.
If so, add a reminder doc dated for the right day with a one-line note.
If it's a receipt, also append a short `type: expense` doc with amount and vendor.
```

### A summarizer

It keeps the 1997 plugin contract, now written as a prompt:

```markdown
---
name: todo-list
test: 'type:todo OR type:reminder'   # cheap structural test; or `test_prompt:` for LLM test
---
Produce a prioritized to-do list from these documents. Group by due date.
Link each item to its source doc id.
```

The UI shows **Summarize → "To-do list"** when exactly one summarizer's `test` passes for
the current substream, and offers a choice when several do, just as in 1997.

## 4. The interface (browser)

A local web app served by the harness (`localhost`). The layout:

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ ⌕  find, or ask…   [type:email from:alice ~"about the move"]      ⏱ Now ▾    │
├──────────────┬──────────────────────────────────────────────┬────────┬────────┤
│ SUBSTREAMS   │   ┄┄┄┄┄ FUTURE ┄┄┄┄┄  (faded, approaching)   │ glance │ time   │
│ ● Lifestream │   Tue Nov 11  ⏰ Call permit office           │ pane / │ mini-  │
│ ▸ email   12 │   ━━━━━━━━━━━━━━━ NOW 7:04 PM ━━━━━━━━━━━━━   │ open   │ map    │
│ ▾ renovation │   Today  ✉ Alice — re: cabinets          ●   │ doc    │ ▁▃█▅▂  │
│    contract… │          ✦ inbox-triage: added reminder       │        │ ▇▆▃▁▂  │
│ ▸ thread:… ✦ │          💬 you: what did the electrician…    │ prove- │ [====] │
│              │          💬 claude: He quoted $3,400 (→3 docs)│ nance  │ ▂▁▃▅▇  │
│ AGENTS ✦     │   Yesterday  📄 Quote_electric.pdf  🔒        │        │ 2019…  │
│              │   [ New ] [ Clone ] [ Transfer ] [ Summarize: To-do list ]   │
└──────────────┴──────────────────────────────────────────────┴────────┴────────┘
```

**The stream (center).** It's a vertical feed instead of the 1997 receding 3-D stack.
Vertical scrolling is the native gesture on every device, and at a glance a feed is
easier to read than a perspective stack. Some of the stack's feel is kept: cards near
the "Now" line sit at full size and older ones compress slightly.

- **A "Now" line** splits the stream. Above it are future docs (reminders, scheduled
  agent wake-ups, calendar items), faded and in reverse order so the soonest is nearest
  the line. Below it is the past, newest first. The 1997 clock reset becomes "scroll up
  past now".
- **Day headers** appear on the first doc of each day only, as in 1997.
- **Card states:** an unread dot (a modern stand-in for the red border), a lock for
  frozen docs, an editable outline for writable ones, and a ✦ badge plus a different
  tint for docs an agent wrote, so you can always tell at a glance what the machine did.
- **Motion:** new docs drop in from the top, incoming docs slide in from the left, and
  arrivals pulse gently. The swoosh sound is optional.

**The find bar (top).** It's one box, and it either *finds* or *asks*:

- Query syntax (`type:`, `from:`, `~"…"`) means **find**. It builds a substream, the view
  refocuses on it, and the left rail shows it nested under the current one.
- Plain-language questions ("what did the electrician quote?") mean **ask**. The question
  and the answer are added as `turn` docs, which land in the current substream (and in a
  `thread:` substream). The answer cites the doc ids it used, and clicking a citation
  focuses that doc in the stream.
- `⌘K` focuses it. `Enter` decides between find and ask heuristically, and `⌘Enter`
  forces ask.

**Substream rail (left).** It shows the nested parent→child list from the 1997
Substreams menu, plus unread counts, a pin to make a substream persistent, and a ✦ when
an agent is attached. "Your Lifestream" sits at the top. Agents are listed below the
substreams with their last run time, and clicking one opens its own substream of
outputs (`author:agent:<name>`).

**Time minimap (right edge).** This is the modern version of the 1997 scrollbar. It's a
vertical histogram of document density over the whole stream (or substream), with the
visible slice drawn as a bracket whose size is the fraction of docs on screen. Dragging
it scrubs through time. Year and month ticks run alongside, and the area above "now"
shows future docs.

**Glance / open pane.** Hovering a card shows a glance, and clicking it opens the doc in
the pane, which is the 1997 "offset to the side". The pane shows the rendered body,
attributes, and **provenance**: what this doc was derived from, which agent made it and
from which trigger, and what was later derived from it.

**Action bar.** It holds `New` `Clone` `Transfer` `Summarize`, the same five operations
the model has. `Summarize` is relabelled with the summarizer that applies to the current
substream.

The working prototype is in [`server/`](../server) and [`web/`](../web); see the README for
how to run it. The original static mockup is still in
[`prototype/index.html`](../prototype/index.html).

## 5. Architecture v0

```
browser UI  ──HTTP/JSON + SSE──▶  lifestreamd (local, single process)
                                    ├─ store:   read/append docs in ~/lifestream (fs)
                                    ├─ watcher: fs events + clock (future-doc arrival)
                                    ├─ matcher: incremental substream membership
                                    ├─ harness: agent runner + context assembly + LLM
                                    └─ ingest:  (later) IMAP, browser bookmarks, Downloads…
```

- One small TypeScript (Node/Bun) server. Endpoints: `GET /stream?sub=&before=&limit=`,
  `POST /docs`, `POST /find`, `POST /ask`, `POST /summarize`, and `GET /events` (SSE for
  arrivals and animations).
- In v0, `find` is ripgrep over `stream/` plus frontmatter filters. That's fine into the
  tens of thousands of docs; the 1997 prototype was about 17k docs with roughly
  one-second finds.
- The clock is a timer that wakes at the next future doc's `created`. The `clock` file
  (or `?now=`) lets you time-travel the UI and the agents.
- Everything under `.index/` can be rebuilt from `stream/`, so the files stay the truth.

## 6. Risks and open questions

- **Agent feedback loops.** Agent output is itself an append event. Mitigations: by
  default an agent doesn't fire on docs it authored; there's a cap on causal depth
  (`derived_from` chain length); and each agent has a per-hour action budget.
- **Summary pollution.** Overviews can crowd out originals in search. Give them
  `type: summary`, rank them below sources by default, and always link back.
- **Semantic predicate cost on backfill.** Creating a new `~"…"` substream over 50k old
  docs means 50k judgements. Use embeddings to pre-filter (v1), and evaluate the head
  first and the tail lazily as the user scrolls.
- **Privacy.** The whole point is that *everything* goes in, which means everything could
  go to a model. We need per-substream rules about what may be sent off-machine, and
  support for a local model.
- **What counts as a document?** Is each chat turn a doc, or each exchange? (Lean: each
  turn, grouped visually.) What about tool results: docs, or attributes of the turn?
- **Many streams.** Should each agent get its own lifestream (with `transfer` between
  them), or should all agents share the user's stream? Starting with one shared stream
  is simpler.

## 7. Prototype status (v0)

Built: steps 1–6 below at prototype quality, in plain Node with one dependency (the
Anthropic SDK).

- **Store.** It reads and writes the file layout in §3 and watches `stream/` for files
  dropped in by other tools. It auto-freezes docs untouched for 14 days. Read/unread state
  lives in `.index/`.
- **Find.** The full query language from §3 is implemented, including `like:<id>`. Nested
  substreams are ANDed. Substreams start temporary and can be pinned to make them
  persistent.
- **Semantic predicates, v0.** `~"topic"` is expanded *once per topic* by the model into a
  list of search terms (cached in `.index/semantic.json`), which are then matched at word
  boundaries. It's cheap and deterministic, but still lexical: in the seed data, `~"the
  book"` picks up "book the place on Chapel". The per-document LLM judgement from §3,
  cached forever because frozen docs never change, is the v1 step.
- **Ask.** A manual tool loop over `find`, `read`, `new_document`, `clone`, and `summarize`.
  The question and the answer are both `turn` docs. The answer's `derived_from` lists every
  doc the model found or read, plus every doc it cited.
- **Summarize.** Summarizers are files that pair a `test` query with a prompt. Each one
  applies when at least `min_fraction` of the substream matches its test. A built-in
  `overview` always applies.
- **Agents.** Agents watch queries and fire on append and on arrival. A `wakeup` doc an
  agent wrote for itself fires that agent. Loop guards: an agent ignores its own docs,
  agent-derived chains stop at depth 2, and each agent is capped at 30 runs per hour.
- **Clock.** Wakes at the next future doc. It also catches up on arrivals missed while the
  server was down (tracked as `lastClock`), and a `clock` file sets a time-travel offset.
- **Without an API key,** ask falls back to keyword search and summarize to a statistical
  overview, and agents report themselves offline.

Not yet: ingest (mail, files, bookmarks), the full-text and embeddings index, per-document
semantic judgements, privacy rules about what may leave the machine, multi-stream UI, auth.

## 8. Build order

1. **Store + UI, read-only.** Seed a few hundred fake docs. Render the stream, the Now
   line, day headers, and the minimap.
2. **Write path.** `New` and `Clone` in the UI, freezing, and SSE arrivals with animation.
3. **Find and substreams.** ripgrep plus attribute filters, nesting, persistence, and
   incremental membership on append.
4. **Ask.** The LLM harness with the tool set, turns as docs, and citations.
5. **Summarize.** The summarizer plugins with test/summarize and the relabelled button.
6. **Agents and future docs.** Watchers, clock arrival, and loop guards.
7. **v1 index and ingest.** SQLite FTS, embeddings, `~"…"` prefiltering, and real
   sources (mail, files, bookmarks).
