import { api } from "./api.mjs";
import { writeFileSync } from "node:fs";
const B = "cmwc33qgt0012hlng6f0q8uz6";
const r = await api("owner@demo.com", "GET", `/api/products?branchId=${B}`);
const list = (r.json.products ?? r.json).map(p => ({ id: p.id, name: p.name, price: p.price ?? p.basePrice, variants: (p.variants || []).map(v => ({ id: v.id, name: v.name, price: v.price })) }));
writeFileSync(new URL("./products.json", import.meta.url), JSON.stringify(list, null, 1));
console.log(JSON.stringify(list).slice(0, 1800));
