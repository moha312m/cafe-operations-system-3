// ── Default table provisioning ───────────────────────────────────────
import { db } from "@/lib/db";

export const DEFAULT_TABLE_COUNT = 15;

// Ensure a branch has usable tables: if it has none configured, create the
// default set (1..15, active). Idempotent and safe to call on first POS use
// or at branch creation. Returns the number of tables created.
export async function ensureDefaultTables(
  cafeId: string,
  branchId: string,
  count = DEFAULT_TABLE_COUNT
): Promise<number> {
  const existing = await db.cafeTable.count({ where: { branchId } });
  if (existing > 0) return 0;

  const rows = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return {
      cafeId,
      branchId,
      tableNumber: String(n),
      isActive: true,
      sortOrder: n,
    };
  });
  // skipDuplicates guards against a race where another request seeds first.
  const res = await db.cafeTable.createMany({ data: rows, skipDuplicates: true });
  return res.count;
}
