#!/usr/bin/env node
// Simulation helper — acts as one logged-in user against the DISPOSABLE test
// server only, calling the same HTTP routes the screens call. Every call is
// appended to logs/timeline.jsonl with who, when, what and the answer.
//
//   node sim.mjs login  <email> <password>
//   node sim.mjs call   <email> <METHOD> <path> [json | @file.json] [--idem KEY] [--times N] [--parallel] [--tag TEXT] [--full]
//   node sim.mjs batch  <email> <file.json>          file: [{method,path,body,idem,tag}]
//   node sim.mjs whoami <email>
//
// --times N --parallel sends the same request N times at once (double tap /
// two devices). --idem sets the Idempotency-Key header (and is NOT put in the
// body). Output: one line per response: STATUS + compact JSON (truncated
// unless --full).
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.resolve(HERE, "..");
const BASE = process.env.SIM_BASE_URL || "http://localhost:3100";
if (!/^http:\/\/(localhost|127\.0\.0\.1):3100$/.test(BASE)) {
  console.error("Refusing: the simulation only talks to the disposable test server on localhost:3100");
  process.exit(2);
}
const JARS = path.join(RUN, "tools", ".jars");
const TIMELINE = path.join(RUN, "logs", "timeline.jsonl");
mkdirSync(JARS, { recursive: true });
mkdirSync(path.dirname(TIMELINE), { recursive: true });

const jarFile = (email) => path.join(JARS, `${email.replace(/[^a-z0-9@._-]/gi, "_")}.cookie`);
const actorLabel = process.env.SIM_ACTOR || "";
const scene = process.env.SIM_SCENE || "";

function log(entry) {
  appendFileSync(TIMELINE, JSON.stringify({ at: new Date().toISOString(), scene, actor: actorLabel, ...entry }) + "\n");
}

function summarize(text, full) {
  let out = text;
  try { out = JSON.stringify(JSON.parse(text)); } catch { /* not JSON */ }
  if (!full && out.length > 1500) out = out.slice(0, 1500) + `…(+${out.length - 1500} chars)`;
  return out;
}

async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  const text = await r.text();
  const cookies = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);
  if (r.ok && cookies.length) writeFileSync(jarFile(email), cookies.join("; "));
  log({ email, method: "POST", path: "/api/auth/login", status: r.status });
  console.log(r.status, r.ok ? "logged in" : summarize(text));
  return r.ok;
}

async function call(email, method, p, body, opts = {}) {
  if (!existsSync(jarFile(email))) { console.error(`not logged in: ${email}`); process.exit(3); }
  const headers = { Cookie: readFileSync(jarFile(email), "utf8"), Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idem) headers["Idempotency-Key"] = opts.idem;
  const once = async () => {
    const started = Date.now();
    let r, text;
    try {
      r = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      text = await r.text();
    } catch (e) {
      log({ email, method, path: p, body, idem: opts.idem, tag: opts.tag, status: "NETWORK_ERROR", error: String(e) });
      return { status: "NETWORK_ERROR", text: String(e) };
    }
    const ct = r.headers.get("content-type") || "";
    const shown = ct.includes("json") ? summarize(text, opts.full) : `[${ct || "no content-type"}; ${text.length} bytes]`;
    log({ email, method, path: p, body, idem: opts.idem, tag: opts.tag, status: r.status, ms: Date.now() - started, response: summarize(text, false) });
    return { status: r.status, text: shown };
  };
  const n = Math.max(1, opts.times || 1);
  const results = opts.parallel ? await Promise.all(Array.from({ length: n }, once)) : [];
  if (!opts.parallel) for (let i = 0; i < n; i++) results.push(await once());
  for (const res of results) console.log(res.status, res.text);
}

function parseBody(arg) {
  if (arg === undefined) return undefined;
  if (arg.startsWith("@")) return JSON.parse(readFileSync(arg.slice(1), "utf8"));
  return JSON.parse(arg);
}

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === "--idem") flags.idem = rest[++i];
  else if (a === "--times") flags.times = Number(rest[++i]);
  else if (a === "--parallel") flags.parallel = true;
  else if (a === "--tag") flags.tag = rest[++i];
  else if (a === "--full") flags.full = true;
  else pos.push(a);
}

if (cmd === "login") await login(pos[0], pos[1]);
else if (cmd === "call") await call(pos[0], pos[1].toUpperCase(), pos[2], parseBody(pos[3]), flags);
else if (cmd === "whoami") await call(pos[0], "GET", "/api/auth/me", undefined, flags);
else if (cmd === "batch") {
  const steps = JSON.parse(readFileSync(pos[1], "utf8"));
  for (const s of steps) {
    process.stdout.write(`${s.tag ?? ""} ${s.method} ${s.path} → `);
    await call(pos[0], s.method.toUpperCase(), s.path, s.body, { idem: s.idem, tag: s.tag, full: flags.full });
  }
} else {
  console.error("usage: login | call | batch | whoami");
  process.exit(1);
}
