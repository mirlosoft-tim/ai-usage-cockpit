// Lokaler Config-Speicher. Hält Accounts inkl. API-Keys in einer JSON-Datei
// neben der App. Keys verlassen niemals deinen Rechner.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const CONFIG_PATH = join(DATA_DIR, "config.json");

const DEFAULT = { accounts: [] };

async function ensureDir() {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
}

export async function loadConfig() {
  await ensureDir();
  if (!existsSync(CONFIG_PATH)) return structuredClone(DEFAULT);
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return { accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [] };
  } catch {
    return structuredClone(DEFAULT);
  }
}

export async function saveConfig(config) {
  await ensureDir();
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

export async function listAccounts() {
  const { accounts } = await loadConfig();
  return accounts;
}

export async function getAccount(id) {
  const { accounts } = await loadConfig();
  return accounts.find((a) => a.id === id) || null;
}

const PROVIDERS = new Set(["anthropic", "openai", "claude-code"]);

export async function upsertAccount(input) {
  const config = await loadConfig();
  const provider = PROVIDERS.has(input.provider) ? input.provider : "anthropic";
  const clean = {
    provider,
    label: (input.label || "").trim() || "Unbenannter Account",
    apiKey: (input.apiKey || "").trim(),
    logPath: (input.logPath || "").trim() || null,
    monthlyBudget:
      input.monthlyBudget === "" || input.monthlyBudget == null
        ? null
        : Number(input.monthlyBudget),
  };
  if (clean.monthlyBudget !== null && !Number.isFinite(clean.monthlyBudget)) {
    clean.monthlyBudget = null;
  }

  if (input.id) {
    const idx = config.accounts.findIndex((a) => a.id === input.id);
    if (idx === -1) throw new Error("Account nicht gefunden");
    // Leeren Key beim Bearbeiten nicht überschreiben
    if (!clean.apiKey) clean.apiKey = config.accounts[idx].apiKey;
    config.accounts[idx] = { ...config.accounts[idx], ...clean, id: input.id };
    await saveConfig(config);
    return config.accounts[idx];
  }

  const account = { id: randomUUID(), createdAt: new Date().toISOString(), ...clean };
  config.accounts.push(account);
  await saveConfig(config);
  return account;
}

export async function deleteAccount(id) {
  const config = await loadConfig();
  const before = config.accounts.length;
  config.accounts = config.accounts.filter((a) => a.id !== id);
  if (config.accounts.length === before) throw new Error("Account nicht gefunden");
  await saveConfig(config);
}

// Maskiert den Key für die Anzeige im Frontend.
export function publicAccount(a) {
  const key = a.apiKey || "";
  const masked = key ? `${key.slice(0, 7)}…${key.slice(-4)}` : "";
  return {
    id: a.id,
    provider: a.provider,
    label: a.label,
    monthlyBudget: a.monthlyBudget ?? null,
    logPath: a.logPath ?? null,
    hasKey: Boolean(key),
    keyMasked: masked,
    needsKey: a.provider !== "claude-code",
    createdAt: a.createdAt,
  };
}
