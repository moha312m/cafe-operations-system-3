export MSYS_NO_PATHCONV=1 SIM_ACTOR="مازن" SIM_SCENE="D1-AM-S2b"; S="node C:/Dev/cafe-operations-system-3/docs/handover/simulation/run-2026-11-11/tools/sim.mjs"; BR=cmwc33qgt0012hlng6f0q8uz6
$S call mazen.bar@sim.test GET "/api/orders?branchId=$BR" --full | grep -v '^\[' | node sum.js
