import { createHash } from "node:crypto";
import { decimal } from "@/lib/money";
import type { RoundingMode } from "./menu-pricing";

export interface PreviewFingerprintItem {
  targetType: "PRODUCT" | "VARIANT";
  targetId: string;
  unitCost: number | string;
  suggestedPrice: number | string;
}

export interface PreviewFingerprintPayload {
  cafeId: string;
  referenceBranchId?: string | null;
  multiplier: number | string;
  roundingMode: RoundingMode;
  roundingStep?: number | string | null;
  items: PreviewFingerprintItem[];
}

/**
 * Generates a deterministic SHA-256 fingerprint for preview validation.
 * Items are deterministically sorted by targetType, then targetId.
 */
export function generatePreviewFingerprint(payload: PreviewFingerprintPayload): string {
  const sortedItems = [...payload.items].sort((a, b) => {
    if (a.targetType !== b.targetType) {
      return a.targetType.localeCompare(b.targetType);
    }
    return a.targetId.localeCompare(b.targetId);
  });

  const body = [
    `cafe:${payload.cafeId}`,
    `refBranch:${payload.referenceBranchId ?? "none"}`,
    `multiplier:${decimal(payload.multiplier).toFixed(3)}`,
    `mode:${payload.roundingMode}`,
    `step:${payload.roundingStep ? decimal(payload.roundingStep).toFixed(2) : "none"}`,
    `items:${sortedItems
      .map(
        (it) =>
          `${it.targetType}:${it.targetId}:${decimal(it.unitCost).toFixed(2)}:${decimal(
            it.suggestedPrice
          ).toFixed(2)}`
      )
      .join("|")}`,
  ].join("#");

  return createHash("sha256").update(body).digest("hex");
}

export function verifyPreviewFingerprint(
  fingerprint: string,
  payload: PreviewFingerprintPayload
): boolean {
  if (!fingerprint || typeof fingerprint !== "string") return false;
  const expected = generatePreviewFingerprint(payload);
  return fingerprint === expected;
}
