// Synthetic café for the 4B.2 browser check on the disposable test database (cafe_ops_test, :3100).
// Retained until `teardown` is passed; prints only the owner login e-mail.
import { db, teardownTaggedCafe } from "../../../tests/helpers/db";
import { countCafe } from "../../../tests/helpers/count";
import { ensureAccountingEntity } from "@/lib/accounting/chart";

import { test } from "node:test";

test("4B.2 browser fixture", { timeout: 120000 }, async () => {
  if (process.env.FIXTURE_TEARDOWN === "1") {
    const cafes = await db.cafe.findMany({ where: { name: { contains: "UI4B2" } }, select: { id: true } });
    for (const c of cafes) await teardownTaggedCafe(c.id);
    console.log("removed", cafes.length);
    await db.$disconnect();
    return;
  }
  const fx = await countCafe("UI4B2");
  const entity = await db.$transaction(tx => ensureAccountingEntity(tx, fx.cafeId));
  const header = await db.accountingAccount.findFirstOrThrow({ where: { entityId: entity.id, systemKey: "HEADER_EXPENSES" } });
  for (const [nameAr, code] of [["نظافة", "S4B2_CLEAN"], ["صيانة", "S4B2_MAINT"], ["رواتب وأجور", "S4B2_WAGES"], ["مرافق", "S4B2_UTIL"], ["إيجار", "S4B2_RENT"], ["تسويق", "S4B2_MKT"]]) {
    await db.expenseCategory.create({ data: { cafeId: fx.cafeId, code, nameAr, createdById: fx.owner.id } });
  }
  await db.accountingAccount.create({ data: { cafeId: fx.cafeId, entityId: entity.id, code: "5420", name: "صيانة حساب المحاسب", type: "EXPENSE", normalBalance: "DEBIT", parentId: header.id } });
  console.log("FIXTURE " + JSON.stringify({ owner: fx.owner.email, manager: fx.manager.email, cashier: fx.cashier.email }));
  await db.$disconnect();
});
