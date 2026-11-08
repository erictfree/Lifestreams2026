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
- `web/`: the browser client
- `prototype/index.html`: the original static mockup
