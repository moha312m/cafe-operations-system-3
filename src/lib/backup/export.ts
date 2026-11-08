import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth";

export const REDACTED_PASSWORD_HASH = "$2a$10$REDACTED_FOR_SECURITY_DUMP_00000000000000000000000000";

export interface BackupManifest {
  version: "1.0.0";
  generator: "NextCup-ERP-Backup-Engine-v1";
  cafeId: string;
  cafeName: string;
  cafeSlug: string;
  exportedAt: string;
  exportedBy: {
    userId: string;
    name: string;
    role: string;
  };
  totalRows: number;
  tableCounts: Record<string, number>;
  omissions: string[];
}

export interface BackupData {
  manifest: BackupManifest;
  tables: Record<string, Record<string, unknown>[]>;
}

export function escapeSqlString(str: string): string {
  return "'" + str.replace(/\0/g, "").replace(/'/g, "''") + "'";
}

export function formatSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "NULL";
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (Decimal.isDecimal(value) || (typeof value === "object" && value !== null && "toFixed" in value)) {
    return (value as { toString: () => string }).toString();
  }
  if (value instanceof Date) {
    return escapeSqlString(value.toISOString()) + "::timestamptz";
  }
  if (typeof value === "string") {
    return escapeSqlString(value);
  }
  if (typeof value === "object") {
    return escapeSqlString(JSON.stringify(value)) + "::jsonb";
  }
  return escapeSqlString(String(value));
}

const TABLES_WITHOUT_ID = new Set(["ProductAddOn", "SalesDiscountLimit", "BranchOpeningSettings"]);

export function generateSqlInserts(tableName: string, rows: Record<string, unknown>[], batchSize = 100): string {
  if (!rows || rows.length === 0) {
    return `-- Table: "${tableName}" (0 rows)\n\n`;
  }

  const columns = Object.keys(rows[0]);
  const hasId = !TABLES_WITHOUT_ID.has(tableName) && columns.includes("id");
  const quotedColumns = columns.map((col) => `"${col}"`).join(", ");

  let sql = `-- Table: "${tableName}" (${rows.length} rows)\n`;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const valueTuples = batch.map((row) => {
      const literals = columns.map((col) => formatSqlLiteral(row[col]));
      return `  (${literals.join(", ")})`;
    });

    sql += `INSERT INTO "${tableName}" (${quotedColumns})\nVALUES\n${valueTuples.join(",\n")}\n`;
    if (hasId) {
      sql += `ON CONFLICT ("id") DO NOTHING;\n\n`;
    } else {
      sql += `;\n\n`;
    }
  }

  return sql;
}

export function sanitizeUserRow(user: Record<string, unknown>): Record<string, unknown> {
  return {
    ...user,
    passwordHash: REDACTED_PASSWORD_HASH,
  };
}

export function sanitizeOwnerPasscodeRow(passcode: Record<string, unknown>): Record<string, unknown> {
  return {
    ...passcode,
    passcodeHash: REDACTED_PASSWORD_HASH,
  };
}

export function sanitizeWhatsAppIntegrationRow(wa: Record<string, unknown>): Record<string, unknown> {
  return {
    ...wa,
    accessTokenCipher: null,
  };
}

export async function fetchAllCafeData(cafeId: string, actor: SessionUser): Promise<BackupData> {
  const cafe = await db.cafe.findUnique({ where: { id: cafeId } });
  if (!cafe) {
    throw new Error("Cafe not found");
  }

  const tables: Record<string, Record<string, unknown>[]> = {};

  // Root cafe
  tables["Cafe"] = [cafe as unknown as Record<string, unknown>];

  // Settings & Branches
  const cafeSettings = await db.cafeSettings.findMany({ where: { cafeId } });
  tables["CafeSettings"] = cafeSettings as unknown as Record<string, unknown>[];

  const branches = await db.branch.findMany({ where: { cafeId } });
  tables["Branch"] = branches as unknown as Record<string, unknown>[];
  const branchIds = branches.map((b) => b.id);

  const branchFinancial = await db.branchFinancialSettings.findMany({ where: { cafeId } });
  tables["BranchFinancialSettings"] = branchFinancial as unknown as Record<string, unknown>[];

  const branchOpening = await db.branchOpeningSettings.findMany({ where: { cafeId } });
  tables["BranchOpeningSettings"] = branchOpening as unknown as Record<string, unknown>[];

  const branchReporting = branchIds.length
    ? await db.branchReportingVersion.findMany({ where: { branchId: { in: branchIds } } })
    : [];
  tables["BranchReportingVersion"] = branchReporting as unknown as Record<string, unknown>[];

  // Users & Permissions (Sanitized)
  const rawUsers = await db.user.findMany({ where: { cafeId } });
  tables["User"] = rawUsers.map((u) => sanitizeUserRow(u as unknown as Record<string, unknown>));
  const userIds = rawUsers.map((u) => u.id);

  const cafeRoles = await db.cafeRole.findMany({ where: { cafeId } });
  tables["CafeRole"] = cafeRoles as unknown as Record<string, unknown>[];
  const roleIds = cafeRoles.map((r) => r.id);

  const cafeRolePerms = roleIds.length
    ? await db.cafeRolePermission.findMany({ where: { cafeRoleId: { in: roleIds } } })
    : [];
  tables["CafeRolePermission"] = cafeRolePerms as unknown as Record<string, unknown>[];

  const userPermOverrides = userIds.length
    ? await db.userPermissionOverride.findMany({ where: { userId: { in: userIds } } })
    : [];
  tables["UserPermissionOverride"] = userPermOverrides as unknown as Record<string, unknown>[];

  // Configuration rules
  tables["ReasonCode"] = (await db.reasonCode.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["ToleranceRule"] = (await db.toleranceRule.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];

  // Catalog & Menu
  tables["MenuCategory"] = (await db.menuCategory.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  const products = await db.product.findMany({ where: { cafeId } });
  tables["Product"] = products as unknown as Record<string, unknown>[];
  const productIds = products.map((p) => p.id);

  const variants = productIds.length ? await db.productVariant.findMany({ where: { productId: { in: productIds } } }) : [];
  tables["ProductVariant"] = variants as unknown as Record<string, unknown>[];

  const branchPrices = productIds.length ? await db.productBranchPrice.findMany({ where: { productId: { in: productIds } } }) : [];
  tables["ProductBranchPrice"] = branchPrices as unknown as Record<string, unknown>[];

  const addOns = await db.addOn.findMany({ where: { cafeId } });
  tables["AddOn"] = addOns as unknown as Record<string, unknown>[];

  const productAddOns = productIds.length ? await db.productAddOn.findMany({ where: { productId: { in: productIds } } }) : [];
  tables["ProductAddOn"] = productAddOns as unknown as Record<string, unknown>[];

  tables["ProductStockBinding"] = (await db.productStockBinding.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];

  const recipes = await db.recipe.findMany({ where: { cafeId } });
  tables["Recipe"] = recipes as unknown as Record<string, unknown>[];
  const recipeIds = recipes.map((r) => r.id);

  const recipeItems = recipeIds.length ? await db.recipeItem.findMany({ where: { recipeId: { in: recipeIds } } }) : [];
  tables["RecipeItem"] = recipeItems as unknown as Record<string, unknown>[];

  // Tables
  tables["CafeTable"] = (await db.cafeTable.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["TableSession"] = (await db.tableSession.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["QrOrderApprovalSettings"] = (await db.qrOrderApprovalSettings.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];

  // Customers & Loyalty
  tables["Customer"] = (await db.customer.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["LoyaltySettings"] = (await db.loyaltySettings.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["LoyaltyTransaction"] = (await db.loyaltyTransaction.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];

  // Inventory & Purchasing
  tables["Supplier"] = (await db.supplier.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["InventoryItem"] = (await db.inventoryItem.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["InventoryTransaction"] = (await db.inventoryTransaction.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["PurchaseInvoice"] = (await db.purchaseInvoice.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["PurchaseInvoiceItem"] = (await db.purchaseInvoiceItem.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["PurchasePayment"] = (await db.purchasePayment.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];

  const countSessions = await db.stockCountSession.findMany({ where: { cafeId } });
  tables["StockCountSession"] = countSessions as unknown as Record<string, unknown>[];
  const countSessionIds = countSessions.map((s) => s.id);

  const countLines = countSessionIds.length ? await db.stockCountLine.findMany({ where: { sessionId: { in: countSessionIds } } }) : [];
  tables["StockCountLine"] = countLines as unknown as Record<string, unknown>[];
  const countLineIds = countLines.map((l) => l.id);

  tables["StockCountRecount"] = countLineIds.length ? ((await db.stockCountRecount.findMany({ where: { lineId: { in: countLineIds } } })) as unknown as Record<string, unknown>[]) : [];
  tables["StockCountCorrection"] = countLineIds.length ? ((await db.stockCountCorrection.findMany({ where: { lineId: { in: countLineIds } } })) as unknown as Record<string, unknown>[]) : [];
  tables["StockCountRebase"] = countSessionIds.length ? ((await db.stockCountRebase.findMany({ where: { sessionId: { in: countSessionIds } } })) as unknown as Record<string, unknown>[]) : [];

  const varianceCases = await db.varianceCase.findMany({ where: { cafeId } });
  tables["VarianceCase"] = varianceCases as unknown as Record<string, unknown>[];
  const varianceCaseIds = varianceCases.map((v) => v.id);

  const varianceSpans = varianceCaseIds.length ? await db.stockVarianceSpan.findMany({ where: { varianceCaseId: { in: varianceCaseIds } } }) : [];
  tables["StockVarianceSpan"] = varianceSpans as unknown as Record<string, unknown>[];
  const varianceSpanIds = varianceSpans.map((s) => s.id);

  tables["StockVarianceSpanCustody"] = varianceSpanIds.length ? ((await db.stockVarianceSpanCustody.findMany({ where: { spanId: { in: varianceSpanIds } } })) as unknown as Record<string, unknown>[]) : [];

  tables["InventoryFreeze"] = (await db.inventoryFreeze.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["DeferredStockDeduction"] = (await db.deferredStockDeduction.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["FinishedGoodsReturn"] = (await db.finishedGoodsReturn.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];

  // Operations & Shifts
  const shifts = await db.shift.findMany({ where: { cafeId } });
  tables["Shift"] = shifts as unknown as Record<string, unknown>[];
  const shiftIds = shifts.map((s) => s.id);

  const custodyPeriods = await db.custodyPeriod.findMany({ where: { cafeId } });
  tables["CustodyPeriod"] = custodyPeriods as unknown as Record<string, unknown>[];
  const custodyPeriodIds = custodyPeriods.map((c) => c.id);

  tables["CustodyParticipant"] = custodyPeriodIds.length ? ((await db.custodyParticipant.findMany({ where: { custodyPeriodId: { in: custodyPeriodIds } } })) as unknown as Record<string, unknown>[]) : [];
  tables["ShiftCustody"] = shiftIds.length ? ((await db.shiftCustody.findMany({ where: { shiftId: { in: shiftIds } } })) as unknown as Record<string, unknown>[]) : [];
  tables["ShiftMaterialsDecision"] = (await db.shiftMaterialsDecision.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];

  const handoverSessions = await db.handoverSession.findMany({ where: { cafeId } });
  tables["HandoverSession"] = handoverSessions as unknown as Record<string, unknown>[];
  const handoverIds = handoverSessions.map((h) => h.id);

  tables["HandoverCarriedOrder"] = (await db.handoverCarriedOrder.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["HandoverRequiredItem"] = handoverIds.length ? ((await db.handoverRequiredItem.findMany({ where: { handoverId: { in: handoverIds } } })) as unknown as Record<string, unknown>[]) : [];
  tables["HandoverStockBoundary"] = handoverIds.length ? ((await db.handoverStockBoundary.findMany({ where: { handoverId: { in: handoverIds } } })) as unknown as Record<string, unknown>[]) : [];
  tables["HandoverStockAcknowledgement"] = handoverIds.length ? ((await db.handoverStockAcknowledgement.findMany({ where: { handoverId: { in: handoverIds } } })) as unknown as Record<string, unknown>[]) : [];

  tables["OpeningException"] = (await db.openingException.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["ShiftCashDisposition"] = (await db.shiftCashDisposition.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["CashDeliveryDeclaration"] = (await db.cashDeliveryDeclaration.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["HandoverIssue"] = (await db.handoverIssue.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["TenderReconciliation"] = (await db.tenderReconciliation.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];

  // Orders & Sales
  const orders = await db.order.findMany({ where: { cafeId } });
  tables["Order"] = orders as unknown as Record<string, unknown>[];
  const orderIds = orders.map((o) => o.id);

  const orderItems = orderIds.length ? await db.orderItem.findMany({ where: { orderId: { in: orderIds } } }) : [];
  tables["OrderItem"] = orderItems as unknown as Record<string, unknown>[];
  const orderItemIds = orderItems.map((oi) => oi.id);

  tables["OrderItemAddOn"] = orderItemIds.length ? ((await db.orderItemAddOn.findMany({ where: { orderItemId: { in: orderItemIds } } })) as unknown as Record<string, unknown>[]) : [];
  tables["Payment"] = (await db.payment.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["OrderItemPayment"] = (await db.orderItemPayment.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["OrderRevision"] = (await db.orderRevision.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["OrderAmendment"] = (await db.orderAmendment.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["AmendmentSettlement"] = (await db.amendmentSettlement.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["AmendmentTenderReference"] = (await db.amendmentTenderReference.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["SalesDiscountLimit"] = (await db.salesDiscountLimit.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["OrderTrace"] = (await db.orderTrace.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["HistoricalSaleLine"] = (await db.historicalSaleLine.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];

  // Treasury & Accounting
  tables["AccountingEntity"] = (await db.accountingEntity.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["AccountingAccount"] = (await db.accountingAccount.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["ExpenseCategory"] = (await db.expenseCategory.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["ExpenseCategoryAccountMapping"] = (await db.expenseCategoryAccountMapping.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["AccountingPeriod"] = (await db.accountingPeriod.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["JournalEntry"] = (await db.journalEntry.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["JournalLine"] = (await db.journalLine.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["MoneyAccount"] = (await db.moneyAccount.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["MoneyTransfer"] = (await db.moneyTransfer.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["MoneyMovement"] = (await db.moneyMovement.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["OperatingExpense"] = (await db.operatingExpense.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["OperatingExpenseReturn"] = (await db.operatingExpenseReturn.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];

  // Place assets
  tables["CashStorage"] = (await db.cashStorage.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["CashStorageMovement"] = (await db.cashStorageMovement.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["OpeningCashReceipt"] = (await db.openingCashReceipt.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["OpeningCashReceiptEvent"] = (await db.openingCashReceiptEvent.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];

  const placeAssets = await db.placeAsset.findMany({ where: { cafeId } });
  tables["PlaceAsset"] = placeAssets as unknown as Record<string, unknown>[];
  const placeAssetIds = placeAssets.map((pa) => pa.id);

  tables["PlaceCheckPoint"] = placeAssetIds.length ? ((await db.placeCheckPoint.findMany({ where: { assetId: { in: placeAssetIds } } })) as unknown as Record<string, unknown>[]) : [];

  const shiftPlaceReceipts = await db.shiftPlaceReceipt.findMany({ where: { cafeId } });
  tables["ShiftPlaceReceipt"] = shiftPlaceReceipts as unknown as Record<string, unknown>[];
  const shiftPlaceReceiptIds = shiftPlaceReceipts.map((r) => r.id);

  tables["PlaceObservation"] = shiftPlaceReceiptIds.length ? ((await db.placeObservation.findMany({ where: { receiptId: { in: shiftPlaceReceiptIds } } })) as unknown as Record<string, unknown>[]) : [];
  tables["PlaceReceiptEvent"] = shiftPlaceReceiptIds.length ? ((await db.placeReceiptEvent.findMany({ where: { receiptId: { in: shiftPlaceReceiptIds } } })) as unknown as Record<string, unknown>[]) : [];
  tables["PlaceIncident"] = (await db.placeIncident.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["PlacePhoto"] = (await db.placePhoto.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];

  // Settings & Passcode (Sanitized)
  tables["OwnerActionSettings"] = (await db.ownerActionSettings.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["OwnerActionRequest"] = (await db.ownerActionRequest.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];
  tables["OwnerActionEvent"] = (await db.ownerActionEvent.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];

  const rawOwnerPasscodes = await db.ownerPasscode.findMany({ where: { cafeId } });
  tables["OwnerPasscode"] = rawOwnerPasscodes.map((p) => sanitizeOwnerPasscodeRow(p as unknown as Record<string, unknown>));

  tables["OwnerPasscodeAttempt"] = (await db.ownerPasscodeAttempt.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];

  const rawWA = await db.whatsAppIntegration.findMany({ where: { cafeId } });
  tables["WhatsAppIntegration"] = rawWA.map((w) => sanitizeWhatsAppIntegrationRow(w as unknown as Record<string, unknown>));
  tables["WhatsAppMessageLog"] = (await db.whatsAppMessageLog.findMany({ where: { cafeId } })) as unknown as Record<string, unknown>[];

  // Audit Logs
  tables["AuditLog"] = (await db.auditLog.findMany({ where: { cafeId }, orderBy: { createdAt: "asc" } })) as unknown as Record<string, unknown>[];

  // Build Manifest
  const tableCounts: Record<string, number> = {};
  let totalRows = 0;
  for (const [name, rows] of Object.entries(tables)) {
    tableCounts[name] = rows.length;
    totalRows += rows.length;
  }

  const manifest: BackupManifest = {
    version: "1.0.0",
    generator: "NextCup-ERP-Backup-Engine-v1",
    cafeId,
    cafeName: cafe.name,
    cafeSlug: cafe.slug,
    exportedAt: new Date().toISOString(),
    exportedBy: {
      userId: actor.id,
      name: actor.name,
      role: actor.role,
    },
    totalRows,
    tableCounts,
    omissions: [
      "User.passwordHash (sanitized to prevent unauthorized credential reuse)",
      "OwnerPasscode.passcodeHash (sanitized to protect override code)",
      "WhatsAppIntegration.accessTokenCipher (sanitized to protect external API secrets)",
      "SessionRevocation (excluded ephemeral tokens)",
      "IdempotencyKey (excluded ephemeral request retry tokens)",
    ],
  };

  return { manifest, tables };
}

export function serializeBackupToSql(data: BackupData): string {
  const { manifest, tables } = data;
  let sql = "";

  sql += `-- ====================================================================\n`;
  sql += `-- NEXT CUP ERP — TENANT DATABASE BACKUP\n`;
  sql += `-- ====================================================================\n`;
  sql += `-- Format: PostgreSQL pg_dump compatible SQL script\n`;
  sql += `-- Version: ${manifest.version}\n`;
  sql += `-- Cafe: ${manifest.cafeName} (${manifest.cafeSlug})\n`;
  sql += `-- Cafe ID: ${manifest.cafeId}\n`;
  sql += `-- Exported At: ${manifest.exportedAt}\n`;
  sql += `-- Exported By: ${manifest.exportedBy.name} (${manifest.exportedBy.role})\n`;
  sql += `-- Total Tables: ${Object.keys(manifest.tableCounts).length}\n`;
  sql += `-- Total Rows: ${manifest.totalRows}\n`;
  sql += `-- ====================================================================\n\n`;

  sql += `-- METADATA_JSON_START\n`;
  sql += `-- ${JSON.stringify(manifest, null, 2).split("\n").join("\n-- ")}\n`;
  sql += `-- METADATA_JSON_END\n\n`;

  sql += `BEGIN;\n`;
  sql += `SET client_encoding = 'UTF8';\n`;
  sql += `SET standard_conforming_strings = on;\n`;
  sql += `SET check_function_bodies = false;\n`;
  sql += `SET client_min_messages = warning;\n`;
  sql += `SET CONSTRAINTS ALL DEFERRED;\n\n`;

  for (const [tableName, rows] of Object.entries(tables)) {
    sql += generateSqlInserts(tableName, rows);
  }

  sql += `COMMIT;\n`;
  sql += `-- END OF BACKUP\n`;

  return sql;
}

export function serializeBackupToJson(data: BackupData): string {
  return JSON.stringify(data, null, 2);
}

export async function getBackupStatus(cafeId: string) {
  const [lastBackup, passcode] = await Promise.all([
    db.auditLog.findFirst({
      where: {
        cafeId,
        action: "DATABASE_BACKUP_EXPORTED",
      },
      orderBy: { createdAt: "desc" },
      select: {
        createdAt: true,
        details: true,
      },
    }),
    db.ownerPasscode.findUnique({
      where: { cafeId },
      select: { id: true, ownerId: true },
    }),
  ]);

  return {
    lastBackupAt: lastBackup?.createdAt?.toISOString() ?? null,
    lastBackupDetails: lastBackup?.details ?? null,
    passcodeConfigured: Boolean(passcode),
  };
}

export async function recordBackupAudit(actor: SessionUser, args: {
  ipAddress: string;
  format: "sql" | "json";
  tableCounts: Record<string, number>;
  totalRows: number;
}) {
  await audit({
    cafeId: actor.cafeId,
    userId: actor.id,
    action: "DATABASE_BACKUP_EXPORTED",
    entity: "Cafe",
    entityId: actor.cafeId,
    details: {
      userId: actor.id,
      cafeId: actor.cafeId,
      timestamp: new Date().toISOString(),
      ipAddress: args.ipAddress,
      format: args.format,
      totalRows: args.totalRows,
      tableCounts: args.tableCounts,
    },
  });
}
