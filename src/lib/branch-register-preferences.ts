import { z } from "zod";

const branchOrderType = z.enum(["DINE_IN", "TAKEAWAY"]);
export type BranchOrderType = z.infer<typeof branchOrderType>;
type OrderType = BranchOrderType | "DELIVERY";

export const branchRegisterPreferences = z.object({
  posDefaultOrderType: branchOrderType.optional(),
  pickupAtCashier: z.boolean().optional(),
});

export function registerOrderType(draft: OrderType | null, branchDefault: BranchOrderType | undefined): OrderType {
  return draft ?? branchDefault ?? "DINE_IN";
}

export function pickupAtCashier(enabled: boolean, type: OrderType): boolean {
  return enabled && type === "TAKEAWAY";
}
