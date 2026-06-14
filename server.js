import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchUsage } from "./src/providers.js";
import { defaultClaudePath, readLocalLogs } from "./src/localLogs.js";
import * as store from "./src/db.js";
import { existsSync } from "node:fs";
import { analyzeAccount, buildRecommendations } from "./src/engine.js";
import {
  listAccounts,
  getAccount,
  upsertAccount,
  deleteAccount,
  publicAccount,
} from "./src/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4317;

app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// Einfacher In-Memory-Cache, damit wir die Admin-APIs nicht überlasten
// (Anthropic empfiehlt ~1x/Minute). TTL 60s, per ?refresh=1 umgehbar.
const CACHE_TTL_MS = 60_000;
const cache = new Map(); // accountId -> { at, usage }

async function getUsageCached(account, force = false) {
  const hit = cache.get(account.id);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.usage;
  const usage = await fetchUsage(account);
  cache.set(account.id, { at: Date.now(), usage });
  return usage;
}

// --- Account-Verwaltung ---------------------------------------------------
app.get("/api/accounts", async (_req, res) => {
  const accounts = await listAccounts();
  res.json(accounts.map(publicAccount));
});

app.post("/api/accounts", async (req, res) => {
  try {
    const account = await upsertAccount(req.body || {});
    cache.delete(account.id);
    res.json(publicAccount(account));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/accounts/:id", async (req, res) => {
  try {
    await deleteAccount(req.params.id);
    cache.delete(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Test-Endpoint: prüft, ob der Key gültige Daten liefert.
app.post("/api/accounts/:id/test", async (req, res) => {
  const account = await getAccount(req.params.id);
  if (!account) return res.status(404).json({ error: "Account nicht gefunden" });
  const usage = await getUsageCached(account, true);
  res.json({ ok: !usage.error, error: usage.error, monthToDate: usage.monthToDateCost });
});

// --- Nur-lokal: Claude-Code-Verbrauch aus der SQLite-DB -------------------
const ALLOWED_DAYS = [7, 30, 90, 365, 3650]; // 3650 ≈ "Gesamt"
let lastIngest = 0;

function sinceDay(days) {
  if (days >= 365) return null; // alles
  const t = Date.now() - (days - 1) * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

function r2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Idempotente Ingestion, höchstens alle 15 s (oder erzwungen).
function maybeIngest(force) {
  if (force || Date.now() - lastIngest > 15000) {
    try {
      store.ingest(defaultClaudePath());
    } catch (e) {
      console.error("Ingest-Fehler:", e.message);
    }
    lastIngest = Date.now();
  }
}

app.get("/api/local", async (req, res) => {
  const force = req.query.refresh === "1";
  let days = parseInt(req.query.days, 10);
  if (!ALLOWED_DAYS.includes(days)) days = 30;

  maybeIngest(force);
  const since = sinceDay(days);

  const s = store.summary(since);
  const all = store.allTime();
  const found = (all.requests || 0) > 0;

  if (!found) {
    return res.json({
      generatedAt: new Date().toISOString(),
      found: false,
      path: defaultClaudePath(),
      summary: { rangeDays: days },
    });
  }

  const cacheShare = s.api_cost > 0 ? (s.api_cost - s.real_cost) / s.api_cost : null;
  const ss = store.sessionStats(since);

  const summary = {
    rangeDays: days,
    requests: s.requests || 0,
    tokens: s.tokens || 0,
    outputTokens: s.output_tokens || 0,
    inputTokens: s.input_tokens || 0,
    cacheTokens: s.cache_tokens || 0,
    realCost: r2(s.real_cost),
    apiCost: r2(s.api_cost),
    cacheShare,
    activeDays: s.active_days || 0,
    avgRequestsPerDay: Math.round((s.requests || 0) / Math.max(1, s.active_days || 1)),
    avgOutputPerReq: Math.round((s.output_tokens || 0) / Math.max(1, s.requests || 1)),
    sessions: s.sessions || 0,
    avgReqPerSession: Math.round(ss.avg_reqs || 0),
    maxReqSession: ss.max_reqs || 0,
    rateLimits: store.rateLimits(since),
    firstDate: s.first_day,
    lastDate: s.last_day,
    daysCovered: s.active_days || 0,
    // kumuliert seit Beginn
    allTimeRequests: all.requests || 0,
    allTimeApi: r2(all.api_cost),
    allTimeReal: r2(all.real_cost),
    allTimeFirst: all.first_day,
  };

  const byModel = store.byModel(since).map((m) => ({
    model: m.model,
    requests: m.requests,
    tokens: m.tokens,
    cacheTokens: m.cache_tokens,
    cost: r2(m.cost),
    costReal: r2(m.cost_real),
  }));
  const byProject = store.byProject(since).map((p) => ({
    name: p.name,
    path: p.path,
    requests: p.requests,
    tokens: p.tokens,
    outputTokens: p.output_tokens,
    cost: r2(p.cost),
    costReal: r2(p.cost_real),
  }));
  const daily = store.daily(since).map((d) => ({
    date: d.date,
    requests: d.requests,
    tokens: d.tokens,
    cost: r2(d.cost),
    costReal: r2(d.cost_real),
  }));
  const byHour = store.byHour(since).map((h) => ({ hour: h.hour, requests: h.requests, costReal: r2(h.cost_real) }));
  const byWeekday = store.byWeekday(since).map((w) => ({ dow: w.dow, requests: w.requests, costReal: r2(w.cost_real) }));
  const patterns = buildPatterns(since);

  const heatmap = store.dailyAll().map((d) => ({ date: d.date, requests: d.requests, costReal: r2(d.cost_real) }));
  const byLanguage = store.byLanguage(since, null).map((l) => ({
    lang: l.lang,
    lines: l.lines,
    files: l.files,
    edits: l.edits,
  }));
  const codeProjects = store.codeProjects(since).map((p) => ({ name: p.project, lines: p.lines }));
  const work = buildWork(store.workdays(since, 25));
  // Arbeitsstunden pro Tag über ALLE Zeit (für den zweiten Kalender)
  const workHeatmap = store.workdays(null, 25).map((r) => ({ date: r.day, hours: r2(r.active_min / 60), requests: r.requests }));

  // Zusätzliche Analysen
  const topFiles = store.topFiles(since, null, 15).map((f) => ({
    path: f.path,
    name: f.path.replace(/[/\\]+$/, "").split(/[/\\]+/).pop() || f.path,
    project: f.project,
    lang: f.lang,
    edits: f.edits,
    lines: f.lines,
  }));
  const modelTrend = buildModelTrend(store.modelByDay(since));
  const rateHeatmap = buildGrid(store.errorDowHour(since), "n");
  const totalLines = byLanguage.reduce((s, l) => s + l.lines, 0);
  work.linesPerHour = work.totalHours > 0 ? r2(totalLines / work.totalHours) : 0;
  work.totalLines = totalLines;

  res.json({
    generatedAt: new Date().toISOString(),
    found: true,
    path: defaultClaudePath(),
    summary,
    byModel,
    byProject,
    daily,
    byHour,
    byWeekday,
    patterns,
    heatmap,
    byLanguage,
    codeProjects,
    work,
    workHeatmap,
    topFiles,
    modelTrend,
    rateHeatmap,
  });
});

// Muster: Stunde (24), Wochentag (7) und Wochentag×Stunde (168) je mit
// requests / lines / cost — für umschaltbare Charts & Punchcard.
function buildPatterns(since) {
  const hour = Array.from({ length: 24 }, (_, h) => ({ hour: h, requests: 0, cost: 0, lines: 0 }));
  for (const r of store.evHour(since)) {
    hour[r.hour].requests = r.requests;
    hour[r.hour].cost = r2(r.cost);
  }
  for (const r of store.cdHour(since)) hour[r.hour].lines = r.lines;

  const weekday = Array.from({ length: 7 }, (_, d) => ({ dow: d, requests: 0, cost: 0, lines: 0 }));
  for (const r of store.evDow(since)) {
    weekday[r.dow].requests = r.requests;
    weekday[r.dow].cost = r2(r.cost);
  }
  for (const r of store.cdDow(since)) weekday[r.dow].lines = r.lines;

  const punch = [];
  const idx = {};
  for (let d = 0; d < 7; d++)
    for (let h = 0; h < 24; h++) {
      idx[d * 24 + h] = punch.length;
      punch.push({ dow: d, hour: h, requests: 0, cost: 0, lines: 0 });
    }
  for (const r of store.evDowHour(since)) {
    const c = punch[idx[r.dow * 24 + r.hour]];
    c.requests = r.requests;
    c.cost = r2(r.cost);
  }
  for (const r of store.cdDowHour(since)) {
    punch[idx[r.dow * 24 + r.hour]].lines = r.lines;
  }
  return { hour, weekday, punch };
}

// 7×24-Gitter aus dow/hour-Zeilen (für Heatmaps).
function buildGrid(rows, valKey) {
  const grid = [];
  const idx = {};
  for (let d = 0; d < 7; d++)
    for (let h = 0; h < 24; h++) {
      idx[d * 24 + h] = grid.length;
      grid.push({ dow: d, hour: h, value: 0 });
    }
  for (const r of rows) {
    const i = idx[r.dow * 24 + r.hour];
    if (i != null) grid[i].value = r[valKey] || 0;
  }
  return grid;
}

// Modell-Trend: pro Tag, Top-6-Modelle + "andere", als Stacked-Datasets.
function buildModelTrend(rows) {
  const days = [...new Set(rows.map((r) => r.day))].sort();
  const totals = {};
  for (const r of rows) totals[r.model] = (totals[r.model] || 0) + r.requests;
  const ranked = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
  const keep = new Set(ranked.slice(0, 6));
  const dayIdx = Object.fromEntries(days.map((d, i) => [d, i]));
  const series = {};
  const ensure = (m) => (series[m] = series[m] || new Array(days.length).fill(0));
  for (const r of rows) {
    const m = keep.has(r.model) ? r.model : "andere";
    ensure(m)[dayIdx[r.day]] += r.requests;
  }
  const order = [...ranked.filter((m) => keep.has(m)), ...(series["andere"] ? ["andere"] : [])];
  return { days, datasets: order.map((m) => ({ model: m, data: series[m] })) };
}

function hhmm(date) {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}
function hhmmFromFloat(f) {
  if (f == null || Number.isNaN(f)) return "—";
  const h = Math.floor(f);
  const m = Math.round((f - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// Kreismittelwert von Uhrzeiten (löst den Mitternachts-Sprung bei Nachtarbeit).
function circularMeanHours(hours) {
  if (!hours.length) return null;
  let x = 0;
  let y = 0;
  for (const h of hours) {
    const a = (h / 24) * 2 * Math.PI;
    x += Math.cos(a);
    y += Math.sin(a);
  }
  let ang = Math.atan2(y / hours.length, x / hours.length);
  if (ang < 0) ang += 2 * Math.PI;
  return (ang / (2 * Math.PI)) * 24;
}

// Arbeitszeit-Statistik aus den Tageszeilen (lokale Zeit des Servers = deine Zeit).
function buildWork(rows) {
  let totalMin = 0;
  let n = 0;
  let maxDay = null;
  const starts = [];
  const ends = [];
  const daily = rows.map((r) => {
    totalMin += r.active_min;
    const fs = new Date(r.first_ts);
    const ls = new Date(r.last_ts);
    starts.push(fs.getHours() + fs.getMinutes() / 60);
    ends.push(ls.getHours() + ls.getMinutes() / 60);
    n++;
    if (!maxDay || r.active_min > maxDay.active_min) maxDay = r;
    return { date: r.day, hours: r2(r.active_min / 60), start: hhmm(fs), end: hhmm(ls), requests: r.requests };
  });
  return {
    totalHours: r2(totalMin / 60),
    days: n,
    avgHours: n ? r2(totalMin / 60 / n) : 0,
    avgStart: n ? hhmmFromFloat(circularMeanHours(starts)) : "—",
    avgEnd: n ? hhmmFromFloat(circularMeanHours(ends)) : "—",
    maxDay: maxDay ? { date: maxDay.date || maxDay.day, hours: r2(maxDay.active_min / 60) } : null,
    daily,
  };
}

// Sprachen-Aufschlüsselung, optional auf ein Projekt gefiltert.
app.get("/api/languages", (req, res) => {
  let days = parseInt(req.query.days, 10);
  if (!ALLOWED_DAYS.includes(days)) days = 3650;
  const since = sinceDay(days);
  const project = req.query.project && req.query.project !== "__all__" ? req.query.project : null;
  const byLanguage = store.byLanguage(since, project).map((l) => ({
    lang: l.lang,
    lines: l.lines,
    files: l.files,
    edits: l.edits,
  }));
  res.json({ project: project || "__all__", byLanguage });
});

// --- Live: hochfrequenter Mini-Endpoint -----------------------------------
let lastLiveIngest = 0;
app.get("/api/live", (_req, res) => {
  // Sehr günstige Ingestion (nur geänderte/aktive Datei), höchstens alle 1,5 s.
  if (Date.now() - lastLiveIngest > 1500) {
    try {
      store.ingest(defaultClaudePath());
    } catch {}
    lastLiveIngest = Date.now();
  }

  const nowMs = Date.now();
  const iso = (msAgo) => new Date(nowMs - msAgo).toISOString();
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(nowMs - 86400000).toISOString().slice(0, 10);

  const t = store.summary(today);
  const y = store.dayExact(yesterday);
  const w5 = store.statsSince(iso(300_000));
  const w60 = store.statsSince(iso(3_600_000));

  const recentRows = store.recent(40);
  const recent = recentRows.map((e) => ({
    id: e.id,
    ts: e.ts,
    model: e.model,
    project: e.project,
    output: e.output,
    input: e.input,
    cacheRead: e.cache_read,
    costReal: r2(e.cost_real),
    costFull: r2(e.cost_full),
  }));

  // Aktuelle Session = Session des jüngsten Events
  let session = null;
  if (recentRows[0]?.session) {
    const sa = store.sessionAgg(recentRows[0].session);
    const durMin = sa.start_ts ? Math.max(0, Math.round((Date.parse(sa.last_ts) - Date.parse(sa.start_ts)) / 60000)) : 0;
    session = {
      id: recentRows[0].session,
      requests: sa.requests || 0,
      tokens: sa.tokens || 0,
      realCost: r2(sa.real_cost),
      durationMin: durMin,
      project: recentRows[0].project,
      model: recentRows[0].model,
    };
  }

  // Burn-Rate: Hochrechnung der letzten 5 Min auf 1 Stunde
  const burnPerHour = r2((w5.real_cost || 0) * 12);
  const tokensPerMin = Math.round((w5.tokens || 0) / 5);
  const apiBurnPerHour = r2((w5.api_cost || 0) * 12);

  // Streak: aufeinanderfolgende aktive Tage bis heute/gestern
  const days = new Set(store.distinctDays());
  let streak = 0;
  let cur = new Date();
  if (!days.has(today)) cur = new Date(nowMs - 86400000); // heute noch nichts → ab gestern
  for (;;) {
    const ds = cur.toISOString().slice(0, 10);
    if (days.has(ds)) {
      streak++;
      cur = new Date(cur.getTime() - 86400000);
    } else break;
  }

  const busiest = store.busiestDay() || { requests: 1 };

  res.json({
    now: new Date().toISOString(),
    lastEventTs: store.lastEventTs(),
    today: {
      requests: t.requests || 0,
      tokens: t.tokens || 0,
      realCost: r2(t.real_cost),
      apiCost: r2(t.api_cost),
      cachePct: t.api_cost > 0 ? Math.round(((t.api_cost - t.real_cost) / t.api_cost) * 100) : 0,
      costPerReq: t.requests ? r2(t.real_cost / t.requests) : 0,
    },
    yesterday: { requests: y.requests || 0, realCost: r2(y.real_cost) },
    rate: {
      perMin1: store.countSince(iso(60_000)),
      perMin5: w5.requests || 0,
      perMin60: w60.requests || 0,
    },
    burn: { perHour: burnPerHour, apiPerHour: apiBurnPerHour, tokensPerMin },
    session,
    streak,
    busiestRequests: busiest.requests || 1,
    recent,
  });
});

// --- Auto-Erkennung lokaler Claude-Code-Logs ------------------------------
app.get("/api/detect", async (_req, res) => {
  const base = defaultClaudePath();
  const projects = join(base, "projects");
  const found = existsSync(projects);
  let summary = null;
  if (found) {
    const usage = await readLocalLogs({}, 30);
    summary = {
      monthToDate: usage.monthToDateCost,
      today: usage.todayCost,
      requests: usage.requests,
      models: usage.models,
      days: usage.daily.length,
      error: usage.error,
    };
  }
  res.json({ found, path: base, summary });
});

// --- Dashboard-Daten ------------------------------------------------------
app.get("/api/dashboard", async (req, res) => {
  const force = req.query.refresh === "1";
  const accounts = await listAccounts();

  const enriched = await Promise.all(
    accounts.map(async (account) => {
      const usage = await getUsageCached(account, force);
      const analysis = analyzeAccount(account, usage);
      return {
        id: account.id,
        label: account.label,
        provider: account.provider,
        monthlyBudget: account.monthlyBudget ?? null,
        usage,
        analysis,
      };
    })
  );

  const { recommendations, totals } = buildRecommendations(enriched);
  res.json({
    generatedAt: new Date().toISOString(),
    accounts: enriched,
    recommendations,
    totals,
  });
});

app.listen(PORT, () => {
  console.log(`\n  AI Manager läuft auf  http://localhost:${PORT}\n`);
});
