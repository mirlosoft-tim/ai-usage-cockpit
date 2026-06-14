// Schlankes Frontend: zeigt ausschließlich den lokalen Claude-Code-Verbrauch.
// Zeitraum umschaltbar (7 / 30 / 90 Tage / Gesamt). Keine Keys, kein Account-Mgmt.

const $ = (s) => document.querySelector(s);
let currentDays = 3650; // Start: Gesamt
let currentProject = "__all__"; // Sprachen-Filter
let allProjects = []; // {name, lines} für das Dropdown

const fmtUsd = (n) =>
  n == null ? "—" : "$" + Number(n).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = (n) => Number(n || 0).toLocaleString("de-DE");
const fmtTokens = (n) => {
  n = Number(n || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " Mrd";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " Mio";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return String(n);
};

function rangeName(days) {
  if (days >= 365) return "Gesamter Verlauf";
  return `Letzte ${days} Tage`;
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "2-digit" });
}

function modelLabel(m) {
  return m
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-/g, " ")
    .replace(/\b(\d) (\d)\b/, "$1.$2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function load(force = false) {
  const btn = $("#refreshBtn");
  btn.classList.add("syncing");
  try {
    const res = await fetch(`/api/local?days=${currentDays}${force ? "&refresh=1" : ""}`);
    const d = await res.json();
    render(d);
  } catch (e) {
    console.error(e);
  } finally {
    btn.classList.remove("syncing");
  }
}

function render(d) {
  $("#period").textContent = rangeName(currentDays);

  if (!d.found) {
    $("#content").classList.add("hidden");
    $("#empty").classList.remove("hidden");
    $("#emptyPath").textContent = d.path || "~/.claude";
    $("#colophon").textContent = "";
    return;
  }

  $("#empty").classList.add("hidden");
  $("#content").classList.remove("hidden");

  const s = d.summary;
  $("#rangeSpan").textContent = `${s.daysCovered} Tage mit Daten · ${fmtDate(s.firstDate)} – ${fmtDate(s.lastDate)}`;

  renderFigures(s);
  renderStats2(s);
  patternsData = d.patterns || { hour: [], weekday: [], punch: [] };
  drawHourChart();
  drawWeekChart();
  renderPunch();
  renderWork(d.work);
  renderSplit(s);
  setCalendarData(d.heatmap, d.workHeatmap);
  allProjects = d.codeProjects || [];
  populateProjects();
  if (currentProject === "__all__") renderLanguages(d.byLanguage);
  else loadLanguages();
  renderModels(d.byModel);
  renderProjects(d.byProject, s.requests);
  drawChart(d.daily);

}

function renderFigures(s) {
  const figs = [
    { label: "Requests", value: fmtNum(s.requests), sub: `⌀ ${fmtNum(s.avgRequestsPerDay)}/Tag` },
    { label: "Tokens", value: fmtTokens(s.tokens), sub: `${fmtTokens(s.outputTokens)} Output` },
    {
      label: "Realer Wert",
      value: fmtUsd(s.realCost),
      sub: "ohne Cache",
      accent: true,
      info: "Nur frischer Input + Output zu API-Preisen — der echte Arbeitsanteil, ohne den gecachten Kontext.",
    },
    {
      label: "API-Gegenwert",
      value: fmtUsd(s.apiCost),
      sub: "inkl. Cache",
      info: "Was diese Nutzung komplett per Pay-as-you-go-API kosten würde. NICHT dein Abo-Preis — dein Abo deckt das pauschal ab.",
    },
  ];
  $("#figures").innerHTML = figs
    .map(
      (f) => `
      <div class="fig">
        <div class="fig-label">${f.label}${f.info ? ` <span class="info" title="${escapeHtml(f.info)}">i</span>` : ""}</div>
        <div class="fig-value ${f.accent ? "accent" : ""}">${f.value}</div>
        <div class="fig-sub">${f.sub}</div>
      </div>`
    )
    .join("");
}

function renderStats2(s) {
  const savedVsApi = s.apiCost; // API-Gegenwert = grob die "Ersparnis" ggü. Pay-as-you-go
  const stats = [
    { label: "Aktive Tage", value: fmtNum(s.activeDays) },
    { label: "Sessions", value: fmtNum(s.sessions), sub: `⌀ ${fmtNum(s.avgReqPerSession)} req` },
    { label: "⌀ Output / Req", value: fmtNum(s.avgOutputPerReq) },
    { label: "Limit-Treffer (429)", value: fmtNum(s.rateLimits), warn: s.rateLimits > 0 },
    { label: "Seit Beginn", value: fmtUsd(s.allTimeApi), sub: "API-Wert kumuliert" },
  ];
  $("#stats2").innerHTML = stats
    .map(
      (st) => `
      <div class="stat2">
        <div class="s2-label">${st.label}</div>
        <div class="s2-value ${st.warn ? "warn" : ""}">${st.value}</div>
        ${st.sub ? `<div class="s2-label" style="margin-top:4px">${st.sub}</div>` : ""}
      </div>`
    )
    .join("");
}

const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const chartReg = {}; // key -> Chart-Instanz (wird in place aktualisiert, nicht neu gebaut)

// Erstellt den Chart einmalig, danach nur noch Daten-Update (kein Flackern).
function upsertBar(key, canvasSel, labels, values, opts = {}) {
  const existing = chartReg[key];
  if (existing) {
    existing.data.labels = labels;
    existing.data.datasets[0].data = values;
    if (opts.color) existing.data.datasets[0].backgroundColor = opts.color;
    existing.update("none"); // ohne Animation/Neuaufbau
    return;
  }
  const ctx = $(canvasSel).getContext("2d");
  chartReg[key] = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: opts.color || "#17150f",
          hoverBackgroundColor: "#17150f",
          borderWidth: 0,
          barPercentage: opts.bp || 0.8,
          categoryPercentage: opts.cp || 0.9,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (i) => (opts.tip ? opts.tip(i.raw) : opts.money ? fmtUsd(i.raw) + " real" : fmtNum(i.raw) + " req"),
          },
          backgroundColor: "#17150f",
          padding: 7,
          titleFont: { family: "JetBrains Mono", size: 11 },
          bodyFont: { family: "JetBrains Mono", size: 11 },
          displayColors: false,
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: "#17150f", width: 1.5 },
          ticks: {
            font: { family: "JetBrains Mono", size: 9 },
            color: "#8a8578",
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: opts.maxTicks || 12,
          },
        },
        y: {
          beginAtZero: true,
          grid: { color: "#d8d3c5" },
          border: { display: false },
          ticks: {
            font: { family: "JetBrains Mono", size: 9 },
            color: "#8a8578",
            maxTicksLimit: 4,
            callback: opts.yfmt ? opts.yfmt : opts.money ? (v) => "$" + v : undefined,
          },
        },
      },
    },
  });
}

function renderWork(w) {
  if (!w || !w.days) {
    $("#workTotal").textContent = "";
    $("#workStats").innerHTML = "";
    return;
  }
  $("#workTotal").textContent = `· ${fmtNum(w.totalHours)} h über ${w.days} Tage`;
  const stats = [
    { l: "Gesamt", v: fmtNum(w.totalHours) + " h" },
    { l: "⌀ pro Tag", v: w.avgHours + " h" },
    { l: "⌀ Start", v: w.avgStart },
    { l: "⌀ Ende", v: w.avgEnd },
    { l: "Längster Tag", v: (w.maxDay ? w.maxDay.hours + " h" : "—"), sub: w.maxDay ? w.maxDay.date.slice(5) : "" },
  ];
  $("#workStats").innerHTML = stats
    .map(
      (s) => `<div class="stat2">
        <div class="s2-label">${s.l}</div>
        <div class="s2-value">${s.v}</div>
        ${s.sub ? `<div class="s2-sub">${s.sub}</div>` : ""}
      </div>`
    )
    .join("");

  const daily = w.daily || [];
  const labels = daily.map((d) => (currentDays > 31 ? d.date.slice(5).replace("-", ".") : d.date.slice(8, 10)));
  const values = daily.map((d) => d.hours);
  upsertBar("work", "#workChart", labels, values, {
    maxTicks: 14,
    bp: 0.78,
    cp: 0.88,
    color: "#4f7a4a", // Arbeitszeit · grün
    tip: (v) => v.toFixed(1) + " h aktiv",
    yfmt: (v) => v + "h",
  });
}

// Umschaltbare Metriken für Muster-Charts & Punchcard
let patternsData = { hour: [], weekday: [], punch: [] };
const patternMetric = { hour: "requests", week: "requests", punch: "requests" };
const METRICS = {
  requests: { get: (x) => x.requests || 0, tip: (v) => fmtNum(Math.round(v)) + " req", yfmt: (v) => fmtNum(v) },
  lines: { get: (x) => x.lines || 0, tip: (v) => fmtNum(Math.round(v)) + " Zeilen", yfmt: (v) => fmtNum(v) },
  cost: { get: (x) => x.cost || 0, tip: (v) => fmtUsd(v) + " real", yfmt: (v) => "$" + v },
};

function drawHourChart() {
  const m = METRICS[patternMetric.hour];
  const data = patternsData.hour || [];
  const labels = data.map((h) => pad2(h.hour));
  const values = data.map(m.get);
  upsertBar("hour", "#hourChart", labels, values, { maxTicks: 12, color: "#c4922a", tip: m.tip, yfmt: m.yfmt });
}

function drawWeekChart() {
  const m = METRICS[patternMetric.week];
  const order = [1, 2, 3, 4, 5, 6, 0]; // Mo..So
  const byDow = new Map((patternsData.weekday || []).map((w) => [w.dow, w]));
  const labels = order.map((i) => WEEKDAYS[i]);
  const values = order.map((i) => m.get(byDow.get(i) || {}));
  upsertBar("week", "#weekChart", labels, values, { maxTicks: 7, bp: 0.6, color: "#4a72a8", tip: m.tip, yfmt: m.yfmt });
}

function renderPunch() {
  const m = METRICS[patternMetric.punch];
  const data = patternsData.punch || [];
  if (!data.length) {
    $("#punch").innerHTML = "";
    return;
  }
  const max = Math.max(...data.map(m.get), 0.0001);
  const total = data.reduce((s, x) => s + m.get(x), 0);
  $("#punchInfo").textContent = total ? `· ${m.tip(total)} gesamt` : "";

  const order = [1, 2, 3, 4, 5, 6, 0]; // Mo..So
  const cells = [];
  for (const dow of order) {
    for (let h = 0; h < 24; h++) {
      const c = data[dow * 24 + h] || { requests: 0, cost: 0, lines: 0 };
      const v = m.get(c);
      const lvl = v > 0 ? Math.min(4, Math.ceil((v / max) * 4)) : 0;
      const tip = `${WEEKDAYS[dow]} ${pad2(h)}:00 · ${v > 0 ? m.tip(v) : "—"}`;
      cells.push(`<div class="punch-cell l${lvl}" data-tip="${escapeHtml(tip)}"></div>`);
    }
  }
  $("#punch").innerHTML = cells.join("");

  // Wochentags-Labels (Mo..So) + Stundenlabels (alle 3 h)
  $("#punchWd").innerHTML = order.map((i) => `<span>${WEEKDAYS[i]}</span>`).join("");
  $("#punchHours").innerHTML = Array.from({ length: 24 }, (_, h) => `<span>${h % 3 === 0 ? pad2(h) : ""}</span>`).join("");

  setupPunchTip();
}

let punchTipReady = false;
function setupPunchTip() {
  if (punchTipReady) return;
  punchTipReady = true;
  const tip = $("#punchTip");
  const grid = $("#punch");
  grid.addEventListener("mouseover", (e) => {
    const cell = e.target.closest(".punch-cell");
    if (!cell) return;
    tip.innerHTML = cell.dataset.tip;
    const r = cell.getBoundingClientRect();
    tip.style.left = r.left + r.width / 2 + "px";
    tip.style.top = r.top + "px";
    tip.classList.remove("hidden");
  });
  grid.addEventListener("mouseout", (e) => {
    if (e.target.closest(".punch-cell")) tip.classList.add("hidden");
  });
}

function pad2(n) {
  return n < 10 ? "0" + n : "" + n;
}

const WD = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const MON = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

let heatData = [];
let currentHeatMetric = "requests";
const HEAT_METRICS = {
  requests: { get: (x) => x.requests || 0, tip: (x) => `<b>${fmtNum(x.requests)}</b> req`, total: (v) => `· ${fmtNum(v)} req` },
  hours: { get: (x) => x.hours || 0, tip: (x) => `<b>${(x.hours || 0).toFixed(1)}</b> h aktiv`, total: (v) => `· ${fmtNum(Math.round(v))} h` },
  cost: { get: (x) => x.cost || 0, tip: (x) => `<b>${fmtUsd(x.cost)}</b> real`, total: (v) => `· ${fmtUsd(v)}` },
};

// Requests- und Stunden-Daten pro Tag zusammenführen.
function setCalendarData(heatmap, workHeatmap) {
  const m = new Map();
  for (const h of heatmap || []) m.set(h.date, { date: h.date, requests: h.requests || 0, cost: h.costReal || 0, hours: 0 });
  for (const w of workHeatmap || []) {
    const e = m.get(w.date) || { date: w.date, requests: w.requests || 0, cost: 0, hours: 0 };
    e.hours = w.hours || 0;
    m.set(w.date, e);
  }
  heatData = [...m.values()].sort((a, b) => a.date.localeCompare(b.date));
  renderCalendar();
}

function renderCalendar() {
  const cfg = HEAT_METRICS[currentHeatMetric];
  const map = new Map(heatData.map((h) => [h.date, h]));
  const total = heatData.reduce((s, x) => s + cfg.get(x), 0);
  const max = Math.max(...heatData.map(cfg.get), 0.0001);
  $("#heatTotal").textContent = total ? cfg.total(total) : "";
  const todayStr = new Date().toISOString().slice(0, 10);

  const end = new Date(todayStr + "T00:00:00Z");
  let start = new Date(end.getTime() - 364 * 86400000);
  start = new Date(start.getTime() - ((start.getUTCDay() + 6) % 7) * 86400000);

  const weeks = [];
  let week = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    week.push(new Date(t));
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length) weeks.push(week);

  const cells = [];
  for (const w of weeks) {
    for (const dt of w) {
      const ds = dt.toISOString().slice(0, 10);
      const h = map.get(ds);
      const v = h ? cfg.get(h) : 0;
      const lvl = v > 0 ? Math.min(4, Math.ceil((v / max) * 4)) : 0;
      const tip = h && v > 0 ? cfg.tip(h) : "keine Aktivität";
      cells.push(`<div class="heat-cell l${lvl}${ds === todayStr ? " today" : ""}" data-d="${ds}" data-tip="${escapeHtml(tip)}"></div>`);
    }
  }
  $("#heatmap").innerHTML = cells.join("");
  $("#heatWd").innerHTML = WD.map((w) => `<span>${w}</span>`).join("");

  let lastMon = -1;
  $("#heatMonths").innerHTML = weeks
    .map((w) => {
      const m = w[0].getUTCMonth();
      if (m !== lastMon) {
        lastMon = m;
        return `<span>${MON[m]}</span>`;
      }
      return `<span></span>`;
    })
    .join("");

  setupHeatTip();
}

let heatTipReady = false;
function setupHeatTip() {
  if (heatTipReady) return;
  heatTipReady = true;
  const tip = $("#heatTip");
  const grid = $("#heatmap");
  const show = (cell) => {
    const ds = cell.dataset.d;
    const date = new Date(ds + "T00:00:00Z").toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
    tip.innerHTML = `${cell.dataset.tip}<br>${date}`;
    const rect = cell.getBoundingClientRect();
    tip.style.left = rect.left + rect.width / 2 + "px";
    tip.style.top = rect.top + "px";
    tip.classList.remove("hidden");
  };
  grid.addEventListener("mouseover", (e) => {
    const cell = e.target.closest(".heat-cell");
    if (cell) show(cell);
  });
  grid.addEventListener("mouseout", (e) => {
    if (e.target.closest(".heat-cell")) tip.classList.add("hidden");
  });
}

const LANG_COLORS = {
  TypeScript: "#3178c6", JavaScript: "#e0b341", Python: "#4b8bbe", HTML: "#c0623e",
  CSS: "#9c6ade", "C#": "#68217a", Go: "#00add8", Rust: "#c4633e", Java: "#b07219",
  Markdown: "#8a8578", JSON: "#a0a0a0", Shell: "#5a8a4a", PowerShell: "#2a5d9c",
  Vue: "#41b883", PHP: "#787cb5", Ruby: "#b23a2e", "C++": "#5a7fc4", C: "#6a8a9a",
};
const LANG_FALLBACK = ["#17150f", "#b23a2e", "#3f6f47", "#c4922a", "#6a6354", "#8a5a8a", "#5a7fc4"];
function langColor(lang, i) {
  return LANG_COLORS[lang] || LANG_FALLBACK[i % LANG_FALLBACK.length];
}

// --- Projekt-Dropdown (durchsuchbar) -------------------------------------
function populateProjects(filter = "") {
  const f = filter.trim().toLowerCase();
  const opts = [{ name: "__all__", label: "Alle Projekte", lines: allProjects.reduce((s, p) => s + p.lines, 0) }];
  for (const p of allProjects) {
    if (!f || p.name.toLowerCase().includes(f)) opts.push({ name: p.name, label: p.name, lines: p.lines });
  }
  $("#psOptions").innerHTML = opts
    .map(
      (o) => `<div class="ps-opt ${o.name === currentProject ? "active" : ""}" data-p="${escapeHtml(o.name)}">
        <span class="o-name">${escapeHtml(o.label)}</span>
        <span class="o-lines">${fmtNum(o.lines)} Z</span>
      </div>`
    )
    .join("");
  $("#psOptions")
    .querySelectorAll(".ps-opt")
    .forEach((el) => el.addEventListener("click", () => selectProject(el.dataset.p)));
}

function selectProject(name) {
  currentProject = name;
  $("#psBtn").innerHTML =
    (name === "__all__" ? "Alle Projekte" : escapeHtml(name)) + ` <span class="ps-caret">▾</span>`;
  closeProjMenu();
  if (name === "__all__") {
    // aus dem nächsten /api/local kommt die Gesamtansicht; sofort separat laden
    loadLanguages();
  } else {
    loadLanguages();
  }
}

async function loadLanguages() {
  try {
    const res = await fetch(`/api/languages?days=${currentDays}&project=${encodeURIComponent(currentProject)}`);
    const d = await res.json();
    renderLanguages(d.byLanguage);
  } catch (e) {
    /* ignore */
  }
}

function openProjMenu() {
  $("#psMenu").classList.remove("hidden");
  populateProjects("");
  const s = $("#psSearch");
  s.value = "";
  setTimeout(() => s.focus(), 10);
}
function closeProjMenu() {
  $("#psMenu").classList.add("hidden");
}

function renderLanguages(langs) {
  langs = (langs || []).filter((l) => l.lines > 0);
  const total = langs.reduce((s, l) => s + l.lines, 0);
  $("#langTotal").textContent = total ? `· ${fmtNum(total)} Zeilen über ${langs.length} Sprachen` : "";
  if (!total) {
    $("#langStack").innerHTML = "";
    $("#langList").innerHTML = "";
    return;
  }

  // Gestapelter Balken (Top 12, Rest = Andere)
  const top = langs.slice(0, 12);
  const restLines = langs.slice(12).reduce((s, l) => s + l.lines, 0);
  $("#langStack").innerHTML =
    top
      .map(
        (l, i) =>
          `<div class="lang-seg" style="width:${(l.lines / total) * 100}%;background:${langColor(l.lang, i)}" title="${escapeHtml(
            l.lang
          )}: ${fmtNum(l.lines)} Z"></div>`
      )
      .join("") +
    (restLines ? `<div class="lang-seg" style="width:${(restLines / total) * 100}%;background:#cfc9ba"></div>` : "");

  // Liste
  $("#langList").innerHTML = top
    .map((l, i) => {
      const pct = ((l.lines / total) * 100).toFixed(1);
      return `<div class="lang-row">
        <span class="l-sw" style="background:${langColor(l.lang, i)}"></span>
        <span class="l-name">${escapeHtml(l.lang)}</span>
        <span class="l-bar"></span>
        <span class="l-lines">${fmtNum(l.lines)} Z</span>
        <span class="l-meta">${pct}% · ${fmtNum(l.files)} Dat</span>
      </div>`;
    })
    .join("");
}

function renderSplit(s) {
  const cacheShare = s.cacheShare == null ? 0 : s.cacheShare;
  const cachePct = Math.round(cacheShare * 100);
  const realPct = 100 - cachePct;
  $("#splitBar").innerHTML =
    `<div class="seg-cache" style="width:${cachePct}%"></div>` +
    `<div class="seg-real" style="width:${realPct}%"></div>`;
  $("#splitLegend").innerHTML = `
    <div class="leg"><span class="swatch cache"></span> <b>${cachePct}%</b> <span>gecachter Kontext</span></div>
    <div class="leg"><span class="swatch real"></span> <b>${realPct}%</b> <span>echte Arbeit (${fmtUsd(s.realCost)})</span></div>`;
}

function renderModels(byModel) {
  byModel = byModel || [];
  const tReq = byModel.reduce((s, m) => s + m.requests, 0);
  const tTok = byModel.reduce((s, m) => s + m.tokens, 0);
  const tReal = byModel.reduce((s, m) => s + m.costReal, 0);
  const tApi = byModel.reduce((s, m) => s + m.cost, 0);

  $("#modelBody").innerHTML = byModel
    .map(
      (m, i) => `
      <tr>
        <td><span class="model-name"><span class="tick" style="background:${i === 0 ? "var(--ink)" : i === 1 ? "var(--red)" : "transparent"}"></span>${escapeHtml(
        modelLabel(m.model)
      )}</span></td>
        <td class="r">${fmtNum(m.requests)}</td>
        <td class="r">${fmtTokens(m.tokens)}</td>
        <td class="r td-red">${fmtUsd(m.costReal)}</td>
        <td class="r">${fmtUsd(m.cost)}</td>
      </tr>`
    )
    .join("");

  $("#modelFoot").innerHTML = `
    <tr>
      <td class="lbl">Summe</td>
      <td class="r">${fmtNum(tReq)}</td>
      <td class="r">${fmtTokens(tTok)}</td>
      <td class="r td-red">${fmtUsd(tReal)}</td>
      <td class="r">${fmtUsd(tApi)}</td>
    </tr>`;
}

function renderProjects(byProject, totalReq) {
  byProject = byProject || [];
  const tot = totalReq || byProject.reduce((s, p) => s + p.requests, 0) || 1;
  const top = byProject.slice(0, 10);
  const rest = byProject.slice(10);

  let rows = top
    .map((p) => {
      const pct = Math.round((p.requests / tot) * 100);
      return `
      <tr>
        <td><span class="proj-name" title="${escapeHtml(p.path)}">${escapeHtml(p.name)}</span></td>
        <td class="r">${fmtNum(p.requests)}</td>
        <td class="r">${fmtTokens(p.tokens)}</td>
        <td class="r td-red">${fmtUsd(p.costReal)}</td>
        <td class="r"><span class="share"><span class="share-bar"><span style="width:${pct}%"></span></span>${pct}%</span></td>
      </tr>`;
    })
    .join("");

  if (rest.length) {
    const rReq = rest.reduce((s, p) => s + p.requests, 0);
    const rTok = rest.reduce((s, p) => s + p.tokens, 0);
    const rReal = rest.reduce((s, p) => s + p.costReal, 0);
    const pct = Math.round((rReq / tot) * 100);
    rows += `
      <tr>
        <td><span class="proj-name muted-name">+ ${rest.length} weitere</span></td>
        <td class="r">${fmtNum(rReq)}</td>
        <td class="r">${fmtTokens(rTok)}</td>
        <td class="r td-red">${fmtUsd(rReal)}</td>
        <td class="r"><span class="share"><span class="share-bar"><span style="width:${pct}%"></span></span>${pct}%</span></td>
      </tr>`;
  }
  $("#projectBody").innerHTML = rows;
}

function drawChart(daily) {
  daily = daily || [];
  const labels = daily.map((d) => (currentDays > 31 ? d.date.slice(5).replace("-", ".") : d.date.slice(8, 10)));
  const values = daily.map((d) => (d.costReal != null ? d.costReal : d.cost));
  upsertBar("daily", "#chart", labels, values, { money: true, maxTicks: 14, bp: 0.78, cp: 0.88, color: "#b23a2e" }); // Usage/Kosten · rot
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --- Live-Panel -----------------------------------------------------------
let lastEventTs = null;
let prevToday = {};
const consoleSeen = new Set();
let consoleInit = false;

// Sanftes Hochzählen (Count-up), läuft mit ~60fps zwischen den Polls.
const anim = {}; // id -> { cur, target, fmt }
function setTarget(id, target, fmt) {
  if (!anim[id]) anim[id] = { cur: 0, target, fmt }; // Intro: von 0 hochzählen
  else {
    anim[id].target = target;
    anim[id].fmt = fmt;
  }
}
function tickAnim() {
  for (const id in anim) {
    const a = anim[id];
    if (a.cur !== a.target) {
      const diff = a.target - a.cur;
      a.cur += diff * 0.2;
      if (Math.abs(a.target - a.cur) < Math.max(0.5, Math.abs(a.target) * 0.0005)) a.cur = a.target;
      const el = document.getElementById(id);
      if (el) el.textContent = a.fmt(a.cur);
    }
  }
  requestAnimationFrame(tickAnim);
}
requestAnimationFrame(tickAnim);

async function pollLive() {
  try {
    const res = await fetch("/api/live");
    const d = await res.json();
    renderLive(d);
  } catch (e) {
    /* still */
  }
}

function renderLive(d) {
  lastEventTs = d.lastEventTs;
  updateAgo();
  const t = d.today;

  // Hero: Heute-Zahlen zählen flüssig hoch
  setTarget("heroReq", t.requests, (v) => fmtNum(Math.round(v)));
  setTarget("heroReal", t.realCost, (v) => fmtUsd(v));
  setTarget("heroTok", t.tokens, (v) => fmtTokens(Math.round(v)));
  if (prevToday.requests !== undefined && prevToday.requests !== t.requests) flashEl("#heroReq");
  const pct = Math.min(100, Math.round((t.requests / Math.max(1, d.busiestRequests)) * 100));
  $("#heroFill").style.width = pct + "%";
  const record = t.requests >= d.busiestRequests && t.requests > 0;
  $("#heroScale").textContent = record
    ? `🔥 REKORDTAG! ${fmtNum(t.requests)} req`
    : `${pct}% vom stärksten Tag (${fmtNum(d.busiestRequests)} req)`;

  // Rate
  $("#liveRate").textContent = `${d.rate.perMin1}/min · ${d.rate.perMin5} in 5 min · ${d.rate.perMin60} in 60 min`;

  renderTiles(d);
  appendConsole(d.recent || []);
  prevToday = t;
}

function renderTiles(d) {
  const s = d.session || {};
  const yReq = d.yesterday.requests || 0;
  const diff = yReq ? Math.round(((d.today.requests - yReq) / yReq) * 100) : 0;
  const tiles = [
    { l: "Burn-Rate", v: fmtUsd(d.burn.perHour) + "/h", sub: "real · API " + fmtUsd(d.burn.apiPerHour) + "/h" },
    { l: "Tokens / min", v: fmtNum(d.burn.tokensPerMin), sub: "letzte 5 min" },
    { l: "Aktive Session", v: fmtNum(s.requests || 0) + " req", sub: `${s.durationMin || 0} min · ${escapeHtml(s.project || "—")}` },
    { l: "Streak", v: (d.streak || 0) + " Tage", sub: "in Folge aktiv" },
    { l: "$ / Request", v: fmtUsd(d.today.costPerReq), sub: `Cache ${d.today.cachePct}%` },
    {
      l: "Heute vs gestern",
      v: `<span class="${diff >= 0 ? "t-up" : "t-down"}">${diff >= 0 ? "+" : ""}${diff}%</span>`,
      sub: `${fmtNum(yReq)} gestern`,
    },
  ];
  $("#liveTiles").innerHTML = tiles
    .map(
      (t) => `<div class="tile">
        <div class="t-label">${t.l}</div>
        <div class="t-value">${t.v}</div>
        ${t.sub ? `<div class="t-sub">${t.sub}</div>` : ""}
      </div>`
    )
    .join("");
}

function consoleLine(e) {
  const cls = e.model.includes("opus")
    ? "c-opus"
    : e.model.includes("sonnet")
    ? "c-sonnet"
    : e.model.includes("haiku")
    ? "c-haiku"
    : "";
  const time = e.ts.slice(11, 19);
  const model = padStr(modelLabel(e.model), 11);
  const proj = padStr(e.project || "—", 16);
  const tok = padStr("+" + fmtNum(e.output) + " tok", 12);
  return (
    `<span class="c-time">${time}</span> ` +
    `<span class="${cls}">${escapeHtml(model)}</span> ` +
    `<span class="c-proj">${escapeHtml(proj)}</span> ` +
    `<span class="c-tok">${escapeHtml(tok)}</span> ` +
    `<span class="c-cost">${fmtUsd(e.costReal)}</span>`
  );
}

function appendConsole(recent) {
  const el = $("#console");
  if (!el) return;
  let cursor = el.querySelector(".c-cursor");
  if (!cursor) {
    cursor = document.createElement("div");
    cursor.className = "cline c-cursor";
    cursor.textContent = "▌";
    el.appendChild(cursor);
  }
  const asc = [...recent].reverse(); // chronologisch
  let appended = false;
  for (const e of asc) {
    if (consoleSeen.has(e.id)) continue;
    consoleSeen.add(e.id);
    const line = document.createElement("div");
    line.className = "cline" + (consoleInit ? " new" : "");
    line.innerHTML = consoleLine(e);
    el.insertBefore(line, cursor);
    appended = true;
  }
  // auf max ~300 Zeilen begrenzen
  let lines = el.querySelectorAll(".cline:not(.c-cursor)");
  while (lines.length > 300) {
    lines[0].remove();
    lines = el.querySelectorAll(".cline:not(.c-cursor)");
  }
  if (appended) el.scrollTop = el.scrollHeight;
  consoleInit = true;
}

function padStr(s, n) {
  s = String(s);
  if (s.length > n) return s.slice(0, n - 1) + "…";
  return s + " ".repeat(n - s.length);
}

function flashEl(sel) {
  const el = $(sel);
  if (!el) return;
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 350);
}

function updateAgo() {
  if (!lastEventTs) {
    $("#liveAgo").textContent = "—";
    return;
  }
  const sec = Math.max(0, Math.round((Date.now() - new Date(lastEventTs).getTime()) / 1000));
  let txt;
  if (sec < 5) txt = "gerade eben";
  else if (sec < 60) txt = `vor ${sec}s`;
  else if (sec < 3600) txt = `vor ${Math.floor(sec / 60)} min`;
  else txt = `vor ${Math.floor(sec / 3600)} h`;
  $("#liveAgo").textContent = `letztes Event ${txt}`;
}

// Zeitraum-Umschalter
$("#rangeToggle").querySelectorAll("button").forEach((b) =>
  b.addEventListener("click", () => {
    currentDays = parseInt(b.dataset.days, 10);
    $("#rangeToggle").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    load(false);
  })
);

// Muster-Charts & Punchcard: Metrik umschalten (Requests / Zeilen / Kosten)
document.querySelectorAll(".metric-toggle").forEach((tog) => {
  const chart = tog.dataset.chart;
  tog.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      patternMetric[chart] = b.dataset.m;
      tog.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      if (chart === "hour") drawHourChart();
      else if (chart === "week") drawWeekChart();
      else renderPunch();
    })
  );
});

// Kalender-Metrik umschalten (Requests / Stunden / Kosten) — ohne Neuladen
$("#heatToggle")
  .querySelectorAll("button")
  .forEach((b) =>
    b.addEventListener("click", () => {
      currentHeatMetric = b.dataset.m;
      $("#heatToggle")
        .querySelectorAll("button")
        .forEach((x) => x.classList.toggle("active", x === b));
      renderCalendar();
    })
  );

// Projekt-Dropdown
$("#psBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  if ($("#psMenu").classList.contains("hidden")) openProjMenu();
  else closeProjMenu();
});
$("#psSearch").addEventListener("input", (e) => populateProjects(e.target.value));
$("#psSearch").addEventListener("click", (e) => e.stopPropagation());
$("#psMenu").addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", closeProjMenu);

$("#refreshBtn").addEventListener("click", () => {
  load(true);
  pollLive();
});

// Initiales Laden
load();
pollLive();

// Live: Daten alle 0,5 s aus der DB; Zahlen zählen dazwischen flüssig hoch.
// „vor Xs" alle 100 ms. Dashboard-Aggregate alle 20 s (in place, kein Flackern).
setInterval(pollLive, 500);
setInterval(updateAgo, 100);
setInterval(() => load(false), 20_000);
