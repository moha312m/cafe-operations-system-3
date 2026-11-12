export MSYS_NO_PATHCONV=1 SIM_ACTOR="كريم — كاشير المساء" SIM_SCENE="D1-PM-S2"; S="node C:/Dev/cafe-operations-system-3/docs/handover/simulation/run-2026-11-11/tools/sim.mjs"
echo '{"status":"SERVED"}' > served.json
$S call karim.pm@sim.test GET "/api/orders?branchId=cmwc33qgt0012hlng6f0q8uz6" --full | node -e 'let s=require("fs").readFileSync(0,"utf8");let o=JSON.parse(s.slice(s.indexOf("{")));for(const r of o.orders)if(r.type=="TAKEAWAY"&&r.orderNumber>=34&&r.status=="READY")console.log(r.id,r.orderNumber)' | while read id n; do echo "serve #$n"; $S call karim.pm@sim.test PATCH /api/orders/$id/status @served.json | head -c 200; echo; done
bash st.sh | grep -v DINE
