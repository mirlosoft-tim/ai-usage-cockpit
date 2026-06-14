// Provider-Adapter: holen Nutzungs- & Kostendaten direkt von den Admin-APIs
// und normalisieren sie auf ein gemeinsames Format.
//
import { readLocalLogs } from "./localLogs.js";

// Gemeinsames Rückgabeformat (NormalizedUsage):
// {
//   currency: "usd",
//   monthToDateCost: number,        // Kosten aktueller Kalendermonat (USD)
//   todayCost: number,              // Kosten heute (USD)
//   daily: [{ date, cost, inputTokens, outputTokens, requests }],
//   tokens: { input, output, cacheRead, cacheCreation },
//   requests: number,
//   fetchedAt: ISO-String,
//   error: string | null
// }

const DAY_MS = 24 * 60 * 60 * 1000;

function iso(date) {
  return date.toISOString();
}

function startOfUTCDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUTCMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function dayKey(date) {
  return iso(startOfUTCDay(date)).slice(0, 10); // YYYY-MM-DD
}

// Fenster: Monatsanfang (oder maximal `maxDays` zurück) bis morgen.
function buildWindow(maxDays = 35) {
  const now = new Date();
  const monthStart = startOfUTCMonth(now);
  const earliest = new Date(now.getTime() - maxDays * DAY_MS);
  const start = monthStart < earliest ? earliest : monthStart;
  const end = new Date(startOfUTCDay(now).getTime() + DAY_MS); // exklusiver Endpunkt = morgen 00:00
  return { start: startOfUTCDay(start), end, now };
}

async function fetchJson(url, options, timeoutMs = 20000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      const msg =
        body?.error?.message ||
        body?.error?.type ||
        body?.message ||
        `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

function emptyUsage() {
  return {
    currency: "usd",
    monthToDateCost: 0,
    todayCost: 0,
    daily: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    requests: 0,
    fetchedAt: new Date().toISOString(),
    error: null,
  };
}

// --- Anthropic ------------------------------------------------------------
// Docs: https://platform.claude.com/docs/en/api/usage-cost-api
// Cost Report:  GET /v1/organizations/cost_report   (USD, Tages-Buckets)
// Usage Report: GET /v1/organizations/usage_report/messages (Tokens)
// Auth: x-api-key = Admin-Key (sk-ant-admin...), anthropic-version: 2023-06-01

async function fetchAnthropic(apiKey) {
  const out = emptyUsage();
  const { start, end, now } = buildWindow();
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "User-Agent": "aiManager/1.0",
  };

  const todayKey = dayKey(now);
  const dailyMap = new Map(); // YYYY-MM-DD -> { cost, inputTokens, outputTokens, requests }
  const ensure = (k) => {
    if (!dailyMap.has(k)) dailyMap.set(k, { cost: 0, inputTokens: 0, outputTokens: 0, requests: 0 });
    return dailyMap.get(k);
  };

  // 1) Kosten (USD)
  try {
    let page = null;
    do {
      const qs = new URLSearchParams({
        starting_at: iso(start),
        ending_at: iso(end),
      });
      if (page) qs.set("page", page);
      const url = `https://api.anthropic.com/v1/organizations/cost_report?${qs.toString()}`;
      const body = await fetchJson(url, { headers });
      for (const bucket of body.data ?? []) {
        const k = (bucket.starting_at || "").slice(0, 10);
        if (!k) continue;
        const entry = ensure(k);
        for (const r of bucket.results ?? []) {
          // amount kommt als Dezimal-String in USD
          const amt = parseFloat(r.amount ?? r.cost ?? "0");
          if (!Number.isNaN(amt)) entry.cost += amt;
        }
      }
      page = body.has_more ? body.next_page : null;
    } while (page);
  } catch (e) {
    out.error = `Kosten: ${e.message}`;
  }

  // 2) Tokens / Requests
  try {
    let page = null;
    do {
      const qs = new URLSearchParams({
        starting_at: iso(start),
        ending_at: iso(end),
        bucket_width: "1d",
      });
      if (page) qs.set("page", page);
      const url = `https://api.anthropic.com/v1/organizations/usage_report/messages?${qs.toString()}`;
      const body = await fetchJson(url, { headers });
      for (const bucket of body.data ?? []) {
        const k = (bucket.starting_at || "").slice(0, 10);
        if (!k) continue;
        const entry = ensure(k);
        for (const r of bucket.results ?? []) {
          const input =
            (r.uncached_input_tokens ?? 0) +
            (r.cache_read_input_tokens ?? 0) +
            (r.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
            (r.cache_creation?.ephemeral_1h_input_tokens ?? 0) +
            (r.cache_creation_input_tokens ?? 0);
          const output = r.output_tokens ?? 0;
          entry.inputTokens += input;
          entry.outputTokens += output;
          entry.requests += 1;
          out.tokens.input += r.uncached_input_tokens ?? 0;
          out.tokens.output += output;
          out.tokens.cacheRead += r.cache_read_input_tokens ?? 0;
          out.tokens.cacheCreation +=
            (r.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
            (r.cache_creation?.ephemeral_1h_input_tokens ?? 0) +
            (r.cache_creation_input_tokens ?? 0);
        }
      }
      page = body.has_more ? body.next_page : null;
    } while (page);
  } catch (e) {
    out.error = out.error ? `${out.error}; Tokens: ${e.message}` : `Tokens: ${e.message}`;
  }

  finalize(out, dailyMap, todayKey);
  return out;
}

// --- OpenAI ---------------------------------------------------------------
// Docs: https://platform.openai.com/docs/api-reference/usage
// Costs:  GET /v1/organization/costs?start_time=...&bucket_width=1d
// Usage:  GET /v1/organization/usage/completions?start_time=...&bucket_width=1d
// Auth: Authorization: Bearer <Admin-Key sk-admin...>
// Zeit als Unix-Sekunden.

async function fetchOpenAI(apiKey) {
  const out = emptyUsage();
  const { start, end, now } = buildWindow();
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": "aiManager/1.0",
  };
  const startTime = Math.floor(start.getTime() / 1000);
  const endTime = Math.floor(end.getTime() / 1000);

  const todayKey = dayKey(now);
  const dailyMap = new Map();
  const ensure = (k) => {
    if (!dailyMap.has(k)) dailyMap.set(k, { cost: 0, inputTokens: 0, outputTokens: 0, requests: 0 });
    return dailyMap.get(k);
  };
  const bucketKey = (b) => dayKey(new Date((b.start_time ?? startTime) * 1000));

  // 1) Kosten (USD)
  try {
    let page = null;
    do {
      const qs = new URLSearchParams({
        start_time: String(startTime),
        end_time: String(endTime),
        bucket_width: "1d",
        limit: "31",
      });
      if (page) qs.set("page", page);
      const url = `https://api.openai.com/v1/organization/costs?${qs.toString()}`;
      const body = await fetchJson(url, { headers });
      for (const bucket of body.data ?? []) {
        const k = bucketKey(bucket);
        const entry = ensure(k);
        for (const r of bucket.results ?? []) {
          const amt = r.amount?.value ?? 0;
          if (typeof amt === "number") entry.cost += amt;
        }
      }
      page = body.has_more ? body.next_page : null;
    } while (page);
  } catch (e) {
    out.error = `Kosten: ${e.message}`;
  }

  // 2) Tokens / Requests
  try {
    let page = null;
    do {
      const qs = new URLSearchParams({
        start_time: String(startTime),
        end_time: String(endTime),
        bucket_width: "1d",
        limit: "31",
      });
      if (page) qs.set("page", page);
      const url = `https://api.openai.com/v1/organization/usage/completions?${qs.toString()}`;
      const body = await fetchJson(url, { headers });
      for (const bucket of body.data ?? []) {
        const k = bucketKey(bucket);
        const entry = ensure(k);
        for (const r of bucket.results ?? []) {
          const input = r.input_tokens ?? 0;
          const output = r.output_tokens ?? 0;
          entry.inputTokens += input;
          entry.outputTokens += output;
          entry.requests += r.num_model_requests ?? 0;
          out.tokens.input += input;
          out.tokens.output += output;
          out.tokens.cacheRead += r.input_cached_tokens ?? 0;
        }
      }
      page = body.has_more ? body.next_page : null;
    } while (page);
  } catch (e) {
    out.error = out.error ? `${out.error}; Tokens: ${e.message}` : `Tokens: ${e.message}`;
  }

  finalize(out, dailyMap, todayKey);
  return out;
}

function finalize(out, dailyMap, todayKey) {
  const days = [...dailyMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  out.daily = days.map(([date, v]) => ({
    date,
    cost: round(v.cost),
    inputTokens: v.inputTokens,
    outputTokens: v.outputTokens,
    requests: v.requests,
  }));
  out.monthToDateCost = round(out.daily.reduce((s, d) => s + d.cost, 0));
  out.requests = out.daily.reduce((s, d) => s + d.requests, 0);
  const today = dailyMap.get(todayKey);
  out.todayCost = round(today ? today.cost : 0);
  out.fetchedAt = new Date().toISOString();
}

function round(n) {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}

export async function fetchUsage(account) {
  // Lokale Claude-Code-Logs brauchen keinen Key.
  if (account.provider === "claude-code") {
    try {
      return await readLocalLogs(account);
    } catch (e) {
      const u = emptyUsage();
      u.error = e.message || String(e);
      return u;
    }
  }

  const key = account.apiKey;
  if (!key) {
    const u = emptyUsage();
    u.error = "Kein API-Key hinterlegt";
    return u;
  }
  try {
    if (account.provider === "anthropic") return await fetchAnthropic(key);
    if (account.provider === "openai") return await fetchOpenAI(key);
    const u = emptyUsage();
    u.error = `Unbekannter Provider: ${account.provider}`;
    return u;
  } catch (e) {
    const u = emptyUsage();
    u.error = e.message || String(e);
    return u;
  }
}
