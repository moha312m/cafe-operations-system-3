// Worktree-local dependency overlay so `prisma generate` can run officially here without touching the
// shared client of the main checkout (and without needing its engine DLL to be unlocked).
//
//   node artifacts/erp-experience-20261102/step4b2/local-node-modules.mjs          # create overlay
//   node artifacts/erp-experience-20261102/step4b2/local-node-modules.mjs --restore # relink the shared directory
//
// node_modules here is normally a junction to C:\Dev\cafe-operations-system-3\node_modules. The overlay is a
// real directory holding junctions to every shared package EXCEPT @prisma/client, which is copied, so the
// generated client (.prisma/client) is resolved from this worktree only. Nothing in the shared tree is edited.
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const link = path.join(root, "node_modules");
const shared = "C:\\Dev\\cafe-operations-system-3\\node_modules";
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const stat = fs.lstatSync(link);
const isJunction = stat.isSymbolicLink() || (stat.isDirectory() && fs.existsSync(link) && same(fs.realpathSync(link), shared));

if (process.argv.includes("--restore")) {
  if (isJunction) { console.log("already linked to the shared directory"); process.exit(0); }
  fs.rmSync(link, { recursive: true, force: false, maxRetries: 3 }); // junction children are links; targets stay untouched
  fs.symlinkSync(shared, link, "junction");
  console.log("restored junction ->", shared);
  process.exit(0);
}
if (!isJunction) { console.log("node_modules is already a local directory; nothing to do"); process.exit(0); }
if (!same(fs.realpathSync(link), shared)) throw new Error("unexpected node_modules target: " + fs.realpathSync(link));

fs.rmdirSync(link); // removes the junction itself only
fs.mkdirSync(link);
let junctions = 0, copied = 0;
for (const entry of fs.readdirSync(shared, { withFileTypes: true })) {
  const from = path.join(shared, entry.name), to = path.join(link, entry.name);
  if (entry.name === ".prisma") continue; // generated here
  if (entry.name === "@prisma") {
    fs.mkdirSync(to);
    for (const sub of fs.readdirSync(from, { withFileTypes: true })) {
      const f = path.join(from, sub.name), t = path.join(to, sub.name);
      if (sub.name === "client") { fs.cpSync(f, t, { recursive: true }); copied++; } else { fs.symlinkSync(f, t, "junction"); junctions++; }
    }
    continue;
  }
  if (entry.isDirectory()) { fs.symlinkSync(from, to, "junction"); junctions++; } else { fs.copyFileSync(from, to); copied++; }
}
console.log(JSON.stringify({ created: link, junctions, copied, sharedUntouched: shared }));
