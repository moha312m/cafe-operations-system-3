import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  structuredBlockers, explainBlocker, explainBlockers, configGuidance, countAction, handoverPhaseLabel, shiftPhase, SHIFT_PHASE_LABEL,
  saveCloseDraft, loadCloseDraft, clearCloseDraft, closeDraftKey, saveCloseOutcome, loadCloseOutcome, clearCloseOutcome, closeOutcomeKey,
  parseReadiness, readinessView, createReadinessLoader, READINESS_UNCHECKED, NO_ACCESS,
  settingsHref, countsHref, handoverHref,
  type CloseDraft, type DraftScope, type GuidanceAccess, type GuidanceContext, type ReadinessState, type StorageLike, type StorageScope,
} from "../src/lib/close-guidance";

const ctx = (access: Partial<GuidanceAccess> = {}, records: GuidanceContext["records"] = null): GuidanceContext => ({ branchId: "br1", access: { ...NO_ACCESS, ...access }, records });
const owner = ctx({ settingsConfig: true, orders: true, approvals: true, purchases: true, counts: true, approveCorrections: true, handovers: true });
const cashier = ctx({ orders: true });
const cfgBlocker = { code: "HANDOVER_CONFIG_ERROR", count: 1, messageAr: "x", ids: ["SELECTED_WITH_NO_ITEMS"] };
const memory = (): StorageLike & { map: Map<string, string> } => { const map = new Map<string, string>(); return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) }; };
const draft = (over: Partial<CloseDraft> = {}): CloseDraft => ({ actualCash: "", notes: "", varianceReason: "", actualCard: "", cardReason: "", actualWallet: "", walletReason: "", handoverTarget: "", leftInDrawer: "", toTreasury: "", ...over });
const readiness = (over: Record<string, unknown> = {}) => ({ readiness: { checkedAt: "2026-10-27T10:00:00.000Z", enabled: true, mode: "SELECTED", configError: null, carryOpenOrders: false, blockers: [], requiredItems: [], records: { countSessions: [] }, ...over } });
const blk = (code: string, count: number, ids: string[], refs?: string[]) => ({ code, count, ids, messageAr: "m", ...(refs ? { refs } : {}) });

// ── explanations ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("SELECTED_WITH_NO_ITEMS is its own specific cause, distinct from outstanding records", () => {
  const [item] = explainBlocker(cfgBlocker, owner);
  assert.equal(item.code, "SELECTED_WITH_NO_ITEMS");
  assert.match(item.cause, /أصناف محددة/);
  assert.match(item.cause, /لم يُختر أي صنف/);
  assert.match(item.role, /المالك/);
  const orders = explainBlocker({ code: "UNSERVED_ORDERS", count: 2, messageAr: "x", ids: ["a", "b"], refs: ["#1", "#2"] }, owner)[0];
  assert.notEqual(orders.code, item.code);
  assert.deepEqual(orders.refs, ["#1", "#2"]);
});

test("a cashier without the permission gets no settings action, a plain explanation and no claim that anybody was notified", () => {
  const [item] = explainBlocker(cfgBlocker, cashier);
  assert.deepEqual(item.actions, []);
  assert.match(item.note ?? "", /اطلب من المالك/);
  assert.match(item.note ?? "", /لا يوجد إشعار تلقائي/);
  for (const text of [item.note ?? "", item.cause, item.role]) assert.doesNotMatch(text, /تم إرسال|اتبعت|أُرسل|تم إبلاغ/);
});

test("the settings action carries the originating branch and the panel anchor, and needs the configure grant AND the settings page", () => {
  const [item] = explainBlocker(cfgBlocker, owner);
  assert.deepEqual(item.actions, [{ label: "اختيار أصناف الجرد", href: "/settings?branchId=br1#handover-config" }]);
  assert.equal(item.note, undefined);
  assert.equal(settingsHref("a b/c"), "/settings?branchId=a%20b%2Fc#handover-config"); // branch id is encoded, never spliced raw
  assert.deepEqual(explainBlocker(cfgBlocker, ctx({ settingsConfig: false }))[0].actions, []); // e.g. configure grant without the settings page
});

test("config readiness from the read-only handover-config GET: CYCLE is not a blocker, SELECTED_WITH_NO_ITEMS and WEEKLY are", () => {
  assert.deepEqual(configGuidance(null, owner), []);
  assert.deepEqual(configGuidance({ code: "CYCLE_POLICY_UNSUPPORTED" }, owner), []);
  assert.deepEqual(configGuidance({ code: "SELECTED_WITH_NO_ITEMS" }, cashier)[0].actions, []);
  assert.match(configGuidance({ code: "WEEKLY_WITHOUT_WEEKDAY" }, owner)[0].cause, /يوم/);
  assert.equal(configGuidance({ code: "SOMETHING_NEW" }, owner)[0].code, "SOMETHING_NEW"); // unknown codes are named, not hidden
});

test("no destination is offered without the grant for THAT destination (fail-closed default), and every denied account is told who can act", () => {
  const cases: [string, keyof GuidanceAccess][] = [
    ["UNSERVED_ORDERS", "orders"], ["DRAFT_PURCHASE_INVOICES", "purchases"], ["PENDING_CORRECTIONS", "counts"], ["FOREIGN_ACTIVE_COUNT", "counts"], ["EXISTING_ACTIVE_HANDOVER", "handovers"],
  ];
  for (const [code, grant] of cases) {
    const denied = explainBlocker(blk(code, 1, ["rec-1"]), ctx())[0];
    assert.deepEqual(denied.actions, [], `${code} must not link anywhere without ${grant}`);
    assert.ok((denied.note ?? "").length > 10 && denied.role.length > 3, `${code} must say who can act`);
    const allowed = explainBlocker(blk(code, 1, ["rec-1"]), ctx({ [grant]: true }))[0];
    assert.ok(allowed.actions.length >= 1 && allowed.actions.every((a) => a.href.startsWith("/")), `${code} offers an action with ${grant}`);
    // a grant for some OTHER destination does not unlock this one
    const other = (Object.keys(NO_ACCESS) as (keyof GuidanceAccess)[]).filter((k) => k !== grant && k !== "approveCorrections");
    for (const k of other) if (!(code === "PENDING_CORRECTIONS" || code === "FOREIGN_ACTIVE_COUNT") || k !== "counts") assert.deepEqual(explainBlocker(blk(code, 1, ["rec-1"]), ctx({ [k]: true }))[0].actions, [], `${code} wrongly unlocked by ${k}`);
  }
  // pending QR approvals: the approvals screen when it can be reached, the orders list as the fallback, nothing otherwise
  assert.equal(explainBlocker(blk("PENDING_APPROVAL_ORDERS", 1, ["o1"]), ctx({ approvals: true, orders: true }))[0].actions[0].href, "/approvals");
  assert.equal(explainBlocker(blk("PENDING_APPROVAL_ORDERS", 1, ["o1"]), ctx({ orders: true }))[0].actions[0].href, "/orders");
  const none = explainBlocker(blk("PENDING_APPROVAL_ORDERS", 1, ["o1"]), ctx())[0];
  assert.deepEqual(none.actions, []); assert.ok(none.note);
});

test("an active count opens its EXACT session; several sessions are listed one by one, never collapsed into a guess", () => {
  const records = { countSessions: [
    { id: "s1", status: "IN_PROGRESS", type: "FULL", pendingCorrections: 0 }, { id: "s2", status: "SUBMITTED", type: "CRITICAL", pendingCorrections: 0 },
  ] };
  const one = explainBlocker(blk("FOREIGN_ACTIVE_COUNT", 1, ["s1"]), ctx({ counts: true }, records))[0];
  assert.deepEqual(one.actions.map((a) => a.href), ["/stock-counts?branchId=br1&sessionId=s1"]);
  assert.match(one.actions[0].label, /جرد كامل/); assert.match(one.actions[0].label, /جاري العد/); // verified type/status, not a raw id
  const two = explainBlocker(blk("FOREIGN_ACTIVE_COUNT", 2, ["s1", "s2"]), ctx({ counts: true }, records))[0];
  assert.deepEqual(two.actions.map((a) => a.href), ["/stock-counts?branchId=br1&sessionId=s1", "/stock-counts?branchId=br1&sessionId=s2"]);
  assert.equal(new Set(two.actions.map((a) => a.label)).size, 2); // the person can tell them apart
  // more records than the server sampled: the listed ones are exact, the rest are reached through a list that SAYS it is a list
  const many = explainBlocker(blk("FOREIGN_ACTIVE_COUNT", 30, Array.from({ length: 20 }, (_, i) => `x${i}`)), ctx({ counts: true }))[0];
  assert.equal(many.actions.length, 6); // 5 exact + the labelled list link
  assert.deepEqual(many.actions[5], { label: "قائمة جرد الفرع (مش سجل بعينه)", href: "/stock-counts?branchId=br1" });
  assert.match(many.note ?? "", /المعروض 5 من 30/);
  assert.equal(countsHref("br1"), "/stock-counts?branchId=br1");
});

test("pending corrections open the count SESSION that owns them; a correction id is never used as a session id", () => {
  const records = { countSessions: [{ id: "sessA", status: "SUBMITTED", type: "FULL", pendingCorrections: 2 }, { id: "sessB", status: "CONFIRMED", type: "CRITICAL", pendingCorrections: 0 }] };
  const [item] = explainBlocker(blk("PENDING_CORRECTIONS", 2, ["corr-1", "corr-2"]), ctx({ counts: true, approveCorrections: true }, records));
  assert.deepEqual(item.actions.map((a) => a.href), ["/stock-counts?branchId=br1&sessionId=sessA"]); // only the session with pending corrections
  assert.doesNotMatch(JSON.stringify(item.actions), /corr-/);
  assert.match(item.actions[0].label, /2 تصحيح/);
  // without the server-verified mapping the account gets a list that is labelled as a list — not a pretend-exact link
  const unresolved = explainBlocker(blk("PENDING_CORRECTIONS", 2, ["corr-1", "corr-2"]), ctx({ counts: true, approveCorrections: true }, null))[0];
  assert.deepEqual(unresolved.actions, [{ label: "قائمة جرد الفرع (مش سجل بعينه)", href: "/stock-counts?branchId=br1" }]);
  assert.doesNotMatch(JSON.stringify(unresolved.actions), /corr-|sessionId/);
  assert.match(unresolved.note ?? "", /تعذّر تحديد/);
  // a viewer without the approval grant may look but is told approval is not theirs
  const viewer = explainBlocker(blk("PENDING_CORRECTIONS", 2, ["corr-1", "corr-2"]), ctx({ counts: true, approveCorrections: false }, records))[0];
  assert.equal(viewer.actions.length, 1); assert.match(viewer.note ?? "", /اعتماد التصحيح يحتاج صلاحية/);
});

test("handovers: each active handover opens exactly; none is offered without handover.view", () => {
  const [one] = explainBlocker(blk("EXISTING_ACTIVE_HANDOVER", 1, ["h-9"]), owner);
  assert.deepEqual(one.actions, [{ label: "فتح هذا التسليم", href: "/handovers?branchId=br1&handoverId=h-9" }]);
  const [two] = explainBlocker(blk("EXISTING_ACTIVE_HANDOVER", 2, ["h-1", "h-2"]), owner);
  assert.deepEqual(two.actions.map((a) => a.href), ["/handovers?branchId=br1&handoverId=h-1", "/handovers?branchId=br1&handoverId=h-2"]);
  assert.deepEqual(explainBlocker(blk("EXISTING_ACTIVE_HANDOVER", 1, ["h-9"]), cashier)[0].actions, []);
  assert.equal(handoverHref("br1"), "/handovers?branchId=br1");
});

test("structured blockers ignore plain strings and malformed entries instead of half-rendering them", () => {
  const list = structuredBlockers({ blockers: ["plain", { code: "X" }, cfgBlocker, { code: "A", messageAr: "m", count: 1, ids: [1] }] });
  assert.equal(list.length, 1);
  assert.deepEqual(structuredBlockers(null), []);
  assert.deepEqual(structuredBlockers({ blockers: "x" }), []);
  assert.equal(explainBlockers(list, owner).length, 1);
});

test("pending versus complete wording: AWAITING_HANDOVER is never described as closed", () => {
  assert.match(SHIFT_PHASE_LABEL.AWAITING_HANDOVER.label, /في انتظار التسليم/);
  assert.match(SHIFT_PHASE_LABEL.AWAITING_HANDOVER.detail, /لم يُقفل بالكامل/);
  assert.doesNotMatch(SHIFT_PHASE_LABEL.AWAITING_HANDOVER.label, /^مقفول/);
  assert.equal(SHIFT_PHASE_LABEL.OPEN.label, "مفتوح");
  assert.equal(SHIFT_PHASE_LABEL.CLOSED.label, "مقفول");
  assert.equal(shiftPhase("AWAITING_HANDOVER"), "AWAITING_HANDOVER");
  assert.equal(shiftPhase("weird"), null);
  for (const s of ["ACCEPTED", "COMPLETED"]) assert.equal(handoverPhaseLabel(s).complete, true);
  for (const s of ["DRAFT", "REJECTED", "OUTGOING_SUBMITTED", "INCOMING_REVIEW", "MANAGER_EXCEPTION", undefined]) assert.equal(handoverPhaseLabel(s).complete, false);
});

test("the count call to action names the real state and always points at the exact handover", () => {
  const exact = "/handovers?branchId=br1&handoverId=h1";
  assert.deepEqual(countAction("br1", "h1", { status: "DRAFT", count: null }, true), { label: "ابدأ الجرد", href: exact });
  assert.deepEqual(countAction("br1", "h1", { status: "DRAFT", count: { sessionId: "s1", status: "IN_PROGRESS" } }, true), { label: "استكمل الجرد", href: exact });
  assert.deepEqual(countAction("br1", "h1", { status: "REJECTED", count: { sessionId: "s1", status: "RECOUNT_REQUIRED" } }, true), { label: "استكمل الجرد", href: exact });
  assert.equal(countAction("br1", "h1", { status: "DRAFT", count: { sessionId: "s1", status: "CONFIRMED" } }, true)?.label, "راجع الجرد وقدّم التسليم");
  assert.equal(countAction("br1", "h1", { status: "DRAFT", count: null }, false)?.label, "متابعة التسليم"); // a viewer who cannot count is not told to start one
  assert.equal(countAction("br1", "h1", { status: "OUTGOING_SUBMITTED", count: { sessionId: "s1", status: "CONFIRMED" } }, true)?.label, "متابعة التسليم");
  assert.equal(countAction("br1", "h1", null, true)?.href, exact); // unknown state: still the exact record, never a generic list
});

// ── R8-01: the readiness read has five states, and only a fresh successful check can say "clear" ───────────────────────────────────────────────
test("parseReadiness is strict: any malformed piece fails the whole read instead of being dropped into a false 'clear'", () => {
  assert.ok(parseReadiness(readiness()));
  for (const bad of [null, undefined, {}, { readiness: null }, { readiness: "x" }, readiness({ checkedAt: "not a date" }), readiness({ enabled: "yes" }), readiness({ blockers: "x" }),
    readiness({ blockers: [{ code: "UNSERVED_ORDERS" }] }),                  // a malformed blocker must NOT be silently dropped
    readiness({ blockers: [blk("UNSERVED_ORDERS", 1, ["o1"]), { nope: true }] }),
    readiness({ requiredItems: [{ id: 1 }] }), readiness({ records: { countSessions: [{ id: "s" }] } }), readiness({ configError: { nocode: 1 } })]) {
    assert.equal(parseReadiness(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(parseReadiness({ readiness: { ...readiness().readiness, records: undefined } })?.records, { countSessions: [] }); // older server shape: no records field
});

test("only a checked, enabled, empty result is 'clear'; unchecked, loading and failed never are", () => {
  const view = (state: ReadinessState, fallback: { code: string } | null = null) => readinessView(state, owner, fallback);
  assert.equal(view(READINESS_UNCHECKED).status, "unchecked");
  assert.equal(view({ status: "loading" }).status, "loading");
  const failed = view({ status: "failed", message: "boom" });
  assert.equal(failed.status, "failed"); assert.equal(failed.message, "boom"); assert.deepEqual(failed.items, []);
  for (const s of ["unchecked", "loading", "failed"] as const) assert.notEqual(view(s === "failed" ? { status: "failed", message: "x" } : { status: s }).status, "clear");
  const data = parseReadiness(readiness())!;
  assert.equal(view({ status: "checked", data }).status, "clear");
  assert.equal(view({ status: "checked", data: { ...data, enabled: false } }).status, "not_applicable"); // handover off: nothing was checked, so not "clear" either
  const withBlockers = view({ status: "checked", data: { ...data, blockers: [blk("UNSERVED_ORDERS", 1, ["o1"], ["#1"])] } });
  assert.equal(withBlockers.status, "blockers"); assert.equal(withBlockers.items.length, 1);
});

test("when the check fails, only the labelled, unconfirmed config cause may appear — never a clear result", () => {
  const v = readinessView({ status: "failed", message: "x" }, cashier, { code: "SELECTED_WITH_NO_ITEMS" });
  assert.equal(v.status, "failed"); assert.equal(v.items.length, 1); assert.equal(v.items[0].code, "SELECTED_WITH_NO_ITEMS");
  assert.equal(readinessView({ status: "failed", message: "x" }, cashier, { code: "CYCLE_POLICY_UNSUPPORTED" }).items.length, 0);
});

test("carry-open-orders waives only the carryable blockers; CYCLE is stepped around; the rest still block", () => {
  const data = parseReadiness(readiness({ carryOpenOrders: true, blockers: [blk("UNSERVED_ORDERS", 1, ["o"]), blk("PENDING_APPROVAL_ORDERS", 1, ["p"]), blk("DRAFT_PURCHASE_INVOICES", 1, ["d"]), { code: "HANDOVER_CONFIG_ERROR", count: 1, messageAr: "m", ids: ["CYCLE_POLICY_UNSUPPORTED"] }] }))!;
  const v = readinessView({ status: "checked", data }, owner, null);
  assert.deepEqual(v.items.map((i) => i.code), ["DRAFT_PURCHASE_INVOICES"]);
  const noCarry = readinessView({ status: "checked", data: { ...data, carryOpenOrders: false } }, owner, null);
  assert.deepEqual(noCarry.items.map((i) => i.code), ["UNSERVED_ORDERS", "PENDING_APPROVAL_ORDERS", "DRAFT_PURCHASE_INVOICES"]);
});

test("the readiness loader: loading, success, failure, recovery — and an unparseable answer is a failure, not a clear", async () => {
  const seen: ReadinessState[] = []; let next: () => Promise<unknown> = async () => readiness();
  const loader = createReadinessLoader(() => next(), (s) => seen.push(s));
  await loader.load();
  assert.deepEqual(seen.map((s) => s.status), ["loading", "checked"]);
  next = async () => { throw new Error("HTTP 500"); };
  await loader.load();
  assert.deepEqual(seen.slice(2).map((s) => s.status), ["loading", "failed"]);
  assert.equal((seen[3] as { message: string }).message, "HTTP 500");
  next = async () => ({ readiness: { checkedAt: "2026-10-27T10:00:00Z", enabled: true } }); // truncated body
  await loader.load();
  assert.equal(seen.at(-1)?.status, "failed");
  next = async () => readiness({ blockers: [blk("UNSERVED_ORDERS", 1, ["o1"])] }); // recovery
  await loader.load();
  assert.equal(seen.at(-1)?.status, "checked");
  assert.equal(seen.filter((s) => s.status === "checked").length, 2);
});

test("stale answers cannot overwrite newer ones: only the latest request publishes, and a cancelled one publishes nothing", async () => {
  const seen: ReadinessState[] = [];
  const resolvers: ((v: unknown) => void)[] = [];
  const loader = createReadinessLoader(() => new Promise((res) => resolvers.push(res)), (s) => seen.push(s));
  const first = loader.load();                       // slow, will answer LAST with an old "clear"
  const second = loader.load();                      // newer, answers first with blockers
  resolvers[1](readiness({ blockers: [blk("UNSERVED_ORDERS", 1, ["o1"])] })); await second;
  resolvers[0](readiness()); await first;            // the old clear arrives late
  const last = seen.at(-1)!;
  assert.equal(last.status, "checked");
  assert.equal(last.status === "checked" && last.data.blockers.length, 1, "the late, older 'clear' must not replace the newer blockers");
  const before = seen.length;
  const third = loader.load(); loader.cancel(); resolvers[2](readiness()); await third;
  assert.equal(seen.length, before + 1); assert.equal(seen.at(-1)?.status, "loading"); // only the 'loading' publish; the cancelled answer is dropped
});

// ── drafts and notes: the browser tab is shared, so every read is scoped to café + user + branch (+ shift) ─────────────────────────────────────
const A: DraftScope = { cafeId: "cafe1", userId: "userA", branchId: "br1", shiftId: "sh1" };
const asScope = ({ cafeId, userId, branchId }: DraftScope): StorageScope => ({ cafeId, userId, branchId });

test("close-form draft keeps only what the user typed, is scoped per shift, and is cleared when empty", () => {
  const s = memory(); const t0 = 1_000_000;
  saveCloseDraft(s, A, draft({ actualCash: "123.5", handoverTarget: "SHIFT_TO_SHIFT", notes: "n" }), t0);
  assert.equal(loadCloseDraft(s, A, t0 + 1000)?.actualCash, "123.5");
  assert.equal(loadCloseDraft(s, { ...A, shiftId: "sh2" }, t0 + 1000), null); // another shift's draft is never applied
  saveCloseDraft(s, A, draft(), t0 + 2000);
  assert.equal(s.map.size, 0); // emptied form removes the draft
  assert.doesNotMatch(JSON.stringify([...s.map.values()]), /expected/i);
});

test("a draft is never read back for another user, café or branch in the same tab (account switch)", () => {
  const s = memory(); const t0 = 2_000_000;
  saveCloseDraft(s, A, draft({ actualCash: "777", actualCard: "55" }), t0);
  assert.equal(loadCloseDraft(s, A, t0)?.actualCash, "777");
  assert.equal(loadCloseDraft(s, { ...A, userId: "userB" }, t0), null, "a manager closing the SAME shift must not see the cashier's typed figures");
  assert.equal(loadCloseDraft(s, { ...A, cafeId: "cafe2" }, t0), null);
  assert.equal(loadCloseDraft(s, { ...A, branchId: "br2" }, t0), null);
  // the payload is checked as well as the key: a copied entry cannot cross a boundary
  const [key, raw] = [...s.map.entries()][0];
  s.map.set(closeDraftKey({ ...A, userId: "userB" }), raw);
  assert.equal(loadCloseDraft(s, { ...A, userId: "userB" }, t0), null);
  s.map.delete(closeDraftKey({ ...A, userId: "userB" })); assert.ok(s.map.has(key));
  // account switch and back: user B has nothing, user A still has their own
  saveCloseDraft(s, { ...A, userId: "userB" }, draft({ actualCash: "1" }), t0);
  assert.equal(loadCloseDraft(s, { ...A, userId: "userB" }, t0)?.actualCash, "1");
  assert.equal(loadCloseDraft(s, A, t0)?.actualCash, "777");
  // an incomplete scope (no café yet / no user) reads and writes nothing
  assert.equal(loadCloseDraft(s, { ...A, cafeId: "" }, t0), null);
  const before = s.map.size; saveCloseDraft(s, { ...A, userId: "" }, draft({ actualCash: "9" }), t0); assert.equal(s.map.size, before);
});

test("a legacy shift-only draft key from the earlier build is never read", () => {
  const s = memory(); const t0 = 3_000_000;
  s.map.set("nextcup:close-draft:sh1", JSON.stringify({ v: 1, shiftId: "sh1", savedAt: t0, draft: draft({ actualCash: "999" }) }));
  assert.equal(loadCloseDraft(s, A, t0), null);
});

test("a stale, malformed or foreign draft is ignored; the draft helpers never throw on a broken storage", () => {
  const s = memory(); const t0 = 5_000_000;
  saveCloseDraft(s, A, draft({ actualCash: "10" }), t0);
  assert.equal(loadCloseDraft(s, A, t0 + 13 * 3600 * 1000), null); // older than 12h
  s.map.set(closeDraftKey(A), "{not json"); assert.equal(loadCloseDraft(s, A, t0), null);
  s.map.set(closeDraftKey(A), JSON.stringify({ v: 2, scope: A, savedAt: t0, draft: { actualCash: 5 } })); assert.equal(loadCloseDraft(s, A, t0), null);
  s.map.set(closeDraftKey(A), JSON.stringify({ v: 2, scope: { ...A, shiftId: "OTHER" }, savedAt: t0, draft: draft() })); assert.equal(loadCloseDraft(s, A, t0), null);
  const broken: StorageLike = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  assert.doesNotThrow(() => { saveCloseDraft(broken, A, draft({ actualCash: "1" }), t0); clearCloseDraft(broken, A); assert.equal(loadCloseDraft(broken, A, t0), null); });
  assert.equal(loadCloseDraft(null, A, t0), null);
});

test("the pending-close note round-trips, expires, and is scoped to café + user + branch", () => {
  const s = memory(); const t0 = 9_000_000; const scope = asScope(A);
  saveCloseOutcome(s, scope, { handoverId: "h1", shiftNumber: 3, savedAt: t0 });
  assert.equal(loadCloseOutcome(s, scope, t0 + 1000)?.handoverId, "h1");
  assert.equal(loadCloseOutcome(s, { ...scope, branchId: "br2" }, t0 + 1000), null);
  assert.equal(loadCloseOutcome(s, { ...scope, userId: "userB" }, t0 + 1000), null, "another user at the same branch must not see this user's note");
  assert.equal(loadCloseOutcome(s, { ...scope, cafeId: "cafe2" }, t0 + 1000), null);
  s.map.set(closeOutcomeKey({ ...scope, userId: "userB" }), s.map.get(closeOutcomeKey(scope))!); // copied entry
  assert.equal(loadCloseOutcome(s, { ...scope, userId: "userB" }, t0), null);
  s.map.set("nextcup:close-outcome:br1", JSON.stringify({ branchId: "br1", handoverId: "legacy", savedAt: t0 })); // legacy branch-only key
  assert.equal(loadCloseOutcome(s, scope, t0)?.handoverId, "h1");
  assert.equal(loadCloseOutcome(s, scope, t0 + 40 * 3600 * 1000), null);
  clearCloseOutcome(s, scope); assert.equal(loadCloseOutcome(s, scope, t0), null);
});

// ── static contract checks on the sources (no database, no network) ──────────────────────────────────────────────────────────────────────────
const root = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

test("contract: close-readiness is a GET-only, READ ONLY, tenant/branch/permission-scoped read that never closes anything", () => {
  const src = read("src/app/api/branches/[id]/close-readiness/route.ts");
  assert.match(src, /export async function GET/);
  assert.doesNotMatch(src, /export async function (POST|PUT|PATCH|DELETE)/);
  assert.match(src, /SET TRANSACTION READ ONLY/);
  assert.match(src, /requirePermission\("shifts:operate"\)/);
  assert.match(src, /branch\.cafeId !== cafeId/);
  assert.match(src, /session\.branchId && session\.branchId !== id/);
  const code = src.replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw`|closeShiftWithSettlement|\/close/);
  assert.doesNotMatch(code, /currentStock|countedQuantity|expectedQuantity|newCountedQuantity|oldCountedQuantity/); // blind counts stay blind: names, units, statuses only
  // the record lookups added for exact navigation are themselves scoped to this café and branch
  assert.match(code, /stockCountSession\.findMany\(\{ where: \{ \.\.\.scope, id: \{ in: activeCountIds \}/);
  assert.match(code, /line: \{ session: scope \}/);
});

test("contract: the shift controls never prefill a figure from an expected value and never submit on their own", () => {
  const src = read("src/components/pos/shift-controls.tsx");
  // The only sources a count field may take: cleared, the user's own keypad/typing, or the user's own restored draft.
  for (const m of src.matchAll(/set(ActualCash|ActualCard|ActualWallet)\(([^)]*)\)/g)) assert.match(m[2], /^(""|''|touchValue|restored\.[A-Za-z]+)$/, `unexpected prefill: ${m[0]}`);
  assert.doesNotMatch(src, /setActual(Cash|Card|Wallet)\([^)]*expected/i);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.equal([...code.matchAll(/\/close`/g)].length, 1, "exactly one place submits a close");
  assert.equal([...code.matchAll(/closeShift\b/g)].length, 2, "closeShift is declared once and wired to the confirm button once");
  assert.doesNotMatch(code.slice(code.indexOf("async function openCloseDialog"), code.indexOf("async function closeShift")), /\/close`|closeShift\(|method: "POST"/);
  // the readiness read is a GET (no method option) made through the sequence-guarded loader
  const readinessCode = code.slice(code.indexOf("const readinessLoader"), code.indexOf("const loadReadiness"));
  assert.match(readinessCode, /close-readiness/);
  assert.match(readinessCode, /createReadinessLoader/);
  assert.doesNotMatch(readinessCode, /method:|POST|\/close`/);
});
