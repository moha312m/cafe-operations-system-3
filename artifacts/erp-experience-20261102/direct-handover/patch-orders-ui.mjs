import fs from "fs";
import path from "path";

const WORKTREE = "C:/Users/Acer/.codex/worktrees/nextcup-workspace-redesign/cafe-operations-system-3";
const filePath = path.join(WORKTREE, "src/app/(app)/orders/page.tsx");

let content = fs.readFileSync(filePath, "utf8");
const isCrlf = content.includes("\r\n");
let normalized = content.replace(/\r\n/g, "\n");

// 1. Header filter wrap
normalized = normalized.replace(
  `        {/* فلتر مصدر الطلب / الموظف */}\n        <div className="flex gap-1">`,
  `        {/* فلتر مصدر الطلب / الموظف */}\n        <div className="flex flex-wrap gap-1.5">`
);

// 2. Card header badges wrap
const oldCardHeader = `                      <div className="flex items-center justify-between">
                        <p className="font-semibold">#{order.orderNumber}</p>
                        <div className="flex gap-1">
                          <Badge variant="outline">
                            {t.orderTypes[order.type as keyof typeof t.orderTypes] ?? order.type}
                          </Badge>
                          <Badge
                            variant={order.source === "QR_MENU" ? "default" : "secondary"}
                          >
                            {t.orderSource[order.source]}
                          </Badge>
                          <Badge variant="outline">{t.orderStatus[order.status]}</Badge>
                          <Badge
                            variant={
                              order.paymentStatus === "PAID"
                                ? "default"
                                : order.paymentStatus === "PARTIAL"
                                  ? "secondary"
                                  : order.paymentStatus === "PENDING_COLLECTION"
                                    ? "outline"
                                    : "destructive"
                            }
                          >
                            {t.paymentStatus[order.paymentStatus] ?? "غير مدفوع"}
                          </Badge>
                        </div>
                      </div>`;

const newCardHeader = `                      <div className="flex flex-wrap items-start justify-between gap-1.5">
                        <p className="font-bold text-base leading-none">#{order.orderNumber}</p>
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          <Badge variant="outline" className="text-xs">
                            {t.orderTypes[order.type as keyof typeof t.orderTypes] ?? order.type}
                          </Badge>
                          <Badge
                            variant={order.source === "QR_MENU" ? "default" : "secondary"}
                            className="text-xs"
                          >
                            {t.orderSource[order.source]}
                          </Badge>
                          <Badge variant="outline" className="text-xs">{t.orderStatus[order.status]}</Badge>
                          <Badge
                            variant={
                              order.paymentStatus === "PAID"
                                ? "default"
                                : order.paymentStatus === "PARTIAL"
                                  ? "secondary"
                                  : order.paymentStatus === "PENDING_COLLECTION"
                                    ? "outline"
                                    : "destructive"
                            }
                            className="text-xs"
                          >
                            {t.paymentStatus[order.paymentStatus] ?? "غير مدفوع"}
                          </Badge>
                        </div>
                      </div>`;

normalized = normalized.replace(oldCardHeader, newCardHeader);

// 3. Card footer layout (prevent button clipping and price squishing)
const oldCardFooter = `                      <div className="flex items-center justify-between border-t pt-2">
                        <p className="text-sm font-semibold tabular-nums">
                          {money(order.total, currency)}
                        </p>
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDetail(order)}
                          >
                            تفاصيل
                          </Button>
                          {/* التحصيل يتم من شاشة الكاشير فقط — navigate with context */}
                          {!isPaid && order.paymentStatus !== "REFUNDED" && can("payments:create") && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => router.push(\`/pos?collectOrderId=\${order.id}\`)}
                            >
                              💵 تحصيل من الكاشير
                            </Button>
                          )}
                          {canKey("orders.request_owner_action") &&
                            (order.status === "CONFIRMED" || order.status === "PREPARING"
                              || (order.status === "READY" && order.paymentStatus === "REFUNDED"
                                && Number(order.paidAmount) === 0 && Number(order.remainingAmount) === 0)) && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-destructive"
                                disabled={busy}
                                onClick={() => { setCancelTarget(order); setCancelReason(""); }}
                              >
                                إلغاء
                              </Button>
                            )}
                          <Button
                            size="sm"
                            disabled={busy || (col.next === "SERVED" && !isPaid)}
                            onClick={() => setStatus(order, col.next)}
                          >
                            {col.nextLabel}
                          </Button>
                        </div>
                      </div>`;

const newCardFooter = `                      <div className="border-t pt-2.5 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-bold tabular-nums whitespace-nowrap">
                            {money(order.total, currency)}
                          </p>
                          <div className="flex items-center gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 px-2 text-xs"
                              onClick={() => setDetail(order)}
                            >
                              تفاصيل
                            </Button>
                            {canKey("orders.request_owner_action") &&
                              (order.status === "CONFIRMED" || order.status === "PREPARING"
                                || (order.status === "READY" && order.paymentStatus === "REFUNDED"
                                  && Number(order.paidAmount) === 0 && Number(order.remainingAmount) === 0)) && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-8 px-2 text-xs text-destructive hover:text-destructive"
                                  disabled={busy}
                                  onClick={() => { setCancelTarget(order); setCancelReason(""); }}
                                >
                                  إلغاء
                                </Button>
                              )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {!isPaid && order.paymentStatus !== "REFUNDED" && can("payments:create") && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-9 flex-1 text-xs font-semibold border-amber-500/50 text-amber-900 dark:text-amber-200 bg-amber-500/10 hover:bg-amber-500/20"
                              disabled={busy}
                              onClick={() => router.push(\`/pos?collectOrderId=\${order.id}\`)}
                            >
                              💵 تحصيل من الكاشير
                            </Button>
                          )}
                          <Button
                            size="sm"
                            className="h-9 flex-1 text-xs font-semibold"
                            disabled={busy || (col.next === "SERVED" && !isPaid)}
                            onClick={() => setStatus(order, col.next)}
                          >
                            {col.nextLabel}
                          </Button>
                        </div>
                      </div>`;

normalized = normalized.replace(oldCardFooter, newCardFooter);

const finalContent = isCrlf ? normalized.replace(/\n/g, "\r\n") : normalized;
fs.writeFileSync(filePath, finalContent, "utf8");
console.log("Successfully patched orders/page.tsx");
