import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as } from "./helpers/http";

let fx: CountCafe;
before(async () => { fx = await countCafe("PLACE004"); });
after(async () => { if (fx) await teardownTaggedCafe(fx.cafeId); await db.$disconnect(); });

async function routeBundle(email: string, html: string, route: "settings" | "handovers") {
  // Next 16 dev server emits page chunks by path, e.g.
  // /_next/static/chunks/app/(app)/settings/page.js — not the legacy
  // flattened webpack name (src_app_(app)_settings_page_tsx_<hash>.js).
  const routeChunk = html.match(new RegExp(`src="([^"]*chunks/app/\\(app\\)/${route}/page(?:-[^/"?]+)?\\.js[^"]*)"`));
  assert.ok(routeChunk, `${route} client bundle should be reachable from the page`);
  const routeCode = await as(email, routeChunk[1]);
  const dependencies = [...routeCode.text.matchAll(/"static\/chunks\/([^"]+\.js)"/g)]
    .map((match) => `/_next/static/chunks/${match[1]}`);
  const dependencyCode = await Promise.all(dependencies.map((path) => as(email, path)));
  return [routeCode.text, ...dependencyCode.map((result) => result.text)].join("\n");
}

test("owner settings and branch handover pages expose place configuration and incoming inspection", async () => {
  const settings = await as(fx.owner.email, "/settings");
  assert.equal(settings.status, 200, settings.text);
  const settingsCode = await routeBundle(fx.owner.email, settings.text, "settings");
  assert.match(settingsCode, /\u0641\u062d\u0635 \u0627\u0644\u0645\u0643\u0627\u0646 \u0648\u0627\u0644\u0623\u062c\u0647\u0632\u0629 \u0639\u0646\u062f \u0627\u0633\u062a\u0644\u0627\u0645 \u0627\u0644\u0634\u064a\u0641\u062a/);

  const handovers = await as(fx.storekeeper.email, "/handovers");
  assert.equal(handovers.status, 200, handovers.text);
  const handoversCode = await routeBundle(fx.storekeeper.email, handovers.text, "handovers");
  assert.match(handoversCode, /\u0627\u0633\u062a\u0644\u0627\u0645 \u0627\u0644\u0645\u0643\u0627\u0646 \u0648\u0627\u0644\u0623\u062c\u0647\u0632\u0629/);

  const inspectors = await as<{ users: Array<{ id: string; name: string }> }>(fx.owner.email, "/api/users?branchId=" + fx.branchId + "&status=ACTIVE");
  assert.equal(inspectors.status, 200, inspectors.text);
  assert.ok(inspectors.body.users.some((employee) => employee.id === fx.storekeeper.id));
  const assets = await as(fx.owner.email, "/api/place-assets?branchId=" + fx.branchId);
  assert.equal(assets.status, 200, assets.text);
  const opening = await as(fx.owner.email, "/api/branches/" + fx.branchId + "/opening-settings");
  assert.equal(opening.status, 200, opening.text);
});
