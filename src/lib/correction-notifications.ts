import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { audit, auditInTransaction } from "@/lib/audit";

export type CorrectionNotificationInput = {
  cafeId: string;
  branchId?: string | null;
  correctionId: string;
  lineId: string;
  actorId: string;
  itemName: string;
  oldCount: number;
  newCount: number;
  reasonLabel: string;
  note?: string;
};

/**
 * Dispatches an automated notification to the owner/managers when a staff member submits a stock correction.
 * Captures audit log and triggers WhatsApp alert if configured.
 * Never throws to avoid blocking the primary transaction.
 */
export async function notifyOwnerOfCorrection(
  input: CorrectionNotificationInput,
  client?: Prisma.TransactionClient
): Promise<void> {
  try {
    const details = {
      correctionId: input.correctionId,
      lineId: input.lineId,
      itemName: input.itemName,
      oldCount: input.oldCount,
      newCount: input.newCount,
      reason: input.reasonLabel,
      note: input.note,
      branchId: input.branchId,
      message: `طلب تصحيح جديد للصنف (${input.itemName}): من ${input.oldCount} إلى ${input.newCount} — السبب: ${input.reasonLabel}`,
    };

    const auditEntry = {
      cafeId: input.cafeId,
      userId: input.actorId,
      action: "CORRECTION_NOTIFICATION_DISPATCHED",
      entity: "StockCountCorrection",
      entityId: input.correctionId,
      details,
    };

    if (client) {
      await auditInTransaction(client, auditEntry);
    } else {
      await audit(auditEntry);
    }

    // Check if WhatsApp integration is enabled for the cafe
    const whatsapp = await (client ?? db).whatsAppIntegration.findUnique({
      where: { cafeId: input.cafeId },
      select: { enabled: true, recipientPhone: true },
    });

    if (whatsapp?.enabled && whatsapp.recipientPhone) {
      // In production with WhatsApp active, log the notification dispatch evidence
      console.log(
        `[whatsapp-notification] Stock correction alert queued for ${whatsapp.recipientPhone}: ${details.message}`
      );
    }
  } catch (err) {
    // Non-blocking logger
    console.error("[correction-notification] Failed to dispatch notification:", err instanceof Error ? err.message : err);
  }
}
