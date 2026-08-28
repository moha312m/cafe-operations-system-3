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
  Prisma,
  StockCountMode,
  StockCountStatus,
  StockCountType,
} from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { activeCustody } from "@/lib/custody";
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
