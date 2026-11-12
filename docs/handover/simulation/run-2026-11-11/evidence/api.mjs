// Shared programmatic client for setup/inspection scripts (same cookie jars
// and timeline as sim.mjs). Test server on localhost:3100 only.
import { readFileSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RUN = path.resolve(HERE, "..");
export const BASE = "http://localhost:3100";
const JARS = path.join(RUN, "tools", ".jars");
const TIMELINE = path.join(RUN, "logs", "timeline.jsonl");
const jar = (email) => path.join(JARS, `${email.replace(/[^a-z0-9@._-]/gi, "_")}.cookie`);

export async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const cookies = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);
  if (r.ok && cookies.length) writeFileSync(jar(email), cookies.join("; "));
  appendFileSync(TIMELINE, JSON.stringify({ at: new Date().toISOString(), scene: process.env.SIM_SCENE || "", actor: process.env.SIM_ACTOR || "", email, method: "POST", path: "/api/auth/login", status: r.status }) + "\n");
  return r.status;
}

export async function api(email, method, p, body, idem) {
  if (!existsSync(jar(email))) throw new Error(`not logged in: ${email}`);
  const headers = { Cookie: readFileSync(jar(email), "utf8"), Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idem) headers["Idempotency-Key"] = idem;
  const r = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  appendFileSync(TIMELINE, JSON.stringify({ at: new Date().toISOString(), scene: process.env.SIM_SCENE || "", actor: process.env.SIM_ACTOR || "", email, method, path: p, body, idem, status: r.status, response: text.slice(0, 1500) }) + "\n");
  return { status: r.status, json };
}
