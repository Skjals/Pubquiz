// ============================================================
// 🍺 Pubquiz App — één bestand, geen dependencies
// Draaien met:  node server.js   (Node 18+)
// Open daarna:  http://localhost:3000
// Spelers en quizmaster gebruiken dezelfde link.
// Alle gegevens worden ook opgeslagen in data.json.
// ============================================================

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");

// ---------- State ----------

let state = {
  quizName: "Pubquiz",
  code: "PUB26",
  pin: null, // quizmaster-PIN, ingesteld bij eerste gebruik
  activeRound: -1, // -1 = nog niet gestart
  status: "setup", // setup | live | done
  theme: {
    bg: "#1E63C9",
    card: "#FFF6E5",
    accent: "#FFD39B",
    text: "#1a1a1a",
    onBg: "#FFF1D6",
  },
  rounds: [], // { name, questions: [], answers: [] }
  teams: [], // { id, name, answers: {r:[]}, marks: {r:q:true/false}, joinedAt }
};

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      state = Object.assign(state, JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
    }
  } catch (e) { console.error("data.json kon niet gelezen worden, vers gestart:", e.message); /* bij fout: verse start */ }
}
function saveState() {
  try {
    // atomair schrijven: eerst tijdelijk bestand, dan hernoemen
    fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(state, null, 2));
    fs.renameSync(DATA_FILE + ".tmp", DATA_FILE);
  } catch (e) {
    console.error("Opslaan van data.json mislukt:", e.message);
  }
}

// ---------- Helpers ----------

function newId() {
  return crypto.randomUUID();
}

// simpele beveiliging tegen PIN raden: 5 fouten = 15 minuten blokkade
let pinFails = 0;
let pinBlockedUntil = 0;

function teamScore(team) {
  let s = 0;
  for (const key of Object.keys(team.marks || {})) {
    s += Object.values(team.marks[key]).filter(Boolean).length;
  }
  return s;
}

function body(req) {
  return new Promise((resolve) => {
    let data = "";
    let overflow = false;
    req.on("data", (c) => {
      if (overflow) return;
      data += c;
      if (data.length > 100 * 1024) { overflow = true; data = ""; req.destroy(); resolve({}); }
    });
    req.on("end", () => {
      if (overflow) return;
      try { resolve(JSON.parse(data || "{}")); }
      catch { resolve({}); }
    });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function isPinOk(obj) {
  if (Date.now() < pinBlockedUntil) return false;
  const ok = !!state.pin && obj.pin === state.pin;
  if (!ok) {
    pinFails += 1;
    if (pinFails >= 5) { pinBlockedUntil = Date.now() + 15 * 60 * 1000; pinFails = 0; }
  } else {
    pinFails = 0;
  }
  return ok;
}

// ---------- API ----------

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === "/api/state" && (req.method === "GET" || req.method === "POST")) {
    const b = req.method === "POST" ? await body(req, res) : null;
    const role = ((b ? b.role : url.searchParams.get("role")) || "player");
    const pin = b ? b.pin : (url.searchParams.get("pin") || "");
    if (role === "admin" && !isPinOk({ pin })) {
      return json(res, 403, { error: "PIN klopt niet." });
    }
    const out = {
      quizName: state.quizName,
      code: state.code,
      status: state.status,
      activeRound: state.activeRound,
      theme: state.theme,
      hasPin: !!state.pin,
    };
    if (role === "admin") {
      out.rounds = state.rounds;
      out.teams = state.teams.map((t) => ({
        id: t.id, name: t.name, answers: t.answers || {}, marks: t.marks || {},
        score: teamScore(t),
      }));
    } else {
      out.teamCount = state.teams.length;
      if (state.activeRound >= 0 && state.rounds[state.activeRound]) {
        out.round = {
          index: state.activeRound,
          name: state.rounds[state.activeRound].name,
          questions: state.rounds[state.activeRound].questions,
        };
      }
      if (state.status === "done") {
        out.finalScores = state.teams
          .map((t) => ({ name: t.name, score: teamScore(t) }))
          .sort((a, b) => b.score - a.score);
      }
    }
    return json(res, 200, out);
  }

  if (route === "/api/join" && req.method === "POST") {
    const b = await body(req, res);
    const name = String(b.team || "").trim().slice(0, 40);
    if (!name) return json(res, 400, { error: "Vul een teamnaam in." });
    if (String(b.code || "").trim().toUpperCase() !== state.code.toUpperCase()) {
      return json(res, 400, { error: "Quizcode klopt niet." });
    }
    if (state.teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      return json(res, 400, { error: "Die teamnaam is al in gebruik." });
    }
    const team = { id: newId(), name, answers: {}, marks: {}, joinedAt: Date.now() };
    state.teams.push(team);
    saveState();
    return json(res, 200, { teamId: team.id, teamName: team.name });
  }

  if (route === "/api/submit" && req.method === "POST") {
    const b = await body(req, res);
    const team = state.teams.find((t) => t.id === b.teamId);
    if (!team) return json(res, 400, { error: "Team onbekend, opnieuw meedoen." });
    const r = parseInt(b.round, 10);
    if (!(r >= 0 && r < state.rounds.length)) return json(res, 400, { error: "Onbekende ronde." });
    if (state.status !== "live" || r !== state.activeRound) {
      return json(res, 400, { error: "Deze ronde is nu niet actief." });
    }
    const list = (Array.isArray(b.answers) ? b.answers : []).map((a) => String(a || "").slice(0, 200));
    list.length = state.rounds[r].questions.length;
    team.answers[r] = list;
    saveState();
    return json(res, 200, { ok: true });
  }

  // ---- Quizmaster (PIN beveiligd) ----

  if (route === "/api/admin/setup-pin" && req.method === "POST") {
    const b = await body(req, res);
    if (state.pin) return json(res, 400, { error: "Er is al een PIN ingesteld." });
    const pin = String(b.pin || "").trim();
    if (!/^\d{4,6}$/.test(pin)) return json(res, 400, { error: "Kies een PIN van 4 t/m 6 cijfers." });
    state.pin = pin;
    saveState();
    return json(res, 200, { ok: true });
  }

  if (route === "/api/admin/login" && req.method === "POST") {
    const b = await body(req, res);
    return json(res, 200, { ok: isPinOk(b) });
  }

  if (route === "/api/admin/change-pin" && req.method === "POST") {
    const b = await body(req, res);
    if (!isPinOk(b)) return json(res, 403, { error: "Huidige PIN klopt niet." });
    const npin = String(b.newPin || "").trim();
    if (!/^\d{4,6}$/.test(npin)) return json(res, 400, { error: "Kies een nieuwe PIN van 4 t/m 6 cijfers." });
    state.pin = npin;
    saveState();
    return json(res, 200, { ok: true });
  }

  if (route === "/api/admin/update" && req.method === "POST") {
    const b = await body(req, res);
    if (!isPinOk(b)) return json(res, 403, { error: "PIN klopt niet." });
    if (b.quizName) state.quizName = String(b.quizName).slice(0, 60);
    if (b.theme) {
      // alleen bekende sleutels en geldige hex-kleuren accepteren
      const okKeys = ["bg", "card", "accent", "text", "onBg"];
      const hx = /^#[0-9a-f]{6}$/i;
      for (const k of okKeys) {
        if (typeof b.theme[k] === "string" && hx.test(b.theme[k])) state.theme[k] = b.theme[k];
      }
    }
    if (Array.isArray(b.rounds)) {
      state.rounds = b.rounds.map((r) => ({
        name: String(r.name || "Ronde").slice(0, 80),
        questions: (r.questions || []).map((q) => String(q || "").slice(0, 300)),
        answers: (r.answers || []).map((a) => String(a || "").slice(0, 200)),
      })).filter((r) => r.questions.some((q) => q.trim() !== ""));
    }
    saveState();
    return json(res, 200, { ok: true });
  }

  if (route === "/api/admin/control" && req.method === "POST") {
    const b = await body(req, res);
    if (!isPinOk(b)) return json(res, 403, { error: "PIN klopt niet." });
    if (b.action === "round") {
      const r = parseInt(b.round, 10);
      if (r >= 0 && r < state.rounds.length) state.activeRound = r;
      state.status = "live";
    } else if (b.action === "start") {
      state.status = "live";
      if (state.activeRound < 0) state.activeRound = 0;
    } else if (b.action === "done") {
      state.status = "done";
    } else if (b.action === "reset") {
      state.teams = [];
      state.activeRound = -1;
      state.status = "setup";
    }
    saveState();
    return json(res, 200, { ok: true });
  }

  if (route === "/api/admin/score" && req.method === "POST") {
    const b = await body(req, res);
    if (!isPinOk(b)) return json(res, 403, { error: "PIN klopt niet." });
    const team = state.teams.find((t) => t.id === b.teamId);
    if (!team) return json(res, 400, { error: "Team onbekend." });
    const r = parseInt(b.round, 10), q = parseInt(b.q, 10);
    if (!(r >= 0 && r < state.rounds.length)) return json(res, 400, { error: "Onbekende ronde." });
    if (!(q >= 0 && q < state.rounds[r].questions.length)) return json(res, 400, { error: "Onbekende vraag." });
    if (!team.marks[r]) team.marks[r] = {};
    team.marks[r][q] = !!b.ok;
    saveState();
    return json(res, 200, { ok: true, score: teamScore(team) });
  }

  return json(res, 404, { error: "Onbekend endpoint." });
}

// ---------- Client (één pagina voor spelers én quizmaster) ----------

const CLIENT_HTML = `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pubquiz</title>
<style>
  :root { --bg:#1E63C9; --card:#FFF6E5; --accent:#FFD39B; --text:#1a1a1a; --onBg:#FFF1D6; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:system-ui,sans-serif; background:var(--bg); color:var(--text); min-height:100vh; padding:16px; }
  .wrap { max-width:860px; margin:0 auto; }
  .card { background:var(--card); border-radius:18px; padding:24px; margin-bottom:18px; box-shadow:0 2px 8px rgba(0,0,0,.18); }
  h1 { color:var(--accent); margin-bottom:4px; font-size:26px; }
  h2 { margin-bottom:10px; font-size:19px; }
  p.sub { color:var(--onBg); font-size:14px; margin-bottom:18px; }
  label { display:block; font-weight:600; font-size:14px; margin:12px 0 4px; }
  input { width:100%; padding:12px; border:1px solid #d8cdb8; border-radius:10px; font-size:16px; background:#fff; color:var(--text); }
  input:focus { outline:2px solid var(--accent); }
  button { background:var(--accent); color:var(--text); border:none; font-weight:700; font-size:16px; padding:12px 18px; border-radius:10px; cursor:pointer; }
  button:hover { opacity:.9; } button.wide { width:100%; }
  button.ghost { background:transparent; border:1px solid #d8cdb8; font-weight:600; }
  .btnrow { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
  .tabs { display:flex; gap:6px; background:var(--card); padding:4px; border-radius:12px; margin-bottom:16px; flex-wrap:wrap; }
  .tabs button { flex:1; min-width:110px; background:transparent; color:#666; }
  .tabs button.on { background:var(--accent); color:var(--text); }
  .row { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:10px 14px; border-radius:10px; background:#fff; border:1px solid #e8dfc9; margin-top:8px; }
  .row.top { border:2px solid var(--accent); background:var(--accent); }
  .score { font-weight:800; font-size:20px; }
  .qrow { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 0; border-top:1px solid #e8dfc9; font-size:14px; }
  .ok,.no { border:none; padding:6px 10px; font-weight:800; }
  .ok.on { background:#2e7d32; color:#fff; } .no.on { background:#c62828; color:#fff; }
  .ok:not(.on){ background:#eee; } .no:not(.on){ background:#eee; }
  .badge { font-size:12px; font-weight:700; padding:4px 10px; border-radius:999px; background:#2e7d32; color:#fff; }
  .badge.wait { background:#9e9e9e; }
  .hint { font-size:12px; color:var(--onBg); text-align:center; margin-top:10px; }
  .err { color:#c62828; font-weight:600; font-size:14px; margin-top:8px; }
  .qline { display:grid; grid-template-columns:1fr 1fr 30px; gap:8px; margin-top:8px; }
  .qline input { padding:8px; font-size:14px; }
  details { background:#fff; border:1px solid #e8dfc9; border-radius:10px; padding:10px 14px; margin-top:8px; }
  summary { cursor:pointer; font-weight:700; }
  @media (max-width:600px){ .qline{ grid-template-columns:1fr; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>&#127968; Pubquiz</h1>
  <p class="sub" id="subtitle"></p>
  <div id="app"></div>
  <p class="hint" id="hint"></p>
</div>
<script>
"use strict";
var pin = localStorage.getItem("pin") || "";
var teamId = localStorage.getItem("teamId") || "";
var teamName = localStorage.getItem("teamName") || "";
var view = "home"; // home | join | play | admin-login | admin-setup | admin-live | admin-theme
var s = null; // laatste serverstate
var myAnswers = {}; var pinFormOpen = false; var openTeams = {};
var msg = "";

function $(sel, el) { return (el || document).querySelector(sel); }
function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

// tekst van gebruikers veilig invoegen (tegen XSS)
function esc(x) {
  return String(x == null ? "" : x).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function applyTheme(t) {
  var r = document.documentElement.style;
  r.setProperty("--bg", t.bg); r.setProperty("--card", t.card);
  r.setProperty("--accent", t.accent); r.setProperty("--text", t.text); r.setProperty("--onBg", t.onBg);
}

function api(path, data) {
  return fetch(path, {
    method: data ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: data ? JSON.stringify(data) : undefined
  }).then(function (r) { return r.json(); });
}

function refreshState() {
  var role = view.indexOf("admin") === 0 ? "admin" : "player";
  return api("/api/state", { role: role, pin: pin }).then(function (st) {
    if (st && st.error) {
      // PIN onjuist of verouderd: netjes terug naar het inlogscherm
      if (role === "admin") { pin = ""; localStorage.removeItem("pin"); view = "admin-login"; }
      return refreshState();
    }
    s = st; applyTheme(st.theme || {}); return st;
  });
}

function render() {
  var app = $("#app");
  app.innerHTML = "";
  $("#subtitle").textContent = "Quizcode: " + (s ? s.code : "") + (s && s.teamCount != null ? " — " + s.teamCount + " teams" : "");
  $("#hint").textContent = "";

  if (msg) { app.appendChild(el("div", "err", msg)); msg = ""; }

  if (view === "home") return renderHome(app);
  if (view === "join") return renderJoin(app);
  if (view === "play") return renderPlay(app);
  if (view === "admin-login") return renderAdminLogin(app);
  if (view === "admin-setup") return renderAdminSetup(app);
  if (view === "admin-live") return renderAdminLive(app);
  if (view === "admin-theme") return renderAdminTheme(app);
}

// ---------- Startpagina ----------

function renderHome(app) {
  var c = el("div", "card");
  c.appendChild(el("h2", null, "Welkom bij de pubquiz!"));
  c.appendChild(el("p", null, "Ben je een team dat mee wilt doen, of ben jij de quizmaster?"));
  var r = el("div", "btnrow");
  var b1 = el("button", "wide", "&#128241; Meedoen met mijn team");
  b1.onclick = function () { view = teamId ? "play" : "join"; render(); };
  var b2 = el("button", "wide ghost", "&#127919; Ik ben de quizmaster");
  b2.onclick = function () { view = "admin-login"; render(); };
  r.appendChild(b1); r.appendChild(b2);
  c.appendChild(r);
  app.appendChild(c);
}

// ---------- Team / Speler ----------

function renderJoin(app) {
  var c = el("div", "card");
  c.appendChild(el("h2", null, "Doe mee met de quiz"));
  c.appendChild(el("p", null, "Vul de quizcode en jullie teamnaam in. Eén telefoon per team."));
  c.appendChild(el("label", null, "Quizcode"));
  var code = el("input"); code.placeholder = "Bijv. PUB26"; code.value = s.code; c.appendChild(code);
  c.appendChild(el("label", null, "Teamnaam"));
  var name = el("input"); name.placeholder = "Bijv. De Trivial Pursuits"; c.appendChild(name);
  var b = el("button", "wide", "Meedoen");
  b.onclick = function () {
    api("/api/join", { code: code.value, team: name.value }).then(function (r) {
      if (r.error) { msg = r.error; render(); return; }
      teamId = r.teamId; teamName = r.teamName;
      localStorage.setItem("teamId", teamId);
      localStorage.setItem("teamName", teamName);
      view = "play"; render();
    });
  };
  c.appendChild(b);
  app.appendChild(c);
}

function renderPlay(app) {
  if (s.status === "done") {
    var c0 = el("div", "card");
    c0.appendChild(el("h2", null, "&#127942; Einduitslag"));
    (s.finalScores || []).forEach(function (t, i) {
      c0.appendChild(el("div", "row" + (i === 0 ? " top" : ""),
        "<span>" + (["&#129351;","&#129352;","&#129353;"][i] || (i + 1) + ".") + " " + esc(t.name) + "</span><span class='score'>" + t.score + "</span>"));
    });
    app.appendChild(c0);
    return;
  }
  if (!s.round) {
    var c1 = el("div", "card");
    c1.appendChild(el("h2", null, "&#9997;&#65039; Welkom, " + teamName + "!"));
    c1.appendChild(el("p", null, "De quiz is nog niet gestart. Laat dit scherm open — zodra de quizmaster begint, verschijnen de vragen vanzelf."));
    app.appendChild(c1);
    return;
  }
  var c = el("div", "card");
  c.appendChild(el("h2", null, s.round.name));
  s.round.questions.forEach(function (q, i) {
    c.appendChild(el("label", null, (i + 1) + ". " + q));
    var inp = el("input"); inp.placeholder = "Jullie antwoord\u2026";
    inp.value = ((myAnswers[s.round.index] || {})[i]) || "";
    inp.oninput = function () { (myAnswers[s.round.index] = myAnswers[s.round.index] || {})[i] = inp.value; };
    c.appendChild(inp);
  });
  var b = el("button", "wide", "Antwoorden insturen");
  b.onclick = function () {
    var arr = s.round.questions.map(function (_, i) { return (myAnswers[s.round.index] || {})[i] || ""; });
    api("/api/submit", { teamId: teamId, round: s.round.index, answers: arr }).then(function (r) {
      if (r.error) { msg = r.error; }
      else { msg = "&#10003;"; c.innerHTML = "<h2>&#10003; Antwoorden ingediend!</h2><p>De quizmaster bekijkt ze nu. Wacht op de volgende ronde \u2014 die verschijnt vanzelf.</p>"; }
    });
  };
  c.appendChild(b);
  app.appendChild(c);
}

// ---------- Quizmaster ----------

function renderAdminLogin(app) {
  var c = el("div", "card");
  c.appendChild(el("h2", null, "&#127919; Quizmaster"));
  if (!s.hasPin) {
    c.appendChild(el("p", null, "Stel hier je persoonlijke quizmaster-PIN in (4 t/m 6 cijfers). Die heb je elke avond nodig."));
    c.appendChild(el("label", null, "Nieuwe PIN"));
    var p1 = el("input"); p1.type = "password"; p1.inputMode = "numeric"; c.appendChild(p1);
    var b = el("button", "wide", "PIN instellen");
    b.onclick = function () {
      api("/api/admin/setup-pin", { pin: p1.value }).then(function (r) {
        if (r.error) { msg = r.error; render(); return; }
        pin = p1.value; localStorage.setItem("pin", pin);
        view = "admin-live"; render();
      });
    };
    c.appendChild(b);
  } else {
    c.appendChild(el("p", null, "Vul je quizmaster-PIN in."));
    c.appendChild(el("label", null, "PIN"));
    var p2 = el("input"); p2.type = "password"; p2.inputMode = "numeric"; c.appendChild(p2);
    var b2 = el("button", "wide", "Inloggen");
    b2.onclick = function () {
      api("/api/admin/login", { pin: p2.value }).then(function (r) {
        if (!r.ok) { msg = "PIN klopt niet."; render(); return; }
        pin = p2.value; localStorage.setItem("pin", pin);
        view = "admin-live"; render();
      });
    };
    c.appendChild(b2);
  }
  app.appendChild(c);
}

function adminTabs(app) {
  var tabs = el("div", "tabs");
  [["admin-live","&#127919; Live"],["admin-setup","&#9998;&#65039; Vragen"],["admin-theme","&#127912; Stijl"]].forEach(function (pair) {
    var b = el("button", view === pair[0] ? "on" : "", pair[1]);
    b.onclick = function () { view = pair[0]; render(); };
    tabs.appendChild(b);
  });
  app.appendChild(tabs);
}

function renderAdminSetup(app) {
  adminTabs(app);
  var c = el("div", "card");
  c.appendChild(el("h2", null, "&#9998;&#65039; Vragen & antwoorden"));
  c.appendChild(el("p", null, "Stel hier je quiz samen: rondes, vragen en correcte antwoorden."));
  c.appendChild(el("label", null, "Naam van de quiz"));
  var qn = el("input"); qn.value = s.quizName; c.appendChild(qn);

  var roundsBox = el("div");
  var rounds = (s.rounds && s.rounds.length ? s.rounds : [{ name: "Ronde 1", questions: [""], answers: [""] }]).map(function (r) {
    return { name: r.name, questions: r.questions.slice(), answers: (r.answers || []).slice() };
  });

  function drawRounds() {
    roundsBox.innerHTML = "";
    rounds.forEach(function (rd, ri) {
      var box = el("div");
      box.style.cssText = "background:#fff;border:1px solid #e8dfc9;border-radius:12px;padding:12px;margin-top:10px";
      var hd = el("div", "qline");
      var nm = el("input"); nm.value = rd.name; nm.oninput = function () { rd.name = nm.value; };
      var del = el("button", "ghost", "&#10005;");
      del.onclick = function () { rounds.splice(ri, 1); drawRounds(); };
      hd.appendChild(nm); hd.appendChild(el("span", null, "")); hd.appendChild(del);
      box.appendChild(hd);
      rd.questions.forEach(function (qq, qi) {
        var ln = el("div", "qline");
        var i1 = el("input"); i1.placeholder = "Vraag " + (qi + 1); i1.value = qq;
        i1.oninput = function () { rd.questions[qi] = i1.value; };
        var i2 = el("input"); i2.placeholder = "Correct antwoord"; i2.value = rd.answers[qi] || "";
        i2.oninput = function () { rd.answers[qi] = i2.value; };
        var rm = el("button", "ghost", "&#10005;");
        rm.onclick = function () { rd.questions.splice(qi, 1); rd.answers.splice(qi, 1); drawRounds(); };
        ln.appendChild(i1); ln.appendChild(i2); ln.appendChild(rm);
        box.appendChild(ln);
      });
      var add = el("button", "ghost", "+ Vraag");
      add.onclick = function () { rd.questions.push(""); rd.answers.push(""); drawRounds(); };
      box.appendChild(add);
      roundsBox.appendChild(box);
    });
  }
  drawRounds();
  c.appendChild(roundsBox);

  var br = el("div", "btnrow");
  var addR = el("button", "ghost", "+ Ronde toevoegen");
  addR.onclick = function () { rounds.push({ name: "Ronde " + (rounds.length + 1), questions: [""], answers: [""] }); drawRounds(); };
  var save = el("button", null, "Opslaan");
  save.onclick = function () {
    api("/api/admin/update", { pin: pin, quizName: qn.value, rounds: rounds }).then(function (r) {
      msg = r.error || "Opgeslagen!"; refreshAndRender();
    });
  };
  br.appendChild(addR); br.appendChild(save);
  c.appendChild(br);
  app.appendChild(c);
}

function renderAdminTheme(app) {
  adminTabs(app);
  var c = el("div", "card");
  c.appendChild(el("h2", null, "&#127912; Stijl & kleuren"));
  c.appendChild(el("p", null, "Past de kleuren direct overal aan en slaat ze op bij de quiz."));
  var t = s.theme;
  [["bg","Achtergrond"],["card","Kaarten"],["accent","Accent (knoppen)"],["text","Tekst op kaarten"],["onBg","Tekst op achtergrond"]]
  .forEach(function (pair) {
    var key = pair[0];
    c.appendChild(el("label", null, pair[1]));
    var row = el("div", "qline");
    var col = el("input"); col.type = "color"; col.value = t[key];
    col.oninput = function () { t[key] = col.value; applyTheme(t); hex.value = col.value; };
    var hex = el("input"); hex.value = t[key];
    hex.oninput = function () { t[key] = hex.value; applyTheme(t); };
    row.appendChild(col); row.appendChild(hex); row.appendChild(el("span"));
    c.appendChild(row);
  });
  var b = el("button", "wide", "Opslaan");
  b.onclick = function () {
    api("/api/admin/update", { pin: pin, theme: t }).then(function (r) { msg = r.error || "Stijl opgeslagen!"; render(); });
  };
  c.appendChild(b);
  app.appendChild(c);
}

function renderAdminLive(app) {
  adminTabs(app);

  var c = el("div", "card");

  // Einduitslag + nieuwe start als de quiz afgerond is
  if (s.status === "done") {
    var dc = el("div", "card");
    dc.appendChild(el("h2", null, "&#127942; Quiz afgerond!"));
    (s.finalScores || s.teams.slice().sort(function (a, b) { return b.score - a.score; })).forEach(function (t, i) {
      dc.appendChild(el("div", "row" + (i === 0 ? " top" : ""),
        "<span>" + (["&#129351;","&#129352;","&#129353;"][i] || (i + 1) + ".") + " " + esc(t.name) + "</span><span class='score'>" + t.score + "</span>"));
    });
    var nb = el("button", "wide", "&#128260; Nieuwe quizavond starten");
    nb.onclick = function () {
      api("/api/admin/control", { pin: pin, action: "reset" }).then(refreshAndRender);
    };
    dc.appendChild(nb);
    app.appendChild(dc);
  }

  // Besturing
  c.appendChild(el("h2", null, "&#127919; Besturing"));
  var cInfo = el("p", null, s.status === "setup" ? "Quiz nog niet gestart." :
    s.status === "done" ? "Quiz afgerond." : "Ronde actief: " + (s.activeRound + 1));
  c.appendChild(cInfo);
  var br = el("div", "btnrow");
  s.rounds.forEach(function (rd, i) {
    var b = el("button", s.activeRound === i ? "" : "ghost", "Ronde " + (i + 1));
    b.onclick = function () { api("/api/admin/control", { pin: pin, action: "round", round: i }).then(refreshAndRender); };
    br.appendChild(b);
  });
  var done = el("button", "ghost", "&#127942; Afsluiten");
  done.onclick = function () { if (confirm("Quiz afsluiten en einduitslag tonen?")) api("/api/admin/control", { pin: pin, action: "done" }).then(refreshAndRender); };
  var reset = el("button", "ghost", "&#128465;&#65039; Teams wissen");
  reset.onclick = function () { if (confirm("Alle teams en antwoorden wissen? (Vragen blijven staan.)")) api("/api/admin/control", { pin: pin, action: "reset" }).then(refreshAndRender); };
  br.appendChild(done); br.appendChild(reset);
  if (!pinFormOpen) {
    var pinBtn = el("button", "ghost", "&#128273; PIN wijzigen");
    pinBtn.onclick = function () { pinFormOpen = true; render(); };
    br.appendChild(pinBtn);
  } else {
    var box = el("div");
    box.style.cssText = "margin-top:10px";
    box.appendChild(el("label", null, "Huidige PIN"));
    var o = el("input"); o.type = "password"; o.inputMode = "numeric"; box.appendChild(o);
    box.appendChild(el("label", null, "Nieuwe PIN (4 t/m 6 cijfers)"));
    var n = el("input"); n.type = "password"; n.inputMode = "numeric"; box.appendChild(n);
    var sv = el("button", null, "PIN wijzigen");
    sv.onclick = function () {
      api("/api/admin/change-pin", { pin: o.value, newPin: n.value }).then(function (r) {
        if (r.error) { msg = r.error; render(); return; }
        pin = n.value; localStorage.setItem("pin", pin);
        pinFormOpen = false; msg = "PIN gewijzigd!"; render();
      });
    };
    var cl = el("button", "ghost", "Annuleren");
    cl.onclick = function () { pinFormOpen = false; render(); };
    var row = el("div", "btnrow");
    row.appendChild(sv); row.appendChild(cl);
    box.appendChild(row);
    c.appendChild(box);
  }
  c.appendChild(br);
  app.appendChild(c);

  // Tussenstand
  var sc = el("div", "card");
  sc.appendChild(el("h2", null, "&#127942; Tussenstand"));
  s.teams.slice().sort(function (a, b) { return b.score - a.score; }).forEach(function (t, i) {
    sc.appendChild(el("div", "row" + (i === 0 ? " top" : ""),
      "<span>" + (["&#129351;","&#129352;","&#129353;"][i] || (i + 1) + ".") + " " + t.name + "</span><span class='score'>" + t.score + "</span>"));
  });
  app.appendChild(sc);

  // Antwoorden per ronde
  s.rounds.forEach(function (rd, ri) {
    var card = el("div", "card");
    card.appendChild(el("h2", null, rd.name));
    if (!s.teams.length) { card.appendChild(el("p", null, "Nog geen teams ingestroomd\u2026")); }
    s.teams.forEach(function (t) {
      var d = el("details");
      d.open = !!openTeams[t.id + "|" + ri];
      d.ontoggle = function () { openTeams[t.id + "|" + ri] = d.open; };
      var submitted = t.answers && t.answers[ri];
      d.appendChild(el("summary", null, esc(t.name) + " <span class='badge" + (submitted ? "" : " wait") + "'>" + (submitted ? "&#10003; ingediend" : "wacht") + "</span>"));
      rd.questions.forEach(function (q, qi) {
        var row = el("div", "qrow");
        var given = submitted ? (submitted[qi] || "\u2014") : "\u2014";
        row.appendChild(el("span", null, (qi + 1) + ". " + esc(given) + " <b>[" + esc(rd.answers[qi]) + "]</b>"));
        var btns = el("span");
        var okB = el("button", "ok" + (t.marks[ri] && t.marks[ri][qi] === true ? " on" : ""), "&#10003;");
        okB.onclick = function () { api("/api/admin/score", { pin: pin, teamId: t.id, round: ri, q: qi, ok: true }).then(refreshAndRender); };
        var noB = el("button", "no" + (t.marks[ri] && t.marks[ri][qi] === false ? " on" : ""), "&#10005;");
        noB.onclick = function () { api("/api/admin/score", { pin: pin, teamId: t.id, round: ri, q: qi, ok: false }).then(refreshAndRender); };
        btns.appendChild(okB); btns.appendChild(noB);
        row.appendChild(btns);
        d.appendChild(row);
      });
      card.appendChild(d);
    });
    app.appendChild(card);
  });
}

function refreshAndRender() { return refreshState().then(render); }

// ---------- Live updates (polling) ----------

var lastPlayKey = "";
var lastLiveKey = "";
setInterval(function () {
  refreshState().then(function () {
    if (view === "play" && !pinFormOpen) {
      var key = s.status + "|" + (s.round ? s.round.index : "-") + "|" + (s.finalScores ? s.finalScores.length : 0);
      if (key !== lastPlayKey) { lastPlayKey = key; render(); }
    } else if (view === "admin-live" && !pinFormOpen) {
      var lk = s.status + "|" + s.activeRound + "|" + s.rounds.length + "|" + JSON.stringify(s.teams);
      if (lk !== lastLiveKey) { lastLiveKey = lk; render(); }
    }
  });
}, 2500);

// opslag van mijn antwoorden per ronde bijhouden
refreshState().then(function () {
  var saved = sessionStorage.getItem("answers");
  if (saved) { try { myAnswers = JSON.parse(saved); } catch (e) {} }
  setInterval(function () { sessionStorage.setItem("answers", JSON.stringify(myAnswers)); }, 1500);
  render();
});
</script>
</body>
</html>`;

// ---------- HTTP server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));

  if (url.pathname.startsWith("/api/")) {
    try {
      await handleApi(req, res, url);
    } catch (e) {
      json(res, 500, { error: "Serverfout: " + e.message });
    }
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(CLIENT_HTML);
});

loadState();
server.listen(PORT, () => {
  console.log("🍺 Pubquiz app draait op http://localhost:" + PORT);
  console.log("   Spelers en quizmaster openen dezelfde link.");
});
