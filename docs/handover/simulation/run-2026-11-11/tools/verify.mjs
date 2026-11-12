import { api } from "./api.mjs";
const O = "owner@demo.com";
const pairs = [["cmwc33r6d002yhlngeip3rlir",null],["cmwc33r6x003ehlngvvzyqm9g",null],["cmwc33r6o0036hlng26cwienr",null],["cmwc33r4s0020hlngdofgvi0q","cmwc33r4s0021hlngqxpr5tte"],["cmwc33r4s0020hlngdofgvi0q","cmwc33r4s0022hlngglbjekgz"],["cmwc33r5l0029hlngzw7i0rng","cmwc33r5l002ahlngb5dqwdd6"],["cmwc33r5l0029hlngzw7i0rng","cmwc33r5l002bhlngg50pzf6x"],["cmwc33r5l0029hlngzw7i0rng","cmwc33r5l002chlngz5dk5i2c"]];
const lat = (await api(O, "GET", "/api/products?branchId=cmwc33qgt0012hlng6f0q8uz6")).json; const L = (lat.products ?? lat).find(p => p.name === "لاتيه");
for (const v of L.variants) pairs.push([L.id, v.id]);
for (const [pid, vid] of pairs) {
  const q = vid ? `?variantId=${vid}` : "";
  const g = await api(O, "GET", `/api/products/${pid}/recipe${q}`);
  const rid = g.json.recipe?.[0]?.recipeId;
  const v = await api(O, "POST", `/api/recipes/${rid}/verify`, {});
  const after = await api(O, "GET", `/api/products/${pid}/recipe${q}`);
  console.log(pid.slice(-6), vid?.slice(-6) ?? "-", "recipe", rid, "verify", v.status, JSON.stringify(v.json).slice(0, 120), "| cost", after.json.costStatus, after.json.cost, after.json.issues);
}
