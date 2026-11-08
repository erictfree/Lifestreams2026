# Lifestreams 2026

A modern Lifestreams: a single time-ordered stream of documents that is your storage, your
memory, and the harness for an LLM. Plain files and folders on disk, a small local server,
and a browser UI. See [docs/design.md](docs/design.md) for the thinking behind it.

## Run it

Requires Node 20+.

```bash
npm install
```

```bash
npm run seed
```

```bash
npm start
```

Then open http://localhost:4747.

Eight views of the same stream, switched in the header (a dropdown on narrow screens) or with keys `1`–`8`:

- **Feed**: vertical, newest first, with future documents above the Now line.
- **Stack**: the 1997 interface rebuilt with CSS 3D. Pages recede into the past, unread
  pages have red borders and writable ones thick borders, as in the original. Scroll,
  swipe, or press ↑/↓ to move through time, including past Now into the future. Click a
  page behind the front to bring it forward.
- **River**: days as columns flowing left to right, with the Now line between past and
  future. The mouse wheel moves through time.
- **Atlas**: the whole stream on the GPU (three.js / WebGL2). It's a wall of cards, one
  column per day. Zoomed out it reads as a color-coded map of formats. Zoom in and each
  card renders its real content: PDF pages (pdf.js), photos, SVG drawings, audio
  waveforms decoded from the file, spreadsheet grids, calendar invites, mail, saved
  pages, and syntax-colored code. Detail sharpens as you get closer. Click a card to fly
  to it and open it. The legend filters by format, and `0` returns to now.
- **Hall**: a pseudo-3D gallery corridor through time, drawn with plain Canvas 2D (no
  WebGL). You stand at Now looking down the hall into the past, with documents hung on
  both walls as fully rendered thumbnails. The walls are texture-mapped the old way, one
  thin vertical strip at a time, with distance fog and a glossy floor reflection. Days and
  months are painted on the floor, and the future lies behind you past the NOW gate.
  Scroll, drag, or press ↑/↓ to walk; click a document to walk up to it and open it.
- **Vista**: the 1997 diagonal, made legible. Each day is a row of documents on a tilted
  plane, ordered through the day from left to right. Today's row is in front, and each
  older day sits one step further back and to the right, so the past recedes diagonally.
  The cards lean back like pages on a drafting table, texture-mapped as perspective quads
  in plain Canvas 2D, so you can read them and they don't hide the rows behind. Scroll or
  press ↑/↓ to glide from day to day and ←/→ to move along a day. Future days fade in
  front of the Now line.
- **Classic**: the 1997 X Windows interface, kept faithful. A diagonal stack of 40 pages
  runs corner to corner, newest at the bottom right, and each page's header line peeks out.
  Hovering a page pops a large rendered copy out of the stack (the original "glance"). The
  stream name and count sit above a time slider, with the visible slice's dates on top and
  the whole stream's range below. Unread pages have red borders and writable ones thick
  borders. Scroll, use the slider, or press ↑/↓ to move through time.
- **Calendar**: a traditional month grid over the same documents. Mail and notes fill the
  past; reminders, events, and agent wake-ups fill the future, shown with their times.
  Pick a day to see its agenda. Double-click a future day, or use "+ Reminder", to
  schedule something: in Lifestreams a calendar entry is just a future document.

## Real files, any format

A document can carry a file of its own (PDF, PNG/JPEG, SVG, WAV/MP3, MP4, CSV, ICS, EML,
HTML, code…), stored next to its markdown sidecar. To add one, do any of these:

- Drop files anywhere on the page.
- Attach them in the New composer.
- Copy them straight into `stream/`. A file copied in this way is **moved** to its place
  in time (dated by the file's own timestamps) and gets a sidecar.

Text is pulled out of the file so find can see inside it. That covers PDFs, CSV, email,
calendar invites, HTML, and code. For email, the sender, subject, and date also become
the document's attributes. A calendar invite lands on its date, so a future invite
becomes a future document. Every format has a full viewer in the document pane.

The sample stream contains real generated files (PDF, PNG, WAV, SVG, CSV, ICS, EML, HTML,
Python), about 12 MB in total.

`npm run seed` writes a sample lifestream (about 650 documents over 18 months, plus
substreams, agents and summarizers) to `lifestreams/me/`. Run `npm run seed -- --force` to
wipe and reseed it.

### With Claude

Set `ANTHROPIC_API_KEY` before `npm start` to turn on:

- **ask**: questions in the find box are answered from your stream, using the Lifestreams
  operations as tools, and both the question and the answer become documents
- **summarize** with real summarizers (to-do list, email digest, expenses, overview)
- **agents**: the files in `agents/` wake when matching documents arrive, or when their own
  scheduled wake-up time comes
- **semantic substreams**: `~"some topic"` is expanded into search terms by the model

Without a key, everything else still works and those features fall back to keyword search
and statistical summaries. The model defaults to `claude-opus-5-5`; override it with
`LIFESTREAMS_MODEL`.

### Options

| env | default | |
|---|---|---|
| `LIFESTREAM_DIR` | `./lifestreams/me` | the lifestream folder; point it at `~/lifestream` to use a real one |
| `PORT` | `4747` | |
| `LIFESTREAMS_MODEL` | `claude-opus-5-5` | |

## What's on disk

```
lifestreams/me/
  stream/2026/11/07/20261107T190412Z-k3f9.md   one document per file; path = time
  substreams/*.yaml                             persistent saved queries
  agents/*.md                                   agent config (frontmatter) + instructions
  summarizers/*.md                              summarizer test query + prompt
  .index/                                       derived state (read marks, expansions)
  clock                                         optional: an ISO time to "time travel" to
```

Drop a markdown file into `stream/` from any tool and it appears live in the UI. Future-dated
documents arrive (and wake agents) when their time comes.

## Layout

- `server/`: `store.mjs` (files ↔ memory), `query.mjs` (find language), `harness.mjs`
  (tools, ask, summarize, agents, clock), `llm.mjs` (Anthropic SDK), `main.mjs` (HTTP + SSE)
- `web/`: the browser client. `formats.js` holds the per-format viewers and thumbnails, and
  `atlas.js` is the GPU view, `hall.js` is the pseudo-3D corridor, `vista.js` is the diagonal view, `classic.js` is the 1997 stack, and `calendar.js` is the month grid.
- `prototype/index.html`: the original static mockup
