import { t } from "@/lib/i18n";

// Minimal shape shared by every screen that shows who handled an order.
export type StaffTrackedOrder = {
  source: "QR_MENU" | "WAITER" | "CASHIER_POS";
  createdBy?: { name: string } | null;
  approvedBy?: { name: string } | null;
};

// Who "handled" the order, per source:
//   WAITER      → the waiter who created it       (الويتر: أحمد)
//   CASHIER_POS → the cashier who created it      (الكاشير: محمد)
//   QR_MENU     → the waiter who approved it      (وافق عليه: أحمد)
// Returns null when the info isn't available yet (e.g. unapproved QR order).
export function handledBy(
  order: StaffTrackedOrder
): { label: string; name: string } | null {
  if (order.source === "WAITER" && order.createdBy) {
    return { label: t.staffInfo.waiter, name: order.createdBy.name };
  }
  if (order.source === "CASHIER_POS" && order.createdBy) {
    return { label: t.staffInfo.cashier, name: order.createdBy.name };
  }
  if (order.source === "QR_MENU" && order.approvedBy) {
    return { label: "وافق عليه", name: order.approvedBy.name };
  }
  return null;
}
