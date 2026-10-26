// Aesthetica leaderboard server: `node server.js` (or `npm start`).
//
//   GET  /scores?level=<id>&limit=20&name=<player>  -> { scores: [...], you: {...}|null }
//   POST /scores  { level, name, token, time_ms }   -> { rank, best_ms, improved }
//   GET  /rank?name=<player>                         -> { records, finished, players }
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

// Crude rate limit: 30 writes per minute per IP.
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const h = (hits.get(ip) || []).filter((t) => now - t < 60000);
  h.push(now);
  hits.set(ip, h);
  return h.length > 30;
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
    return send(res, 200, { records, finished, players: Object.keys(db.players).length });
  }
  if (url.pathname === "/ghost") return ghost(req, res, url);
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
      if (typeof name !== "string" || !NAME_RE.test(name)) return send(res, 400, { error: "Bad name" });
      if (typeof token !== "string" || token.length < 16 || token.length > 64)
        return send(res, 400, { error: "Bad token" });
      if (!Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) return send(res, 400, { error: "Bad time" });
      if (limited(req.socket.remoteAddress)) return send(res, 429, { error: "Slow down" });

      const owner = db.players[name];
      if (owner && owner !== token) return send(res, 403, { error: "That name is taken" });
      db.players[name] = token;

      const board = (db.scores[level] ||= {});
      const prev = board[name];
      const improved = prev === undefined || ms < prev;
      if (improved) {
        board[name] = ms;
        save();
      }
      const rank = ranked(level).find((s) => s.name === name).rank;
      return send(res, 200, { rank, best_ms: board[name], improved });
    });
    return;
  }
  send(res, 405, { error: "Method not allowed" });
});

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
    if (limited(req.socket.remoteAddress)) return send(res, 429, { error: "Slow down" });
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
