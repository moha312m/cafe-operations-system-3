// ── Handover accountability report ───────────────────────────────────────
// One read-only, masked payload per request. The screen, the print page, CSV
// and XLSX all render from it, so their totals cannot disagree.
//
// Owner decisions applied here (R1–R10):
//  R1  A close variance (counted − expected, as stored by the close) belongs
//      to the shift's cashier — the person who held the drawer, not whoever
//      signed the close.
//  R2  An ingredient variance belongs to its custody: one participant on a
//      VERIFIED_SHIFT case names that person; several participants, a period
//      gap (PERIOD_UNRESOLVED) or branch custody is listed as shared and never
//      split. An owner who already assigned responsibility on the case wins.
//  R3  Valued at the cost stored with the count line (cost at count time).
//  R4  Delivery disputes stay in their own columns; nothing in the data
//      assigns a delivery shortfall to anyone, so none is added to a cashier.
//  R5  Shortage and overage are always separate; net is shown beside them.
//  R6  Business day = the Cairo calendar day of the close.
//  R9  A difference found when the next person counted the cash is between
//      two people, so it is shared, naming both.
//  R10 Ingredient money values need `purchases.view_cost` (or the owner).
// «لم يُسجَّل» is never zero: unrecorded figures are excluded from totals and
// counted as exceptions instead.
import type { Prisma, Role } from "@prisma/client";
import { db } from "@/lib/db";
import { addDays, dateStrInTz, zonedDayStart } from "@/lib/date-range";
import { decimal, money, type Decimal, type Numeric } from "@/lib/money";
import { EXCEPTION_LABELS, MODE_LABELS, PERIOD_LABELS, REPORT_TZ, formatAmount } from "@/lib/reports/handover-accountability-format";
export { EXCEPTION_LABELS, MODE_LABELS, PERIOD_LABELS };

// ─────────────────────────────── Period ───────────────────────────────

export const PERIOD_KEYS = ["today", "yesterday", "this_week", "this_month", "last_month", "custom"] as const;
export type PeriodKey = (typeof PERIOD_KEYS)[number];
/** The longest range one request may read. A month always fits. */
export const MAX_RANGE_DAYS = 93;

export type ResolvedPeriod = { key: PeriodKey; from: string; to: string; start: Date; end: Date };

const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(value: string) {
  const d = new Date(value + "T00:00:00Z");
  return VALID_DATE.test(value) && Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) + 1;
}

/** Cairo calendar days; the week runs Saturday to Friday. `end` is exclusive. */
export function resolvePeriod(key: PeriodKey, custom: { from?: string | null; to?: string | null }, now = new Date()): ResolvedPeriod | { error: string } {
  const today = dateStrInTz(now, REPORT_TZ);
  let from: string, to: string;
  switch (key) {
    case "today": from = to = today; break;
    case "yesterday": from = to = addDays(today, -1); break;
    case "this_week": {
      const weekday = new Date(today + "T12:00:00Z").getUTCDay(); // 6 = Saturday
      from = addDays(today, -((weekday + 1) % 7)); to = today; break;
    }
    case "this_month": from = today.slice(0, 8) + "01"; to = today; break;
    case "last_month": {
      const firstThis = today.slice(0, 8) + "01";
      to = addDays(firstThis, -1); from = to.slice(0, 8) + "01"; break;
    }
    case "custom": {
      if (!custom.from || !custom.to || !validDate(custom.from) || !validDate(custom.to)) return { error: "تاريخ غير صالح" };
      if (custom.from > custom.to) return { error: "تاريخ البداية بعد تاريخ النهاية" };
      from = custom.from; to = custom.to; break;
    }
  }
  if (daysBetween(from, to) > MAX_RANGE_DAYS) return { error: `أقصى مدة للتقرير ${MAX_RANGE_DAYS} يومًا` };
  return { key, from, to, start: zonedDayStart(from, REPORT_TZ), end: zonedDayStart(addDays(to, 1), REPORT_TZ) };
}

// ─────────────────────────────── Payload ───────────────────────────────

export type Person = { id: string; name: string; role: Role; active: boolean };
export type Tone = "success" | "danger" | "warning" | "info" | "neutral";
export type StatusChip = { code: string; label: string; tone: Tone };
export type HandoverMode = keyof typeof MODE_LABELS;

export type LedgerRow = {
  id: string;
  kind: "CLOSE" | "OPENING";
  at: string;
  businessDate: string;
  branch: { id: string; name: string };
  shift: { id: string; number: number };
  outgoing: Person | null;
  incoming: Person | null;
  mode: HandoverMode | null;
  handoverId: string | null;
  handoverStatus: string | null;
  cash: {
    /** Stored by the close (`recomputeShiftTotals`); never re-derived. */
    expected: number | null;
    counted: number | null;
    variance: number | null;
    shortage: number | null;
    overage: number | null;
    reason: string | null;
    retained: number | null;
    delivered: number | null;
    deliveries: { declared: number; confirmed: number; pending: number; disputed: number; resolvedShortfall: number; pendingCount: number; disputedCount: number };
    /** R9: what the next person's count found, between the two of them. */
    receiving: number | null;
  };
  stock: { items: number; shortageValue: number | null; overageValue: number | null; unpriced: number; notCounted: number };
  issues: { open: number; resolved: number };
  /** The receiving shift's place and equipment inspection. */
  place: { status: string; faults: number; openIncidents: number } | null;
  note: string | null;
  statuses: StatusChip[];
  exception: boolean;
};

export type IngredientLine = {
  id: string;
  at: string;
  businessDate: string;
  branch: { id: string; name: string };
  item: { id: string; name: string };
  unit: string | null;
  expected: number | null;
  counted: number | null;
  difference: number | null;
  unitCost: number | null;
  costBasis: "COUNT_TIME" | null;
  /** Signed: negative is a shortage. Null when unpriced or hidden. */
  value: number | null;
  priced: boolean;
  attribution: "PERSON" | "SHARED";
  basis: "ASSIGNED" | "CUSTODY" | "PERIOD" | "SEVERAL" | "BRANCH";
  employee: Person | null;
  participants: Person[];
  shifts: number[];
  handoverId: string | null;
  caseStatus: string;
};

export type ExceptionKind = keyof typeof EXCEPTION_LABELS;
export type ExceptionRow = {
  id: string; kind: ExceptionKind; label: string; at: string; businessDate: string;
  branch: { id: string; name: string }; shiftNumber: number | null; people: Person[];
  amount: number | null; note: string | null; stale: boolean;
};

export type EmployeeSummary = {
  employee: Person;
  shiftsClosed: number;
  handoversReceived: number;
  cash: { expected: number; counted: number; shortage: number; overage: number; net: number; notCounted: number };
  deliveries: { declared: number; confirmed: number; pending: number; disputed: number; resolvedShortfall: number };
  stock: { items: number; shortageValue: number | null; overageValue: number | null; net: number | null; unpriced: number };
  /** Listed in full for every person involved, never split (R2/R9). */
  shared: { count: number; stockValue: number | null; cashAmount: number };
  grossVariance: number;
  flags: StatusChip[];
};

export type AccountabilityReport = {
  period: { key: PeriodKey; label: string; from: string; to: string; timezone: string; dayBasis: string };
  branch: { id: string; name: string } | null;
  employeeFilter: Person | null;
  exceptionsOnly: boolean;
  generatedAt: string;
  generatedBy: { id: string; name: string };
  visibility: { ingredientValues: boolean };
  kpis: {
    handovers: number;
    closes: number;
    openingsWithoutReceipt: number;
    closesWithoutCount: number;
    matched: number;
    cashShortage: number; cashOverage: number; cashNet: number;
    ingredientShortage: number | null; ingredientOverage: number | null; ingredientNet: number | null; ingredientUnpriced: number;
    sharedCount: number; sharedStockShortage: number | null; sharedStockOverage: number | null; sharedCashShortage: number; sharedCashOverage: number;
    openDisputes: number; pendingDeliveries: number; staleDeliveries: number; openIssues: number; stockNotCounted: number;
    exceptions: number;
  };
  employees: EmployeeSummary[];
  employeeTotals: Omit<EmployeeSummary, "employee" | "flags" | "shared">;
  ledger: LedgerRow[];
  ledgerTotals: {
    rows: number; expected: number; counted: number; shortage: number; overage: number; retained: number; delivered: number;
    receiving: number; stockItems: number; stockShortage: number | null; stockOverage: number | null;
  };
  ingredients: IngredientLine[];
  ingredientTotals: { lines: number; shortageValue: number | null; overageValue: number | null; net: number | null; unpriced: number };
  exceptions: ExceptionRow[];
};

// ─────────────────────────────── Queries ───────────────────────────────

const PERSON = { id: true, name: true, role: true, isActive: true, archivedAt: true } as const;
type PersonRow = { id: string; name: string; role: Role; isActive: boolean; archivedAt: Date | null };
const person = (p: PersonRow): Person => ({ id: p.id, name: p.name, role: p.role, active: p.isActive && !p.archivedAt });

const PLACE = { status: true, observations: { select: { condition: true, incident: { select: { status: true } } } } } as const;
type PlaceRow = { status: string; observations: { condition: string; incident: { status: string } | null }[] } | null;
// The same reading the opening-receipts page made of a place receipt.
function place(p: PlaceRow): LedgerRow["place"] {
  if (!p) return null;
  const faults = p.observations.filter((o) => o.condition === "FAULT").length;
  const openIncidents = p.observations.filter((o) => o.incident?.status === "OPEN").length;
  const status = p.status === "ACCEPTED" || p.status === "OVERRIDDEN" ? p.status : faults ? "FAULT" : p.observations.length ? "IN_PROGRESS" : "PENDING";
  return { status, faults, openIncidents };
}

const CLOSED_SHIFT = {
  id: true, shiftNumber: true, openedAt: true, closedAt: true, financiallyClosedAt: true,
  expectedCashAmount: true, actualCashAmount: true, cashDifference: true, cashReasonNote: true,
  branch: { select: { id: true, name: true } },
  cashier: { select: PERSON },
  cashDisposition: {
    select: {
      retainedAmount: true, deliveredAmount: true,
      deliveries: { orderBy: { declaredAt: "asc" }, select: { id: true, amount: true, status: true, declaredAt: true, resolvedAmount: true, disputeNote: true, recipient: { select: PERSON } } },
    },
  },
  handoversOutgoing: {
    orderBy: { createdAt: "desc" }, take: 1,
    select: {
      id: true, status: true, target: true, resolvedTarget: true, directHandover: true, acceptedAt: true, completedAt: true,
      cashVarianceAmount: true, cashVerifiedAt: true,
      incomingUser: { select: PERSON },
      incomingShift: { select: { cashier: { select: PERSON }, placeReceipt: { select: PLACE } } },
      cashStorage: { select: { id: true, receipt: { select: { status: true, varianceAmount: true, claimant: { select: PERSON } } } } },
      issues: { orderBy: { reportedAt: "asc" }, select: { id: true, status: true, kind: true, reportedAt: true, description: true, reportedBy: { select: PERSON } } },
      _count: { select: { stockBoundaries: { where: { source: "SYSTEM_CARRIED" } } } },
    },
  },
} satisfies Prisma.ShiftSelect;
type ClosedShift = Prisma.ShiftGetPayload<{ select: typeof CLOSED_SHIFT }>;

const OPENED_SHIFT = {
  id: true, shiftNumber: true, openedAt: true, branch: { select: { id: true, name: true } }, cashier: { select: PERSON },
  openingExceptions: { select: { kind: true } },
  placeReceipt: { select: PLACE },
} satisfies Prisma.ShiftSelect;

const CUSTODY = { holderType: true, participants: { select: { user: { select: PERSON } } }, responsibleShift: { select: { shiftNumber: true } } } as const;
const STOCK_CASE = {
  id: true, openedAt: true, status: true, attribution: true, confidence: true, quantityVariance: true, financialImpact: true, financialImpactAvailable: true,
  branch: { select: { id: true, name: true } },
  shift: { select: { shiftNumber: true, cashier: { select: PERSON } } },
  assignedResponsibility: { select: PERSON },
  custodyPeriod: { select: CUSTODY },
  stockCountLine: { select: { unit: true, expectedQuantity: true, countedQuantity: true, effectiveCountedQuantity: true, unitCostSnapshot: true, inventoryItem: { select: { id: true, name: true } } } },
  acceptedHandover: { select: { id: true, outgoingUser: { select: PERSON }, outgoingShift: { select: { shiftNumber: true } } } },
  varianceSpan: { select: { custodyLinks: { select: { custodyPeriod: { select: CUSTODY } } } } },
} satisfies Prisma.VarianceCaseSelect;
type StockCase = Prisma.VarianceCaseGetPayload<{ select: typeof STOCK_CASE }>;

const BATCH = 500;
/** Keyset pages through a cafe-scoped query so a month never hits a row cap. */
async function all<T extends { id: string }>(page: (cursor: string | undefined) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const batch = await page(cursor);
    out.push(...batch);
    if (batch.length < BATCH) return out;
    cursor = batch[batch.length - 1].id;
  }
}
const pageArgs = (cursor: string | undefined) => ({ orderBy: { id: "asc" as const }, take: BATCH, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });

// ─────────────────────────────── Arithmetic ───────────────────────────────

const ZERO = () => decimal(0);
const num = (v: Numeric | null | undefined) => (v === null || v === undefined ? null : decimal(v));
const out = (d: Decimal) => money(d).toNumber();
const qty = (v: Numeric | null | undefined) => (v === null || v === undefined ? null : decimal(v).toDecimalPlaces(3).toNumber());

// ─────────────────────────────── Build ───────────────────────────────

export type ReportArgs = {
  cafeId: string;
  branchId?: string;
  employeeId?: string;
  exceptionsOnly?: boolean;
  period: ResolvedPeriod;
  viewer: { id: string; name: string; role: Role; keys: Set<string> };
  now?: Date;
};

const ACCEPTED = new Set(["ACCEPTED", "COMPLETED"]);
const STALE_MS = 24 * 3600 * 1000;

export async function loadHandoverAccountability(args: ReportArgs): Promise<AccountabilityReport> {
  const now = args.now ?? new Date();
  const window = { gte: args.period.start, lt: args.period.end };
  const scope = { cafeId: args.cafeId, ...(args.branchId ? { branchId: args.branchId } : {}) };
  const canSeeCost = args.viewer.role === "CAFE_OWNER" || args.viewer.keys.has("purchases.view_cost");

  // One read-only transaction: every section sees the same snapshot.
  const [closed, opened, cases, branch, employeeFilter] = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return Promise.all([
      all<ClosedShift>((c) => tx.shift.findMany({ where: { ...scope, OR: [{ financiallyClosedAt: window }, { financiallyClosedAt: null, closedAt: window }] }, select: CLOSED_SHIFT, ...pageArgs(c) })),
      all((c) => tx.shift.findMany({ where: { ...scope, openedAt: window, openingCashReceipt: { is: null }, handoversIncoming: { none: { status: { in: ["ACCEPTED", "COMPLETED"] } } } }, select: OPENED_SHIFT, ...pageArgs(c) })),
      all<StockCase>((c) => tx.varianceCase.findMany({ where: { ...scope, type: "STOCK", openedAt: window }, select: STOCK_CASE, ...pageArgs(c) })),
      args.branchId ? tx.branch.findFirst({ where: { id: args.branchId, cafeId: args.cafeId }, select: { id: true, name: true } }) : null,
      args.employeeId ? tx.user.findFirst({ where: { id: args.employeeId, cafeId: args.cafeId }, select: PERSON }) : null,
    ]);
  }, { isolationLevel: "RepeatableRead", timeout: 60000 });

  // ── Ingredient lines (R2/R3/R10) ──
  const ingredients: IngredientLine[] = cases.map((c) => stockLine(c, canSeeCost));
  const linesByHandover = new Map<string, IngredientLine[]>();
  for (const line of ingredients) if (line.handoverId) linesByHandover.set(line.handoverId, [...(linesByHandover.get(line.handoverId) ?? []), line]);

  // ── Ledger and exceptions ──
  const ledger: LedgerRow[] = [];
  const exceptions: ExceptionRow[] = [];
  const exception = (row: Omit<ExceptionRow, "label" | "businessDate">) => exceptions.push({ ...row, label: EXCEPTION_LABELS[row.kind], businessDate: dateStrInTz(new Date(row.at), REPORT_TZ) });

  for (const s of closed) ledger.push(closeRow(s, linesByHandover, now, exception));
  for (const s of opened) {
    const at = s.openedAt.toISOString();
    const kinds = s.openingExceptions.map((e) => OPENING_KIND_LABELS[e.kind] ?? e.kind);
    const note = kinds.length ? `اعتماد فتح: ${kinds.join("، ")}` : null;
    const cashier = person(s.cashier);
    ledger.push({
      id: `open:${s.id}`, kind: "OPENING", at, businessDate: dateStrInTz(s.openedAt, REPORT_TZ), branch: s.branch, shift: { id: s.id, number: s.shiftNumber },
      outgoing: null, incoming: cashier, mode: null, handoverId: null, handoverStatus: null,
      cash: { expected: null, counted: null, variance: null, shortage: null, overage: null, reason: null, retained: null, delivered: null,
        deliveries: { declared: 0, confirmed: 0, pending: 0, disputed: 0, resolvedShortfall: 0, pendingCount: 0, disputedCount: 0 }, receiving: null },
      stock: { items: 0, shortageValue: canSeeCost ? 0 : null, overageValue: canSeeCost ? 0 : null, unpriced: 0, notCounted: 0 },
      issues: { open: 0, resolved: 0 }, place: place(s.placeReceipt), note,
      statuses: [{ code: "NO_RECEIPT", label: "لم يُسجَّل استلام", tone: "danger" }], exception: true,
    });
    exception({ id: `open:${s.id}`, kind: "OPENING_WITHOUT_RECEIPT", at, branch: s.branch, shiftNumber: s.shiftNumber, people: [cashier], amount: null, note, stale: false });
  }
  for (const line of ingredients) if (!line.priced && canSeeCost) {
    exception({ id: `unpriced:${line.id}`, kind: "STOCK_UNPRICED", at: line.at, branch: line.branch, shiftNumber: line.shifts[0] ?? null,
      people: line.employee ? [line.employee] : line.participants, amount: null, note: line.item.name, stale: false });
  }

  // ── Employee filter: rows that involve the person ──
  const involves = (people: (Person | null)[]) => !args.employeeId || people.some((p) => p?.id === args.employeeId);
  const fLedger = ledger.filter((r) => involves([r.outgoing, r.incoming]));
  const fIngredients = ingredients.filter((l) => involves([l.employee, ...l.participants]));
  const fExceptions = exceptions.filter((e) => involves(e.people));

  // ── Per-employee summary ──
  const people = new Map<string, Acc>();
  const ensure = (p: Person) => {
    let a = people.get(p.id);
    if (!a) { a = newAcc(p); people.set(p.id, a); }
    return a;
  };
  for (const r of fLedger) {
    if (r.kind === "CLOSE" && r.outgoing) {
      const a = ensure(r.outgoing);
      a.shiftsClosed++;
      if (r.cash.counted === null) a.notCounted++;
      else {
        a.expected = a.expected.plus(r.cash.expected!); a.counted = a.counted.plus(r.cash.counted);
        a.shortage = a.shortage.plus(r.cash.shortage!); a.overage = a.overage.plus(r.cash.overage!);
      }
      const d = r.cash.deliveries;
      a.declared = a.declared.plus(d.declared); a.confirmed = a.confirmed.plus(d.confirmed); a.pending = a.pending.plus(d.pending);
      a.disputed = a.disputed.plus(d.disputed); a.resolvedShortfall = a.resolvedShortfall.plus(d.resolvedShortfall);
      for (const s of r.statuses) if (s.tone === "danger" || s.tone === "warning") a.flags.set(s.code, s);
      if (r.cash.receiving !== null && r.cash.receiving !== 0) {
        for (const p of [r.outgoing, r.incoming]) if (p) { const b = ensure(p); b.sharedCount++; b.sharedCash = b.sharedCash.plus(r.cash.receiving); }
      }
    }
    if (r.incoming && (r.kind === "OPENING" || (r.handoverStatus && ACCEPTED.has(r.handoverStatus)))) {
      const a = ensure(r.incoming);
      if (r.kind === "CLOSE") a.handoversReceived++;
      else a.flags.set("NO_RECEIPT", r.statuses[0]);
    }
  }
  for (const l of fIngredients) {
    if (l.attribution === "PERSON" && l.employee) {
      const a = ensure(l.employee);
      a.stockItems++;
      if (!l.priced) a.stockUnpriced++;
      else if (l.value !== null) {
        if (l.value < 0) a.stockShortage = a.stockShortage.plus(-l.value); else a.stockOverage = a.stockOverage.plus(l.value);
      }
    } else {
      for (const p of l.participants) {
        const a = ensure(p);
        a.sharedCount++;
        if (l.value !== null) a.sharedStock = a.sharedStock.plus(l.value);
      }
    }
  }
  const visible = (p: Person) => !args.employeeId || p.id === args.employeeId;
  let employees = [...people.values()].filter((a) => visible(a.person)).map((a) => summary(a, canSeeCost));
  employees.sort((x, y) => y.grossVariance - x.grossVariance || x.employee.name.localeCompare(y.employee.name, "ar"));

  // ── KPIs (before the exceptions-only view narrows the tables) ──
  const closes = fLedger.filter((r) => r.kind === "CLOSE");
  const sumE = (pick: (e: EmployeeSummary) => number | null) => employees.reduce((s, e) => s.plus(pick(e) ?? 0), ZERO());
  const shared = fIngredients.filter((l) => l.attribution === "SHARED");
  const sharedStockShortage = shared.reduce((s, l) => (l.value !== null && l.value < 0 ? s.plus(-l.value) : s), ZERO());
  const sharedStockOverage = shared.reduce((s, l) => (l.value !== null && l.value > 0 ? s.plus(l.value) : s), ZERO());
  const receiving = closes.filter((r) => r.cash.receiving !== null && r.cash.receiving !== 0);
  const cashShortage = sumE((e) => e.cash.shortage), cashOverage = sumE((e) => e.cash.overage);
  const ingShortage = sumE((e) => e.stock.shortageValue), ingOverage = sumE((e) => e.stock.overageValue);
  const kpis: AccountabilityReport["kpis"] = {
    handovers: closes.filter((r) => r.handoverId).length,
    closes: closes.length,
    openingsWithoutReceipt: fLedger.filter((r) => r.kind === "OPENING").length,
    closesWithoutCount: closes.filter((r) => r.cash.counted === null).length,
    matched: closes.filter((r) => r.cash.variance === 0).length,
    cashShortage: out(cashShortage), cashOverage: out(cashOverage), cashNet: out(cashOverage.minus(cashShortage)),
    ingredientShortage: canSeeCost ? out(ingShortage) : null, ingredientOverage: canSeeCost ? out(ingOverage) : null,
    ingredientNet: canSeeCost ? out(ingOverage.minus(ingShortage)) : null,
    ingredientUnpriced: fIngredients.filter((l) => !l.priced).length,
    sharedCount: shared.length + receiving.length,
    sharedStockShortage: canSeeCost ? out(sharedStockShortage) : null, sharedStockOverage: canSeeCost ? out(sharedStockOverage) : null,
    sharedCashShortage: out(receiving.reduce((s, r) => (r.cash.receiving! < 0 ? s.plus(-r.cash.receiving!) : s), ZERO())),
    sharedCashOverage: out(receiving.reduce((s, r) => (r.cash.receiving! > 0 ? s.plus(r.cash.receiving!) : s), ZERO())),
    openDisputes: fExceptions.filter((e) => e.kind === "DELIVERY_DISPUTED").length,
    pendingDeliveries: fExceptions.filter((e) => e.kind === "DELIVERY_PENDING").length,
    staleDeliveries: fExceptions.filter((e) => e.kind === "DELIVERY_PENDING" && e.stale).length,
    openIssues: fExceptions.filter((e) => e.kind === "ISSUE_OPEN").length,
    stockNotCounted: fExceptions.filter((e) => e.kind === "STOCK_NOT_COUNTED").length,
    exceptions: fExceptions.length,
  };

  // ── Exceptions-only view ──
  let shownLedger = fLedger, shownIngredients = fIngredients;
  if (args.exceptionsOnly) {
    shownLedger = fLedger.filter((r) => r.exception);
    shownIngredients = fIngredients.filter((l) => l.attribution === "SHARED" || !l.priced);
    employees = employees.filter((e) => e.flags.length > 0 || e.cash.shortage > 0 || e.cash.overage > 0 || e.shared.count > 0);
  }
  shownLedger.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  shownIngredients.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  fExceptions.sort((a, b) => Number(b.stale) - Number(a.stale) || b.at.localeCompare(a.at) || a.id.localeCompare(b.id));

  return {
    period: { key: args.period.key, label: PERIOD_LABELS[args.period.key], from: args.period.from, to: args.period.to, timezone: REPORT_TZ, dayBasis: "يوم إقفال الشيفت بتوقيت القاهرة" },
    branch: branch ?? null,
    employeeFilter: employeeFilter ? person(employeeFilter) : null,
    exceptionsOnly: !!args.exceptionsOnly,
    generatedAt: now.toISOString(),
    generatedBy: { id: args.viewer.id, name: args.viewer.name },
    visibility: { ingredientValues: canSeeCost },
    kpis,
    employees,
    employeeTotals: employeeTotals(employees, canSeeCost),
    ledger: shownLedger,
    ledgerTotals: ledgerTotals(shownLedger, canSeeCost),
    ingredients: shownIngredients,
    ingredientTotals: ingredientTotals(shownIngredients, canSeeCost),
    exceptions: fExceptions,
  };
}

const OPENING_KIND_LABELS: Record<string, string> = {
  FIRST_OPENING: "أول فتح للفرع", FREE_FORM_OPENING: "فتح حر", NO_INCOMING: "بدون مستلم", MANAGER_ADJUSTMENT: "تعديل مدير",
  CASH_MISMATCH: "اختلاف نقدية", OVERNIGHT_CASH_MISMATCH: "اختلاف نقدية الليل", STOCK_MISMATCH: "اختلاف خامات",
};

function stockLine(c: StockCase, canSeeCost: boolean): IngredientLine {
  const line = c.stockCountLine;
  const participants = new Map<string, Person>();
  const shifts = new Set<number>();
  const custodies = [c.custodyPeriod, ...(c.varianceSpan?.custodyLinks.map((l) => l.custodyPeriod) ?? [])].filter((x): x is NonNullable<typeof x> => !!x);
  for (const cp of custodies) {
    for (const p of cp.participants) participants.set(p.user.id, person(p.user));
    if (cp.responsibleShift) shifts.add(cp.responsibleShift.shiftNumber);
  }
  if (c.shift) shifts.add(c.shift.shiftNumber);
  if (c.acceptedHandover) shifts.add(c.acceptedHandover.outgoingShift.shiftNumber);

  // The same two gates the employee-variance report uses (attribution AND
  // confidence), so the two reports never name different people.
  const branchHeld = c.custodyPeriod?.holderType === "BRANCH" || c.attribution === "BRANCH_CUSTODY";
  const own = c.custodyPeriod?.participants.map((p) => person(p.user)) ?? [];
  let employee: Person | null = null;
  let basis: IngredientLine["basis"];
  if (c.assignedResponsibility) { employee = person(c.assignedResponsibility); basis = "ASSIGNED"; }
  else if (branchHeld) basis = "BRANCH";
  else if (c.attribution !== "VERIFIED_SHIFT" || c.confidence !== "VERIFIED") basis = "PERIOD";
  else if (own.length > 1) basis = "SEVERAL";
  else if (own.length === 1) { employee = own[0]; basis = "CUSTODY"; }
  else if (c.shift) { employee = person(c.shift.cashier); basis = "CUSTODY"; }
  else basis = "PERIOD";
  if (!employee) {
    if (c.acceptedHandover) participants.set(c.acceptedHandover.outgoingUser.id, person(c.acceptedHandover.outgoingUser));
    if (c.shift) participants.set(c.shift.cashier.id, person(c.shift.cashier));
  }

  const diff = num(c.quantityVariance);
  const priced = c.financialImpactAvailable && c.financialImpact !== null && diff !== null;
  // financialImpact carries the magnitude; the quantity carries the sign.
  const value = priced && canSeeCost ? out(decimal(c.financialImpact!).abs().times(diff!.isNegative() ? -1 : 1)) : null;
  return {
    id: c.id, at: c.openedAt.toISOString(), businessDate: dateStrInTz(c.openedAt, REPORT_TZ), branch: c.branch,
    item: line?.inventoryItem ?? { id: "", name: "صنف غير معروف" }, unit: line?.unit ?? null,
    expected: qty(line?.expectedQuantity), counted: qty(line?.effectiveCountedQuantity ?? line?.countedQuantity), difference: qty(c.quantityVariance),
    unitCost: canSeeCost && line?.unitCostSnapshot !== null && line?.unitCostSnapshot !== undefined ? out(decimal(line.unitCostSnapshot)) : null,
    costBasis: line?.unitCostSnapshot !== null && line?.unitCostSnapshot !== undefined ? "COUNT_TIME" : null,
    value, priced,
    attribution: employee ? "PERSON" : "SHARED", basis, employee,
    participants: employee ? [] : [...participants.values()].sort((a, b) => a.name.localeCompare(b.name, "ar")),
    shifts: [...shifts].sort((a, b) => a - b), handoverId: c.acceptedHandover?.id ?? null, caseStatus: c.status,
  };
}

function closeRow(
  s: ClosedShift,
  linesByHandover: Map<string, IngredientLine[]>,
  now: Date,
  exception: (row: Omit<ExceptionRow, "label" | "businessDate">) => void,
): LedgerRow {
  const closedAt = s.financiallyClosedAt ?? s.closedAt!;
  const at = closedAt.toISOString();
  const h = s.handoversOutgoing[0] ?? null;
  const outgoing = person(s.cashier);
  const incomingRow = h?.incomingUser ?? h?.incomingShift?.cashier ?? h?.cashStorage?.receipt?.claimant ?? null;
  const incoming = incomingRow ? person(incomingRow) : null;
  const target = h?.resolvedTarget ?? h?.target ?? null;
  const mode: HandoverMode = !h ? "NO_HANDOVER" : h.directHandover ? "DIRECT" : target === "BRANCH_CUSTODY" ? "BRANCH_CUSTODY" : "RECOUNT";
  const base = { branch: s.branch, shiftNumber: s.shiftNumber };

  // R1: stored close values only.
  const expected = num(s.expectedCashAmount), counted = num(s.actualCashAmount);
  const variance = counted === null ? null : num(s.cashDifference) ?? counted.minus(expected!);
  const statuses: StatusChip[] = [];
  if (counted === null) {
    statuses.push({ code: "NOT_COUNTED", label: "لم يُسجَّل عدّ", tone: "danger" });
    exception({ id: `nocount:${s.id}`, kind: "CLOSE_WITHOUT_COUNT", at, ...base, people: [outgoing], amount: null, note: null, stale: false });
  } else if (variance!.isZero()) statuses.push({ code: "MATCHED", label: "مطابق", tone: "success" });
  else if (variance!.isNegative()) statuses.push({ code: "SHORTAGE", label: `عجز ${formatAmount(out(variance!.abs()))}`, tone: "danger" });
  else statuses.push({ code: "OVERAGE", label: `زيادة ${formatAmount(out(variance!))}`, tone: "warning" });

  // R4: deliveries in their own columns.
  const d = { declared: ZERO(), confirmed: ZERO(), pending: ZERO(), disputed: ZERO(), resolvedShortfall: ZERO(), pendingCount: 0, disputedCount: 0 };
  for (const x of s.cashDisposition?.deliveries ?? []) {
    const amount = decimal(x.amount);
    d.declared = d.declared.plus(amount);
    const recipient = person(x.recipient);
    if (x.status === "CONFIRMED") d.confirmed = d.confirmed.plus(amount);
    else if (x.status === "DECLARED") {
      d.pending = d.pending.plus(amount); d.pendingCount++;
      const stale = now.getTime() - x.declaredAt.getTime() > STALE_MS;
      exception({ id: `delivery:${x.id}`, kind: "DELIVERY_PENDING", at: x.declaredAt.toISOString(), ...base, people: [outgoing, recipient], amount: out(amount), note: null, stale });
    } else if (x.status === "DISPUTED") {
      d.disputed = d.disputed.plus(amount); d.disputedCount++;
      exception({ id: `dispute:${x.id}`, kind: "DELIVERY_DISPUTED", at: x.declaredAt.toISOString(), ...base, people: [outgoing, recipient], amount: out(amount), note: x.disputeNote, stale: false });
    } else if (x.status === "RESOLVED") {
      d.confirmed = d.confirmed.plus(x.resolvedAmount ?? 0);
      d.resolvedShortfall = d.resolvedShortfall.plus(amount.minus(x.resolvedAmount ?? 0));
    }
  }
  if (d.pendingCount) statuses.push({ code: "PENDING_DELIVERY", label: "بانتظار تأكيد", tone: "warning" });
  if (d.disputedCount) statuses.push({ code: "OPEN_DISPUTE", label: "نزاع مفتوح", tone: "danger" });
  if (mode === "DIRECT" && !s.cashDisposition) {
    statuses.push({ code: "NO_DISPOSITION", label: "لم يُسجَّل مصير النقدية", tone: "danger" });
    exception({ id: `nodisp:${s.id}`, kind: "NO_DISPOSITION", at, ...base, people: [outgoing], amount: null, note: null, stale: false });
  }

  // R9: the next person's count, when there was one.
  let receiving: Decimal | null = null;
  if (h) {
    const receipt = h.cashStorage?.receipt;
    if (mode === "BRANCH_CUSTODY") {
      if (receipt && (receipt.status === "ACCEPTED" || receipt.status === "OVERRIDDEN")) receiving = num(receipt.varianceAmount);
      else if (h.cashStorage) {
        statuses.push({ code: "RECEIPT_PENDING", label: "بانتظار استلام النقدية", tone: "warning" });
        exception({ id: `receipt:${h.id}`, kind: "RECEIPT_PENDING", at, ...base, people: [outgoing, ...(incoming ? [incoming] : [])], amount: null, note: receipt?.status === "DISPUTED" ? "معترض عليه" : null, stale: false });
      }
    } else if (h.cashVerifiedAt) receiving = num(h.cashVarianceAmount);
    if (receiving && !receiving.isZero()) statuses.push({ code: "RECEIVING_DIFF", label: `فرق استلام ${formatAmount(out(receiving))}`, tone: "warning" });
    if (!ACCEPTED.has(h.status) && h.status !== "REJECTED") {
      statuses.push({ code: "AWAITING_RECEIPT", label: "بانتظار الاستلام", tone: "warning" });
      exception({ id: `handover:${h.id}`, kind: "HANDOVER_PENDING", at, ...base, people: [outgoing], amount: null, note: null, stale: false });
    }
  }

  const issues = { open: 0, resolved: 0 };
  for (const i of h?.issues ?? []) {
    if (i.status === "OPEN") {
      issues.open++;
      exception({ id: `issue:${i.id}`, kind: "ISSUE_OPEN", at: i.reportedAt.toISOString(), ...base, people: [person(i.reportedBy), outgoing], amount: null, note: i.description, stale: false });
    } else issues.resolved++;
  }
  if (issues.open) statuses.push({ code: "OPEN_ISSUE", label: "مشكلة مفتوحة", tone: "danger" });

  const lines = h ? linesByHandover.get(h.id) ?? [] : [];
  const notCounted = h?._count.stockBoundaries ?? 0;
  if (notCounted) {
    statuses.push({ code: "STOCK_NOT_COUNTED", label: "خامات لم تُعدّ", tone: "warning" });
    exception({ id: `nostock:${h!.id}`, kind: "STOCK_NOT_COUNTED", at, ...base, people: [outgoing], amount: null, note: `${notCounted} صنف`, stale: false });
  }
  const pricedValues = lines.filter((l) => l.value !== null).map((l) => decimal(l.value!));
  const hidden = lines.some((l) => l.priced && l.value === null);
  if (lines.length) statuses.push({ code: "STOCK_DIFF", label: `فرق خامات (${lines.length})`, tone: "info" });

  return {
    id: `close:${s.id}`, kind: "CLOSE", at, businessDate: dateStrInTz(closedAt, REPORT_TZ), branch: s.branch, shift: { id: s.id, number: s.shiftNumber },
    outgoing, incoming, mode, handoverId: h?.id ?? null, handoverStatus: h?.status ?? null,
    cash: {
      expected: expected ? out(expected) : null, counted: counted ? out(counted) : null, variance: variance ? out(variance) : null,
      shortage: variance ? out(variance.isNegative() ? variance.abs() : ZERO()) : null,
      overage: variance ? out(variance.isPositive() && !variance.isZero() ? variance : ZERO()) : null,
      reason: s.cashReasonNote,
      retained: s.cashDisposition ? out(decimal(s.cashDisposition.retainedAmount)) : null,
      delivered: s.cashDisposition ? out(decimal(s.cashDisposition.deliveredAmount)) : null,
      deliveries: { declared: out(d.declared), confirmed: out(d.confirmed), pending: out(d.pending), disputed: out(d.disputed), resolvedShortfall: out(d.resolvedShortfall), pendingCount: d.pendingCount, disputedCount: d.disputedCount },
      receiving: receiving ? out(receiving) : null,
    },
    stock: {
      items: lines.length,
      shortageValue: hidden ? null : out(pricedValues.filter((v) => v.isNegative()).reduce((a, v) => a.plus(v.abs()), ZERO())),
      overageValue: hidden ? null : out(pricedValues.filter((v) => v.isPositive()).reduce((a, v) => a.plus(v), ZERO())),
      unpriced: lines.filter((l) => !l.priced).length,
      notCounted,
    },
    issues, place: place(h?.incomingShift?.placeReceipt ?? null), note: null, statuses,
    exception: statuses.some((x) => x.code !== "MATCHED" && x.code !== "STOCK_DIFF") || lines.length > 0,
  };
}

type Acc = {
  person: Person; shiftsClosed: number; handoversReceived: number; notCounted: number;
  expected: Decimal; counted: Decimal; shortage: Decimal; overage: Decimal;
  declared: Decimal; confirmed: Decimal; pending: Decimal; disputed: Decimal; resolvedShortfall: Decimal;
  stockItems: number; stockUnpriced: number; stockShortage: Decimal; stockOverage: Decimal;
  sharedCount: number; sharedStock: Decimal; sharedCash: Decimal; flags: Map<string, StatusChip>;
};
const newAcc = (p: Person): Acc => ({
  person: p, shiftsClosed: 0, handoversReceived: 0, notCounted: 0,
  expected: ZERO(), counted: ZERO(), shortage: ZERO(), overage: ZERO(),
  declared: ZERO(), confirmed: ZERO(), pending: ZERO(), disputed: ZERO(), resolvedShortfall: ZERO(),
  stockItems: 0, stockUnpriced: 0, stockShortage: ZERO(), stockOverage: ZERO(),
  sharedCount: 0, sharedStock: ZERO(), sharedCash: ZERO(), flags: new Map(),
});
function summary(a: Acc, canSeeCost: boolean): EmployeeSummary {
  const flags = [...a.flags.values()];
  if (!a.person.active) flags.push({ code: "INACTIVE", label: "غير نشط", tone: "neutral" });
  const gross = a.shortage.plus(a.overage).plus(canSeeCost ? a.stockShortage.plus(a.stockOverage) : 0);
  return {
    employee: a.person, shiftsClosed: a.shiftsClosed, handoversReceived: a.handoversReceived,
    cash: { expected: out(a.expected), counted: out(a.counted), shortage: out(a.shortage), overage: out(a.overage), net: out(a.overage.minus(a.shortage)), notCounted: a.notCounted },
    deliveries: { declared: out(a.declared), confirmed: out(a.confirmed), pending: out(a.pending), disputed: out(a.disputed), resolvedShortfall: out(a.resolvedShortfall) },
    stock: {
      items: a.stockItems, unpriced: a.stockUnpriced,
      shortageValue: canSeeCost ? out(a.stockShortage) : null, overageValue: canSeeCost ? out(a.stockOverage) : null,
      net: canSeeCost ? out(a.stockOverage.minus(a.stockShortage)) : null,
    },
    shared: { count: a.sharedCount, stockValue: canSeeCost ? out(a.sharedStock) : null, cashAmount: out(a.sharedCash) },
    grossVariance: out(gross), flags,
  };
}
function employeeTotals(rows: EmployeeSummary[], canSeeCost: boolean): AccountabilityReport["employeeTotals"] {
  const s = (pick: (e: EmployeeSummary) => number | null) => out(rows.reduce((a, e) => a.plus(pick(e) ?? 0), ZERO()));
  const n = (pick: (e: EmployeeSummary) => number) => rows.reduce((a, e) => a + pick(e), 0);
  return {
    shiftsClosed: n((e) => e.shiftsClosed), handoversReceived: n((e) => e.handoversReceived),
    cash: { expected: s((e) => e.cash.expected), counted: s((e) => e.cash.counted), shortage: s((e) => e.cash.shortage), overage: s((e) => e.cash.overage), net: s((e) => e.cash.net), notCounted: n((e) => e.cash.notCounted) },
    deliveries: { declared: s((e) => e.deliveries.declared), confirmed: s((e) => e.deliveries.confirmed), pending: s((e) => e.deliveries.pending), disputed: s((e) => e.deliveries.disputed), resolvedShortfall: s((e) => e.deliveries.resolvedShortfall) },
    stock: {
      items: n((e) => e.stock.items), unpriced: n((e) => e.stock.unpriced),
      shortageValue: canSeeCost ? s((e) => e.stock.shortageValue) : null, overageValue: canSeeCost ? s((e) => e.stock.overageValue) : null,
      net: canSeeCost ? s((e) => e.stock.net) : null,
    },
    grossVariance: s((e) => e.grossVariance),
  };
}
function ledgerTotals(rows: LedgerRow[], canSeeCost: boolean): AccountabilityReport["ledgerTotals"] {
  const s = (pick: (r: LedgerRow) => number | null) => out(rows.reduce((a, r) => a.plus(pick(r) ?? 0), ZERO()));
  const counted = rows.filter((r) => r.cash.counted !== null);
  const sc = (pick: (r: LedgerRow) => number | null) => out(counted.reduce((a, r) => a.plus(pick(r) ?? 0), ZERO()));
  return {
    rows: rows.length, expected: sc((r) => r.cash.expected), counted: sc((r) => r.cash.counted),
    shortage: s((r) => r.cash.shortage), overage: s((r) => r.cash.overage), retained: s((r) => r.cash.retained), delivered: s((r) => r.cash.delivered),
    receiving: s((r) => r.cash.receiving), stockItems: rows.reduce((a, r) => a + r.stock.items, 0),
    stockShortage: canSeeCost ? s((r) => r.stock.shortageValue) : null, stockOverage: canSeeCost ? s((r) => r.stock.overageValue) : null,
  };
}
function ingredientTotals(rows: IngredientLine[], canSeeCost: boolean): AccountabilityReport["ingredientTotals"] {
  const values = rows.filter((l) => l.value !== null).map((l) => decimal(l.value!));
  const shortage = values.filter((v) => v.isNegative()).reduce((a, v) => a.plus(v.abs()), ZERO());
  const overage = values.filter((v) => v.isPositive()).reduce((a, v) => a.plus(v), ZERO());
  return {
    lines: rows.length, unpriced: rows.filter((l) => !l.priced).length,
    shortageValue: canSeeCost ? out(shortage) : null, overageValue: canSeeCost ? out(overage) : null, net: canSeeCost ? out(overage.minus(shortage)) : null,
  };
}
