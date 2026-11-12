import { api } from "./api.mjs";
const O = "owner@demo.com", B = "cmwc33qgt0012hlng6f0q8uz6";
const I = { cups: "cmwc33rg900b3hlnguu01chxu", lids: "cmwc33rgd00b7hlngcx9ixlhp", beans: "cmwc33rfe00avhlng60csy64h", milk: "cmwc33rg400azhlngah6f6bl8", tea: "cmwc33rgp00bjhlngxs7rh5rm" };
for (const [k, body] of Object.entries({
  croissant: { name: "كرواسون (قطعة)", branchId: B, unit: "PIECE", currentStock: 30, minimumStock: 5, costPerUnit: 20, category: "مخبوزات" },
  orange: { name: "برتقال", branchId: B, unit: "KG", currentStock: 10, minimumStock: 2, costPerUnit: 30, category: "فاكهة" },
})) { const r = await api(O, "POST", "/api/inventory", body); I[k] = r.json.item?.id ?? r.json.id; console.log("item", k, r.status, I[k] ?? JSON.stringify(r.json).slice(0,200)); }
const P = { esp: "cmwc33r4s0020hlngdofgvi0q", cap: "cmwc33r5l0029hlngzw7i0rng", lat: "cmwc33r5q002ehlng1n5wov7l", tea: "cmwc33r6d002yhlngeip3rlir", cro: "cmwc33r6x003ehlngvvzyqm9g", oj: "cmwc33r6o0036hlng26cwienr" };
const V = { espS: "cmwc33r4s0021hlngqxpr5tte", espD: "cmwc33r4s0022hlngglbjekgz", capS: "cmwc33r5l002ahlngb5dqwdd6", capM: "cmwc33r5l002bhlngg50pzf6x", capL: "cmwc33r5l002chlngz5dk5i2c" };
const prods = (await api(O, "GET", `/api/products?branchId=${B}`)).json; const list = prods.products ?? prods;
const lat = list.find(p => p.id === P.lat); const latV = Object.fromEntries((lat.variants||[]).map(v => [v.name, v.id]));
const line = (id, q, unit) => ({ inventoryItemId: id, quantity: q, unit, wastePercentage: 0 });
const cup = [line(I.cups, 1, "PIECE"), line(I.lids, 1, "PIECE")];
const plan = [
  [P.tea, null, [line(I.tea, 0.02, "BOX"), line(I.cups, 1, "PIECE")]],
  [P.cro, null, [line(I.croissant, 1, "PIECE")]],
  [P.oj, null, [line(I.orange, 0.4, "KG"), ...cup]],
  [P.esp, V.espS, [line(I.beans, 0.009, "KG"), line(I.cups, 1, "PIECE")]],
  [P.esp, V.espD, [line(I.beans, 0.018, "KG"), line(I.cups, 1, "PIECE")]],
  [P.cap, V.capS, [line(I.beans, 0.009, "KG"), line(I.milk, 0.12, "LITER"), ...cup]],
  [P.cap, V.capM, [line(I.beans, 0.018, "KG"), line(I.milk, 0.18, "LITER"), ...cup]],
  [P.cap, V.capL, [line(I.beans, 0.018, "KG"), line(I.milk, 0.24, "LITER"), ...cup]],
  [P.lat, latV["صغير"], [line(I.beans, 0.009, "KG"), line(I.milk, 0.15, "LITER"), ...cup]],
  [P.lat, latV["وسط"], [line(I.beans, 0.018, "KG"), line(I.milk, 0.22, "LITER"), ...cup]],
  [P.lat, latV["كبير"], [line(I.beans, 0.018, "KG"), line(I.milk, 0.3, "LITER"), ...cup]],
];
for (const [pid, vid, items] of plan) {
  const q = vid ? `?variantId=${vid}` : "";
  const put = await api(O, "PUT", `/api/products/${pid}/recipe${q}`, { items });
  const ver = await api(O, "POST", `/api/recipes/${pid}/verify${q}`, {});
  console.log("recipe", pid.slice(-6), vid?.slice(-6) ?? "-", put.status, ver.status, ver.status >= 300 ? JSON.stringify(ver.json).slice(0, 200) : "");
}
console.log(JSON.stringify(I));
