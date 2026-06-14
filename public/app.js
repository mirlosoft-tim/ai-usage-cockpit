// Schlankes Frontend: zeigt ausschließlich den lokalen Claude-Code-Verbrauch.
// Zeitraum umschaltbar (7 / 30 / 90 Tage / Gesamt). Keine Keys, kein Account-Mgmt.

const $ = (s) => document.querySelector(s);
let currentDays = 3650; // Start: Gesamt
let currentProject = "__all__"; // Sprachen-Filter
let allProjects = []; // {name, lines} für das Dropdown
let lastData = null; // letzte Dashboard-Daten (für Sprachwechsel-Rerender)

const loc = () => (LANG === "en" ? "en-US" : "de-DE");
const fmtUsd = (n) =>
  n == null ? "—" : "$" + Number(n).toLocaleString(loc(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = (n) => Number(n || 0).toLocaleString(loc());
const fmtTokens = (n) => {
  n = Number(n || 0);
  const u = LANG === "en" ? ["B", "M", "k"] : ["Mrd", "Mio", "k"];
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " " + u[0];
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " " + u[1];
  if (n >= 1e3) return (n / 1e3).toFixed(0) + u[2];
  return String(n);
};

function rangeName(days) {
  return days >= 365 ? t("range_all_name") : t("range_last", { n: days });
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString(loc(), { day: "2-digit", month: "short", year: "2-digit" });
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
  lastData = d;
  $("#period").textContent = rangeName(currentDays);

  if (!d.found) {
    $("#content").classList.add("hidden");
    $("#empty").classList.remove("hidden");
    const path = d.path || "~/.claude";
    $("#emptyPath").textContent = path;
    $("#emptyP").innerHTML = t("empty_p", { path: `<code>${escapeHtml(path)}</code>` });
    return;
  }

  $("#empty").classList.add("hidden");
  $("#content").classList.remove("hidden");

  const s = d.summary;
  $("#rangeSpan").textContent = t("range_span", {
    n: s.daysCovered,
    from: fmtDate(s.firstDate),
    to: fmtDate(s.lastDate),
  });

  renderFigures(s);
  renderStats2(s);
  patternsData = d.patterns || { hour: [], weekday: [], punch: [] };
  drawHourChart();
  drawWeekChart();
  renderPunch();
  renderWork(d.work);
  renderFocus(d.focus);
  renderRecords(d.records);
  renderSplit(s);
  setCalendarData(d.heatmap, d.workHeatmap);
  allProjects = d.codeProjects || [];
  populateProjects();
  if (currentProject === "__all__") renderLanguages(d.byLanguage);
  else loadLanguages();
  drawModelTrend(d.modelTrend);
  renderModels(d.byModel);
  renderTopFiles(d.topFiles);
  renderRateHeatmap(d.rateHeatmap);
  renderProjects(d.byProject, s.requests);
  drawChart(d.daily);

}

function renderFigures(s) {
  const figs = [
    { label: t("fig_requests"), value: fmtNum(s.requests), sub: `⌀ ${fmtNum(s.avgRequestsPerDay)}/${LANG === "en" ? "day" : "Tag"}` },
    { label: t("fig_tokens"), value: fmtTokens(s.tokens), sub: `${fmtTokens(s.outputTokens)} Output` },
    { label: t("fig_real"), value: fmtUsd(s.realCost), sub: t("fig_real_sub"), accent: true, info: t("info_real") },
    { label: t("fig_api"), value: fmtUsd(s.apiCost), sub: t("fig_api_sub"), info: t("info_api") },
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
    { label: t("s_activedays"), value: fmtNum(s.activeDays) },
    { label: t("s_sessions"), value: fmtNum(s.sessions), sub: t("s_sessions_sub", { n: fmtNum(s.avgReqPerSession) }) },
    { label: t("s_output"), value: fmtNum(s.avgOutputPerReq) },
    { label: t("s_limit"), value: fmtNum(s.rateLimits), warn: s.rateLimits > 0 },
    { label: t("s_since"), value: fmtUsd(s.allTimeApi), sub: t("s_since_sub") },
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
  $("#workTotal").textContent = t("work_total", { h: fmtNum(w.totalHours), n: w.days });
  const stats = [
    { l: t("w_total"), v: fmtNum(w.totalHours) + " h" },
    { l: t("w_avg"), v: w.avgHours + " h" },
    { l: t("w_start"), v: w.avgStart },
    { l: t("w_end"), v: w.avgEnd },
    { l: t("w_lph"), v: fmtNum(Math.round(w.linesPerHour || 0)), sub: t("w_lph_sub") },
    { l: t("w_longest"), v: w.maxDay ? w.maxDay.hours + " h" : "—", sub: w.maxDay ? w.maxDay.date.slice(5) : "" },
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
    tip: (v) => t("h_active", { h: v.toFixed(1) }),
    yfmt: (v) => v + "h",
  });
}

function fmtMin(min) {
  min = Math.round(min || 0);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
}
function fmtDur(min) {
  const d = Math.floor((min || 0) / 1440);
  if (d >= 2) return `${d} d`;
  return `${Math.floor((min || 0) / 60)} h`;
}
function fmtMonthDay(iso) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00Z").toLocaleDateString(loc(), { day: "2-digit", month: "short" });
}

function renderFocus(f) {
  f = f || {};
  const stats = [
    { l: t("f_blocks"), v: fmtNum(f.focusBlocks) },
    { l: t("f_avg"), v: Math.round(f.avgFocusMin) + " min" },
    { l: t("f_longest"), v: fmtMin(f.longestFocusMin) },
    { l: t("f_pauses"), v: fmtNum(f.pauses) },
    { l: t("f_avgpause"), v: Math.round(f.avgPauseMin) + " min" },
  ];
  $("#focusStats").innerHTML = stats
    .map((s) => `<div class="stat2"><div class="s2-label">${s.l}</div><div class="s2-value">${s.v}</div></div>`)
    .join("");
}

function renderRecords(r) {
  r = r || {};
  const recs = [
    { l: t("r_busiest"), v: fmtNum(r.busiestDay?.requests) + " req", sub: fmtMonthDay(r.busiestDay?.date) },
    { l: t("r_lines"), v: t("r_lines_v", { n: fmtNum(r.maxLinesDay?.lines) }), sub: fmtMonthDay(r.maxLinesDay?.date) },
    { l: t("r_costday"), v: fmtUsd(r.maxCostDay?.cost), sub: fmtMonthDay(r.maxCostDay?.date) },
    { l: t("r_costreq"), v: fmtUsd(r.maxCostEvent?.cost), sub: `${modelLabel(r.maxCostEvent?.model || "—")} · ${fmtMonthDay(r.maxCostEvent?.date)}` },
    { l: t("r_session"), v: t("r_session_v", { n: fmtNum(r.topSession?.requests) }), sub: fmtDur(r.topSession?.durationMin) },
    { l: t("r_model"), v: r.topModel ? modelLabel(r.topModel.model) : "—", sub: r.topModel ? fmtNum(r.topModel.requests) + " req" : "" },
    { l: t("r_lang"), v: r.topLang ? escapeHtml(r.topLang.lang) : "—", sub: r.topLang ? `${fmtNum(r.topLang.lines)} ${t("unit_lines_short")}` : "" },
  ];
  $("#recordsGrid").innerHTML = recs
    .map((x) => `<div class="record"><div class="rc-label">${x.l}</div><div class="rc-value">${x.v}</div><div class="rc-sub">${x.sub || ""}</div></div>`)
    .join("");
}

// Umschaltbare Metriken für Muster-Charts & Punchcard
let patternsData = { hour: [], weekday: [], punch: [] };
const patternMetric = { hour: "requests", week: "requests", punch: "requests" };
const METRICS = {
  requests: { get: (x) => x.requests || 0, tip: (v) => t("u_req", { n: fmtNum(Math.round(v)) }), yfmt: (v) => fmtNum(v) },
  lines: { get: (x) => x.lines || 0, tip: (v) => t("u_lines", { n: fmtNum(Math.round(v)) }), yfmt: (v) => fmtNum(v) },
  cost: { get: (x) => x.cost || 0, tip: (v) => t("u_cost", { v: fmtUsd(v) }), yfmt: (v) => "$" + v },
};

// --- Modell-Trend (gestapelt) --------------------------------------------
const TREND_PALETTE = ["#17150f", "#b23a2e", "#c4922a", "#4a72a8", "#4f7a4a", "#8a5a8a", "#a0988a"];
function modelTrendColor(model, i) {
  if (model.includes("opus")) return "#17150f";
  if (model.includes("sonnet")) return "#b23a2e";
  if (model.includes("haiku")) return "#4f7a4a";
  if (model === "andere") return "#a0988a";
  return TREND_PALETTE[i % TREND_PALETTE.length];
}

function modelDisp(model) {
  return model === "andere" ? t("other") : modelLabel(model);
}

function drawModelTrend(trend) {
  trend = trend || { days: [], datasets: [] };
  const labels = trend.days.map((d) => (currentDays > 31 ? d.slice(5).replace("-", ".") : d.slice(8, 10)));
  const datasets = trend.datasets.map((ds, i) => ({
    label: modelDisp(ds.model),
    data: ds.data,
    backgroundColor: modelTrendColor(ds.model, i),
    borderWidth: 0,
    barPercentage: 0.92,
    categoryPercentage: 0.96,
  }));
  $("#trendInfo").textContent = trend.days.length ? t("trend_info", { m: trend.datasets.length, n: trend.days.length }) : "";
  $("#trendLegend").innerHTML = trend.datasets
    .map(
      (ds, i) =>
        `<span class="tl"><span class="tl-sw" style="background:${modelTrendColor(ds.model, i)}"></span>${escapeHtml(modelDisp(ds.model))}</span>`
    )
    .join("");
  upsertStacked("trend", "#trendChart", labels, datasets);
}

function upsertStacked(key, sel, labels, datasets) {
  const ex = chartReg[key];
  if (ex) {
    ex.data.labels = labels;
    ex.data.datasets = datasets;
    ex.update("none");
    return;
  }
  const ctx = $(sel).getContext("2d");
  chartReg[key] = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#17150f",
          padding: 7,
          titleFont: { family: "JetBrains Mono", size: 11 },
          bodyFont: { family: "JetBrains Mono", size: 11 },
          callbacks: { label: (i) => `${i.dataset.label}: ${fmtNum(i.raw)} req` },
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          border: { color: "#17150f", width: 1.5 },
          ticks: { font: { family: "JetBrains Mono", size: 9 }, color: "#8a8578", maxRotation: 0, autoSkip: true, maxTicksLimit: 14 },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: "#d8d3c5" },
          border: { display: false },
          ticks: { font: { family: "JetBrains Mono", size: 9 }, color: "#8a8578", maxTicksLimit: 4 },
        },
      },
    },
  });
}

// --- Top-Dateien ----------------------------------------------------------
function renderTopFiles(files) {
  files = files || [];
  $("#filesBody").innerHTML = files
    .map(
      (f) => `
      <tr>
        <td><span class="proj-name" title="${escapeHtml(f.path)}">${escapeHtml(f.name)}</span></td>
        <td>${escapeHtml(f.project || "—")}</td>
        <td class="r">${fmtNum(f.edits)}</td>
        <td class="r td-red">${fmtNum(f.lines)}</td>
      </tr>`
    )
    .join("");
}

// --- 429-Rate-Limit-Heatmap ----------------------------------------------
function renderRateHeatmap(grid) {
  grid = grid || [];
  const total = grid.reduce((s, c) => s + c.value, 0);
  $("#rateInfo").textContent = total ? t("rate_total", { n: fmtNum(total) }) : t("rate_none");
  const max = Math.max(...grid.map((c) => c.value), 0.0001);
  const order = [1, 2, 3, 4, 5, 6, 0];
  const map = {};
  for (const c of grid) map[c.dow * 24 + c.hour] = c.value;
  const cells = [];
  for (const dow of order) {
    for (let h = 0; h < 24; h++) {
      const v = map[dow * 24 + h] || 0;
      const lvl = v > 0 ? Math.min(4, Math.ceil((v / max) * 4)) : 0;
      const tip = t("tip_429", { w: WD_I18N[LANG][dow], h: pad2(h), n: v });
      cells.push(`<div class="punch-cell l${lvl}" data-tip="${escapeHtml(tip)}"></div>`);
    }
  }
  $("#rateGrid").innerHTML = cells.join("");
  $("#rateWd").innerHTML = order.map((i) => `<span>${WD_I18N[LANG][i]}</span>`).join("");
  $("#rateHours").innerHTML = Array.from({ length: 24 }, (_, h) => `<span>${h % 3 === 0 ? pad2(h) : ""}</span>`).join("");
  setupRateTip();
}
let rateTipReady = false;
function setupRateTip() {
  if (rateTipReady) return;
  rateTipReady = true;
  const tip = $("#rateTip");
  const grid = $("#rateGrid");
  grid.addEventListener("mouseover", (e) => {
    const c = e.target.closest(".punch-cell");
    if (!c) return;
    tip.innerHTML = c.dataset.tip;
    const r = c.getBoundingClientRect();
    tip.style.left = r.left + r.width / 2 + "px";
    tip.style.top = r.top + "px";
    tip.classList.remove("hidden");
  });
  grid.addEventListener("mouseout", (e) => {
    if (e.target.closest(".punch-cell")) tip.classList.add("hidden");
  });
}

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
  const labels = order.map((i) => WD_I18N[LANG][i]);
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
  $("#punchInfo").textContent = total ? t("punch_total", { v: m.tip(total) }) : "";

  const order = [1, 2, 3, 4, 5, 6, 0]; // Mo..So
  const cells = [];
  for (const dow of order) {
    for (let h = 0; h < 24; h++) {
      const c = data[dow * 24 + h] || { requests: 0, cost: 0, lines: 0 };
      const v = m.get(c);
      const lvl = v > 0 ? Math.min(4, Math.ceil((v / max) * 4)) : 0;
      const tip = `${WD_I18N[LANG][dow]} ${pad2(h)}:00 · ${v > 0 ? m.tip(v) : "—"}`;
      cells.push(`<div class="punch-cell l${lvl}" data-tip="${escapeHtml(tip)}"></div>`);
    }
  }
  $("#punch").innerHTML = cells.join("");

  // Wochentags-Labels (Mo..So) + Stundenlabels (alle 3 h)
  $("#punchWd").innerHTML = order.map((i) => `<span>${WD_I18N[LANG][i]}</span>`).join("");
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

const WD_MO = () => [1, 2, 3, 4, 5, 6, 0].map((i) => WD_I18N[LANG][i]); // Mo..So

let heatData = [];
let currentHeatMetric = "requests";
const HEAT_METRICS = {
  requests: { get: (x) => x.requests || 0, tip: (x) => t("tip_req", { n: `<b>${fmtNum(x.requests)}</b>` }), total: (v) => t("cal_req_total", { n: fmtNum(v) }) },
  hours: { get: (x) => x.hours || 0, tip: (x) => t("tip_hours", { h: `<b>${(x.hours || 0).toFixed(1)}</b>` }), total: (v) => t("cal_hours_total", { n: fmtNum(Math.round(v)) }) },
  cost: { get: (x) => x.cost || 0, tip: (x) => t("tip_cost", { v: `<b>${fmtUsd(x.cost)}</b>` }), total: (v) => t("cal_cost_total", { v: fmtUsd(v) }) },
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
      const tip = h && v > 0 ? cfg.tip(h) : t("no_activity");
      cells.push(`<div class="heat-cell l${lvl}${ds === todayStr ? " today" : ""}" data-d="${ds}" data-tip="${escapeHtml(tip)}"></div>`);
    }
  }
  $("#heatmap").innerHTML = cells.join("");
  $("#heatWd").innerHTML = WD_MO().map((w) => `<span>${w}</span>`).join("");

  let lastMon = -1;
  $("#heatMonths").innerHTML = weeks
    .map((w) => {
      const m = w[0].getUTCMonth();
      if (m !== lastMon) {
        lastMon = m;
        return `<span>${MON_I18N[LANG][m]}</span>`;
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
    const date = new Date(ds + "T00:00:00Z").toLocaleDateString(loc(), { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
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
  const opts = [{ name: "__all__", label: t("all_projects"), lines: allProjects.reduce((s, p) => s + p.lines, 0) }];
  for (const p of allProjects) {
    if (!f || p.name.toLowerCase().includes(f)) opts.push({ name: p.name, label: p.name, lines: p.lines });
  }
  $("#psOptions").innerHTML = opts
    .map(
      (o) => `<div class="ps-opt ${o.name === currentProject ? "active" : ""}" data-p="${escapeHtml(o.name)}">
        <span class="o-name">${escapeHtml(o.label)}</span>
        <span class="o-lines">${fmtNum(o.lines)} ${t("unit_lines_short")}</span>
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
    (name === "__all__" ? t("all_projects") : escapeHtml(name)) + ` <span class="ps-caret">▾</span>`;
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
  $("#langTotal").textContent = total ? t("langs_total", { n: fmtNum(total), c: langs.length }) : "";
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
        <span class="l-lines">${fmtNum(l.lines)} ${t("unit_lines_short")}</span>
        <span class="l-meta">${t("lang_meta", { pct, n: fmtNum(l.files) })}</span>
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
    <div class="leg"><span class="swatch cache"></span> <b>${cachePct}%</b> <span>${t("leg_cache")}</span></div>
    <div class="leg"><span class="swatch real"></span> <b>${realPct}%</b> <span>${t("leg_real", { v: fmtUsd(s.realCost) })}</span></div>`;
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
      <td class="lbl">${t("sum")}</td>
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
        <td><span class="proj-name muted-name">${t("more_n", { n: rest.length })}</span></td>
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
  const today = d.today;

  // Hero: Heute-Zahlen zählen flüssig hoch
  setTarget("heroReq", today.requests, (v) => fmtNum(Math.round(v)));
  setTarget("heroReal", today.realCost, (v) => fmtUsd(v));
  setTarget("heroTok", today.tokens, (v) => fmtTokens(Math.round(v)));
  if (prevToday.requests !== undefined && prevToday.requests !== today.requests) flashEl("#heroReq");
  const pct = Math.min(100, Math.round((today.requests / Math.max(1, d.busiestRequests)) * 100));
  $("#heroFill").style.width = pct + "%";
  const record = today.requests >= d.busiestRequests && today.requests > 0;
  $("#heroScale").textContent = record
    ? t("record", { n: fmtNum(today.requests) })
    : t("of_peak", { pct, n: fmtNum(d.busiestRequests) });

  // Rate
  $("#liveRate").textContent = t("rate", { a: d.rate.perMin1, b: d.rate.perMin5, c: d.rate.perMin60 });

  renderTiles(d);
  appendConsole(d.recent || []);
  prevToday = today;
}

function renderTiles(d) {
  const s = d.session || {};
  const yReq = d.yesterday.requests || 0;
  const diff = yReq ? Math.round(((d.today.requests - yReq) / yReq) * 100) : 0;
  const tiles = [
    { l: t("tile_burn"), v: fmtUsd(d.burn.perHour) + "/h", sub: t("tile_burn_sub", { v: fmtUsd(d.burn.apiPerHour) }) },
    { l: t("tile_tpm"), v: fmtNum(d.burn.tokensPerMin), sub: t("tile_tpm_sub") },
    { l: t("tile_session"), v: fmtNum(s.requests || 0) + " req", sub: t("tile_session_sub", { min: s.durationMin || 0, proj: escapeHtml(s.project || "—") }) },
    { l: t("tile_streak"), v: (d.streak || 0) + " " + t("days"), sub: t("tile_streak_sub") },
    { l: t("tile_perreq"), v: fmtUsd(d.today.costPerReq), sub: t("tile_perreq_sub", { pct: d.today.cachePct }) },
    {
      l: t("tile_vs"),
      v: `<span class="${diff >= 0 ? "t-up" : "t-down"}">${diff >= 0 ? "+" : ""}${diff}%</span>`,
      sub: t("tile_vs_sub", { n: fmtNum(yReq) }),
    },
  ];
  $("#liveTiles").innerHTML = tiles
    .map(
      (ti) => `<div class="tile">
        <div class="t-label">${ti.l}</div>
        <div class="t-value">${ti.v}</div>
        ${ti.sub ? `<div class="t-sub">${ti.sub}</div>` : ""}
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
  if (sec < 5) txt = t("just_now");
  else if (sec < 60) txt = t("ago_s", { n: sec });
  else if (sec < 3600) txt = t("ago_m", { n: Math.floor(sec / 60) });
  else txt = t("ago_h", { n: Math.floor(sec / 3600) });
  $("#liveAgo").textContent = t("last_event", { ago: txt });
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

// Sprach-Umschalter (DE/EN)
function markLang() {
  $("#langSwitch")
    .querySelectorAll("button")
    .forEach((b) => b.classList.toggle("active", b.dataset.l === LANG));
}
$("#langSwitch")
  .querySelectorAll("button")
  .forEach((b) =>
    b.addEventListener("click", () => {
      setLang(b.dataset.l); // aktualisiert statische [data-i18n]
      markLang();
      $("#period").textContent = rangeName(currentDays);
      if (lastData) render(lastData); // dynamische Teile neu rendern
    })
  );

// Initiales Laden
applyStaticI18n();
markLang();
load();
pollLive();

// Live: Daten alle 0,5 s aus der DB; Zahlen zählen dazwischen flüssig hoch.
// „vor Xs" alle 100 ms. Dashboard-Aggregate alle 20 s (in place, kein Flackern).
setInterval(pollLive, 500);
setInterval(updateAgo, 100);
setInterval(() => load(false), 20_000);
