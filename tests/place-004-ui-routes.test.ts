import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as } from "./helpers/http";

let fx: CountCafe;
before(async () => { fx = await countCafe("PLACE004"); });
after(async () => { if (fx) await teardownTaggedCafe(fx.cafeId); await db.$disconnect(); });

async function routeBundle(email: string, html: string, route: "settings" | "handovers") {
  // Retrieve the scripts the rendered page actually advertises. Their names
  // and grouping differ between Turbopack, webpack and production builds.
  const chunks = [...new Set([...html.matchAll(/<script\b[^>]*src="([^"]*\/_next\/static\/chunks\/[^"]+\.js(?:\?[^"]*)?)"/g)]
    .map((match) => match[1].replaceAll("&amp;", "&")))];
  assert.ok(chunks.length > 0, `${route} client bundles should be reachable from the page`);
  const code = await Promise.all(chunks.map(async (chunk) => {
    const response = await as(email, chunk);
    assert.equal(response.status, 200, `${route} chunk ${chunk} must be retrievable`);
    assert.match(response.headers.get("content-type") ?? "", /(?:java|ecma)script/i, `${chunk} must return JavaScript`);
    return response.text;
  }));
  return code.join("\n");
}

test("owner settings and branch handover pages expose place configuration and incoming inspection", async () => {
  const settings = await as(fx.owner.email, "/settings");
  assert.equal(settings.status, 200, settings.text);
  const settingsCode = await routeBundle(fx.owner.email, settings.text, "settings");
  assert.match(settingsCode, /place-checklist-card/);

  const handovers = await as(fx.storekeeper.email, "/handovers");
  assert.equal(handovers.status, 200, handovers.text);
  const handoversCode = await routeBundle(fx.storekeeper.email, handovers.text, "handovers");
  assert.match(handoversCode, /place-receipt-panel/);

  const inspectors = await as<{ users: Array<{ id: string; name: string }> }>(fx.owner.email, "/api/users?branchId=" + fx.branchId + "&status=ACTIVE");
  assert.equal(inspectors.status, 200, inspectors.text);
  assert.ok(inspectors.body.users.some((employee) => employee.id === fx.storekeeper.id));
  const assets = await as(fx.owner.email, "/api/place-assets?branchId=" + fx.branchId);
  assert.equal(assets.status, 200, assets.text);
  const opening = await as(fx.owner.email, "/api/branches/" + fx.branchId + "/opening-settings");
  assert.equal(opening.status, 200, opening.text);
});
