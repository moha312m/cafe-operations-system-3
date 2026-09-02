// Running a count: starting one, and what starting one is allowed to decide.
//
// The single property this module exists to hold is that the scope of a count
// is derived by the server and cannot be steered by the person being
// measured. `resolveCountScope` (T9) already refuses to take an item list —
// by signature, not by ignoring one — and this is the HTTP-facing half of
// that same refusal: a request that names items is rejected with a sentence
// saying where scope comes from, rather than having the field dropped.
//
// Dropping it silently would be worse than accepting it. A custodian who
// believed they had narrowed a count would read a clean result as evidence
// about the shelves they chose, and nobody downstream would know which
// question had actually been asked.
//
// Starting a count writes NO figures. The session and its `PENDING` lines
// are a list of questions; `expectedQuantity` and `itemVersion` are captured
// per line at the moment somebody counts it (T26), under the item's row lock,
// because a target captured at start would be stale by the time the counter
// reached the shelf — and would have to be stored somewhere a blind counter
// might read it.
//
// A session is created `DRAFT`: its scope is fixed but nothing has been
// counted. It becomes `IN_PROGRESS` when the first line is captured. Both
// states are blind under a BLIND mode, so nothing is disclosed in between.

import type {
  CountLineDisposition,
  Prisma,
  StockCountAccountabilityContext,
  StockCountMode,
  StockCountStatus,
  StockCountType,
} from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { audit, auditInTransaction } from "@/lib/audit";
import { round3 } from "@/lib/costing";
import { captureCountPoint } from "@/lib/count-point";
import { activeCustody } from "@/lib/custody";
import { isTerminal } from "@/lib/count-disposition";
import {
  EFFECTIVE_EVIDENCE_SELECT,
  effectiveCountEvidence,
  hasSupersedingRecount,
} from "@/lib/count-evidence";
import { openVarianceCase, resolveRecountPolicy } from "@/lib/variance-case";
import {
  captureUnitCost,
  confidenceForCountedItem,
  lastTrustedBaselineAt,
  stockCostImpact,
} from "@/lib/variance-confidence";
import { resolveStockTolerance, withinTolerance } from "@/lib/tolerance";
import {
  resolveCountScope,
  resolveStockCountPolicy,
  UnsupportedCountPolicyError,
} from "@/lib/stock-count-policy";

/**
 * The statuses the branch's partial unique index treats as live.
 *
 * Stated here so the service's legibility check and the database's guarantee
 * cannot drift: `StockCountSession_one_active_per_branch` (M6) covers exactly
 * these four.
 */
export const ACTIVE_COUNT_STATUSES = [
  "DRAFT",
  "IN_PROGRESS",
  "SUBMITTED",
  "RECOUNT_REQUIRED",
] as const satisfies readonly StockCountStatus[];

/** The one audit action a start writes. */
export const COUNT_STARTED_AUDIT_ACTION = "COUNT_STARTED";

/**
 * Keys that would mean the caller chose the scope.
 *
 * Rejected by name rather than stripped by a permissive schema, because the
 * refusal is the feature. `scopeDerivation` is here too: it is the server's
 * record of HOW it derived the scope, and a caller writing it would be
 * forging that record rather than choosing a scope.
 */
const SCOPE_KEYS = ["inventoryItemIds", "itemIds", "inventoryItems", "scope", "scopeDerivation"];

export const CLIENT_SCOPE_REFUSAL = "نطاق الجرد بيتحدد من الإعدادات، مش من الطلب";

/** 400 if the body tries to choose what gets counted. */
export function assertNoClientScope(body: unknown): void {
  if (!body || typeof body !== "object") return;
  const named = SCOPE_KEYS.filter((k) => k in (body as Record<string, unknown>));
  if (named.length > 0) {
    throw new ApiError(400, `${CLIENT_SCOPE_REFUSAL} (${named.join("، ")})`);
  }
}

/**
 * A requested count type, refused by name when it is `CYCLE`.
 *
 * `StockCountType` has only two values, so a schema alone would reject
 * `CYCLE` as "not one of FULL, CRITICAL" — true, but not the truth that
 * matters. Cycle counting is a policy the enum still lists and no engine
 * implements, and somebody asking for one deserves to be told that rather
 * than left to conclude they mistyped.
 */
export function assertSupportedCountType(type: unknown): void {
  if (type === "CYCLE") throw new UnsupportedCountPolicyError();
}

export type StartCountResult = {
  sessionId: string;
  lineCount: number;
  derivation: string;
  status: StockCountStatus;
  custodyPeriodId: string | null;
};

/** Postgres unique-violation, however it reaches us. */
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string }).code;
  return code === "P2002" || code === "23505";
}

const ALREADY_RUNNING = "في جرد شغال في الفرع بالفعل — اقفله الأول";

/**
 * Open a count session over a scope the server derived for itself.
 *
 * Refuses an empty scope rather than creating a count of nothing: a session
 * with no lines would submit and confirm vacuously, and read afterwards as a
 * branch that had been counted.
 */
export async function startCountSession(args: {
  cafeId: string;
  branchId: string;
  type: StockCountType;
  initiatedById: string;
  shiftId: string | null;
}): Promise<StartCountResult> {
  const branch = await db.branch.findUnique({
    where: { id: args.branchId },
    select: { id: true, cafeId: true },
  });
  if (!branch) throw new ApiError(404, "الفرع مش موجود");
  if (branch.cafeId !== args.cafeId) throw new ApiError(400, "الفرع مش تابع للكافيه");

  // Resolved once and handed to the scope resolver, so policy is read from
  // the café exactly once per start. CYCLE throws from inside `resolveCountScope`.
  const policy = await resolveStockCountPolicy(args.cafeId, args.branchId);
  const scope = await resolveCountScope({
    cafeId: args.cafeId,
    branchId: args.branchId,
    type: args.type,
    policy,
  });

  if (scope.inventoryItemIds.length === 0) {
    throw new ApiError(
      400,
      args.type === "CRITICAL"
        ? "مفيش أصناف حرجة متظبطة في الفرع — اظبط الأصناف الحرجة الأول أو اعمل جرد كامل"
        : "مفيش أصناف مخزون في الفرع ينفع تتعد"
    );
  }

  // A shift from elsewhere would attach this count to the wrong period.
  if (args.shiftId) {
    const shift = await db.shift.findUnique({
      where: { id: args.shiftId },
      select: { cafeId: true, branchId: true },
    });
    if (!shift) throw new ApiError(404, "الشيفت مش موجود");
    if (shift.cafeId !== args.cafeId || shift.branchId !== args.branchId) {
      throw new ApiError(400, "الشيفت مش تابع للفرع");
    }
  }

  // Legibility, not enforcement — the partial unique index is the guarantee,
  // and the catch below is what makes a lost race an answer rather than a crash.
  const live = await db.stockCountSession.findFirst({
    where: { branchId: args.branchId, status: { in: [...ACTIVE_COUNT_STATUSES] } },
    select: { id: true },
  });
  if (live) throw new ApiError(409, ALREADY_RUNNING);

  const custody = await activeCustody(args.branchId, "STOCK");

  // Units come from the items themselves: a line records the unit the shelf
  // is stocked in, so a later reader is not left converting.
  const items = await db.inventoryItem.findMany({
    where: { id: { in: scope.inventoryItemIds } },
    select: { id: true, unit: true },
    orderBy: { name: "asc" },
  });

  let session: { id: string; status: StockCountStatus; custodyPeriodId: string | null };
  try {
    session = await db.stockCountSession.create({
      data: {
        cafeId: args.cafeId,
        branchId: args.branchId,
        shiftId: args.shiftId,
        custodyPeriodId: custody?.id ?? null,
        type: args.type,
        status: "DRAFT",
        mode: policy.mode,
        scopeDerivation: scope.derivation,
        initiatedById: args.initiatedById,
        lines: {
          create: items.map((i) => ({
            inventoryItemId: i.id,
            unit: i.unit,
            disposition: "PENDING" as const,
          })),
        },
      },
      select: { id: true, status: true, custodyPeriodId: true },
    });
  } catch (e) {
    // Somebody else started one between the check above and this insert.
    if (isUniqueViolation(e)) throw new ApiError(409, ALREADY_RUNNING);
    throw e;
  }

  await audit({
    cafeId: args.cafeId,
    userId: args.initiatedById,
    action: COUNT_STARTED_AUDIT_ACTION,
    entity: "StockCountSession",
    entityId: session.id,
    details: {
      branchId: args.branchId,
      type: args.type,
      scopeDerivation: scope.derivation,
      lineCount: items.length,
      custodyPeriodId: session.custodyPeriodId,
      shiftId: args.shiftId,
      // The derivation, not the items' figures: an audit row is not a place
      // to publish a blind count's targets.
      inventoryItemIds: scope.inventoryItemIds,
    },
  });

  return {
    sessionId: session.id,
    lineCount: items.length,
    derivation: scope.derivation,
    status: session.status,
    custodyPeriodId: session.custodyPeriodId,
  };
}

/**
 * The summary shape a list may carry.
 *
 * No quantity of any kind. A list is read by whoever is about to count, so
 * the safe shape is one that has no target in it to leak.
 */
export const COUNT_SESSION_SUMMARY = {
  id: true,
  branchId: true,
  shiftId: true,
  custodyPeriodId: true,
  type: true,
  status: true,
  mode: true,
  scopeDerivation: true,
  startedAt: true,
  submittedAt: true,
  confirmedAt: true,
  lockedAt: true,
  initiatedById: true,
  createdAt: true,
  _count: { select: { lines: true } },
} satisfies Prisma.StockCountSessionSelect;

export async function listCountSessions(args: {
  cafeId: string;
  branchId: string;
  status?: StockCountStatus;
  take?: number;
}) {
  const rows = await db.stockCountSession.findMany({
    where: {
      cafeId: args.cafeId,
      branchId: args.branchId,
      ...(args.status ? { status: args.status } : {}),
    },
    select: COUNT_SESSION_SUMMARY,
    orderBy: { createdAt: "desc" },
    take: args.take ?? 50,
  });
  return rows.map(({ _count, ...s }) => ({ ...s, lineCount: _count.lines }));
}

// ───────────────────────── The blind read model ──────────────────────
//
// Spec §5. Somebody about to measure something must not be able to learn the
// answer first, and "blind" has to mean blind at the RESPONSE, not merely
// undrawn by the UI. The control is keyed on custody rather than on role, the
// way SHIFT-003 keyed the cash target on holding the drawer: a manager who is
// not counting keeps full visibility, and a manager who started the count
// does not.
//
// Three fields are withheld together, because withholding only the first
// would be theatre:
//
//   expectedQuantity  — the target itself
//   varianceQuantity  — counted − expected, so expected = counted − variance
//   costImpact        — |variance| × a cost the counter can read off the item
//
// They are DELETED rather than nulled. A null still tells the counter that a
// figure exists and is being kept from them, and — more practically — invites
// a client to render "expected: —" beside a field the server intends to be
// absent. `redactBlindCount` set that precedent for the drawer.
//
// Two things never reach this route for anybody: `InventoryItem.currentStock`,
// which is the theoretical figure under another name, and the ledger counters,
// which LEDGER-004 keeps off the wire generally. Neither is in the projection
// at all, so no redactor has to remember them.

/** The figures a blind counter must not see, or trivially recompute. */
export const BLIND_LINE_FIELDS = [
  "expectedQuantity",
  "varianceQuantity",
  "costImpact",
  "costImpactAvailable",
  "costUnavailableReason",
] as const;

/** The statuses before the §5 disclosure point. */
const PRE_DISCLOSURE_STATUSES: readonly StockCountStatus[] = ["DRAFT", "IN_PROGRESS"];

type RedactableLine = { counterId: string | null };
type RedactableSession = {
  mode: StockCountMode;
  status: StockCountStatus;
  initiatedById: string;
  lines: RedactableLine[];
};

/**
 * Whether this viewer is one of the people this count is blind to.
 *
 * Initiator OR any line's counter. The initiator is included because starting
 * a count is not supervising it — in a two-person café the person who opened
 * the session is usually the person walking the shelves.
 */
export function countIsBlindTo(session: RedactableSession, viewerId: string): boolean {
  if (session.mode !== "BLIND") return false;
  if (!PRE_DISCLOSURE_STATUSES.includes(session.status)) return false;
  return (
    session.initiatedById === viewerId ||
    session.lines.some((l) => l.counterId === viewerId)
  );
}

/**
 * Remove the count's targets from what this viewer is about to receive.
 *
 * Returns the session unchanged when the viewer is entitled to see it, so a
 * caller can apply it unconditionally. The cast is deliberate and local: the
 * runtime shape is narrower than `T` by exactly `BLIND_LINE_FIELDS`, which is
 * the point, and every consumer of the redacted value is a JSON response.
 */
export function redactCountTargets<T extends RedactableSession>(
  session: T,
  viewerId: string
): T {
  if (!countIsBlindTo(session, viewerId)) return session;
  return {
    ...session,
    lines: session.lines.map((line) => {
      const copy = { ...line } as Record<string, unknown>;
      for (const field of BLIND_LINE_FIELDS) delete copy[field];
      return copy;
    }),
  } as unknown as T;
}

/**
 * One session, shaped for reading.
 *
 * `currentStock` and the ledger counters are absent from the projection
 * rather than removed afterwards: a field that is never selected cannot be
 * forgotten by a redactor.
 */
const COUNT_SESSION_DETAIL = {
  id: true,
  cafeId: true,
  branchId: true,
  shiftId: true,
  custodyPeriodId: true,
  type: true,
  status: true,
  mode: true,
  scopeDerivation: true,
  startedAt: true,
  submittedAt: true,
  confirmedAt: true,
  lockedAt: true,
  initiatedById: true,
  firstCounterId: true,
  confirmedById: true,
  lockedByHandoverId: true,
  notes: true,
  createdAt: true,
  lines: {
    select: {
      id: true,
      inventoryItemId: true,
      unit: true,
      disposition: true,
      countedQuantity: true,
      effectiveCountedQuantity: true,
      countedAt: true,
      counterId: true,
      expectedQuantity: true,
      varianceQuantity: true,
      costImpact: true,
      costImpactAvailable: true,
      costUnavailableReason: true,
      confidence: true,
      expectedBasis: true,
      reasonCodeId: true,
      reasonNote: true,
      inventoryItem: { select: { id: true, name: true, category: true, unit: true } },
    },
    orderBy: { inventoryItem: { name: "asc" } },
  },
} satisfies Prisma.StockCountSessionSelect;

/**
 * Load a session for a viewer, or refuse.
 *
 * A session belonging to another café is `404`, not `403`: a 403 would
 * confirm the id exists, and one tenant learns nothing about another's
 * records, including that they are there. A session at another branch of the
 * viewer's OWN café is `403`, because the café is theirs and the branch is not.
 */
export async function getCountSessionForViewer(args: {
  sessionId: string;
  cafeId: string;
  viewerId: string;
  viewerBranchId: string | null;
}) {
  const session = await db.stockCountSession.findUnique({
    where: { id: args.sessionId },
    select: COUNT_SESSION_DETAIL,
  });
  if (!session || session.cafeId !== args.cafeId) {
    throw new ApiError(404, "جلسة الجرد غير موجودة");
  }
  if (args.viewerBranchId && session.branchId !== args.viewerBranchId) {
    throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
  }

  const blind = countIsBlindTo(session, args.viewerId);
  return { ...redactCountTargets(session, args.viewerId), blind };
}

// ─────────────────────────── Recording a count ───────────────────────
//
// One transaction, one lock, three consequences.
//
// `captureCountPoint` takes the item's FOR UPDATE lock — the identical lock
// every stock mutation takes — and reads `currentStock` and `ledgerVersion`
// together under it. That is what makes the pair trustworthy: a concurrent
// mutator must hold the same lock to assign version N+1, so at capture time
// everything at or below the captured version is committed AND reflected in
// the balance. A movement posted while the counter walks the floor is
// therefore neither an error nor silently absorbed — it is assigned a version
// ABOVE the captured one, excluded from this line's expected figure, and
// replayed onto the rebase (T23) so the balance ends correct.
//
// The client supplies ONE number: what they saw on the shelf. Everything
// else on the row — the expected figure, the version, the basis, the
// variance, the disposition — is the server's conclusion, and a request that
// names any of them is refused rather than obeyed. Obeying would let the
// person being measured write their own result; ignoring would let them
// believe they had.
//
// Capture writes NO stock. The shelf is changed to match a count only after
// confirmation, through `applyStockMutation`, as an audited COUNT_REBASE.
// Recording evidence and acting on evidence are different acts, and this is
// the first one.
//
// The audit row here is fire-and-forget, unlike the rebase's. The difference
// is not laziness: a rebase MOVES stock, so a rebase with no record is stock
// changing for reasons nobody can reconstruct. A capture's own evidence is
// the line row itself — counted quantity, counter, time and version all
// persist in the write — so losing the note would be worse than losing the
// count it describes, which is exactly the case `audit` is for.

/**
 * Fields on a count line that are the server's conclusions.
 *
 * Refused by name, like `SCOPE_KEYS`. `counterId` and `countedAt` are here
 * too: who counted and when are observations about the request, not values
 * for it to assert.
 */
const SERVER_FIGURE_KEYS = [
  "expectedQuantity",
  "expectedBasis",
  "itemVersion",
  "varianceQuantity",
  "effectiveCountedQuantity",
  "confidence",
  "theoreticalConfidence",
  "confidenceWindowFrom",
  "confidenceIssues",
  "disposition",
  "costImpact",
  "costImpactAvailable",
  "costUnavailableReason",
  "counterId",
  "countedAt",
];

export const CLIENT_FIGURE_REFUSAL =
  "الكمية المتوقعة وإصدار الحركة بيتحسبوا في السيرفر، مش من الطلب";

/** 400 if the body tries to write a figure the server is responsible for. */
export function assertNoClientFigures(body: unknown): void {
  if (!body || typeof body !== "object") return;
  const named = SERVER_FIGURE_KEYS.filter((k) => k in (body as Record<string, unknown>));
  if (named.length > 0) {
    throw new ApiError(400, `${CLIENT_FIGURE_REFUSAL} (${named.join("، ")})`);
  }
}

/** The one audit action a capture writes. */
export const ITEM_COUNTED_AUDIT_ACTION = "ITEM_COUNTED";

/** Statuses whose evidence is settled: a count against them is refused. */
const CLOSED_TO_CAPTURE: readonly StockCountStatus[] = ["CONFIRMED", "LOCKED"];

/**
 * Load a line for writing, having proved it is this caller's to write.
 *
 * A line reached through the wrong session id is `404` rather than being
 * looked up by id alone: the session in the URL is part of what the caller
 * claimed, and honouring a mismatch would let one session's id address
 * another's evidence.
 */
async function lineForWrite(args: {
  sessionId: string;
  lineId: string;
  cafeId: string;
  viewerBranchId: string | null;
}) {
  const line = await db.stockCountLine.findUnique({
    where: { id: args.lineId },
    select: {
      id: true,
      sessionId: true,
      inventoryItemId: true,
      disposition: true,
      session: {
        select: {
          id: true,
          cafeId: true,
          branchId: true,
          status: true,
          startedAt: true,
          firstCounterId: true,
        },
      },
    },
  });
  if (!line || line.sessionId !== args.sessionId || line.session.cafeId !== args.cafeId) {
    throw new ApiError(404, "سطر الجرد غير موجود");
  }
  if (args.viewerBranchId && line.session.branchId !== args.viewerBranchId) {
    throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
  }
  return line;
}

export type RecordCountLineResult = {
  lineId: string;
  countedAt: Date;
  itemVersion: bigint;
  disposition: "COUNTED";
};

/**
 * Record what somebody saw on one shelf.
 *
 * Re-recording an uncounted line re-captures IN PLACE — at a new count
 * point, because the shelf has moved on and reusing the first capture would
 * recreate exactly the staleness the lock exists to prevent. It never adds a
 * second line: one session asks about one item once.
 */
export async function recordCountLine(args: {
  sessionId: string;
  lineId: string;
  countedQuantity: number;
  counterId: string;
  cafeId: string;
  viewerBranchId: string | null;
}): Promise<RecordCountLineResult> {
  if (!Number.isFinite(args.countedQuantity) || args.countedQuantity < 0) {
    throw new ApiError(400, "الكمية المعدودة لازم تكون رقم مش سالب");
  }

  const line = await lineForWrite(args);
  if (CLOSED_TO_CAPTURE.includes(line.session.status)) {
    throw new ApiError(409, "الجرد ده اتقفل خلاص — مينفعش تسجل كمية عليه");
  }

  const counted = round3(args.countedQuantity);

  const result = await db.$transaction(async (tx) => {
    // The lock is held from here to commit, which is what makes the balance
    // and the version below describe the same instant.
    const point = await captureCountPoint(tx, line.inventoryItemId);

    const updated = await tx.stockCountLine.update({
      where: { id: line.id },
      data: {
        expectedQuantity: point.expectedQuantity,
        itemVersion: point.itemVersion,
        expectedBasis: point.basis,
        countedAt: point.capturedAt,
        counterId: args.counterId,
        countedQuantity: counted,
        // The working figure equals the observation until an APPROVED
        // correction (T29) supersedes it. Never the other way round.
        effectiveCountedQuantity: counted,
        varianceQuantity: round3(counted - point.expectedQuantity),
        disposition: "COUNTED",
      },
      select: { id: true, countedAt: true, itemVersion: true },
    });

    // A count that has begun says so, and says who began it.
    if (line.session.status === "DRAFT" || line.session.firstCounterId === null) {
      await tx.stockCountSession.update({
        where: { id: line.session.id },
        data: {
          ...(line.session.status === "DRAFT" ? { status: "IN_PROGRESS" as const } : {}),
          startedAt: line.session.startedAt ?? point.capturedAt,
          firstCounterId: line.session.firstCounterId ?? args.counterId,
        },
      });
    }

    return { updated, point };
  });

  await audit({
    cafeId: args.cafeId,
    userId: args.counterId,
    action: ITEM_COUNTED_AUDIT_ACTION,
    entity: "StockCountLine",
    entityId: line.id,
    details: {
      sessionId: line.session.id,
      branchId: line.session.branchId,
      inventoryItemId: line.inventoryItemId,
      // Stringified: `itemVersion` is BigInt, which JSON cannot carry.
      itemVersion: String(result.point.itemVersion),
      expectedBasis: result.point.basis,
      countedQuantity: counted,
      previousDisposition: line.disposition,
    },
  });

  return {
    lineId: result.updated.id,
    countedAt: result.updated.countedAt!,
    itemVersion: result.updated.itemVersion!,
    disposition: "COUNTED",
  };
}

// ────────────────────────── Submitting a count ───────────────────────
//
// Submission is where a pile of observations becomes a set of verdicts. Each
// counted line is measured against the tolerance governing its item (T15,
// narrowest scope wins) and lands either settled or contested.
//
// COMPLETENESS IS SERVER-VERIFIED. A line whose `countedQuantity` is NULL is
// not a zero — it is a shelf nobody looked at, and the two must never
// collapse. Submitting with one outstanding is refused rather than treated
// as a total loss on that item, which is what reading NULL as 0 would report.
//
// The dispositions set here follow `DISPOSITION_TRANSITIONS` (T13) exactly.
// An outside-tolerance line becomes `OUTSIDE_TOLERANCE` first and only then
// `RECOUNT_REQUIRED`, when the owner requires a recount — there is no
// COUNTED → RECOUNT_REQUIRED edge, so the reason a recount was demanded is
// always a state the line actually occupied.

export type SubmitCountResult = {
  status: "SUBMITTED" | "RECOUNT_REQUIRED";
  within: number;
  outside: number;
};

/** Sessions that may still be submitted. CONFIRMED and LOCKED may not. */
const SUBMITTABLE: readonly StockCountStatus[] = [
  "DRAFT",
  "IN_PROGRESS",
  "SUBMITTED",
  "RECOUNT_REQUIRED",
];

export const COUNT_SUBMITTED_AUDIT_ACTION = "COUNT_SUBMITTED";

/**
 * Close the counting phase and give every line a verdict.
 *
 * Lines already in a terminal disposition are left alone: a recount that
 * resolved a line before submission has already answered it, and re-judging
 * it against today's tolerance would let a settled question reopen.
 */
export async function submitCountSession(args: {
  sessionId: string;
  submittedById: string;
  cafeId?: string;
  viewerBranchId?: string | null;
}): Promise<SubmitCountResult> {
  const session = await db.stockCountSession.findUnique({
    where: { id: args.sessionId },
    select: {
      id: true,
      cafeId: true,
      branchId: true,
      status: true,
      lines: {
        select: {
          ...EFFECTIVE_EVIDENCE_SELECT,
          inventoryItemId: true,
          disposition: true,
          inventoryItem: { select: { name: true, category: true, costPerUnit: true } },
        },
      },
    },
  });
  if (!session || (args.cafeId !== undefined && session.cafeId !== args.cafeId)) {
    throw new ApiError(404, "جلسة الجرد غير موجودة");
  }
  if (args.viewerBranchId && session.branchId !== args.viewerBranchId) {
    throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
  }
  if (!SUBMITTABLE.includes(session.status)) {
    throw new ApiError(409, "الجرد ده اتقفل خلاص");
  }

  const uncounted = session.lines.filter((l) => l.countedQuantity === null);
  if (uncounted.length > 0) {
    const names = uncounted.map((l) => l.inventoryItem.name).slice(0, 5).join("، ");
    throw new ApiError(
      400,
      `في أصناف لسه ما اتعدتش (${uncounted.length}): ${names}`
    );
  }

  const policy = await resolveRecountPolicy(session.cafeId);

  let within = 0;
  let outside = 0;
  const verdicts: { id: string; disposition: CountLineDisposition }[] = [];
  const updates: { id: string; data: Prisma.StockCountLineUpdateInput }[] = [];
  const judgedAt = new Date();

  for (const line of session.lines) {
    // The variance under judgement belongs to the observation in force: after
    // a resolving recount that is the recount's gap, not the discredited
    // first count's.
    const evidence = effectiveCountEvidence(line);
    const variance = evidence.varianceQuantity;
    const observedAt = evidence.countedAt ?? new Date();

    // How far the theoretical figure this variance is measured against can be
    // trusted, judged over everything since the last count somebody believed
    // (T21). Written for EVERY counted line, including ones a recount or an
    // acceptance already settled, because the variance case opened at
    // confirmation reads these columns.
    const window = await lastTrustedBaselineAt({
      branchId: session.branchId,
      inventoryItemId: line.inventoryItemId,
      before: observedAt,
    });
    const rated = await confidenceForCountedItem({
      cafeId: session.cafeId,
      branchId: session.branchId,
      inventoryItemId: line.inventoryItemId,
      windowFrom: window.at,
      countedAt: observedAt,
    });
    const observedUnitCost = Number(line.inventoryItem.costPerUnit);
    const unitCostSnapshot = captureUnitCost(observedUnitCost, judgedAt);
    const cost = stockCostImpact({
      varianceQuantity: variance,
      costPerUnit: observedUnitCost,
      confidence: rated.confidence,
    });

    const data: Prisma.StockCountLineUpdateInput = {
      // The two denormalised mirrors, re-stated from the resolver so they
      // cannot drift away from the evidence in force.
      effectiveCountedQuantity: evidence.quantity,
      varianceQuantity: variance,
      confidence: rated.confidence,
      confidenceIssues: rated.issues,
      confidenceWindowFrom: window.at,
      // NULL, never 0. The paired flag and reason keep "we could not price
      // this" from reading as "this cost nothing".
      costImpact: cost.available ? cost.value : null,
      costImpactAvailable: cost.available,
      costUnavailableReason: cost.available ? null : cost.reason,
      unitCostSnapshot: unitCostSnapshot.available ? unitCostSnapshot.unitCost : null,
      unitCostSource: unitCostSnapshot.available ? unitCostSnapshot.source : null,
      unitCostCapturedAt: unitCostSnapshot.available ? unitCostSnapshot.capturedAt : null,
    };

    if (isTerminal(line.disposition)) {
      // Already answered — by a recount, or by an accepted variance. Its
      // verdict is not re-judged against today's tolerance.
      if (line.disposition === "VARIANCE_CONFIRMED") outside += 1;
      else within += 1;
      updates.push({ id: line.id, data });
      continue;
    }

    const tolerance = await resolveStockTolerance({
      cafeId: session.cafeId,
      branchId: session.branchId,
      inventoryItemId: line.inventoryItemId,
      category: line.inventoryItem.category,
    });
    const ok = withinTolerance({
      varianceQuantity: variance,
      expectedQuantity: evidence.expectedQuantity,
      tolerance,
    });

    const disposition: CountLineDisposition = ok
      ? "WITHIN_TOLERANCE"
      // Through OUTSIDE_TOLERANCE, always — see the note above.
      : policy.required
        ? "RECOUNT_REQUIRED"
        : "OUTSIDE_TOLERANCE";

    if (ok) within += 1;
    else outside += 1;

    verdicts.push({ id: line.id, disposition });
    updates.push({ id: line.id, data: { ...data, disposition } });
  }

  const needsRecount = verdicts.some((v) => v.disposition === "RECOUNT_REQUIRED");
  const status: SubmitCountResult["status"] = needsRecount ? "RECOUNT_REQUIRED" : "SUBMITTED";
  const submittedAt = judgedAt;

  // One transaction: a submission that gave half the lines a verdict and then
  // failed would leave the count in a state nobody chose.
  await db.$transaction(async (tx) => {
    for (const u of updates) {
      await tx.stockCountLine.update({ where: { id: u.id }, data: u.data });
    }
    await tx.stockCountSession.update({
      where: { id: session.id },
      data: { status, submittedAt },
    });
  });

  await audit({
    cafeId: session.cafeId,
    userId: args.submittedById,
    action: COUNT_SUBMITTED_AUDIT_ACTION,
    entity: "StockCountSession",
    entityId: session.id,
    details: {
      branchId: session.branchId,
      status,
      within,
      outside,
      recountRequired: needsRecount,
      lineCount: session.lines.length,
    },
  });

  return { status, within, outside };
}

// ───────────────────────── Confirming a count ────────────────────────
//
// Confirmation is where a count stops being a work-in-progress and becomes
// evidence other things may act on: the rebase reads it, variance cases are
// opened from it, a handover may cite it. So it succeeds on exactly one
// condition — every line is terminal — and it runs once however many times it
// is called.
//
// ONCE MATTERS MORE HERE THAN ANYWHERE ELSE. A confirmation that ran twice
// would open two variance cases for one shortage, and a shop would
// investigate the same missing 2 kg as two separate incidents. Idempotency is
// carried by the database rather than by a flag:
//
//   • the status guard is a conditional UPDATE, so of two callers racing
//     exactly one sees a row change and the other learns it already happened;
//   • `VarianceCase.stockCountLineId` is `@unique`, so even if both got
//     through, `openVarianceCase` returns the winner's row rather than a twin.
//
// CONFIRMING DOES NOT MOVE STOCK. The shelf is changed to match a count by an
// explicit, audited COUNT_REBASE (T23), after confirmation and never as part
// of it. Fusing them would make "we agreed the count" and "we moved the
// stock" one act, leaving no moment at which somebody could look at the
// numbers before the shelf moved.
//
// The refusal names the offending lines. A 409 saying only "some lines are
// unsettled" leaves the person holding it with no move to make.

/**
 * What a count carrying an accountability context hands to the acceptance
 * that will answer for it.
 *
 * A count taken FOR a handover, or for a branch opening verification, is a
 * proposal nobody has accepted yet. Opening cases at confirmation would mean
 * a shortage is investigated — and a custody named on it — before anyone
 * agreed the figure was right. So confirmation opens nothing and returns this
 * instead; SH-20/21/22 open the cases from the accepted evidence.
 */
export type DeferredAccountability = {
  context: Exclude<StockCountAccountabilityContext, "NONE">;
  handoverId: string | null;
  openingBranchCustodyPeriodId: string | null;
};

export type ConfirmCountResult = {
  status: "CONFIRMED";
  confirmedAt: Date;
  varianceCaseIds: string[];
  alreadyConfirmed: boolean;
  /** NULL on the ordinary path — a count answering to nobody but itself. */
  deferred: DeferredAccountability | null;
};

export const COUNT_CONFIRMED_AUDIT_ACTION = "COUNT_CONFIRMED";

/** Statuses a confirmation may be applied to. */
const CONFIRMABLE: readonly StockCountStatus[] = ["SUBMITTED", "RECOUNT_REQUIRED"];

/** The cases already opened from this session's lines, in line order. */
async function casesFor(lineIds: string[]): Promise<string[]> {
  if (lineIds.length === 0) return [];
  const rows = await db.varianceCase.findMany({
    where: { stockCountLineId: { in: lineIds } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => r.id);
}

/**
 * Close the count, and open a case for every difference somebody accepted.
 *
 * A repeat with the key that already confirmed returns the first result and
 * creates nothing. A caller that lost a race learns the count is confirmed
 * rather than receiving an error about a state that is, from their point of
 * view, exactly what they asked for.
 */
export async function confirmCountSession(args: {
  sessionId: string;
  confirmedById: string;
  idempotencyKey: string;
  cafeId?: string;
  viewerBranchId?: string | null;
}): Promise<ConfirmCountResult> {
  if (!args.idempotencyKey) {
    throw new ApiError(400, "مفتاح التأكيد مطلوب");
  }

  const session = await db.stockCountSession.findUnique({
    where: { id: args.sessionId },
    select: {
      id: true,
      cafeId: true,
      branchId: true,
      shiftId: true,
      custodyPeriodId: true,
      status: true,
      confirmedAt: true,
      idempotencyKey: true,
      accountabilityContext: true,
      handoverId: true,
      openingBranchCustodyPeriodId: true,
      lines: {
        select: {
          ...EFFECTIVE_EVIDENCE_SELECT,
          disposition: true,
          confidence: true,
          costImpact: true,
          costImpactAvailable: true,
          costUnavailableReason: true,
        },
      },
    },
  });
  if (!session || (args.cafeId !== undefined && session.cafeId !== args.cafeId)) {
    throw new ApiError(404, "جلسة الجرد غير موجودة");
  }
  if (args.viewerBranchId && session.branchId !== args.viewerBranchId) {
    throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
  }

  const lineIds = session.lines.map((l) => l.id);

  // Resolved once, from the session, and returned identically from every
  // successful exit below. A retry that dropped the binding would leave the
  // acceptance nothing to key on, which is the failure this whole deferral
  // exists to prevent.
  const deferred: DeferredAccountability | null =
    session.accountabilityContext === "NONE"
      ? null
      : {
          context: session.accountabilityContext,
          handoverId: session.handoverId,
          openingBranchCustodyPeriodId: session.openingBranchCustodyPeriodId,
        };

  // Already done. Same key or not, the count is confirmed and saying so is
  // the truthful answer; what must never happen is a second set of cases.
  if (session.status === "CONFIRMED" || session.status === "LOCKED") {
    return {
      status: "CONFIRMED",
      confirmedAt: session.confirmedAt ?? new Date(),
      varianceCaseIds: await casesFor(lineIds),
      alreadyConfirmed: true,
      deferred,
    };
  }

  if (!CONFIRMABLE.includes(session.status)) {
    throw new ApiError(409, "لازم تسلّم الجرد الأول قبل ما تأكده");
  }

  const unsettled = session.lines.filter((l) => !isTerminal(l.disposition));
  if (unsettled.length > 0) {
    throw new ApiError(
      409,
      `في سطور لسه مش مقفولة (${unsettled.length}): ${unsettled.map((l) => l.id).join("، ")}`
    );
  }

  const confirmedAt = new Date();
  const accepted = session.lines.filter((l) => l.disposition === "VARIANCE_CONFIRMED");

  const outcome = await db.$transaction(async (tx) => {
    // The guard and the write are one statement, so two callers racing cannot
    // both see SUBMITTED and both proceed.
    const claimed = await tx.stockCountSession.updateMany({
      where: { id: session.id, status: { in: [...CONFIRMABLE] } },
      data: {
        status: "CONFIRMED",
        confirmedAt,
        confirmedById: args.confirmedById,
        idempotencyKey: args.idempotencyKey,
      },
    });
    if (claimed.count === 0) return { won: false, caseIds: [] as string[] };

    // The deferral, and the whole of it. Everything above this point runs
    // exactly as it did before M22 — the count is confirmed, its lines keep
    // their dispositions, the audit row is written. Only NONE takes the
    // generic case-opening path below; handover and branch-opening contexts
    // are answered later, by different atomic custody transactions.
    if (deferred) return { won: true, caseIds: [] as string[] };

    const caseIds: string[] = [];
    for (const line of accepted) {
      const impact = line.costImpactAvailable
        ? ({ available: true, value: Number(line.costImpact) } as const)
        : ({
            available: false,
            reason:
              (line.costUnavailableReason as
                | "MISSING_COST"
                | "UNTRUSTED_COST"
                | "CONFIDENCE_NOT_VERIFIED") ?? "MISSING_COST",
          } as const);

      const opened = await openVarianceCase(tx, {
        cafeId: session.cafeId,
        branchId: session.branchId,
        type: "STOCK",
        shiftId: session.shiftId,
        custodyPeriodId: session.custodyPeriodId,
        source: { kind: "STOCK_LINE", stockCountLineId: line.id },
        // The gap the evidence in force actually found. After a recount that
        // is the recount's, so an investigation is opened on the figure
        // somebody last stood in front of the shelf and wrote down.
        quantityVariance: effectiveCountEvidence(line).varianceQuantity,
        // An unpriced difference has no amount to measure a threshold
        // against, which is why `caseIsBlocking` never blocks on one.
        amountVariance: impact.available ? impact.value : null,
        financialImpact: impact,
        confidence: line.confidence,
        openedById: args.confirmedById,
      });
      caseIds.push(opened.caseId);
    }
    return { won: true, caseIds };
  });

  if (!outcome.won) {
    // Somebody else confirmed it a moment ago. Their cases are the cases.
    const current = await db.stockCountSession.findUniqueOrThrow({
      where: { id: session.id },
      select: { confirmedAt: true },
    });
    return {
      status: "CONFIRMED",
      confirmedAt: current.confirmedAt ?? confirmedAt,
      varianceCaseIds: await casesFor(lineIds),
      alreadyConfirmed: true,
      deferred,
    };
  }

  await audit({
    cafeId: session.cafeId,
    userId: args.confirmedById,
    action: COUNT_CONFIRMED_AUDIT_ACTION,
    entity: "StockCountSession",
    entityId: session.id,
    details: {
      branchId: session.branchId,
      lineCount: session.lines.length,
      acceptedVarianceLines: accepted.length,
      varianceCaseIds: outcome.caseIds,
      deferredContext: deferred?.context ?? null,
      idempotencyKey: args.idempotencyKey,
    },
  });

  return {
    status: "CONFIRMED",
    confirmedAt,
    varianceCaseIds: outcome.caseIds,
    alreadyConfirmed: false,
    deferred,
  };
}

// ──────────────────── Corrections and the effective figure ───────────
//
// Somebody miscounts, or writes 15 where they meant 1.5. The count has to be
// correctable, and the correction must not destroy the thing it corrects.
//
// That is why a line carries two numbers which must never collapse into one:
//
//   countedQuantity           what was observed. Evidence. Written once at
//                             capture and never again.
//   effectiveCountedQuantity  what the business acts on. Equals the
//                             observation until an APPROVED correction
//                             supersedes it.
//
// `countedQuantity` is absent from the approval's update payload, not merely
// set to its own value. An investigation into a repeated shortage needs to
// see that a figure was corrected and by how much; overwriting the original
// would erase exactly that, leaving a tidy record of a count that was always
// right.
//
// A correction is also not something one person does alone. It costs a reason
// code from the café's own STOCK vocabulary and a second signature — and
// holding `stock_count.approve_correction` is not the same as being a second
// person, so the author is refused their own approval whatever keys they
// hold. Every attempt, approved or not, stays readable: the trail is the
// point of having corrections at all.

export const CORRECTION_CREATED_AUDIT_ACTION = "CORRECTION_CREATED";
export const CORRECTION_APPROVED_AUDIT_ACTION = "CORRECTION_APPROVED";

/** A STOCK reason code of this café's, or a refusal saying which it was. */
async function assertStockReason(reasonCodeId: string, cafeId: string) {
  if (!reasonCodeId) throw new ApiError(400, "لازم تحدد سبب التصحيح");
  const reason = await db.reasonCode.findUnique({
    where: { id: reasonCodeId },
    select: { cafeId: true, domain: true, isActive: true },
  });
  if (!reason || reason.cafeId !== cafeId || reason.domain !== "STOCK") {
    throw new ApiError(400, "سبب التصحيح مش من أسباب المخزون بتاعة الكافيه");
  }
  if (!reason.isActive) throw new ApiError(400, "سبب التصحيح ده متوقف");
}

/**
 * Propose a different figure for a counted line.
 *
 * Records what it is replacing — the figure currently IN FORCE, which after
 * an earlier approved correction is that correction's value rather than the
 * original observation. Writes nothing to the line: a proposal is not a
 * decision, and a line that moved on proposal would let one person correct a
 * count by simply asking to.
 */
export async function createCountCorrection(args: {
  lineId: string;
  newCountedQuantity: number;
  reasonCodeId: string;
  note?: string;
  actorId: string;
  sessionId?: string;
  cafeId?: string;
  viewerBranchId?: string | null;
}): Promise<{ correctionId: string; status: "PENDING_APPROVAL" }> {
  if (!Number.isFinite(args.newCountedQuantity) || args.newCountedQuantity < 0) {
    throw new ApiError(400, "الكمية المصححة لازم تكون رقم مش سالب");
  }

  const line = await db.stockCountLine.findUnique({
    where: { id: args.lineId },
    select: {
      ...EFFECTIVE_EVIDENCE_SELECT,
      sessionId: true,
      session: { select: { id: true, cafeId: true, branchId: true, status: true } },
    },
  });
  const wrongSession = args.sessionId !== undefined && line?.sessionId !== args.sessionId;
  const wrongCafe = args.cafeId !== undefined && line?.session.cafeId !== args.cafeId;
  if (!line || wrongSession || wrongCafe) {
    throw new ApiError(404, "سطر الجرد غير موجود");
  }
  if (args.viewerBranchId && line.session.branchId !== args.viewerBranchId) {
    throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
  }
  if (line.countedQuantity === null) {
    throw new ApiError(400, "مفيش كمية معدودة تتصحح — الصنف ده لسه ما اتعدش");
  }

  // A recount is a second physical observation, and `StockCountCorrection`
  // records which FIGURE it replaces but not which OBSERVATION. Correcting on
  // top of a recount would therefore leave nothing able to say whether the
  // corrected quantity belongs to the first count's cursor or the recount's —
  // and the rebase needs that answer to know which movements to replay.
  // Refused rather than guessed. A recount is the way to change a figure once
  // somebody has walked back to the shelf.
  if (hasSupersedingRecount(line)) {
    throw new ApiError(
      409,
      "الصنف ده اتعاد عده — عدّل عن طريق إعادة عد تانية، مش تصحيح (recount supersedes correction)"
    );
  }

  await assertStockReason(args.reasonCodeId, line.session.cafeId);

  // What is being superseded is the figure in force, not necessarily the
  // original observation: correcting a correction starts from where the line
  // stands. Taken from the resolver so it cannot disagree with what a rebase
  // would act on.
  const oldCountedQuantity = effectiveCountEvidence(line).quantity;
  const newCountedQuantity = round3(args.newCountedQuantity);

  // Changing a figure the incoming custodian has already accepted is a
  // different act from correcting a draft, and a reviewer needs to be able to
  // tell which one they are looking at.
  const postCustodyTransfer = isCountLocked(line.session);

  const correction = await db.stockCountCorrection.create({
    data: {
      lineId: line.id,
      oldCountedQuantity,
      newCountedQuantity,
      reasonCodeId: args.reasonCodeId,
      note: args.note ?? null,
      actorId: args.actorId,
      status: "PENDING_APPROVAL",
      postCustodyTransfer,
    },
    select: { id: true },
  });

  await audit({
    cafeId: line.session.cafeId,
    userId: args.actorId,
    action: CORRECTION_CREATED_AUDIT_ACTION,
    entity: "StockCountCorrection",
    entityId: correction.id,
    details: {
      sessionId: line.session.id,
      lineId: line.id,
      oldCountedQuantity,
      newCountedQuantity,
      reasonCodeId: args.reasonCodeId,
      note: args.note ?? null,
      postCustodyTransfer,
    },
  });

  return { correctionId: correction.id, status: "PENDING_APPROVAL" };
}

/**
 * THE only writer of `effectiveCountedQuantity` after capture.
 *
 * One transaction: mark the correction approved, move the working figure, and
 * recompute the variance from it. `countedQuantity` is not in the update
 * payload at all — COUNT-013 reads the raw column as text before and after,
 * so a value that merely formats the same cannot pass for one that was left
 * alone.
 */
export async function approveCountCorrection(args: {
  correctionId: string;
  approvedById: string;
  cafeId?: string;
  viewerBranchId?: string | null;
}): Promise<{ correctionId: string; effectiveCountedQuantity: number; varianceQuantity: number }> {
  const correction = await db.stockCountCorrection.findUnique({
    where: { id: args.correctionId },
    select: {
      id: true,
      status: true,
      actorId: true,
      oldCountedQuantity: true,
      newCountedQuantity: true,
      line: {
        select: {
          id: true,
          expectedQuantity: true,
          session: { select: { id: true, cafeId: true, branchId: true } },
        },
      },
    },
  });
  if (
    !correction ||
    (args.cafeId !== undefined && correction.line.session.cafeId !== args.cafeId)
  ) {
    throw new ApiError(404, "التصحيح غير موجود");
  }
  if (args.viewerBranchId && correction.line.session.branchId !== args.viewerBranchId) {
    throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
  }
  if (correction.status !== "PENDING_APPROVAL") {
    throw new ApiError(409, "التصحيح ده اتبتّ فيه خلاص");
  }
  // Holding the key is not the same as being a second person.
  if (correction.actorId === args.approvedById) {
    throw new ApiError(403, "مينفعش تعتمد تصحيح انت اللي طلبته — لازم توقيع تاني");
  }

  const effective = round3(Number(correction.newCountedQuantity));
  const variance = round3(effective - Number(correction.line.expectedQuantity ?? 0));
  const approvedAt = new Date();

  await db.$transaction(async (tx) => {
    // Conditional, so two approvals racing move the figure once.
    const claimed = await tx.stockCountCorrection.updateMany({
      where: { id: correction.id, status: "PENDING_APPROVAL" },
      data: { status: "APPROVED", approvedById: args.approvedById, approvedAt },
    });
    if (claimed.count === 0) throw new ApiError(409, "التصحيح ده اتبتّ فيه خلاص");

    await tx.stockCountLine.update({
      where: { id: correction.line.id },
      data: {
        // `countedQuantity` is deliberately absent. See the note above.
        effectiveCountedQuantity: effective,
        varianceQuantity: variance,
      },
    });
  });

  await audit({
    cafeId: correction.line.session.cafeId,
    userId: args.approvedById,
    action: CORRECTION_APPROVED_AUDIT_ACTION,
    entity: "StockCountCorrection",
    entityId: correction.id,
    details: {
      sessionId: correction.line.session.id,
      lineId: correction.line.id,
      oldCountedQuantity: Number(correction.oldCountedQuantity),
      effectiveCountedQuantity: effective,
      varianceQuantity: variance,
      requestedById: correction.actorId,
    },
  });

  return { correctionId: correction.id, effectiveCountedQuantity: effective, varianceQuantity: variance };
}

// ─────────────────────────── The LOCKED state ────────────────────────
//
// A state that means nothing is worse than no state, because readers infer
// meaning from the name. `LOCKED` sat in the enum through the whole schema
// phase without one. It now has exactly one entry point and exactly one
// consequence.
//
// ENTRY. A CONFIRMED session becomes LOCKED when an accepted handover has
// rebased stock from it and transferred custody. `lockedByHandoverId` names
// that handover, so why a count is closed reads off the count itself instead
// of being inferred from dates.
//
// CONSEQUENCE. Correcting a locked count is still possible — a mistake found
// after a handover is still a mistake — but it is flagged
// `postCustodyTransfer`. Changing a figure the incoming custodian has already
// accepted is a different act from correcting a draft, and a reviewer needs
// to be able to tell which one they are looking at. Locking changes the flag,
// not the approval requirement: the second signature is still required.

/** The state a session is created in. Nothing transitions INTO it. */
export const COUNT_SESSION_ENTRY_STATUS: StockCountStatus = "DRAFT";

/**
 * Every legal session move, and the runtime that makes each one.
 *
 * DRAFT            → IN_PROGRESS       first capture (`recordCountLine`)
 * IN_PROGRESS      → SUBMITTED | RECOUNT_REQUIRED   `submitCountSession`
 * SUBMITTED        → RECOUNT_REQUIRED  a re-submission that found a gap
 * SUBMITTED        → CONFIRMED         `confirmCountSession`
 * RECOUNT_REQUIRED → SUBMITTED         re-submitted once recounts resolved
 * RECOUNT_REQUIRED → CONFIRMED         every line settled, including accepted
 * CONFIRMED        → LOCKED            `lockCountSession`, from a handover
 *
 * LOCKED leads nowhere. Reopening a count another party has accepted would
 * let the record of what they accepted be quietly rewritten.
 */
export const COUNT_SESSION_TRANSITIONS: Record<StockCountStatus, StockCountStatus[]> = {
  DRAFT: ["IN_PROGRESS"],
  IN_PROGRESS: ["SUBMITTED", "RECOUNT_REQUIRED"],
  SUBMITTED: ["RECOUNT_REQUIRED", "CONFIRMED"],
  RECOUNT_REQUIRED: ["SUBMITTED", "CONFIRMED"],
  CONFIRMED: ["LOCKED"],
  LOCKED: [],
};

export function isCountLocked(s: { status: StockCountStatus }): boolean {
  return s.status === "LOCKED";
}

export const COUNT_LOCKED_AUDIT_ACTION = "COUNT_LOCKED";

/**
 * Freeze a confirmed count as the baseline a handover accepted.
 *
 * Takes the caller's transaction client and never opens its own, for the same
 * reason custody's mutators do not: accepting a handover closes one custody,
 * opens the next, rebases stock and locks the count it rebased from as ONE
 * act. A lock that committed independently would be a statement about a
 * custody transfer that may not have happened.
 *
 * The audit row goes through `auditInTransaction` for that same reason — it
 * commits or rolls back with the lock, rather than recording a freeze that
 * was undone a moment later.
 */
export async function lockCountSession(
  tx: Prisma.TransactionClient,
  args: { sessionId: string; handoverId: string; actorId?: string | null }
): Promise<{ status: "LOCKED"; lockedAt: Date }> {
  const session = await tx.stockCountSession.findUnique({
    where: { id: args.sessionId },
    select: { id: true, cafeId: true, branchId: true, status: true },
  });
  if (!session) throw new ApiError(404, "جلسة الجرد غير موجودة");
  if (session.status !== "CONFIRMED") {
    throw new ApiError(
      409,
      "مينفعش تقفل جرد لسه متأكدش — الجلسة لازم تكون CONFIRMED"
    );
  }

  const handover = await tx.handoverSession.findUnique({
    where: { id: args.handoverId },
    select: { cafeId: true, branchId: true },
  });
  if (!handover) throw new ApiError(404, "جلسة التسليم غير موجودة");
  if (handover.cafeId !== session.cafeId || handover.branchId !== session.branchId) {
    throw new ApiError(400, "التسليم مش تابع لنفس الفرع");
  }

  const lockedAt = new Date();
  await tx.stockCountSession.update({
    where: { id: session.id },
    data: { status: "LOCKED", lockedAt, lockedByHandoverId: args.handoverId },
  });

  await auditInTransaction(tx, {
    cafeId: session.cafeId,
    userId: args.actorId ?? null,
    action: COUNT_LOCKED_AUDIT_ACTION,
    entity: "StockCountSession",
    entityId: session.id,
    details: {
      branchId: session.branchId,
      handoverId: args.handoverId,
      lockedAt: lockedAt.toISOString(),
    },
  });

  return { status: "LOCKED", lockedAt };
}
