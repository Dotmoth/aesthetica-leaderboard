// Aesthetica leaderboard server: `node server.js` (or `npm start`).
//
//   GET  /scores?level=<id>&limit=20&name=<player>  -> { scores: [...], you: {...}|null }
//   POST /scores  { level, name, token, time_ms }   -> { rank, best_ms, improved }
//   POST /sync    { name, token, times: {level: ms} } -> { results: {level: {rank, best_ms, improved}} }
//   GET  /rank?name=<player>                         -> { records, finished, players, continent, place, of, top_pct }
//   POST /account { action: "register", name, password, continent, token } -> { name, token, continent }
//   POST /account { action: "login", name, password }                      -> { name, token, continent }
//   POST /account { action: "continent", name, token, continent }          -> { name, token, continent }
//   POST /ghost   { level, name, token, time_ms, data } -> { ok }   (record holder only)
//   GET  /ghost?level=<id>                          -> { name, time_ms, data }
//   GET  /health                                    -> { ok: true }
//
// Each name is claimed by the first token that submits with it, so nobody else
// can overwrite your times. Only each player's best time per level is kept.
//
// Storage: with DATABASE_URL set (a Postgres database, e.g. a free Neon one)
// everything is kept there and survives restarts; without it, in a JSON file
// next to this script (or DATA_FILE). Hosts like Render wipe their disk on
// every restart, so online you want DATABASE_URL.

"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8787);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "scores.json");
// Level ids look like "plinths_v1" or "aero_lagoon_v1". Set LEVELS (comma-separated)
// to accept only an exact list instead.
const LEVEL_RE = /^[a-z0-9_]{3,40}$/;
const LEVEL_LIST = process.env.LEVELS ? new Set(process.env.LEVELS.split(",")) : null;
const validLevel = (id) => typeof id === "string" && (LEVEL_LIST ? LEVEL_LIST.has(id) : LEVEL_RE.test(id));
const MIN_MS = 500; // some levels really are done in under 3 s
const MAX_MS = 60 * 60 * 1000;
// Letters from any language (é, ç, ß...), digits, spaces and _ . - ; up to 16.
const NAME_RE = /^[\p{L}\p{N} _.-]{1,16}$/u;

let db = { players: {}, scores: {} }; // players: name -> token, scores: level -> { name: ms }
// The run behind each level's record, for players to race: level -> { name, time_ms, data }.
// Kept apart from the board: runs are much bigger than times.
let ghosts = {};
const GHOST_FILE = process.env.GHOST_FILE || path.join(__dirname, "ghosts.json");
const GHOST_MAX = 800 * 1024;

// Postgres: the whole board is one small JSON document in one row.
const DATABASE_URL = process.env.DATABASE_URL || "";
let pool = null;
async function load() {
  if (DATABASE_URL) {
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pool.query("CREATE TABLE IF NOT EXISTS board (id int PRIMARY KEY, data jsonb NOT NULL)");
    const r = await pool.query("SELECT data FROM board WHERE id = 1");
    if (r.rows.length) db = r.rows[0].data;
    await pool.query("CREATE TABLE IF NOT EXISTS ghosts (level text PRIMARY KEY, name text NOT NULL, time_ms int NOT NULL, data text NOT NULL)");
    return "postgres";
  }
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    /* first run */
  }
  try {
    ghosts = JSON.parse(fs.readFileSync(GHOST_FILE, "utf8"));
  } catch {
    /* none yet */
  }
  return DATA_FILE;
}

async function saveGhost(level, g) {
  if (pool) {
    await pool.query(
      "INSERT INTO ghosts (level, name, time_ms, data) VALUES ($1, $2, $3, $4) " +
        "ON CONFLICT (level) DO UPDATE SET name = EXCLUDED.name, time_ms = EXCLUDED.time_ms, data = EXCLUDED.data",
      [level, g.name, g.time_ms, g.data]
    );
    return;
  }
  ghosts[level] = g;
  fs.writeFileSync(GHOST_FILE, JSON.stringify(ghosts));
}

async function loadGhost(level) {
  if (pool) {
    const r = await pool.query("SELECT name, time_ms, data FROM ghosts WHERE level = $1", [level]);
    return r.rows[0] || null;
  }
  return ghosts[level] || null;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (pool) {
      try {
        await pool.query(
          "INSERT INTO board (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data",
          [JSON.stringify(db)]
        );
      } catch (e) {
        console.error("save failed:", e.message);
      }
      return;
    }
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
  }, 500);
}

// Crude rate limit: 60 writes per minute per player (by token: behind a host's
// proxy every request arrives from the same address, so addresses mean nothing).
const hits = new Map();
function limited(key) {
  const now = Date.now();
  const h = (hits.get(key) || []).filter((t) => now - t < 60000);
  h.push(now);
  hits.set(key, h);
  return h.length > 60;
}

// Accounts: name (any letter case is the same name) -> password hash, the
// player's token (what their times are filed under) and continent.
const CONTINENTS = ["AF", "AS", "EU", "NA", "SA", "OC"];
const accounts = () => (db.accounts ||= {});
const hashOf = (password, salt) => crypto.scryptSync(String(password), salt, 32).toString("hex");

// Another player's name that differs only in letter case ("" if none).
function caseTwin(name, token) {
  const low = name.toLowerCase();
  const acc = accounts()[low];
  if (acc && acc.token !== token) return acc.name;
  for (const [n, t] of Object.entries(db.players)) if (n !== name && t !== token && n.toLowerCase() === low) return n;
  return "";
}

// Checks a player's name and token; claims the name for the token if free.
// Returns an error message, or "" when fine.
function claim(name, token) {
  if (typeof name !== "string" || !NAME_RE.test(name)) return "Bad name";
  if (typeof token !== "string" || token.length < 16 || token.length > 64) return "Bad token";
  const owner = db.players[name];
  if (owner && owner !== token) return "That name is taken";
  if (caseTwin(name, token)) return "That name is taken";
  db.players[name] = token;
  return "";
}

// Where a player stands among the players of their continent (everyone, if
// they have none): the average of their placement on every level they have a
// time on (0 = first, 1 = last), compared with everyone else's average.
function standing(name) {
  const acc = accounts()[name.toLowerCase()];
  const cont = acc && acc.name === name ? acc.continent : "";
  const inCont = (n) => {
    if (!cont) return true;
    const a = accounts()[n.toLowerCase()];
    return !!a && a.name === n && a.continent === cont;
  };
  const sums = {};
  for (const level of Object.keys(db.scores)) {
    const list = ranked(level).filter((s) => inCont(s.name));
    const n = list.length;
    list.forEach((s, i) => {
      const e = (sums[s.name] ||= [0, 0]);
      e[0] += n > 1 ? i / (n - 1) : 0;
      e[1]++;
    });
  }
  const avgs = Object.entries(sums)
    .map(([n, [s, c]]) => ({ name: n, avg: s / c, count: c }))
    .sort((a, b) => a.avg - b.avg || b.count - a.count);
  const i = avgs.findIndex((x) => x.name === name);
  return {
    continent: cont,
    place: i + 1,
    of: avgs.length,
    top_pct: i < 0 ? null : i === 0 ? 1 : Math.max(1, Math.round(((i + 1) / avgs.length) * 100)),
  };
}

function account(req, res) {
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 4096) req.destroy();
  });
  req.on("end", () => {
    let p;
    try {
      p = JSON.parse(body);
    } catch {
      return send(res, 400, { error: "Bad JSON" });
    }
    const { action, name, password, token, continent } = p;
    if (typeof name !== "string" || !NAME_RE.test(name)) return send(res, 400, { error: "Bad name" });
    if (limited("acc:" + name.toLowerCase())) return send(res, 429, { error: "Slow down" });
    const low = name.toLowerCase();
    const acc = accounts()[low];
    const reply = (a) => send(res, 200, { name: a.name, token: a.token, continent: a.continent });
    if (action === "register") {
      if (typeof password !== "string" || password.length < 6 || password.length > 72)
        return send(res, 400, { error: "Password: 6 to 72 characters" });
      if (!CONTINENTS.includes(continent)) return send(res, 400, { error: "Pick a continent" });
      if (acc) return send(res, 403, { error: "That name is taken" });
      // Your current name (and its times) become the account, if they are yours.
      const err = claim(name, token);
      if (err) return send(res, err === "That name is taken" ? 403 : 400, { error: err });
      const salt = crypto.randomBytes(16).toString("hex");
      accounts()[low] = { name, salt, hash: hashOf(password, salt), token, continent };
      save();
      return reply(accounts()[low]);
    }
    if (action === "login") {
      const ok =
        acc && typeof password === "string" &&
        crypto.timingSafeEqual(Buffer.from(hashOf(password, acc.salt), "hex"), Buffer.from(acc.hash, "hex"));
      if (!ok) return send(res, 403, { error: "Wrong name or password" });
      return reply(acc);
    }
    if (action === "continent") {
      if (!acc || acc.token !== token) return send(res, 403, { error: "Not your account" });
      if (!CONTINENTS.includes(continent)) return send(res, 400, { error: "Pick a continent" });
      acc.continent = continent;
      save();
      return reply(acc);
    }
    return send(res, 400, { error: "Unknown action" });
  });
}

// Records one time; returns { rank, best_ms, improved }.
function record(level, name, ms) {
  const board = (db.scores[level] ||= {});
  const prev = board[name];
  const improved = prev === undefined || ms < prev;
  if (improved) board[name] = ms;
  return { rank: ranked(level).find((x) => x.name === name).rank, best_ms: board[name], improved };
}

function ranked(level) {
  const board = db.scores[level] || {};
  return Object.entries(board)
    .map(([name, time_ms]) => ({ name, time_ms }))
    .sort((a, b) => a.time_ms - b.time_ms || a.name.localeCompare(b.name))
    .map((s, i) => ({ ...s, rank: i + 1 }));
}

function send(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") return send(res, 204, {});
  // storage: "postgres" (kept for good) or "file" (lost when a free host restarts).
  if (url.pathname === "/health") return send(res, 200, { ok: true, storage: pool ? "postgres" : "file" });
  if (url.pathname === "/rank" && req.method === "GET") {
    // Records: levels where this name holds the best time. Finished: levels with any time.
    const name = url.searchParams.get("name") || "";
    let records = 0;
    let finished = 0;
    for (const level of Object.keys(db.scores)) {
      const board = db.scores[level];
      if (!(name in board)) continue;
      finished++;
      if (ranked(level)[0].name === name) records++;
    }
    return send(res, 200, { records, finished, players: Object.keys(db.players).length, ...standing(name) });
  }
  if (url.pathname === "/ghost") return ghost(req, res, url);
  if (url.pathname === "/sync" && req.method === "POST") return sync(req, res);
  if (url.pathname === "/account" && req.method === "POST") return account(req, res);
  if (url.pathname !== "/scores") return send(res, 404, { error: "Not found" });

  if (req.method === "GET") {
    const level = url.searchParams.get("level") || "";
    if (!validLevel(level)) return send(res, 400, { error: "Unknown level" });
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
    const all = ranked(level);
    const name = url.searchParams.get("name");
    const you = all.find((s) => s.name === name) || null;
    return send(res, 200, { scores: all.slice(0, limit), you, total: all.length });
  }

  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 4096) req.destroy();
    });
    req.on("end", () => {
      let p;
      try {
        p = JSON.parse(body);
      } catch {
        return send(res, 400, { error: "Bad JSON" });
      }
      const { level, name, token } = p;
      const ms = Math.round(Number(p.time_ms));
      if (!validLevel(level)) return send(res, 400, { error: "Unknown level" });
      if (!Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) return send(res, 400, { error: "Bad time" });
      if (limited(String(token))) return send(res, 429, { error: "Slow down" });
      const err = claim(name, token);
      if (err) return send(res, err === "That name is taken" ? 403 : 400, { error: err });
      const r = record(level, name, ms);
      if (r.improved) save();
      return send(res, 200, r);
    });
    return;
  }
  send(res, 405, { error: "Method not allowed" });
});

// Every best time of one player in one request (the game sends them all at
// startup, so the board gets back anything it lost). Counts as one write.
function sync(req, res) {
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 64 * 1024) req.destroy();
  });
  req.on("end", () => {
    let p;
    try {
      p = JSON.parse(body);
    } catch {
      return send(res, 400, { error: "Bad JSON" });
    }
    const { name, token, times } = p;
    if (typeof times !== "object" || times === null) return send(res, 400, { error: "Bad times" });
    if (limited(String(token))) return send(res, 429, { error: "Slow down" });
    const err = claim(name, token);
    if (err) return send(res, err === "That name is taken" ? 403 : 400, { error: err });
    const results = {};
    let changed = false;
    for (const [level, t] of Object.entries(times).slice(0, 500)) {
      const ms = Math.round(Number(t));
      if (!validLevel(level) || !Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) continue;
      results[level] = record(level, name, ms);
      changed ||= results[level].improved;
    }
    if (changed) save();
    send(res, 200, { results });
  });
}

// The record ghost: anyone can fetch it; only the current record holder, with
// their token and exactly their record time, can replace it.
function ghost(req, res, url) {
  if (req.method === "GET") {
    const level = url.searchParams.get("level") || "";
    if (!validLevel(level)) return send(res, 400, { error: "Unknown level" });
    loadGhost(level)
      .then((g) => (g ? send(res, 200, g) : send(res, 404, { error: "No ghost yet" })))
      .catch(() => send(res, 500, { error: "Could not load the ghost" }));
    return;
  }
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > GHOST_MAX) req.destroy();
  });
  req.on("end", () => {
    let p;
    try {
      p = JSON.parse(body);
    } catch {
      return send(res, 400, { error: "Bad JSON" });
    }
    const { level, name, token, data } = p;
    const ms = Math.round(Number(p.time_ms));
    if (!validLevel(level)) return send(res, 400, { error: "Unknown level" });
    if (typeof data !== "string" || data.length < 16 || !/^[A-Za-z0-9+/=]+$/.test(data))
      return send(res, 400, { error: "Bad ghost" });
    if (db.players[name] !== token) return send(res, 403, { error: "Not your name" });
    const top = ranked(level)[0];
    if (!top || top.name !== name || top.time_ms !== ms) return send(res, 403, { error: "Only the record holder's run" });
    if (limited(String(token))) return send(res, 429, { error: "Slow down" });
    saveGhost(level, { name, time_ms: ms, data })
      .then(() => send(res, 200, { ok: true }))
      .catch(() => send(res, 500, { error: "Could not save the ghost" }));
  });
}

load()
  .then((where) => server.listen(PORT, () => console.log(`Aesthetica leaderboard on :${PORT} (${where})`)))
  .catch((e) => {
    console.error("could not load the board:", e.message);
    process.exit(1);
  });
