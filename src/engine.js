// Analyse-Engine: berechnet aus den normalisierten Nutzungsdaten
// Durchschnittsverbrauch, Monatsprognose, Limit-Status und Switch-Empfehlung.

function daysInMonth(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

function round(n, p = 2) {
  const f = 10 ** p;
  return Math.round((n + Number.EPSILON) * f) / f;
}

// Liefert die Analyse für einen einzelnen Account.
export function analyzeAccount(account, usage) {
  const now = new Date();
  const dayOfMonth = now.getUTCDate();
  const totalDays = daysInMonth(now);
  const remainingDays = totalDays - dayOfMonth;

  const daily = usage.daily ?? [];
  // Monat-bisher: nur Tage des laufenden Kalendermonats zählen (konsistent zu Kosten).
  const monthStartIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
  const monthDays = daily.filter((d) => d.date >= monthStartIso);
  const monthRequests = monthDays.reduce((s, d) => s + (d.requests || 0), 0);
  const monthTokens = monthDays.reduce((s, d) => s + (d.inputTokens || 0) + (d.outputTokens || 0), 0);
  const monthOutputTokens = monthDays.reduce((s, d) => s + (d.outputTokens || 0), 0);
  // "Realer" Wert = nur frischer Input + Output, ohne gecachte Kontext-Tokens.
  const monthRealCost = round(
    monthDays.reduce((s, d) => s + (d.costReal != null ? d.costReal : 0), 0),
    2
  );

  // Durchschnitt nur über Tage mit echtem Verbrauch der letzten 7 Tage,
  // damit ein träger Tag den Schnitt nicht künstlich drückt.
  const last7 = daily.slice(-7);
  const activeDays = last7.filter((d) => d.cost > 0);
  const avgDailyCost = activeDays.length
    ? activeDays.reduce((s, d) => s + d.cost, 0) / activeDays.length
    : last7.length
    ? last7.reduce((s, d) => s + d.cost, 0) / last7.length
    : 0;

  const monthToDate = usage.monthToDateCost ?? 0;
  const projectedMonth = monthToDate + avgDailyCost * remainingDays;

  const budget = account.monthlyBudget && account.monthlyBudget > 0 ? account.monthlyBudget : null;

  let utilization = null;
  let projectedUtilization = null;
  let budgetExhaustedOn = null; // Datum, an dem das Budget voraussichtlich aufgebraucht ist
  let daysUntilExhausted = null;

  if (budget) {
    utilization = monthToDate / budget;
    projectedUtilization = projectedMonth / budget;
    if (avgDailyCost > 0) {
      const remainingBudget = budget - monthToDate;
      if (remainingBudget <= 0) {
        daysUntilExhausted = 0;
      } else {
        daysUntilExhausted = remainingBudget / avgDailyCost;
      }
      const exhaustDate = new Date(now.getTime() + daysUntilExhausted * 86400000);
      budgetExhaustedOn = exhaustDate.toISOString().slice(0, 10);
    }
  }

  // Status-Ampel
  let status = "ok";
  let headline = "Alles im grünen Bereich";
  if (usage.error) {
    status = "error";
    headline = "Konnte Daten nicht laden";
  } else if (budget) {
    if (utilization >= 1) {
      status = "over";
      headline = "Budget überschritten";
    } else if (utilization >= 0.9 || (daysUntilExhausted !== null && daysUntilExhausted <= remainingDays * 0.5)) {
      status = "critical";
      headline = "Budget fast erreicht";
    } else if (projectedUtilization >= 1) {
      status = "warning";
      headline = "Prognose über Budget";
    } else if (utilization >= 0.75) {
      status = "warning";
      headline = "Über 75% verbraucht";
    }
  }

  const headroom = budget ? Math.max(0, budget - monthToDate) : null;

  return {
    avgDailyCost: round(avgDailyCost, 4),
    monthToDate: round(monthToDate, 2),
    todayCost: round(usage.todayCost ?? 0, 2),
    projectedMonth: round(projectedMonth, 2),
    budget,
    headroom: headroom === null ? null : round(headroom, 2),
    utilization: utilization === null ? null : round(utilization, 4),
    projectedUtilization: projectedUtilization === null ? null : round(projectedUtilization, 4),
    daysUntilExhausted: daysUntilExhausted === null ? null : round(daysUntilExhausted, 1),
    budgetExhaustedOn,
    remainingDays,
    totalDays,
    status,
    headline,
    activeDays: activeDays.length,
    monthRequests,
    monthTokens,
    monthOutputTokens,
    monthRealCost,
    cacheShare:
      monthToDate > 0 ? round((monthToDate - monthRealCost) / monthToDate, 3) : null,
  };
}

// Empfehlung über alle Accounts: welcher Account hat am meisten Luft?
// "Avoid limits" — wir empfehlen, Last auf den Account mit dem meisten
// freien Headroom (bzw. der niedrigsten Auslastung) zu verlagern.
export function buildRecommendations(accounts) {
  // accounts: [{ id, label, provider, analysis, usage }]
  const usable = accounts.filter((a) => a.analysis.status !== "error");

  const byProvider = {};
  for (const a of accounts) {
    (byProvider[a.provider] ??= []).push(a);
  }

  const recommendations = [];

  for (const [provider, list] of Object.entries(byProvider)) {
    const ok = list.filter((a) => a.analysis.status !== "error");
    if (ok.length === 0) continue;
    // Switch-Empfehlung ergibt nur Sinn, wenn es eine Alternative gibt.
    if (ok.length < 2) continue;

    // Scoring: bevorzugt freien Headroom; ohne Budget niedrige Tagesausgaben.
    const scored = ok
      .map((a) => {
        const an = a.analysis;
        let score;
        if (an.budget) {
          score = an.headroom; // mehr freies Budget = besser
        } else {
          // ohne Budget: invertierter Monatsverbrauch (weniger genutzt = besser)
          score = -an.monthToDate;
        }
        return { account: a, score, util: an.utilization };
      })
      .sort((x, y) => y.score - x.score);

    const best = scored[0];
    const critical = ok.filter((a) => ["critical", "over"].includes(a.analysis.status));

    let message;
    if (critical.length && best.account.analysis.status === "ok") {
      const names = critical.map((c) => c.account.label).join(", ");
      message = `${names} ist am Limit — wechsle zu „${best.account.label}".`;
    } else if (best.account.analysis.budget) {
      message = `„${best.account.label}" hat am meisten Luft (${formatUsd(best.account.analysis.headroom)} frei).`;
    } else {
      message = `„${best.account.label}" ist diesen Monat am wenigsten genutzt — am besten dort weiterarbeiten.`;
    }

    recommendations.push({
      provider,
      recommendedAccountId: best.account.id,
      recommendedAccountLabel: best.account.label,
      message,
      ranking: scored.map((s) => ({
        id: s.account.id,
        label: s.account.label,
        status: s.account.analysis.status,
        headroom: s.account.analysis.headroom,
        utilization: s.account.analysis.utilization,
      })),
    });
  }

  // Gesamt-Kennzahlen (Monat-bisher, konsistent zu den Kosten)
  const totalRequests = usable.reduce((s, a) => s + (a.analysis.monthRequests || 0), 0);
  const activeDaysMax = Math.max(1, ...usable.map((a) => a.analysis.activeDays || 0), 1);
  const totals = {
    monthToDate: round(
      usable.reduce((s, a) => s + a.analysis.monthToDate, 0),
      2
    ),
    projectedMonth: round(
      usable.reduce((s, a) => s + a.analysis.projectedMonth, 0),
      2
    ),
    today: round(
      usable.reduce((s, a) => s + a.analysis.todayCost, 0),
      2
    ),
    avgDaily: round(
      usable.reduce((s, a) => s + a.analysis.avgDailyCost, 0),
      2
    ),
    tokens: usable.reduce((s, a) => s + (a.analysis.monthTokens || 0), 0),
    realCost: round(usable.reduce((s, a) => s + (a.analysis.monthRealCost || 0), 0), 2),
    requests: totalRequests,
    avgRequestsPerDay: Math.round(totalRequests / activeDaysMax),
    estimated: usable.some((a) => a.usage?.estimated),
    accounts: accounts.length,
    alerts: accounts.filter((a) => ["warning", "critical", "over"].includes(a.analysis.status)).length,
  };

  return { recommendations, totals };
}

function formatUsd(n) {
  if (n === null || n === undefined) return "—";
  return "$" + Number(n).toFixed(2);
}
