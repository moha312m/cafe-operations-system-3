import { requireActiveSession, resolveReadScope } from '@/lib/api';
import { db } from '@/lib/db';
import { resolvePermissionKeys } from '@/lib/perms/effective';
import { visibleReportCatalog } from '@/lib/report-center';
import { ReportCenter } from '@/components/reports/report-center';

export default async function ReportCenterPage() {
  const actor = await requireActiveSession();
  const scope = resolveReadScope(actor);
  const settings = scope.cafeId ? await db.cafeSettings.findUnique({ where: { cafeId: scope.cafeId } }) : null;
  // The permission resolver has a legacy default-settings initializer. Avoid
  // invoking it here when the settings row is absent.
  const keys = settings ? await resolvePermissionKeys(actor) : [];
  const reports = visibleReportCatalog({ keys: new Set(keys), features: settings ?? {}, role: actor.role, branchId: actor.branchId });
  return <ReportCenter reports={reports} branchScoped={!!actor.branchId} configured={!!settings} />;
}
