import { ApiError, requireActiveSession, resolveReadScope } from './api';
import { db } from './db';
import { resolvePermissions } from './perms/effective';
import { assertPurchaseReportPermissions, PurchaseReportError } from './purchase-report';

// Read settings directly: opening a report must not create missing defaults.
export async function requirePurchaseReportAccess(exporting = false) {
  const actor = await requireActiveSession();
  const scope = resolveReadScope(actor);
  if (!scope.cafeId) throw new ApiError(403, 'نطاق الكافيه مطلوب');
  const settings = await db.cafeSettings.findUnique({ where: { cafeId: scope.cafeId }, select: { inventoryEnabled: true, purchasesEnabled: true } });
  if (!settings?.inventoryEnabled || !settings.purchasesEnabled) throw new ApiError(403, 'تقارير المشتريات غير مفعلة لهذا الكافيه');
  const { keys } = await resolvePermissions(actor);
  try { assertPurchaseReportPermissions(keys, settings, exporting); }
  catch (error) { if (error instanceof PurchaseReportError) throw new ApiError(error.status, error.message); throw error; }
  return { actor, scope: { ...scope, cafeId: scope.cafeId, role: actor.role } };
}
