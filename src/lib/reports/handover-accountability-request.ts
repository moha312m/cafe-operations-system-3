// The one gate in front of the accountability report. The JSON route, every
// export and the print page call it, so none of them can skip a check (R7):
// the viewer needs `reports.view` and `shifts.view_reports` (the owner holds
// both), an export also needs `reports.export`, and a branch-pinned viewer is
// held to their branch.
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError, requireActiveSession, requireFeature, resolveCafeId, resolveBranchId } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { PERIOD_KEYS, loadHandoverAccountability, resolvePeriod, type AccountabilityReport } from "@/lib/reports/handover-accountability";

export const REPORT_KEYS = ["reports.view", "shifts.view_reports"] as const;

export async function accountabilityFromParams(p: URLSearchParams, opts: { export?: boolean } = {}): Promise<AccountabilityReport> {
  const session = await requireActiveSession();
  const { keys } = await resolvePermissions(session);
  const required = [...REPORT_KEYS, ...(opts.export ? ["reports.export"] : [])];
  if (!required.every((k) => keys.has(k))) throw new ApiError(403, "ليس لديك صلاحية عرض تقرير الاستلام والمسؤولية");
  await requireFeature(session, "shiftManagementEnabled");

  const cafeId = resolveCafeId(session, p.get("cafeId"));
  const branchId = session.branchId || p.get("branchId") ? resolveBranchId(session, p.get("branchId")) : undefined;
  if (branchId && !await db.branch.findFirst({ where: { id: branchId, cafeId }, select: { id: true } })) throw new ApiError(403, "الفرع مش تابع للكافيه");
  const employeeId = p.get("employeeId") || undefined;
  if (employeeId && !await db.user.findFirst({ where: { id: employeeId, cafeId }, select: { id: true } })) throw new ApiError(400, "الموظف مش تابع للكافيه");

  const key = z.enum(PERIOD_KEYS).safeParse(p.get("period") ?? "today");
  if (!key.success) throw new ApiError(400, "الفترة غير صالحة");
  const period = resolvePeriod(key.data, { from: p.get("from"), to: p.get("to") });
  if ("error" in period) throw new ApiError(400, period.error);

  return loadHandoverAccountability({
    cafeId, branchId, employeeId, exceptionsOnly: p.get("exceptionsOnly") === "1", period,
    viewer: { id: session.id, name: session.name, role: session.role, keys },
  });
}

/** Filter choices: every branch the viewer may read, and every person — archived staff included, since history names them. */
export async function accountabilityOptions(p: URLSearchParams) {
  const session = await requireActiveSession();
  const cafeId = resolveCafeId(session, p.get("cafeId"));
  const [branches, employees] = await Promise.all([
    db.branch.findMany({ where: { cafeId, ...(session.branchId ? { id: session.branchId } : {}) }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.user.findMany({
      where: { cafeId, role: { not: "SUPER_ADMIN" }, ...(session.branchId ? { OR: [{ branchId: session.branchId }, { shifts: { some: { branchId: session.branchId } } }] } : {}) },
      select: { id: true, name: true, isActive: true, archivedAt: true }, orderBy: { name: "asc" },
    }),
  ]);
  return { branches, employees: employees.map((e) => ({ id: e.id, name: e.name, active: e.isActive && !e.archivedAt })) };
}
