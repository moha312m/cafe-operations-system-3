// ── Incoming shift readiness (read-only) ───────────────────────────────
// A handover can be COMPLETE while the next shift still cannot operate. This reads
// the same facts the server gates read (`assertOpeningReady`, the custody gate on
// the shift, the opening cash receipt and the place receipt) and names what is still
// missing for each open shift of the branch. It decides nothing: POS and the APIs
// keep enforcing the gates themselves.
import { db } from "@/lib/db";

export type ReadinessRequirement = {
  id: "custody" | "opening-verification" | "cash-receipt" | "place-receipt";
  label: string;
  state: "done" | "pending" | "not-required";
  /** Why it is pending, in the café's words. */
  detail: string | null;
};
export type ShiftReadiness = {
  shiftId: string; shiftNumber: number; cashierName: string; openedAt: string;
  gate: "AWAITING_CUSTODY_TRANSFER" | "AWAITING_OPENING_VERIFICATION" | "AWAITING_CASH_RECEIPT" | null;
  requirements: ReadinessRequirement[];
  operational: boolean;
};

export async function branchReadiness(cafeId: string, branchId: string): Promise<ShiftReadiness[]> {
  const [shifts, settings] = await Promise.all([
    db.shift.findMany({
      where: { cafeId, branchId, status: "OPEN" }, orderBy: { shiftNumber: "asc" },
      select: { id: true, shiftNumber: true, openedAt: true, custodyGateReason: true, cashier: { select: { name: true } }, openingCashReceipt: { select: { status: true } } },
    }),
    db.branchOpeningSettings.findUnique({ where: { branchId }, select: { placeAcceptanceRequired: true, updatedAt: true } }),
  ]);
  const places = shifts.length ? await db.shiftPlaceReceipt.findMany({ where: { incomingShiftId: { in: shifts.map((s) => s.id) } }, select: { incomingShiftId: true, status: true } }) : [];
  const placeBy = new Map(places.map((p) => [p.incomingShiftId, p.status]));
  const ok = (status: string | null | undefined) => status === "ACCEPTED" || status === "OVERRIDDEN";

  return shifts.map((s) => {
    const gate = s.custodyGateReason as ShiftReadiness["gate"];
    const custodyPending = gate === "AWAITING_CUSTODY_TRANSFER";
    const verificationPending = gate === "AWAITING_OPENING_VERIFICATION";
    const cash = s.openingCashReceipt?.status ?? null;
    const placeRequired = !!settings?.placeAcceptanceRequired && s.openedAt >= settings.updatedAt;
    const place = placeBy.get(s.id) ?? null;
    const requirements: ReadinessRequirement[] = [
      { id: "custody", label: "استلام عهدة المخزون", state: custodyPending ? "pending" : "done",
        detail: custodyPending ? "الشيفت مستني تسليم العهدة من الشيفت السابق (أو تحويلها لعهدة الفرع)." : null },
      { id: "opening-verification", label: "التحقق من العهدة الافتتاحية", state: verificationPending ? "pending" : custodyPending ? "pending" : "done",
        detail: verificationPending ? "عهدة الفرع اتسلّمت؛ الشيفت لازم يعدّ الأصناف ويتحقق منها قبل التشغيل." : custodyPending ? "بيبدأ بعد ما العهدة تتسلّم." : null },
      { id: "cash-receipt", label: "استلام كاش الدرج", state: cash === null ? "not-required" : ok(cash) ? "done" : "pending",
        detail: cash !== null && !ok(cash) ? "المستلم لازم يعدّ الكاش ويؤكد المبلغ الفعلي (أو اعتماد استثنائي من المالك)." : null },
      { id: "place-receipt", label: "استلام المكان والأجهزة", state: !placeRequired ? "not-required" : ok(place) ? "done" : "pending",
        detail: placeRequired && !ok(place) ? (place === null ? "فحص المكان مطلوب للفرع ولم يُفتح لهذا الشيفت بعد." : "فحص المكان مفتوح ولم يُعتمد بعد.") : null },
    ];
    return {
      shiftId: s.id, shiftNumber: s.shiftNumber, cashierName: s.cashier.name, openedAt: s.openedAt.toISOString(),
      gate, requirements, operational: requirements.every((r) => r.state !== "pending"),
    };
  });
}
