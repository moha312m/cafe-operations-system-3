// One variance case as the board and the detail show it: where, who, what was
// expected, what was found, the signed difference and the reason given.
//
// Pure, so the four case types are formatted the same everywhere and can be
// tested without a screen. Decimals arrive as strings (Prisma's JSON); every
// figure stays a string here and only the screen applies the currency. A
// figure nobody recorded is null — never zero.

import { decimal } from "@/lib/money";
import type { VarianceStatus, VarianceType } from "./variance-labels";

type Named = { id: string; name: string };
export type VarianceShift = {
  id: string;
  shiftNumber: number;
  status?: string;
  openedAt: string;
  closedAt?: string | null;
  financiallyClosedAt?: string | null;
  openingCashAmount?: string | null;
  expectedCashAmount?: string | null;
  actualCashAmount?: string | null;
  cashDifference?: string | null;
  cashReasonNote?: string | null;
  cashier: Named;
};

/** One row of `GET /api/variances` (and the shared part of `GET /api/variances/:id`). */
export type VarianceRow = {
  id: string;
  type: VarianceType;
  status: VarianceStatus;
  quantityVariance: string | null;
  amountVariance: string | null;
  financialImpact: string | null;
  financialImpactAvailable: boolean;
  confidence?: string;
  blocking: boolean;
  openedAt: string;
  branch?: Named | null;
  shift?: VarianceShift | null;
  cashShift?: VarianceShift | null;
  custodyPeriod?: {
    id: string; scope: string; status: string; holderType?: string;
    responsibleShift?: { id: string; shiftNumber: number; cashier: Named } | null;
    participants?: { role: string; user: Named }[];
  } | null;
  acceptedHandover?: { id: string; target: string | null; outgoingUser: Named | null; incomingUser: Named | null } | null;
  stockCountLine?: {
    id: string;
    unit?: string;
    expectedQuantity?: string | null;
    countedQuantity?: string | null;
    effectiveCountedQuantity?: string | null;
    varianceQuantity?: string | null;
    reasonNote?: string | null;
    inventoryItem: { id: string; name: string; unit: string };
  } | null;
  tenderReconciliation?: { id: string; method: string; expectedAmount: string | null; actualAmount: string | null; varianceAmount: string | null; reasonNote: string | null } | null;
  openingException?: {
    id: string; kind: string; proposedAmount: string | null; actualAmount: string | null; varianceAmount: string | null; note: string | null;
    reasonCode?: { id: string; code: string; label: string } | null;
  } | null;
  assignedResponsibility?: Named | null;
  resolvedBy?: Named | null;
};

export const CASE_TYPE_LABEL: Record<VarianceType, string> = {
  CASH: "نقدية الدرج",
  TENDER: "تحصيل إلكتروني",
  STOCK: "مخزون",
  OPENING_EXCEPTION: "استثناء فتح",
};

export const TENDER_METHOD_LABEL: Record<string, string> = {
  CASH: "نقدي",
  CARD: "ماكينة الكارت (فيزا)",
  WALLET: "محفظة إلكترونية",
  EWALLET: "محفظة إلكترونية",
  MIXED: "دفع مقسّم",
};

export const OPENING_KIND_LABEL: Record<string, string> = {
  OVERNIGHT_CASH_MISMATCH: "فرق نقدية الدرج الليلي",
  CASH_MISMATCH: "فرق نقدية الافتتاح",
  STOCK_MISMATCH: "فرق مخزون الافتتاح",
  FREE_FORM_OPENING: "فتح بدون تسليم",
  NO_INCOMING: "مفيش مستلم",
  FIRST_OPENING: "أول فتح للفرع",
  MANAGER_ADJUSTMENT: "تعديل مدير",
};

/** The schema's confidence values, plus the names the owner's brief uses for the same three levels. */
export const CONFIDENCE_LABEL: Record<string, string> = {
  VERIFIED: "موثّق بجرد معتمد",
  PARTIAL: "مبدئي",
  PROVISIONAL: "مبدئي",
  UNVERIFIABLE: "تقديري",
  ESTIMATED: "تقديري",
};

export const NO_REASON = "بدون سبب مسجل";
export const SHORTAGE_LABEL = "عجز −";
export const OVERAGE_LABEL = "زيادة +";

export type VarianceDirection = "SHORTAGE" | "OVERAGE" | "NONE" | "UNKNOWN";

export type FormattedVariance = {
  branchName: string | null;
  shiftId: string | null;
  shiftNumber: number | null;
  /** When the shift opened (else when the case opened). */
  date: string;
  employeeName: string | null;
  typeLabel: string;
  /** Money for CASH/TENDER/OPENING_EXCEPTION, a quantity for STOCK. */
  isMoney: boolean;
  unit: string | null;
  expected: string | null;
  actual: string | null;
  /** Signed: actual − expected. */
  difference: string | null;
  direction: VarianceDirection;
  directionLabel: string | null;
  /** STOCK only: the valued impact, or null when it could not be valued. */
  costImpact: string | null;
  /** CASH only: the drawer the shift opened with. */
  openingCash: string | null;
  reason: string;
};

const present = (value: string | null | undefined) => (value === null || value === undefined || value === "" ? null : value);

export function directionOf(difference: string | null): VarianceDirection {
  if (difference === null) return "UNKNOWN";
  const d = decimal(difference);
  return d.isNeg() && !d.isZero() ? "SHORTAGE" : d.gt(0) ? "OVERAGE" : "NONE";
}

/** "−50.00" / "+30.00" / "0.00" — the sign in front, the magnitude after. */
export function signedFigure(value: string | null, places: number): string | null {
  if (value === null) return null;
  const d = decimal(value);
  const magnitude = d.abs().toFixed(places);
  return d.isZero() ? magnitude : `${d.isNeg() ? "−" : "+"}${magnitude}`;
}

function responsibleName(c: VarianceRow, shift: VarianceShift | null): string | null {
  if (c.assignedResponsibility) return c.assignedResponsibility.name;
  if (c.type === "STOCK") {
    const custody = c.custodyPeriod;
    return custody?.responsibleShift?.cashier.name
      ?? custody?.participants?.find((p) => p.role === "PRIMARY")?.user.name
      ?? c.acceptedHandover?.outgoingUser?.name
      ?? shift?.cashier.name
      ?? null;
  }
  return shift?.cashier.name ?? c.acceptedHandover?.outgoingUser?.name ?? null;
}

export function formatVarianceRow(c: VarianceRow): FormattedVariance {
  const shift = (c.type === "CASH" ? c.cashShift ?? c.shift : c.shift ?? c.cashShift) ?? null;
  const base = {
    branchName: c.branch?.name ?? null,
    shiftId: shift?.id ?? null,
    shiftNumber: shift?.shiftNumber ?? null,
    date: shift?.openedAt ?? c.openedAt,
    employeeName: responsibleName(c, shift),
  };
  const money = (expected: string | null, actual: string | null, difference: string | null, reason: string | null | undefined, typeLabel: string, openingCash: string | null = null): FormattedVariance => ({
    ...base, typeLabel, isMoney: true, unit: null, expected, actual, difference,
    direction: directionOf(difference),
    directionLabel: directionOf(difference) === "SHORTAGE" ? SHORTAGE_LABEL : directionOf(difference) === "OVERAGE" ? OVERAGE_LABEL : null,
    costImpact: null, openingCash, reason: present(reason?.trim()) ?? NO_REASON,
  });

  switch (c.type) {
    case "CASH":
      return money(present(shift?.expectedCashAmount), present(shift?.actualCashAmount), present(c.amountVariance) ?? present(shift?.cashDifference), shift?.cashReasonNote, CASE_TYPE_LABEL.CASH, present(shift?.openingCashAmount));
    case "TENDER": {
      const t = c.tenderReconciliation;
      const method = t ? TENDER_METHOD_LABEL[t.method] ?? t.method : null;
      return money(present(t?.expectedAmount), present(t?.actualAmount), present(c.amountVariance) ?? present(t?.varianceAmount), t?.reasonNote, method ? `${CASE_TYPE_LABEL.TENDER} — ${method}` : CASE_TYPE_LABEL.TENDER);
    }
    case "OPENING_EXCEPTION": {
      const o = c.openingException;
      const reasonLabel = o ? o.reasonCode?.label ?? OPENING_KIND_LABEL[o.kind] ?? o.kind : null;
      return money(present(o?.proposedAmount), present(o?.actualAmount), present(c.amountVariance) ?? present(o?.varianceAmount), o?.note, reasonLabel ? `${CASE_TYPE_LABEL.OPENING_EXCEPTION} — ${reasonLabel}` : CASE_TYPE_LABEL.OPENING_EXCEPTION);
    }
    case "STOCK": {
      const line = c.stockCountLine;
      const difference = present(c.quantityVariance) ?? present(line?.varianceQuantity);
      const direction = directionOf(difference);
      return {
        ...base,
        typeLabel: line ? `${CASE_TYPE_LABEL.STOCK} — ${line.inventoryItem.name}` : CASE_TYPE_LABEL.STOCK,
        isMoney: false,
        unit: line?.unit ?? line?.inventoryItem.unit ?? null,
        expected: present(line?.expectedQuantity),
        actual: present(line?.effectiveCountedQuantity) ?? present(line?.countedQuantity),
        difference,
        direction,
        directionLabel: direction === "SHORTAGE" ? SHORTAGE_LABEL : direction === "OVERAGE" ? OVERAGE_LABEL : null,
        costImpact: c.financialImpactAvailable ? present(c.financialImpact) : null,
        openingCash: null,
        reason: present(line?.reasonNote?.trim()) ?? NO_REASON,
      };
    }
  }
}

/** The search box: employee, item, branch or shift number, case-insensitive. */
export function matchesVarianceSearch(c: VarianceRow, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  if (!q) return true;
  const f = formatVarianceRow(c);
  const haystack = [
    f.employeeName, f.branchName, f.typeLabel, f.shiftNumber === null ? null : String(f.shiftNumber),
    c.stockCountLine?.inventoryItem.name, c.shift?.cashier.name, c.cashShift?.cashier.name,
    ...(c.custodyPeriod?.participants ?? []).map((p) => p.user.name),
  ].filter((v): v is string => !!v).map((v) => v.toLowerCase());
  return haystack.some((v) => v.includes(q));
}
