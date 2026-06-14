// Minimal i18n: DE/EN dictionaries + t() with {placeholder} support.
// Loaded before app.js, exposes globals: LANG, t, setLang, applyStaticI18n,
// WD_I18N, MON_I18N.

const I18N = {
  de: {
    tagline: "Verbrauchsauszug · Claude Code (lokal)",
    sync: "Sync",
    range_label: "Zeitraum",
    range_7: "7 T", range_30: "30 T", range_90: "90 T", range_all: "Gesamt",
    range_all_name: "Gesamter Verlauf", range_last: "Letzte {n} Tage",
    range_span: "{n} Tage mit Daten · {from} – {to}",

    live: "LIVE",
    last_event: "letztes Event {ago}", just_now: "gerade eben",
    ago_s: "vor {n}s", ago_m: "vor {n} min", ago_h: "vor {n} h",
    rate: "{a}/min · {b} in 5 min · {c} in 60 min",
    today: "HEUTE", req: "req", tok: "tok",
    record: "🔥 REKORDTAG! {n} req", of_peak: "{pct}% vom stärksten Tag ({n} req)",
    console_title: "live · ~/.claude/projects",

    tile_burn: "Burn-Rate", tile_burn_sub: "real · API {v}/h",
    tile_tpm: "Tokens / min", tile_tpm_sub: "letzte 5 min",
    tile_session: "Aktive Session", tile_session_sub: "{min} min · {proj}",
    tile_streak: "Streak", tile_streak_sub: "in Folge aktiv",
    tile_perreq: "$ / Request", tile_perreq_sub: "Cache {pct}%",
    tile_vs: "Heute vs gestern", tile_vs_sub: "{n} gestern",
    days: "Tage",

    fig_requests: "Requests", fig_tokens: "Tokens",
    fig_real: "Realer Wert", fig_real_sub: "ohne Cache",
    fig_cost: "Kosten", fig_cost_sub: "⌀ {v}/Tag",
    fig_api: "API-Gegenwert", fig_api_sub: "inkl. Cache · nicht dein Abo",
    fig_proj: "Prognose / Monat", fig_proj_sub: "Hochrechnung",
    info_real: "Nur frischer Input + Output zu API-Preisen — der echte Arbeitsanteil, ohne den gecachten Kontext.",
    info_api: "Was diese Nutzung komplett per Pay-as-you-go-API kosten würde. NICHT dein Abo-Preis — dein Abo deckt das pauschal ab.",

    s_activedays: "Aktive Tage", s_sessions: "Sessions", s_sessions_sub: "⌀ {n} req",
    s_output: "⌀ Output / Req", s_limit: "Limit-Treffer (429)",
    s_since: "Seit Beginn", s_since_sub: "API-Wert kumuliert",

    pat_hour: "Nach Tageszeit", pat_week: "Nach Wochentag", pat_punch: "Wochentag × Tageszeit",
    m_req: "Req", m_lines: "Zeilen", m_cost: "$",
    m_req_full: "Requests", m_lines_full: "Zeilen", m_cost_full: "Kosten",
    punch_total: "· {v} gesamt",
    u_req: "{n} req", u_lines: "{n} Zeilen", u_cost: "{v} real",

    focus: "Fokus & Pausen",
    f_blocks: "Fokus-Blöcke", f_avg: "⌀ Fokus", f_longest: "Längster Fokus",
    f_pauses: "Pausen", f_avgpause: "⌀ Pause",
    records: "Rekorde · Bestwerte",
    r_busiest: "Meiste Requests / Tag", r_lines: "Meiste Zeilen / Tag",
    r_costday: "Teuerster Tag", r_costreq: "Teuerster Request",
    r_session: "Größte Session", r_model: "Top-Modell", r_lang: "Top-Sprache",
    r_lines_v: "{n} Zeilen", r_session_v: "{n} req", r_session_sub: "{min} · {tok} tok",
    work: "Geschätzte Arbeitszeit", work_total: "· {h} h über {n} Tage",
    w_total: "Gesamt", w_avg: "⌀ pro Tag", w_start: "⌀ Start", w_end: "⌀ Ende",
    w_lph: "Zeilen / Stunde", w_lph_sub: "Code-Tempo", w_longest: "Längster Tag",
    h_active: "{h} h aktiv",

    cal: "Kalender · letztes Jahr", cal_req: "Requests", cal_hours: "Stunden", cal_cost: "Kosten",
    less: "weniger", more: "mehr", no_activity: "keine Aktivität",
    cal_req_total: "· {n} req", cal_hours_total: "· {n} h", cal_cost_total: "· {v}",
    tip_req: "{n} req", tip_hours: "{h} h aktiv", tip_cost: "{v} real",

    langs: "Programmiersprachen · geschriebene Zeilen",
    langs_total: "· {n} Zeilen über {c} Sprachen",
    all_projects: "Alle Projekte", search_project: "Projekt suchen…",
    unit_lines_short: "Z", unit_files_short: "Dat",
    lang_meta: "{pct}% · {n} Dat",

    trend: "Modell-Mix im Zeitverlauf", trend_info: "· {m} Modelle über {n} Tage", other: "Andere",
    topfiles: "Top-Dateien · am häufigsten bearbeitet",
    th_file: "Datei", th_project: "Projekt", th_edits: "Edits", th_lines: "Zeilen",
    rate_limits: "Rate-Limit-Treffer (429) · Wochentag × Tageszeit",
    rate_total: "· {n} Treffer", rate_none: "· keine", tip_429: "{w} {h}:00 · {n}× 429",

    models: "Modelle · diesen Monat",
    th_model: "Modell", th_req: "Requests", th_tokens: "Tokens", th_realc: "Real $", th_apic: "API-Wert $",
    sum: "Summe",
    projects: "Projekte · nach Ordner", th_share: "Anteil", more_n: "+ {n} weitere",

    breakdown: "Aufschlüsselung",
    cache_cap: "{c}% gecachter Kontext · {r}% echte Arbeit",
    leg_cache: "gecachter Kontext", leg_real: "echte Arbeit ({v})",
    abo_note: "Abo (Pauschalpreis) — kein $-Limit. Verbrauch siehst du an Tokens & Requests.",

    cap_daily: "TAGESVERBRAUCH (REAL) · LETZTE 30 TAGE",
    empty_h: "Keine Claude-Code-Logs gefunden",
    empty_p: "Erwartet unter {path}. Sobald du Claude Code nutzt, erscheinen hier deine Zahlen — automatisch, ohne Konfiguration.",
  },
  en: {
    tagline: "Usage statement · Claude Code (local)",
    sync: "Sync",
    range_label: "Range",
    range_7: "7d", range_30: "30d", range_90: "90d", range_all: "All",
    range_all_name: "Full history", range_last: "Last {n} days",
    range_span: "{n} days with data · {from} – {to}",

    live: "LIVE",
    last_event: "last event {ago}", just_now: "just now",
    ago_s: "{n}s ago", ago_m: "{n} min ago", ago_h: "{n} h ago",
    rate: "{a}/min · {b} in 5 min · {c} in 60 min",
    today: "TODAY", req: "req", tok: "tok",
    record: "🔥 RECORD DAY! {n} req", of_peak: "{pct}% of your busiest day ({n} req)",
    console_title: "live · ~/.claude/projects",

    tile_burn: "Burn rate", tile_burn_sub: "real · API {v}/h",
    tile_tpm: "Tokens / min", tile_tpm_sub: "last 5 min",
    tile_session: "Active session", tile_session_sub: "{min} min · {proj}",
    tile_streak: "Streak", tile_streak_sub: "consecutive days",
    tile_perreq: "$ / request", tile_perreq_sub: "cache {pct}%",
    tile_vs: "Today vs yesterday", tile_vs_sub: "{n} yesterday",
    days: "days",

    fig_requests: "Requests", fig_tokens: "Tokens",
    fig_real: "Real value", fig_real_sub: "without cache",
    fig_cost: "Cost", fig_cost_sub: "⌀ {v}/day",
    fig_api: "API-equivalent", fig_api_sub: "incl. cache · not your plan price",
    fig_proj: "Projected / month", fig_proj_sub: "extrapolation",
    info_real: "Only fresh input + output at API prices — the real work, excluding cached context.",
    info_api: "What this usage would cost on pay-as-you-go API. NOT your subscription price — your plan covers it flat.",

    s_activedays: "Active days", s_sessions: "Sessions", s_sessions_sub: "⌀ {n} req",
    s_output: "⌀ output / req", s_limit: "Rate limits (429)",
    s_since: "Since start", s_since_sub: "API value, cumulative",

    pat_hour: "By hour of day", pat_week: "By weekday", pat_punch: "Weekday × hour",
    m_req: "Req", m_lines: "Lines", m_cost: "$",
    m_req_full: "Requests", m_lines_full: "Lines", m_cost_full: "Cost",
    punch_total: "· {v} total",
    u_req: "{n} req", u_lines: "{n} lines", u_cost: "{v} real",

    focus: "Focus & breaks",
    f_blocks: "Focus blocks", f_avg: "⌀ focus", f_longest: "Longest focus",
    f_pauses: "Breaks", f_avgpause: "⌀ break",
    records: "Records · personal bests",
    r_busiest: "Most requests / day", r_lines: "Most lines / day",
    r_costday: "Priciest day", r_costreq: "Priciest request",
    r_session: "Biggest session", r_model: "Top model", r_lang: "Top language",
    r_lines_v: "{n} lines", r_session_v: "{n} req", r_session_sub: "{min} · {tok} tok",
    work: "Estimated working time", work_total: "· {h} h over {n} days",
    w_total: "Total", w_avg: "⌀ per day", w_start: "⌀ start", w_end: "⌀ end",
    w_lph: "Lines / hour", w_lph_sub: "coding pace", w_longest: "Longest day",
    h_active: "{h} h active",

    cal: "Calendar · past year", cal_req: "Requests", cal_hours: "Hours", cal_cost: "Cost",
    less: "less", more: "more", no_activity: "no activity",
    cal_req_total: "· {n} req", cal_hours_total: "· {n} h", cal_cost_total: "· {v}",
    tip_req: "{n} req", tip_hours: "{h} h active", tip_cost: "{v} real",

    langs: "Programming languages · lines written",
    langs_total: "· {n} lines across {c} languages",
    all_projects: "All projects", search_project: "Search project…",
    unit_lines_short: "L", unit_files_short: "files",
    lang_meta: "{pct}% · {n} files",

    trend: "Model mix over time", trend_info: "· {m} models over {n} days", other: "Other",
    topfiles: "Top files · most edited",
    th_file: "File", th_project: "Project", th_edits: "Edits", th_lines: "Lines",
    rate_limits: "Rate-limit hits (429) · weekday × hour",
    rate_total: "· {n} hits", rate_none: "· none", tip_429: "{w} {h}:00 · {n}× 429",

    models: "Models · this month",
    th_model: "Model", th_req: "Requests", th_tokens: "Tokens", th_realc: "Real $", th_apic: "API value $",
    sum: "Total",
    projects: "Projects · by folder", th_share: "Share", more_n: "+ {n} more",

    breakdown: "Breakdown",
    cache_cap: "{c}% cached context · {r}% real work",
    leg_cache: "cached context", leg_real: "real work ({v})",
    abo_note: "Subscription (flat fee) — no $ limit. See usage via tokens & requests.",

    cap_daily: "DAILY USAGE (REAL) · LAST 30 DAYS",
    empty_h: "No Claude Code logs found",
    empty_p: "Expected at {path}. As soon as you use Claude Code, your numbers appear here — automatically, no config.",
  },
};

let LANG = localStorage.getItem("lang") || "de";

function t(key, params) {
  let s = (I18N[LANG] && I18N[LANG][key]) ?? (I18N.de[key] ?? key);
  if (params) for (const k in params) s = s.replaceAll(`{${k}}`, params[k]);
  return s;
}

const WD_I18N = { de: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"], en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] };
const MON_I18N = {
  de: ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"],
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
};

// Statische [data-i18n] / [data-i18n-ph] Elemente füllen.
function applyStaticI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
  document.documentElement.lang = LANG;
}

function setLang(lang) {
  LANG = lang;
  localStorage.setItem("lang", lang);
  applyStaticI18n();
}
