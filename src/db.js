// Lokale SQLite-DB: sammelt alle Claude-Code-Events dauerhaft ein und behält
// die Historie, auch wenn Claude Code seine Logs löscht.
//
// Kosten werden NICHT beim Einlesen fixiert, sondern bei jeder Abfrage aus den
// gespeicherten Roh-Tokens berechnet — mit modellabhängigen Preisen (s. PIN/POUT)
// und getrenntem Cache-Preis (Lesen 0.1×, 5-Min-Write 1.25×, 1-Std-Write 2×).
// Dadurch sind Preisanpassungen rückwirkend für ALLE Daten gültig.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { projectName } from "./localLogs.js";

// Datei-Endung → Programmiersprache
const LANG = {
  ".tsx": "TypeScript", ".ts": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
  ".jsx": "JavaScript", ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".py": "Python", ".pyw": "Python", ".ipynb": "Python",
  ".html": "HTML", ".htm": "HTML", ".css": "CSS", ".scss": "CSS", ".sass": "CSS", ".less": "CSS",
  ".cs": "C#", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin",
  ".cpp": "C++", ".cc": "C++", ".cxx": "C++", ".hpp": "C++", ".c": "C", ".h": "C/C++",
  ".rb": "Ruby", ".php": "PHP", ".swift": "Swift", ".dart": "Dart", ".vue": "Vue", ".svelte": "Svelte",
  ".sql": "SQL", ".sh": "Shell", ".bash": "Shell", ".ps1": "PowerShell", ".bat": "Batch",
  ".json": "JSON", ".yml": "YAML", ".yaml": "YAML", ".toml": "Config", ".ini": "Config",
  ".conf": "Config", ".service": "Config", ".env": "Config", ".xml": "XML",
  ".md": "Markdown", ".txt": "Text", ".gd": "GDScript", ".lua": "Lua", ".r": "R",
};
function langOf(ext) {
  return LANG[ext] || (ext ? ext.slice(1).toUpperCase() : "Andere");
}
function countLines(s) {
  if (!s) return 0;
  s = String(s);
  return s.length ? s.split("\n").length : 0;
}
function editPath(input) {
  return input.file_path || input.path || input.notebook_path || input.filePath || "";
}
function editLines(name, input) {
  if (name === "Write") return countLines(input.content);
  if (name === "Edit" || name === "Update") return countLines(input.new_string);
  if (name === "NotebookEdit") return countLines(input.new_source);
  if (name === "MultiEdit" && Array.isArray(input.edits))
    return input.edits.reduce((s, e) => s + countLines(e.new_string), 0);
  return 0;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const DB_PATH = join(DATA_DIR, "usage.db");

// --- Preis-Logik als SQL-Ausdrücke (USD pro 1 Mio Tokens, je Modell) -------
// Reihenfolge wichtig: spezifischere Muster zuerst.
const PIN = `(CASE
  WHEN model LIKE '%opus-4-1%' OR model LIKE '%opus-4-0%' OR model LIKE '%opus-3%' THEN 15.0
  WHEN model LIKE '%opus%'      THEN 5.0
  WHEN model LIKE '%haiku-3-5%' THEN 0.8
  WHEN model LIKE '%haiku-3%'   THEN 0.25
  WHEN model LIKE '%haiku%'     THEN 1.0
  WHEN model LIKE '%sonnet%'    THEN 3.0
  ELSE 3.0 END)`;
const POUT = `(CASE
  WHEN model LIKE '%opus-4-1%' OR model LIKE '%opus-4-0%' OR model LIKE '%opus-3%' THEN 75.0
  WHEN model LIKE '%opus%'      THEN 25.0
  WHEN model LIKE '%haiku-3-5%' THEN 4.0
  WHEN model LIKE '%haiku-3%'   THEN 1.25
  WHEN model LIKE '%haiku%'     THEN 5.0
  WHEN model LIKE '%sonnet%'    THEN 15.0
  ELSE 15.0 END)`;
// Realer Wert: nur frischer Input + Output
const REAL = `((input*${PIN} + output*${POUT})/1000000.0)`;
// Voller API-Gegenwert: real + Cache (Lesen 0.1×, 5m-Write 1.25×, 1h-Write 2×)
const FULL = `(${REAL} + (cache_read*${PIN}*0.1 + cw5*${PIN}*1.25 + cw1*${PIN}*2.0)/1000000.0)`;
const CACHE_TOK = `(cache_read + cw5 + cw1)`;

let db = null;

export function getDb() {
  if (db) return db;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");

  // Migration: altes Schema (ohne cw1) → neu aufbauen (Logs werden neu eingelesen).
  const cols = db.prepare("PRAGMA table_info(events)").all().map((c) => c.name);
  if (cols.length && !cols.includes("cw1")) {
    db.exec("DROP TABLE IF EXISTS events; DELETE FROM ingest_state;");
  }

  // code-Tabelle: vorhanden? Hat sie die Spalte hour? Falls Schema veraltet,
  // neu aufbauen und Ingest-Historie löschen (Logs werden neu eingelesen;
  // events bleiben via INSERT OR IGNORE erhalten).
  const codeInfo = db.prepare("PRAGMA table_info(code)").all();
  const codeExists = codeInfo.length > 0;
  const codeHasHour = codeInfo.some((c) => c.name === "hour");
  if (codeExists && !codeHasHour) db.exec("DROP TABLE code;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      ts TEXT, day TEXT, hour INTEGER, dow INTEGER,
      model TEXT, project TEXT, cwd TEXT, session TEXT, version TEXT,
      input INTEGER, output INTEGER, cache_read INTEGER, cw5 INTEGER, cw1 INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_events_day ON events(day);
    CREATE INDEX IF NOT EXISTS idx_events_model ON events(model);
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE TABLE IF NOT EXISTS errors (
      id TEXT PRIMARY KEY, ts TEXT, day TEXT, status INTEGER
    );
    CREATE TABLE IF NOT EXISTS code (
      id TEXT PRIMARY KEY, ts TEXT, day TEXT, hour INTEGER, dow INTEGER,
      session TEXT, project TEXT, path TEXT, ext TEXT, lang TEXT, lines INTEGER, op TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_code_day ON code(day);
    CREATE INDEX IF NOT EXISTS idx_code_lang ON code(lang);
    CREATE TABLE IF NOT EXISTS ingest_state (
      file TEXT PRIMARY KEY, mtime REAL, size INTEGER
    );
  `);

  if (!codeExists || !codeHasHour) db.exec("DELETE FROM ingest_state;");
  return db;
}

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

export function ingest(claudePath) {
  const d = getDb();
  const projectsDir = join(claudePath, "projects");
  if (!existsSync(projectsDir)) return { files: 0, inserted: 0 };

  const files = walk(projectsDir);
  const getState = d.prepare("SELECT mtime, size FROM ingest_state WHERE file = ?");
  const setState = d.prepare(
    "INSERT INTO ingest_state(file, mtime, size) VALUES(?,?,?) ON CONFLICT(file) DO UPDATE SET mtime=excluded.mtime, size=excluded.size"
  );
  const insEvent = d.prepare(`
    INSERT OR IGNORE INTO events
      (id, ts, day, hour, dow, model, project, cwd, session, version,
       input, output, cache_read, cw5, cw1)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insError = d.prepare("INSERT OR IGNORE INTO errors(id, ts, day, status) VALUES(?,?,?,?)");
  const insCode = d.prepare(
    "INSERT OR IGNORE INTO code(id, ts, day, hour, dow, session, project, path, ext, lang, lines, op) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
  );

  let processed = 0;
  let inserted = 0;

  d.exec("BEGIN");
  try {
    for (const file of files) {
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      const prev = getState.get(file);
      if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) continue;
      processed++;

      let content;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of content.split("\n")) {
        if (!line || line[0] !== "{") continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = o.timestamp;
        if (!ts) continue;
        const dt = new Date(ts);
        if (Number.isNaN(dt.getTime())) continue;
        const day = ts.slice(0, 10);

        if (o.apiErrorStatus || o.error === "rate_limit") {
          insError.run(o.uuid || `${o.requestId || ""}|${ts}`, ts, day, Number(o.apiErrorStatus) || 0);
        }

        if (o.type !== "assistant") continue;
        const msg = o.message;

        // Datei-Edits (Programmiersprachen) aus den Tool-Aufrufen ziehen
        if (Array.isArray(msg?.content)) {
          for (const b of msg.content) {
            if (!b || b.type !== "tool_use" || !b.id) continue;
            if (!["Write", "Edit", "MultiEdit", "NotebookEdit", "Update"].includes(b.name)) continue;
            const inp = b.input || {};
            const fp = editPath(inp);
            if (!fp) continue;
            const ext = extname(String(fp)).toLowerCase();
            insCode.run(
              b.id,
              ts,
              day,
              dt.getHours(),
              dt.getDay(),
              o.sessionId || "",
              projectName(o.cwd || ""),
              String(fp),
              ext,
              langOf(ext),
              editLines(b.name, inp),
              b.name
            );
          }
        }

        const u = msg?.usage;
        if (!u || msg.model === "<synthetic>") continue;
        const id = `${msg.id || o.uuid || ""}|${o.requestId || ""}`;
        if (id === "|") continue;

        const cc = u.cache_creation || {};
        const cw5 = cc.ephemeral_5m_input_tokens ?? 0;
        const cw1 = cc.ephemeral_1h_input_tokens ?? (u.cache_creation_input_tokens || 0) - cw5;
        const cwd = o.cwd || "";
        const res = insEvent.run(
          id,
          ts,
          day,
          dt.getHours(),
          dt.getDay(),
          msg.model || "unknown",
          projectName(cwd),
          cwd,
          o.sessionId || "",
          o.version || "",
          u.input_tokens || 0,
          u.output_tokens || 0,
          u.cache_read_input_tokens || 0,
          Math.max(0, cw5),
          Math.max(0, cw1)
        );
        if (res.changes) inserted++;
      }
      setState.run(file, st.mtimeMs, st.size);
    }
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  return { files: processed, inserted };
}

// --- Abfragen -------------------------------------------------------------
function whereSince(since) {
  return since ? " WHERE day >= ?" : "";
}
function args(since) {
  return since ? [since] : [];
}

export function summary(since) {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(input+output),0) AS tokens,
              COALESCE(SUM(output),0) AS output_tokens,
              COALESCE(SUM(input),0) AS input_tokens,
              COALESCE(SUM(${CACHE_TOK}),0) AS cache_tokens,
              COALESCE(SUM(${REAL}),0) AS real_cost,
              COALESCE(SUM(${FULL}),0) AS api_cost,
              COUNT(DISTINCT day) AS active_days,
              COUNT(DISTINCT session) AS sessions,
              MIN(day) AS first_day, MAX(day) AS last_day
       FROM events${whereSince(since)}`
    )
    .get(...args(since));
}

export function byModel(since) {
  return getDb()
    .prepare(
      `SELECT model, COUNT(*) AS requests, SUM(input+output) AS tokens,
              SUM(${CACHE_TOK}) AS cache_tokens,
              SUM(${FULL}) AS cost, SUM(${REAL}) AS cost_real
       FROM events${whereSince(since)}
       GROUP BY model ORDER BY cost DESC`
    )
    .all(...args(since));
}

export function byProject(since) {
  return getDb()
    .prepare(
      `SELECT project AS name, MAX(cwd) AS path, COUNT(*) AS requests,
              SUM(input+output) AS tokens, SUM(output) AS output_tokens,
              SUM(${FULL}) AS cost, SUM(${REAL}) AS cost_real
       FROM events${whereSince(since)}
       GROUP BY LOWER(cwd) ORDER BY requests DESC`
    )
    .all(...args(since));
}

export function daily(since) {
  return getDb()
    .prepare(
      `SELECT day AS date, COUNT(*) AS requests, SUM(input+output) AS tokens,
              SUM(${FULL}) AS cost, SUM(${REAL}) AS cost_real
       FROM events${whereSince(since)}
       GROUP BY day ORDER BY day`
    )
    .all(...args(since));
}

export function byHour(since) {
  const rows = getDb()
    .prepare(
      `SELECT hour, COUNT(*) AS requests, SUM(${REAL}) AS cost_real
       FROM events${whereSince(since)} GROUP BY hour`
    )
    .all(...args(since));
  const arr = Array.from({ length: 24 }, (_, h) => ({ hour: h, requests: 0, cost_real: 0 }));
  for (const r of rows) arr[r.hour] = { hour: r.hour, requests: r.requests, cost_real: r.cost_real };
  return arr;
}

export function byWeekday(since) {
  const rows = getDb()
    .prepare(
      `SELECT dow, COUNT(*) AS requests, SUM(${REAL}) AS cost_real
       FROM events${whereSince(since)} GROUP BY dow`
    )
    .all(...args(since));
  const arr = Array.from({ length: 7 }, (_, w) => ({ dow: w, requests: 0, cost_real: 0 }));
  for (const r of rows) arr[r.dow] = { dow: r.dow, requests: r.requests, cost_real: r.cost_real };
  return arr;
}

// --- Muster (Stunde / Wochentag / Wochentag×Stunde) ----------------------
export function evHour(since) {
  return getDb()
    .prepare(`SELECT hour, COUNT(*) AS requests, COALESCE(SUM(${REAL}),0) AS cost FROM events${whereSince(since)} GROUP BY hour`)
    .all(...args(since));
}
export function evDow(since) {
  return getDb()
    .prepare(`SELECT dow, COUNT(*) AS requests, COALESCE(SUM(${REAL}),0) AS cost FROM events${whereSince(since)} GROUP BY dow`)
    .all(...args(since));
}
export function evDowHour(since) {
  return getDb()
    .prepare(`SELECT dow, hour, COUNT(*) AS requests, COALESCE(SUM(${REAL}),0) AS cost FROM events${whereSince(since)} GROUP BY dow, hour`)
    .all(...args(since));
}
export function cdHour(since) {
  return getDb()
    .prepare(`SELECT hour, COALESCE(SUM(lines),0) AS lines FROM code${whereSince(since)} GROUP BY hour`)
    .all(...args(since));
}
export function cdDow(since) {
  return getDb()
    .prepare(`SELECT dow, COALESCE(SUM(lines),0) AS lines FROM code${whereSince(since)} GROUP BY dow`)
    .all(...args(since));
}
export function cdDowHour(since) {
  return getDb()
    .prepare(`SELECT dow, hour, COALESCE(SUM(lines),0) AS lines FROM code${whereSince(since)} GROUP BY dow, hour`)
    .all(...args(since));
}

export function rateLimits(since) {
  const total = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM errors${since ? " WHERE day >= ? AND" : " WHERE"} status = 429`)
    .get(...(since ? [since] : []));
  return total.n || 0;
}

export function sessionStats(since) {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS sessions, AVG(reqs) AS avg_reqs, MAX(reqs) AS max_reqs
       FROM (SELECT session, COUNT(*) AS reqs FROM events${whereSince(since)} GROUP BY session)`
    )
    .get(...args(since));
}

export function allTime() {
  return summary(null);
}

// Wie viel pro Programmiersprache geschrieben/editiert wurde.
// Optional auf ein Projekt eingeschränkt.
export function byLanguage(since, project) {
  const where = [];
  const a = [];
  if (since) {
    where.push("day >= ?");
    a.push(since);
  }
  if (project) {
    where.push("project = ?");
    a.push(project);
  }
  const w = where.length ? " WHERE " + where.join(" AND ") : "";
  return getDb()
    .prepare(
      `SELECT lang, COUNT(*) AS edits, COALESCE(SUM(lines),0) AS lines,
              COUNT(DISTINCT path) AS files
       FROM code${w} GROUP BY lang ORDER BY lines DESC`
    )
    .all(...a);
}

// Projekte mit Code-Aktivität (für das Dropdown).
export function codeProjects(since) {
  return getDb()
    .prepare(
      `SELECT project, COALESCE(SUM(lines),0) AS lines FROM code${since ? " WHERE day >= ?" : ""}
       GROUP BY project HAVING lines > 0 ORDER BY lines DESC`
    )
    .all(...(since ? [since] : []));
}

// --- Live -----------------------------------------------------------------
export function recent(limit = 20) {
  return getDb()
    .prepare(
      `SELECT id, ts, model, project, session, output, input, cache_read,
              ${REAL} AS cost_real, ${FULL} AS cost_full
       FROM events ORDER BY ts DESC LIMIT ?`
    )
    .all(limit);
}

export function statsSince(iso) {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(${REAL}),0) AS real_cost,
              COALESCE(SUM(${FULL}),0) AS api_cost,
              COALESCE(SUM(input+output),0) AS tokens
       FROM events WHERE ts >= ?`
    )
    .get(iso);
}

export function dayExact(day) {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(${REAL}),0) AS real_cost,
              COALESCE(SUM(input+output),0) AS tokens
       FROM events WHERE day = ?`
    )
    .get(day);
}

export function sessionAgg(session) {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(input+output),0) AS tokens,
              COALESCE(SUM(${REAL}),0) AS real_cost,
              MIN(ts) AS start_ts, MAX(ts) AS last_ts
       FROM events WHERE session = ?`
    )
    .get(session);
}

export function busiestDay() {
  return getDb().prepare("SELECT day, COUNT(*) AS requests FROM events GROUP BY day ORDER BY requests DESC LIMIT 1").get();
}

export function distinctDays() {
  return getDb().prepare("SELECT DISTINCT day FROM events ORDER BY day DESC").all().map((r) => r.day);
}

export function countSince(iso) {
  return getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE ts >= ?").get(iso).n || 0;
}

export function lastEventTs() {
  const r = getDb().prepare("SELECT MAX(ts) AS ts FROM events").get();
  return r.ts || null;
}

// Geschätzte Arbeitszeit pro Tag: Summe der Lücken zwischen aufeinanderfolgenden
// Requests, sofern die Lücke <= thresholdMin ist (längere Lücken = Pause).
export function workdays(since, thresholdMin = 25) {
  // Gruppierung nach lokalem "Arbeitstag" mit 05-Uhr-Grenze: alles vor 05:00
  // lokaler Zeit zählt noch zum Vortag (für Nachtarbeit über Mitternacht).
  const wd = "date(ts,'localtime','-5 hours')";
  const sql = `
    SELECT wd AS day,
           MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS requests,
           COALESCE(SUM(CASE WHEN gap <= ? THEN gap ELSE 0 END), 0) AS active_min
    FROM (
      SELECT ${wd} AS wd, ts,
        (julianday(ts) - julianday(LAG(ts) OVER (PARTITION BY ${wd} ORDER BY ts))) * 1440.0 AS gap
      FROM events${since ? ` WHERE ${wd} >= ?` : ""}
    )
    GROUP BY wd ORDER BY wd`;
  const params = since ? [thresholdMin, since] : [thresholdMin];
  return getDb().prepare(sql).all(...params);
}

// Tägliche Aktivität über ALLE Zeit (für die Kalender-Heatmap).
export function dailyAll() {
  return getDb()
    .prepare(`SELECT day AS date, COUNT(*) AS requests, SUM(${REAL}) AS cost_real FROM events GROUP BY day ORDER BY day`)
    .all();
}
