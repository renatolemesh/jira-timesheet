/* Dashboard de apontamentos Jira — front-end sem dependências. */
"use strict";

const $ = (sel) => document.querySelector(sel);

const state = {
  meta: null,
  start: null,          // "YYYY-MM-DD"
  end: null,
  users: new Set(),     // accountIds selecionados (vazio = todos)
  projects: new Set(),  // keys selecionadas (vazio = todos)
  expected: 8,
  report: null,
  missing: null,
  tab: "dashboard",
  wlSearch: "",
  nwSearch: "",   // filtros da tabela "tasks sem apontamento"
  nwCat: "",
};

const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/* ---------- utils ---------- */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function pad(n) { return String(n).padStart(2, "0"); }
function isoOf(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function dateOf(iso) { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d, 12); }
function fmtDate(iso) { const d = dateOf(iso); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`; }
function fmtDateFull(iso) { const d = dateOf(iso); return `${WEEKDAYS[d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`; }

function fmtH(seconds) {
  const neg = seconds < 0 ? "-" : "";
  seconds = Math.abs(Math.round(seconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0 && m === 0) return "0h";
  if (m === 0) return `${neg}${h}h`;
  if (h === 0) return `${neg}${m}m`;
  return `${neg}${h}h${pad(m)}`;
}
function fmtDec(seconds) {
  return (seconds / 3600).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function seriesColors() {
  return ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"].map(cssVar);
}

/* cor por pessoa: slot atribuído na primeira vez que a pessoa aparece com horas
   e persistido no localStorage — estável entre filtros e sessões, nunca repinta.
   Esgotados os 8 slots, quem sobra fica cinza ("Outros"). */
let colorAssign = {};
try { colorAssign = JSON.parse(localStorage.getItem("jira-dash-colors") || "{}"); } catch { /* ignora */ }

function ensureColors(idsByHours) {
  const used = new Set(Object.values(colorAssign));
  let changed = false;
  for (const id of idsByHours) {
    if (colorAssign[id] !== undefined) continue;
    let slot = 0;
    while (used.has(slot)) slot++;
    if (slot >= 8) break;
    colorAssign[id] = slot;
    used.add(slot);
    changed = true;
  }
  if (changed) {
    try { localStorage.setItem("jira-dash-colors", JSON.stringify(colorAssign)); } catch { /* ignora */ }
    refreshUserDots();
  }
}

function colorFor(accountId) {
  const slot = colorAssign[accountId];
  return slot === undefined ? cssVar("--muted") : seriesColors()[slot];
}

function refreshUserDots() {
  document.querySelectorAll("#dd-users-panel .dd-item").forEach((item) => {
    const input = item.querySelector("input");
    const dot = item.querySelector(".dot");
    if (input && dot) dot.style.background = colorFor(input.value);
  });
}

/* ---------- tooltip ---------- */

const tooltip = $("#tooltip");
function showTooltip(html, ev) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  moveTooltip(ev);
}
function moveTooltip(ev) {
  const pad = 14;
  const r = tooltip.getBoundingClientRect();
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
  tooltip.style.left = x + "px";
  tooltip.style.top = y + "px";
}
function hideTooltip() { tooltip.hidden = true; }

/* ---------- API ---------- */

/* credenciais do Jira salvas neste navegador (tela de login) */
let creds = null;
try { creds = JSON.parse(localStorage.getItem("jira-dash-creds") || "null"); } catch { /* ignora */ }

function credHeaders() {
  if (!creds) return {};
  return {
    "X-Jira-Base-Url": creds.baseUrl,
    "X-Jira-Email": creds.email,
    "X-Jira-Token": creds.token,
  };
}

async function apiGet(path, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${path}?${qs}`, { headers: credHeaders() });
  if (!res.ok) {
    let detail = `${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch { /* html */ }
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function filterParams(refresh) {
  const p = { start: state.start, end: state.end };
  if (state.users.size) p.users = [...state.users].join(",");
  if (state.projects.size) p.projects = [...state.projects].join(",");
  if (refresh) p.refresh = "true";
  return p;
}

async function loadAll(refresh = false) {
  $("#loading").hidden = false;
  $("#error-banner").hidden = true;
  try {
    const [report, missing] = await Promise.all([
      apiGet("/api/report", filterParams(refresh)),
      apiGet("/api/missing", { ...filterParams(refresh), expected: state.expected }),
    ]);
    state.report = report;
    state.missing = missing;
    $("#last-update").textContent =
      "atualizado " + new Date(report.generatedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    renderAll();
  } catch (err) {
    if (err.status === 401) { showLogin("Sessão expirada — entre novamente."); return; }
    const banner = $("#error-banner");
    banner.textContent = "Erro ao consultar o Jira: " + err.message;
    banner.hidden = false;
  } finally {
    $("#loading").hidden = true;
  }
}

/* ---------- filtros ---------- */

function setPeriod(startIso, endIso) {
  state.start = startIso;
  state.end = endIso;
  $("#f-start").value = startIso;
  $("#f-end").value = endIso;
}

function applyPreset(name) {
  const today = new Date();
  const t = isoOf(today);
  if (name === "today") setPeriod(t, t);
  else if (name === "week") {
    const d = new Date(today);
    const diff = (d.getDay() + 6) % 7; // segunda-feira
    d.setDate(d.getDate() - diff);
    const end = new Date(d); end.setDate(d.getDate() + 6);
    setPeriod(isoOf(d), isoOf(end));
  } else if (name === "month") {
    setPeriod(isoOf(new Date(today.getFullYear(), today.getMonth(), 1)),
              isoOf(new Date(today.getFullYear(), today.getMonth() + 1, 0)));
  } else if (name === "last-month") {
    setPeriod(isoOf(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
              isoOf(new Date(today.getFullYear(), today.getMonth(), 0)));
  } else if (name === "30d") {
    const d = new Date(today); d.setDate(d.getDate() - 29);
    setPeriod(isoOf(d), t);
  }
}

function markPreset(name) {
  document.querySelectorAll("#presets .chip").forEach((c) =>
    c.classList.toggle("active", c.dataset.preset === name));
}

function buildDropdown(rootId, items, selected, labelAll, withDots) {
  const root = $(rootId);
  const panel = root.querySelector(".dd-panel");
  const toggle = root.querySelector(".dd-toggle");

  const rows = items.map((it) => `
    <label class="dd-item">
      <input type="checkbox" value="${esc(it.value)}" ${selected.has(it.value) ? "checked" : ""}>
      ${withDots ? `<span class="dot" style="background:${colorFor(it.value)}"></span>` : ""}
      <span>${esc(it.label)}</span>
    </label>`).join("");
  panel.innerHTML = `
    <div class="dd-actions">
      <button type="button" data-act="all">todos</button>
      <button type="button" data-act="none">limpar</button>
    </div>${rows}`;

  const sync = () => {
    selected.clear();
    panel.querySelectorAll("input:checked").forEach((i) => selected.add(i.value));
    toggle.textContent = selected.size === 0
      ? labelAll
      : items.filter((i) => selected.has(i.value)).map((i) => i.label.split(" ")[0]).slice(0, 3).join(", ")
        + (selected.size > 3 ? ` +${selected.size - 3}` : "");
  };
  // onchange/onclick (e não addEventListener) para poder reconstruir após re-login
  panel.onchange = sync;
  panel.querySelectorAll("[data-act]").forEach((b) =>
    b.addEventListener("click", () => {
      panel.querySelectorAll("input").forEach((i) => (i.checked = b.dataset.act === "all"));
      sync();
    }));
  toggle.onclick = (ev) => {
    ev.stopPropagation();
    document.querySelectorAll(".dropdown.open").forEach((d) => d !== root && d.classList.remove("open"));
    root.classList.toggle("open");
  };
  sync();
}

document.addEventListener("click", (ev) => {
  if (!ev.target.closest(".dropdown"))
    document.querySelectorAll(".dropdown.open").forEach((d) => d.classList.remove("open"));
});

/* ---------- agregações ---------- */

function aggregate(entries) {
  const byUser = new Map(), byProject = new Map(), byIssue = new Map(), byDay = new Map();
  let total = 0;
  for (const e of entries) {
    total += e.seconds;
    byUser.set(e.authorId, (byUser.get(e.authorId) || { name: e.authorName, seconds: 0 }));
    byUser.get(e.authorId).seconds += e.seconds;
    const pk = e.projectName || e.projectKey || "(sem projeto)";
    byProject.set(pk, (byProject.get(pk) || 0) + e.seconds);
    if (!byIssue.has(e.issueKey)) {
      byIssue.set(e.issueKey, {
        key: e.issueKey, summary: e.summary, project: e.projectKey, status: e.status,
        statusCategory: e.statusCategory, estimate: e.estimateSeconds,
        totalSpent: e.totalSpentSeconds, seconds: 0, count: 0,
      });
    }
    const it = byIssue.get(e.issueKey);
    it.seconds += e.seconds; it.count += 1;
    if (!byDay.has(e.date)) byDay.set(e.date, new Map());
    const dm = byDay.get(e.date);
    dm.set(e.authorId, (dm.get(e.authorId) || 0) + e.seconds);
  }
  return { total, byUser, byProject, byIssue, byDay };
}

function listDays(startIso, endIso) {
  const out = [];
  const end = dateOf(endIso);
  for (let d = dateOf(startIso); d <= end; d.setDate(d.getDate() + 1)) out.push(isoOf(d));
  return out;
}

/* agrupa dias em buckets: dia / semana / mês conforme o tamanho do período */
function buildBuckets(days) {
  const n = days.length;
  if (n <= 45) {
    return days.map((iso) => ({ key: iso, label: fmtDate(iso), sub: WEEKDAYS[dateOf(iso).getDay()], days: [iso] }));
  }
  const buckets = new Map();
  for (const iso of days) {
    const d = dateOf(iso);
    let key, label;
    if (n <= 200) { // semana (segunda como início)
      const m = new Date(d); m.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      key = isoOf(m); label = fmtDate(key);
    } else { // mês
      key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
      label = `${MONTHS[d.getMonth()]}/${String(d.getFullYear()).slice(2)}`;
    }
    if (!buckets.has(key)) buckets.set(key, { key, label, sub: "", days: [] });
    buckets.get(key).days.push(iso);
  }
  return [...buckets.values()];
}

/* ---------- render: tiles ---------- */

function renderTiles(agg) {
  const days = listDays(state.start, state.end);
  const todayIso = isoOf(new Date());
  const workdaysElapsed = days.filter((iso) => {
    const wd = dateOf(iso).getDay();
    return wd >= 1 && wd <= 5 && iso <= todayIso;
  }).length;
  const workdaysTotal = days.filter((iso) => { const w = dateOf(iso).getDay(); return w >= 1 && w <= 5; }).length;
  const daysWithLog = agg.byDay.size;
  const avg = workdaysElapsed ? agg.total / workdaysElapsed : 0;

  $("#tiles").innerHTML = `
    <div class="tile hero">
      <div class="t-label">Total apontado</div>
      <div class="t-value">${fmtH(agg.total)}</div>
      <div class="t-sub">${fmtDec(agg.total)} h no período</div>
    </div>
    <div class="tile">
      <div class="t-label">Média por dia útil</div>
      <div class="t-value">${fmtH(avg)}</div>
      <div class="t-sub">${workdaysElapsed} dia(s) útil(eis) decorrido(s)</div>
    </div>
    <div class="tile">
      <div class="t-label">Dias com apontamento</div>
      <div class="t-value">${daysWithLog}<span class="muted" style="font-size:16px"> / ${workdaysTotal}</span></div>
      <div class="t-sub">dias úteis no período</div>
    </div>
    <div class="tile">
      <div class="t-label">Tasks trabalhadas</div>
      <div class="t-value">${agg.byIssue.size}</div>
      <div class="t-sub">${state.report.entries.length} apontamento(s)</div>
    </div>
    <div class="tile">
      <div class="t-label">Pessoas</div>
      <div class="t-value">${agg.byUser.size}</div>
      <div class="t-sub">com tempo registrado</div>
    </div>`;
}

/* ---------- render: colunas empilhadas (SVG) ---------- */

function renderDayChart(agg) {
  const container = $("#chart-days");
  const legendEl = $("#legend-days");
  container.innerHTML = "";
  legendEl.innerHTML = "";
  if (!state.report.entries.length) {
    container.innerHTML = `<div class="empty">Sem apontamentos no período.</div>`;
    return;
  }

  // séries = pessoas ordenadas por horas; além de 7, agrupa em "Outros"
  const usersSorted = [...agg.byUser.entries()].sort((a, b) => b[1].seconds - a[1].seconds);
  const MAXS = 7;
  const main = usersSorted.slice(0, MAXS);
  const otherIds = new Set(usersSorted.slice(MAXS).map(([id]) => id));
  const series = main.map(([id, u]) => ({ id, name: u.name, color: colorFor(id) }));
  if (otherIds.size) series.push({ id: "__other", name: "Outros", color: cssVar("--muted") });

  const days = listDays(state.start, state.end);
  const buckets = buildBuckets(days).map((b) => {
    const perSeries = new Map(series.map((s) => [s.id, 0]));
    let total = 0;
    for (const iso of b.days) {
      const dm = agg.byDay.get(iso);
      if (!dm) continue;
      for (const [uid, secs] of dm) {
        const sid = otherIds.has(uid) ? "__other" : uid;
        perSeries.set(sid, (perSeries.get(sid) || 0) + secs);
        total += secs;
      }
    }
    return { ...b, perSeries, total };
  });

  const bucketMode = buckets[0]?.days.length === 1 ? "day" : "agg";
  $("#chart-days-title").textContent =
    bucketMode === "day" ? "Horas por dia" : (days.length <= 200 ? "Horas por semana" : "Horas por mês");

  // legenda (só com 2+ séries)
  if (series.length >= 2) {
    legendEl.innerHTML = series.map((s) =>
      `<span class="l-item"><span class="dot" style="background:${s.color}"></span>${esc(s.name)}</span>`).join("");
  }

  const W = Math.max(640, container.clientWidth || 640);
  const H = 260, mL = 44, mR = 10, mT = 14, mB = 36;
  const plotW = W - mL - mR, plotH = H - mT - mB;
  const maxSec = Math.max(...buckets.map((b) => b.total), 1);

  // escala com teto "redondo" em horas
  const maxH = maxSec / 3600;
  const steps = [1, 2, 4, 5, 10, 20, 25, 50, 100, 200, 400];
  let step = steps.find((s) => maxH / s <= 5) || 400;
  const top = Math.ceil(maxH / step) * step;
  const y = (sec) => mT + plotH - (sec / 3600 / top) * plotH;

  const band = plotW / buckets.length;
  const barW = Math.min(24, Math.max(3, band * 0.62));
  const surface = cssVar("--surface-1");

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Horas apontadas por período">`;

  // gridlines + rótulos do eixo Y
  for (let v = 0; v <= top; v += step) {
    const yy = y(v * 3600);
    svg += `<line x1="${mL}" x2="${W - mR}" y1="${yy}" y2="${yy}" stroke="${v === 0 ? cssVar("--axis") : cssVar("--grid")}" stroke-width="1"/>`;
    svg += `<text x="${mL - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="${cssVar("--muted")}">${v}h</text>`;
  }

  // linha de referência da meta (só na visão diária com uma pessoa)
  if (bucketMode === "day" && series.length === 1 && state.expected * 1.02 <= top) {
    const yy = y(state.expected * 3600);
    svg += `<line x1="${mL}" x2="${W - mR}" y1="${yy}" y2="${yy}" stroke="${cssVar("--axis")}" stroke-width="1"/>`;
    svg += `<text x="${W - mR}" y="${yy - 4}" text-anchor="end" font-size="10" fill="${cssVar("--muted")}">meta ${state.expected}h</text>`;
  }

  const labelEvery = Math.ceil(buckets.length / Math.floor(plotW / 46));
  buckets.forEach((b, i) => {
    const cx = mL + band * i + band / 2;
    const x = cx - barW / 2;

    // segmentos de baixo para cima, gap de 2px entre eles, topo arredondado 4px
    let cursor = y(0);
    const segs = series
      .map((s) => ({ s, sec: b.perSeries.get(s.id) || 0 }))
      .filter((o) => o.sec > 0);
    segs.forEach((o, k) => {
      const hPx = (o.sec / 3600 / top) * plotH;
      const yTop = cursor - hPx;
      const isTop = k === segs.length - 1;
      const gap = k > 0 ? 2 : 0;
      const hDraw = Math.max(1, hPx - gap);
      if (isTop) {
        const r = Math.min(4, hDraw, barW / 2);
        svg += `<path d="M${x},${yTop + hDraw} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${yTop + hDraw} Z" fill="${o.s.color}"/>`;
      } else {
        svg += `<rect x="${x}" y="${yTop}" width="${barW}" height="${hDraw}" fill="${o.s.color}"/>`;
      }
      cursor = yTop;
    });

    // rótulo do eixo X (esparso quando há muitos buckets)
    if (i % labelEvery === 0) {
      const isWknd = bucketMode === "day" && [0, 6].includes(dateOf(b.key).getDay());
      const op = isWknd ? ' opacity="0.45"' : "";
      svg += `<text x="${cx}" y="${H - 20}" text-anchor="middle" font-size="10.5" fill="${cssVar("--muted")}"${op}>${esc(b.label)}</text>`;
      if (b.sub) svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle" font-size="9.5" fill="${cssVar("--muted")}"${op}>${esc(b.sub)}</text>`;
    }

    // alvo de hover: a banda toda
    svg += `<rect class="hover-zone" data-i="${i}" x="${mL + band * i}" y="${mT}" width="${band}" height="${plotH}" fill="transparent"/>`;
  });

  svg += "</svg>";
  container.innerHTML = svg;

  container.querySelectorAll(".hover-zone").forEach((zone) => {
    const b = buckets[Number(zone.dataset.i)];
    const rows = series
      .map((s) => ({ s, sec: b.perSeries.get(s.id) || 0 }))
      .filter((o) => o.sec > 0)
      .map((o) => `<div class="tt-row"><span class="tt-left"><span class="dot" style="background:${o.s.color}"></span>${esc(o.s.name)}</span><span class="v">${fmtH(o.sec)}</span></div>`)
      .join("");
    const title = b.days.length === 1 ? fmtDateFull(b.key) : `${fmtDate(b.days[0])} – ${fmtDate(b.days[b.days.length - 1])}`;
    const html = `<div class="tt-title">${title}</div>${rows || '<div class="muted">sem apontamento</div>'}` +
      (rows && series.length > 1 ? `<div class="tt-row" style="margin-top:4px;border-top:1px solid ${cssVar("--grid")};padding-top:4px"><span>Total</span><span class="v"><b>${fmtH(b.total)}</b></span></div>` : "");
    zone.addEventListener("mouseenter", (ev) => showTooltip(html, ev));
    zone.addEventListener("mousemove", moveTooltip);
    zone.addEventListener("mouseleave", hideTooltip);
  });
}

/* ---------- render: barras horizontais ---------- */

function renderHBars(el, items) {
  if (!items.length) { el.innerHTML = `<div class="empty">Sem dados.</div>`; return; }
  const max = Math.max(...items.map((i) => i.seconds));
  el.innerHTML = items.map((i) => `
    <div class="hbar-row" title="${esc(i.label)}: ${fmtDec(i.seconds)} h">
      <div class="hbar-label">${esc(i.label)}</div>
      <div class="hbar-track">
        <div class="hbar-fill" style="width:${(i.seconds / max) * 100 * 0.82}%;background:${i.color}"></div>
        <span class="hbar-value">${fmtH(i.seconds)}</span>
      </div>
    </div>`).join("");
}

/* ---------- render: tabelas ---------- */

function issueLink(key) {
  return `<a href="${esc(state.meta.baseUrl)}/browse/${esc(key)}" target="_blank" rel="noopener">${esc(key)}</a>`;
}
function statusBadge(name, category) {
  const icon = category === "done" ? "✓" : category === "indeterminate" ? "◐" : "○";
  return `<span class="badge">${icon} ${esc(name)}</span>`;
}

function renderIssuesTable(agg) {
  const rows = [...agg.byIssue.values()].sort((a, b) => b.seconds - a.seconds);
  const total = agg.total || 1;
  $("#table-issues").innerHTML = `
    <thead><tr>
      <th>Task</th><th>Projeto</th><th>Status</th>
      <th class="num">Apontamentos</th><th class="num">Horas</th><th class="num">% do total</th><th class="num">Estimado</th>
    </tr></thead>
    <tbody>${rows.map((r) => `
      <tr>
        <td>${issueLink(r.key)}<div class="cell-sub">${esc(r.summary)}</div></td>
        <td>${esc(r.project)}</td>
        <td>${statusBadge(r.status, r.statusCategory)}</td>
        <td class="num">${r.count}</td>
        <td class="num"><b>${fmtH(r.seconds)}</b></td>
        <td class="num">${((r.seconds / total) * 100).toFixed(1).replace(".", ",")}%</td>
        <td class="num">${r.estimate ? fmtH(r.estimate) : "—"}</td>
      </tr>`).join("")}
    </tbody>`;
}

function filteredEntries() {
  const q = state.wlSearch.trim().toLowerCase();
  const entries = [...state.report.entries].sort((a, b) => b.started.localeCompare(a.started));
  if (!q) return entries;
  return entries.filter((e) =>
    [e.issueKey, e.summary, e.authorName, e.comment, e.projectName, e.date]
      .join(" ").toLowerCase().includes(q));
}

function renderWorklogsTable() {
  const entries = filteredEntries();
  $("#wl-count").textContent = `(${entries.length})`;
  $("#table-worklogs").innerHTML = `
    <thead><tr>
      <th>Data</th><th>Task</th><th>Pessoa</th><th class="num">Tempo</th><th>Comentário</th>
    </tr></thead>
    <tbody>${entries.map((e) => `
      <tr>
        <td class="num">${fmtDateFull(e.date)}</td>
        <td>${issueLink(e.issueKey)}<div class="cell-sub">${esc(e.summary)}</div></td>
        <td><span class="dot" style="display:inline-block;background:${colorFor(e.authorId)}"></span> ${esc(e.authorName)}</td>
        <td class="num"><b>${fmtH(e.seconds)}</b></td>
        <td class="cell-sub">${esc(e.comment)}</td>
      </tr>`).join("")}
    </tbody>`;
}

function exportCsv() {
  const entries = filteredEntries();
  const header = ["data", "projeto", "task", "resumo", "pessoa", "tempo", "horas_decimal", "comentario"];
  const lines = [header.join(";")];
  for (const e of entries) {
    lines.push([
      e.date, e.projectName, e.issueKey, e.summary, e.authorName,
      e.timeSpent, (e.seconds / 3600).toFixed(2).replace(".", ","), e.comment,
    ].map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";"));
  }
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `apontamentos_${state.start}_a_${state.end}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- render: sem apontamento ---------- */

function renderMissing() {
  const m = state.missing;
  $("#missing-scope").textContent =
    `Dias úteis avaliados: ${fmtDate(m.start)} a ${fmtDate(m.horizon)} — meta de ${String(m.expectedHours).replace(".", ",")}h por dia (fins de semana ignorados; feriados não são descontados).`;

  const cards = m.users.map((u) => {
    const missing = u.missingDays;
    const chips = missing.map((d) => {
      const cls = d.seconds === 0 ? "zero" : "partial";
      const mark = d.seconds === 0 ? "✕" : "◑";
      return `<span class="day-chip ${cls}${d.isToday ? " today" : ""}" title="${d.isToday ? "hoje (dia ainda em andamento)" : ""}">
        <span class="mark">${mark}</span>${fmtDateFull(d.date)} — ${fmtH(d.seconds)}</span>`;
    }).join("");
    return `
      <div class="card mu-card">
        <div class="mu-head">
          <h2><span class="dot" style="display:inline-block;background:${colorFor(u.accountId)}"></span> ${esc(u.displayName)}</h2>
          <span class="muted">${fmtH(u.totalSeconds)} no período</span>
          ${missing.length === 0
            ? `<span class="ok">✓ todos os ${u.daysEvaluated} dias úteis com ${String(m.expectedHours).replace(".", ",")}h+</span>`
            : `<span class="muted">${missing.length} de ${u.daysEvaluated} dia(s) abaixo da meta</span>`}
        </div>
        ${missing.length ? `<div class="mu-days">${chips}</div>` : ""}
      </div>`;
  }).join("");
  $("#missing-users").innerHTML = cards || `<div class="empty">Nenhuma pessoa para avaliar no período.</div>`;

  const all = m.issuesWithoutWorklog;

  // contagem por status nos chips
  const counts = { "": all.length };
  for (const r of all) counts[r.statusCategory] = (counts[r.statusCategory] || 0) + 1;
  document.querySelectorAll("#nw-status .chip").forEach((c) => {
    const cat = c.dataset.cat;
    const base = { "": "Todas", indeterminate: "Em andamento", new: "A fazer", done: "Concluídas" }[cat];
    c.textContent = `${base} (${counts[cat] || 0})`;
    c.classList.toggle("active", cat === state.nwCat);
  });

  let rows = all;
  if (state.nwCat) rows = rows.filter((r) => r.statusCategory === state.nwCat);
  const q = state.nwSearch.trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) =>
      [r.issueKey, r.summary, r.assigneeName, r.projectKey, r.status]
        .join(" ").toLowerCase().includes(q));
  }
  $("#nw-count").textContent = rows.length === all.length ? `(${all.length})` : `(${rows.length} de ${all.length})`;

  $("#table-noworklog").innerHTML = rows.length ? `
    <thead><tr>
      <th>Task</th><th>Status</th><th>Responsável</th><th>Projeto</th><th class="num">Outros apontaram</th>
    </tr></thead>
    <tbody>${rows.map((r) => `
      <tr>
        <td>${issueLink(r.issueKey)}<div class="cell-sub">${esc(r.summary)}</div></td>
        <td>${statusBadge(r.status, r.statusCategory)}</td>
        <td>${esc(r.assigneeName)}</td>
        <td>${esc(r.projectKey)}</td>
        <td class="num">${r.othersSeconds ? fmtH(r.othersSeconds) : "—"}</td>
      </tr>`).join("")}
    </tbody>` : all.length
      ? `<tbody><tr><td class="empty">Nenhuma task com esses filtros.</td></tr></tbody>`
      : `<tbody><tr><td class="empty">Nenhuma task pendente de apontamento no período. ✓</td></tr></tbody>`;
}

/* ---------- render geral ---------- */

function renderAll() {
  if (!state.report) return;
  const agg = aggregate(state.report.entries);

  ensureColors(
    [...agg.byUser.entries()].sort((a, b) => b[1].seconds - a[1].seconds).map(([id]) => id)
  );
  renderTiles(agg);
  renderDayChart(agg);

  renderHBars($("#chart-users"),
    [...agg.byUser.entries()]
      .sort((a, b) => b[1].seconds - a[1].seconds)
      .map(([id, u]) => ({ label: u.name, seconds: u.seconds, color: colorFor(id) })));

  renderHBars($("#chart-projects"),
    [...agg.byProject.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, seconds]) => ({ label: name, seconds, color: cssVar("--s1") })));

  renderIssuesTable(agg);
  renderWorklogsTable();
  if (state.missing) renderMissing();
}

/* ---------- abas ---------- */

function switchTab(name) {
  state.tab = name;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-content").forEach((s) => (s.hidden = s.id !== `tab-${name}`));
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
}

/* ---------- boot ---------- */

async function boot() {
  applyPreset("month");
  document.querySelectorAll("#presets .chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      applyPreset(chip.dataset.preset);
      markPreset(chip.dataset.preset);
      applyAndLoad();
    }));
  ["f-start", "f-end"].forEach((id) =>
    $("#" + id).addEventListener("change", () => markPreset(null)));

  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => switchTab(t.dataset.tab)));
  const hashTab = location.hash.slice(1);
  if (["dashboard", "worklogs", "missing"].includes(hashTab)) switchTab(hashTab);

  $("#btn-apply").addEventListener("click", applyAndLoad);
  $("#btn-refresh").addEventListener("click", () => loadAll(true));
  $("#btn-csv").addEventListener("click", exportCsv);
  $("#wl-search").addEventListener("input", (ev) => {
    state.wlSearch = ev.target.value;
    renderWorklogsTable();
  });
  $("#nw-search").addEventListener("input", (ev) => {
    state.nwSearch = ev.target.value;
    if (state.missing) renderMissing();
  });
  document.querySelectorAll("#nw-status .chip").forEach((c) =>
    c.addEventListener("click", () => {
      state.nwCat = c.dataset.cat;
      if (state.missing) renderMissing();
    }));
  window.addEventListener("resize", () => { if (state.report) renderDayChart(aggregate(state.report.entries)); });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderAll);

  $("#login-form").addEventListener("submit", doLogin);
  $("#btn-logout").addEventListener("click", logout);

  await startApp();
}

async function startApp() {
  $("#loading").hidden = false;
  $("#error-banner").hidden = true;
  try {
    state.meta = await apiGet("/api/meta", {});
    buildDropdown("#dd-users",
      state.meta.users.map((u) => ({ value: u.accountId, label: u.displayName })),
      state.users, "Todas", true);
    buildDropdown("#dd-projects",
      state.meta.projects.map((p) => ({ value: p.key, label: `${p.name} (${p.key})` })),
      state.projects, "Todos", false);
    $("#who").textContent = creds?.displayName || state.meta.myself?.displayName || "";
    $("#btn-logout").hidden = !creds;
  } catch (err) {
    if (err.status === 401) {
      showLogin(creds ? "As credenciais salvas não funcionaram — entre novamente." : "");
      return;
    }
    const banner = $("#error-banner");
    banner.textContent = "Erro ao conectar no Jira: " + err.message;
    banner.hidden = false;
    $("#loading").hidden = true;
    return;
  }
  await loadAll();
}

/* ---------- login ---------- */

function showLogin(msg) {
  $("#loading").hidden = true;
  $("#login-overlay").hidden = false;
  if (creds) {
    $("#l-url").value = creds.baseUrl || "";
    $("#l-email").value = creds.email || "";
  }
  const errEl = $("#login-error");
  errEl.hidden = !msg;
  if (msg) errEl.textContent = msg;
}

async function doLogin(ev) {
  ev.preventDefault();
  const body = {
    baseUrl: $("#l-url").value.trim().replace(/\/+$/, ""),
    email: $("#l-email").value.trim(),
    token: $("#l-token").value.trim(),
  };
  const btn = $("#login-btn");
  btn.disabled = true;
  btn.textContent = "Conectando…";
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `Erro ${res.status}`);
    creds = { ...body, displayName: data.displayName };
    localStorage.setItem("jira-dash-creds", JSON.stringify(creds));
    $("#l-token").value = "";
    $("#login-overlay").hidden = true;
    await startApp();
  } catch (err) {
    const errEl = $("#login-error");
    errEl.textContent = String(err.message || err);
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
}

function logout() {
  localStorage.removeItem("jira-dash-creds");
  creds = null;
  state.report = null;
  state.missing = null;
  $("#btn-logout").hidden = true;
  $("#who").textContent = "";
  showLogin();
}

function applyAndLoad() {
  state.start = $("#f-start").value;
  state.end = $("#f-end").value;
  state.expected = Number($("#f-expected").value) || 8;
  if (!state.start || !state.end) return;
  loadAll();
}

boot();
