# AI Usage Cockpit

A **local, zero-config dashboard for your [Claude Code](https://claude.com/claude-code) usage.**
It reads the JSONL logs Claude Code writes to `~/.claude/projects` and turns them into a
rich, live dashboard — requests, tokens, estimated API-equivalent cost, models, projects,
programming languages, working hours, a calendar heatmap and a live console.

Everything runs **on your machine**. No API key required. Works on **Pro/Max subscriptions**
(where there is no usage API) because Claude Code logs every request locally anyway.

> 🌐 UI available in **English and German** — toggle in the top-right (DE/EN).

---

## Why

Claude Code subscriptions (Pro/Max) don't expose a usage API, and the Admin usage/cost API
only works for API **organizations**, not individual accounts. But Claude Code stores a full
local transcript of every request — including token counts, model and project — in
`~/.claude/projects/**/*.jsonl`. This tool parses those logs into a persistent local database
and visualizes them.

---

## Features

- **Live console** — every new request streams in like a terminal feed, with a today-counter
  that ticks up and a burn-rate / tokens-per-minute readout.
- **Time range switch** — 7 / 30 / 90 days / all-time; every panel follows.
- **Cost, honestly labeled** — a "real" value (fresh input + output) next to the full
  API-equivalent value (incl. cached context). Per-model pricing, computed in SQL so price
  changes apply retroactively. On a subscription you pay a flat fee — these are *estimates*
  of what the usage would cost on pay-as-you-go API.
- **Calendar heatmap** — a full-year, GitHub-style grid, switchable between requests, working
  hours and cost.
- **Programming languages** — how many lines you wrote per language, with a searchable
  **project filter**.
- **Projects & models** — breakdowns with shares.
- **Activity patterns** — by hour of day, by weekday, and a **weekday × hour punchcard**, each
  switchable between requests / lines / cost.
- **Model-mix trend** over time, **top edited files**, and a **rate-limit (429) heatmap** by
  weekday × hour.
- **Estimated working time** — active minutes per day (gaps over 25 min count as breaks),
  average start/end (robust to night-owl schedules), longest day, lines per hour.
- **English / German UI** with a one-click toggle.
- **Persistent** — all events are ingested into a local SQLite database and kept forever, even
  if Claude Code prunes its own logs.

---

## Requirements

- **Node.js ≥ 22.5** (uses the built-in `node:sqlite` module — no native build step).
- An existing `~/.claude/projects` directory (i.e. you use Claude Code).

## Quick start

```bash
npm install
npm start
```

Then open **http://localhost:4317**.

Different port: `PORT=8080 npm start`.

The first request ingests your logs into `data/usage.db` (a few seconds). After that it only
re-reads changed files, and auto-refreshes while running.

---

## Privacy

- **100% local.** Nothing is sent anywhere. The server only reads `~/.claude` and serves a
  dashboard on `localhost`.
- Your ingested data lives in `data/usage.db`, which is **gitignored** and never leaves your
  machine.
- No API keys are used or stored.

---

## How it works

```
server.js          Express server + REST endpoints + live endpoint
src/db.js          SQLite schema, log ingestion, all aggregation queries
src/localLogs.js   JSONL parsing + per-model pricing helpers
src/engine.js      Budget/limit analysis (for optional API-key sources)
public/            Dashboard (vanilla JS + Chart.js, no build step)
data/usage.db      Local SQLite database (gitignored)
```

Ingestion is idempotent: each event is deduplicated by its message/tool id, and unchanged log
files are skipped. Costs are derived from stored raw token counts at query time using
per-model rates, so the pricing table can be updated without re-ingesting.

### A note on the numbers

Token and request counts are exact (straight from the logs). **Dollar values are estimates**
computed from public Anthropic API prices — on a subscription you pay the flat plan price, so
the "API-equivalent" figure is a measure of *how much* you used, not a bill.

---

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `4317` | HTTP port |

The Claude Code path defaults to `~/.claude`. Pricing lives in `src/db.js` (`PIN` / `POUT`).

---

## Contributing

Issues and PRs welcome — especially:

- **More languages** (translations live in `public/i18n.js`).
- More analytics ideas (pause/focus analysis, productivity by time of day, records panel, …).
- Optional Anthropic/OpenAI Admin-API sources (scaffolding exists in `src/providers.js`).

## License

[MIT](LICENSE)

---

*Not affiliated with Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.*
