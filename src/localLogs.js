// Liest die lokalen Claude-Code-Nutzungslogs (~/.claude/projects/**/*.jsonl)
// und normalisiert sie auf dasselbe Format wie die API-Adapter.
//
// Diese Logs entstehen bei jeder Claude-Code-Nutzung — unabhängig davon, ob du
// per API-Key oder per Abo (Pro/Max) angemeldet bist. Damit funktioniert das
// Tracking auch ohne Admin-API.
//
// Kosten sind eine SCHÄTZUNG auf API-Preisbasis ("API-äquivalent") — beim Abo
// zahlst du real den Pauschalpreis, der Wert dient als Verbrauchs-Maßstab.

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

const DAY_MS = 86_400_000;

// Preise pro 1 Mio Tokens (USD). Quelle: Anthropic-Pricing (Stand 2026).
// input/output je Modellfamilie; Cache: read = 0.1x input, write = 1.25x input.
const PRICING = [
  [/opus-4-(8|7|6|5)/, { in: 5, out: 25 }],
  [/opus-4-(1|0)/, { in: 15, out: 75 }],
  [/opus-3/, { in: 15, out: 75 }],
  [/sonnet-4/, { in: 3, out: 15 }],
  [/sonnet-3-7/, { in: 3, out: 15 }],
  [/sonnet/, { in: 3, out: 15 }],
  [/haiku-4/, { in: 1, out: 5 }],
  [/haiku-3-5/, { in: 0.8, out: 4 }],
  [/haiku/, { in: 0.25, out: 1.25 }],
];
const DEFAULT_PRICE = { in: 3, out: 15 };

function priceFor(model = "") {
  for (const [re, p] of PRICING) if (re.test(model)) return p;
  return DEFAULT_PRICE;
}

// Liefert vollen API-Gegenwert UND den "realen" Wert ohne Cache-Tokens.
export function costOf(model, u) {
  const p = priceFor(model);
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const real = (input * p.in + output * p.out) / 1_000_000;
  const cache = (cacheRead * p.in * 0.1 + cacheWrite * p.in * 1.25) / 1_000_000;
  return { full: real + cache, real };
}

function startOfUTCDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function dayKey(d) {
  return startOfUTCDay(d).toISOString().slice(0, 10);
}
function round(n) {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}

export function defaultClaudePath() {
  return join(homedir(), ".claude");
}

async function findJsonl(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await findJsonl(full)));
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

export function projectName(cwd) {
  if (!cwd) return "—";
  const parts = cwd.replace(/[/\\]+$/, "").split(/[/\\]+/);
  return parts[parts.length - 1] || cwd;
}

async function parseFile(file, sinceMs, monthStartMs, agg, byModel, byProject, seen) {
  await new Promise((resolve) => {
    const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line || line[0] !== "{") return;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        return;
      }
      if (d.type !== "assistant") return;
      const msg = d.message;
      const usage = msg?.usage;
      if (!usage) return;
      // Lokal erzeugte Claude-Code-Meldungen (kein echter API-Call) überspringen.
      if (msg.model === "<synthetic>") return;
      const ts = d.timestamp ? new Date(d.timestamp) : null;
      if (!ts || Number.isNaN(ts.getTime())) return;
      if (ts.getTime() < sinceMs) return;

      // Doppelte vermeiden: dieselbe API-Antwort kann mehrfach geloggt werden.
      const id = `${msg.id || d.uuid || ""}|${d.requestId || ""}`;
      if (id !== "|") {
        if (seen.has(id)) return;
        seen.add(id);
      }

      const key = dayKey(ts);
      const model = msg.model || "unknown";
      const entry = agg.get(key) || {
        cost: 0,
        costReal: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheCreation: 0,
        requests: 0,
        models: new Set(),
      };
      const input = usage.input_tokens || 0;
      const output = usage.output_tokens || 0;
      const c = costOf(model, usage);
      entry.cost += c.full;
      entry.costReal += c.real;
      entry.inputTokens += input;
      entry.outputTokens += output;
      entry.cacheRead += usage.cache_read_input_tokens || 0;
      entry.cacheCreation += usage.cache_creation_input_tokens || 0;
      entry.requests += 1;
      if (model !== "unknown") entry.models.add(model);
      agg.set(key, entry);

      // Modell-Split über das gesamte gewählte Fenster.
      const m = byModel.get(model) || {
        model,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        cost: 0,
        costReal: 0,
      };
      m.requests += 1;
      m.inputTokens += input;
      m.outputTokens += output;
      m.cacheTokens += (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      m.cost += c.full;
      m.costReal += c.real;
      byModel.set(model, m);

      // Aufschlüsselung nach Projekt-Ordner (cwd, Groß/Klein zusammengefasst).
      const cwd = d.cwd || "";
      const pkey = cwd.toLowerCase();
      const p = byProject.get(pkey) || {
        name: projectName(cwd),
        path: cwd,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        costReal: 0,
      };
      p.requests += 1;
      p.inputTokens += input;
      p.outputTokens += output;
      p.cost += c.full;
      p.costReal += c.real;
      byProject.set(pkey, p);
    });
    rl.on("close", resolve);
    rl.on("error", resolve);
  });
}

// Liest die Logs und gibt das normalisierte Usage-Objekt zurück.
// account.logPath kann einen abweichenden ~/.claude-Pfad setzen; days = Verlauf.
export async function readLocalLogs(account = {}, days = 30) {
  const base = account.logPath || defaultClaudePath();
  const projectsDir = join(base, "projects");

  const out = {
    currency: "usd",
    monthToDateCost: 0,
    todayCost: 0,
    daily: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    requests: 0,
    models: [],
    byModel: [],
    source: "claude-code",
    estimated: true,
    fetchedAt: new Date().toISOString(),
    error: null,
  };

  if (!existsSync(projectsDir)) {
    out.error = `Keine Claude-Code-Logs gefunden unter ${projectsDir}`;
    return out;
  }

  const now = new Date();
  const sinceMs = startOfUTCDay(new Date(now.getTime() - (days - 1) * DAY_MS)).getTime();
  const monthStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const todayK = dayKey(now);

  const files = await findJsonl(projectsDir);
  const agg = new Map();
  const byModel = new Map();
  const byProject = new Map();
  const seen = new Set();
  const modelSet = new Set();

  // Neueste Dateien zuerst (für sauberes Dedup), parallel in kleinen Batches.
  const withTime = await Promise.all(
    files.map(async (f) => ({ f, m: (await stat(f).catch(() => ({ mtimeMs: 0 }))).mtimeMs }))
  );
  withTime.sort((a, b) => b.m - a.m);

  for (const { f } of withTime) {
    await parseFile(f, sinceMs, monthStartMs, agg, byModel, byProject, seen);
  }

  const sorted = [...agg.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  out.daily = sorted.map(([date, v]) => {
    for (const m of v.models) modelSet.add(m);
    out.tokens.input += v.inputTokens;
    out.tokens.output += v.outputTokens;
    out.tokens.cacheRead += v.cacheRead;
    out.tokens.cacheCreation += v.cacheCreation;
    return {
      date,
      cost: round(v.cost),
      costReal: round(v.costReal),
      inputTokens: v.inputTokens,
      outputTokens: v.outputTokens,
      requests: v.requests,
      models: [...v.models],
    };
  });

  out.byModel = [...byModel.values()]
    .map((m) => ({
      model: m.model,
      requests: m.requests,
      tokens: m.inputTokens + m.outputTokens,
      cacheTokens: m.cacheTokens,
      cost: round(m.cost),
      costReal: round(m.costReal),
    }))
    .sort((a, b) => b.cost - a.cost);

  out.byProject = [...byProject.values()]
    .map((p) => ({
      name: p.name,
      path: p.path,
      requests: p.requests,
      tokens: p.inputTokens + p.outputTokens,
      outputTokens: p.outputTokens,
      cost: round(p.cost),
      costReal: round(p.costReal),
    }))
    .sort((a, b) => b.requests - a.requests);

  out.requests = out.daily.reduce((s, d) => s + d.requests, 0);
  // Fenster-Summen (über den gesamten gewählten Zeitraum)
  out.windowCost = round(out.daily.reduce((s, d) => s + d.cost, 0));
  out.windowReal = round(out.daily.reduce((s, d) => s + (d.costReal || 0), 0));
  out.activeDays = out.daily.filter((d) => d.cost > 0).length;
  out.firstDate = out.daily.length ? out.daily[0].date : null;
  out.lastDate = out.daily.length ? out.daily[out.daily.length - 1].date : null;
  // Monat-bisher bleibt für Kompatibilität erhalten
  out.monthToDateCost = round(
    out.daily.filter((d) => Date.parse(d.date + "T00:00:00Z") >= monthStartMs).reduce((s, d) => s + d.cost, 0)
  );
  const today = agg.get(todayK);
  out.todayCost = round(today ? today.cost : 0);
  out.models = [...modelSet];
  return out;
}
