import assert from "node:assert/strict";

// Execute through mcp__cua_repl after the guarded clone runner. No Playwright
// installation, hidden fetch, DOM mutation, cookie injection or launch route.
// Source-bound locators are validated against fresh live DOM before every
// decision; a mismatch is a test failure/verification gap, never a guessed PASS.
const exact = text => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const button = (scope, name) => scope.getByRole("button", { name, exact: typeof name === "string" });
async function one(locator) { await locator.waitFor({ state: "visible", timeoutMs: 15_000 }); assert.equal(await locator.count(), 1); return locator; }
async function click(tab, locator) { await (await one(locator)).click(); await tab.playwright.domSnapshot(); }
async function go(tab, url) { if (await tab.url() !== url) await tab.goto(url); else await tab.reload(); await tab.playwright.domSnapshot(); }
const card = (tab, number) => tab.playwright.locator('[data-slot="card"]').filter({ hasText: new RegExp(`#${number}(?!\\d)`) });
const dialog = tab => tab.playwright.getByRole("dialog");

export async function ui01(tab, ctx) {
  const f = ctx.fixtures.config; await ctx.login(tab, f, "owner"); await go(tab, ctx.base + "/menu");
  const row = tab.playwright.getByRole("row").filter({ hasText: f.productName });
  await click(tab, button(await one(row), "تعديل"));
  const d = await one(dialog(tab));
  assert.equal(await d.getByLabel("طريقة استهلاك المخزون", { exact: true }).evaluate(el => el.value), "RECIPE");
  await d.getByPlaceholder("اسم الحجم (صغير/وسط/كبير)", { exact: true }).fill("retained configuration");
  await d.getByLabel("طريقة استهلاك المخزون", { exact: true }).selectOption("FINISHED_GOOD"); await tab.playwright.domSnapshot();
  await (await one(d.getByLabel(f.branchName + " / retained configuration", { exact: true }))).selectOption(f.stockId);
  await click(tab, button(d, "حفظ المنتج"));
  const product = await ctx.poll(() => ctx.db.product.findUnique({ where: { id: f.productId }, include: { variants: true, stockBindings: true } }), p => p?.stockMode === "FINISHED_GOOD");
  assert.ok(product.variants.some(v => v.id === f.variantId && v.name === "retained configuration"));
  assert.ok(product.stockBindings.some(b => b.variantId === f.variantId && b.branchId === f.branchId && b.inventoryItemId === f.stockId && b.unit === "PIECE"));
  await ctx.capture(tab, "RESALE-UI01"); ctx.pass("RESALE-UI01", { stableVariantId: f.variantId, exactBinding: true, stockMode: product.stockMode });
}

async function collectAndServe(tab, ctx, f, order) {
  await go(tab, ctx.base + "/orders");
  await click(tab, button(await one(card(tab, order.orderNumber)), /تحصيل من الكاشير/));
  await click(tab, button(await one(dialog(tab)), "تحصيل الدفع"));
  await tab.playwright.getByText("تم تحصيل الدفع بنجاح", { exact: true }).waitFor({ state: "visible", timeoutMs: 15_000 });
  assert.equal(await ctx.db.inventoryTransaction.count({ where: { orderId: order.id } }), 0, "Payment must not consume stock");
  await click(tab, button(dialog(tab), "إغلاق")); await go(tab, ctx.base + "/orders");
  for (const [label, status] of [["ابدأ التحضير", "PREPARING"], ["جاهز", "READY"], ["تسليم", "SERVED"]]) {
    await click(tab, button(await one(card(tab, order.orderNumber)), label));
    await ctx.poll(() => ctx.db.order.findUnique({ where: { id: order.id } }), o => o?.status === status);
    await tab.playwright.domSnapshot();
  }
  const usage = await ctx.db.inventoryTransaction.findMany({ where: { orderId: order.id, type: "USAGE" } });
  assert.equal(usage.length, 1); assert.equal(Number(usage[0].quantity), -1); assert.equal(usage[0].inventoryItemId, f.stockId);
  return { orderId: order.id, movementId: usage[0].id, quantity: Number(usage[0].quantity), cost: Number(usage[0].totalCost) };
}
export async function ui02(staffTab, publicTab, ctx) {
  const f = ctx.fixtures.sales; await ctx.login(staffTab, f, "cashier"); await go(staffTab, ctx.base + "/pos");
  await click(staffTab, button(staffTab.playwright, /تيك أواي/));
  await click(staffTab, button(staffTab.playwright, exact(f.productName)));
  await click(staffTab, button(staffTab.playwright, /انتظار التحصيل/));
  await click(staffTab, button(staffTab.playwright, /^تسجيل الطلب/));
  const pos = await ctx.poll(() => ctx.db.order.findFirst({ where: { cafeId: f.cafeId, source: "CASHIER_POS" }, include: { items: true }, orderBy: { createdAt: "desc" } }), o => !!o);
  assert.equal(pos.items[0].finishedStockQuantity, 1); assert.equal(pos.items[0].finishedStockItemId, f.stockId);
  const posEvidence = await collectAndServe(staffTab, ctx, f, pos);
  await go(publicTab, ctx.base + f.publicPath);
  await click(publicTab, button(publicTab.playwright, exact(f.productName)));
  // A base product without configuration/add-ons adds directly to the cart.
  await click(publicTab, button(publicTab.playwright, "السلة"));
  await click(publicTab, button(dialog(publicTab), "زوّد الكمية"));
  await dialog(publicTab).getByPlaceholder("اسمك", { exact: true }).fill(f.marker + " browser customer");
  await dialog(publicTab).getByPlaceholder("مثلاً: 5", { exact: true }).fill("R1");
  await click(publicTab, button(dialog(publicTab), "إرسال الطلب"));
  await publicTab.playwright.getByRole("heading", { name: "تم إرسال طلبك بنجاح", exact: true }).waitFor({ state: "visible", timeoutMs: 15_000 });
  const qr = await ctx.poll(() => ctx.db.order.findFirst({ where: { cafeId: f.cafeId, source: "QR_MENU" }, include: { items: true }, orderBy: { createdAt: "desc" } }), o => !!o);
  assert.equal(qr.items[0].quantity, 2); assert.equal(qr.items[0].stockAcceptedAt, null);
  await go(staffTab, ctx.base + "/approvals"); await click(staffTab, button(await one(card(staffTab, qr.orderNumber)), "تعديل الطلب"));
  for (let n = 0; n < 3; n++) await click(staffTab, button(dialog(staffTab), "+"));
  await ctx.capture(staffTab, "RESALE-UI02-pending-five");
  for (let n = 0; n < 4; n++) await click(staffTab, button(dialog(staffTab), "−"));
  await click(staffTab, button(dialog(staffTab), "حفظ وتأكيد الطلب"));
  const accepted = await ctx.poll(() => ctx.db.orderItem.findUnique({ where: { id: qr.items[0].id } }), line => !!line?.stockAcceptedAt);
  assert.equal(accepted.finishedStockQuantity, 1); assert.equal(accepted.quantity, 1);
  const qrEvidence = await collectAndServe(staffTab, ctx, f, qr);
  assert.equal(await ctx.balance(f.stockId), 28); assert.equal(await ctx.balance(f.preparedStockId), 10);
  await ctx.capture(staffTab, "RESALE-UI02"); await ctx.capture(publicTab, "RESALE-UI02-public");
  ctx.pass("RESALE-UI02", { pos: posEvidence, qr: qrEvidence, pendingQuantities: [2, 5, 1], noPaymentConsumption: true });
}

async function returnForm(tab, ctx, f, lineId, quantity) {
  await go(tab, ctx.base + "/inventory");
  await click(tab, button(await one(tab.playwright.getByRole("row").filter({ hasText: f.stockName })), "حركة مخزون"));
  await click(tab, button(dialog(tab), "مرتجع"));
  const d = await one(dialog(tab)); assert.match(await d.innerText(), /منفصلة/);
  await (await one(d.getByLabel("صنف الطلب الأصلي للمرتجع", { exact: true }))).selectOption(lineId);
  await d.getByRole("spinbutton").fill(String(quantity)); await d.locator("textarea").fill(f.marker + " physically received browser pieces");
  await tab.playwright.domSnapshot(); return d;
}
export async function ui03Intake(tab, ctx) {
  const f = ctx.fixtures.returns; await ctx.login(tab, f, "owner");
  let d = await returnForm(tab, ctx, f, f.olderLineId, 2);
  const cdp = await tab.capabilities.get("cdp");
  // Real committed receipt with its response deliberately lost. No mocked
  // server response, request or PostgreSQL concurrency claim.
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: ctx.base + `/api/inventory/${f.stockId}/movement`, requestStage: "Response" }] });
  let requestId;
  try {
    const cursor = (await cdp.readEvents({ methods: ["Fetch.requestPaused"] })).cursor;
    await button(d, "حفظ الحركة").click();
    const events = await cdp.readEvents({ methods: ["Fetch.requestPaused"], afterSequence: cursor, timeoutMs: 15_000, limit: 10 }); assert.equal(events.truncated, false);
    assert.equal(events.events.length, 1); const paused = events.events[0].params; requestId = paused.requestId;
    assert.ok(paused.responseStatusCode >= 200 && paused.responseStatusCode < 300);
    await ctx.poll(() => ctx.db.finishedGoodsReturn.count({ where: { orderItemId: f.olderLineId } }), count => count === 1);
    await cdp.send("Fetch.failRequest", { requestId, errorReason: "ConnectionClosed" }); requestId = undefined;
  } finally {
    if (requestId) await cdp.send("Fetch.continueRequest", { requestId });
    await cdp.send("Fetch.disable");
  }
  await tab.playwright.domSnapshot(); assert.equal(await button(d, "حفظ الحركة").isEnabled(), true);
  await click(tab, button(d, "حفظ الحركة"));
  await tab.playwright.getByText(/طلب مكرر — الإيصال السابق/).waitFor({ state: "visible", timeoutMs: 15_000 });
  assert.equal(await ctx.db.finishedGoodsReturn.count({ where: { orderItemId: f.olderLineId } }), 1);
  for (const lineId of [f.unvaluedLineId, f.deferredLineId]) { d = await returnForm(tab, ctx, f, lineId, 1); await click(tab, button(d, "حفظ الحركة")); await ctx.poll(() => ctx.db.finishedGoodsReturn.count({ where: { orderItemId: lineId } }), count => count === 1); }
  assert.equal(await ctx.balance(f.stockId), f.initialStock); const receipts = await ctx.receiptEvidence(f); assert.equal(receipts.length, 3); assert.ok(receipts.every(r => !r.appliedAt));
  await ctx.capture(tab, "RESALE-UI03-pending");
  await ctx.login(tab, f, "cashier");
  await go(tab, ctx.base + "/handovers");
  assert.equal(await ctx.db.handoverSession.count({ where: { cafeId: f.cafeId } }), 1);
  await click(tab, tab.playwright.getByTestId("handover-row"));
  const handoverView = await ctx.capture(tab, "RESALE-UI03-handover"); assert.match(handoverView, /منفصلة/);
  for (const receipt of receipts) assert.ok(handoverView.includes(receipt.id));
  // UI03 is not PASS yet: execute guarded --browser-finish-returns, then
  // ui03Posted on the same context. Frozen pieces stay outside the count.
  return { phase: "PENDING_POSTING", receipts };
}
export async function ui03Posted(tab, ctx) {
  const f = ctx.fixtures.returns; await ctx.login(tab, f, "manager"); const receipts = await ctx.receiptEvidence(f);
  assert.equal(receipts.length, 3); assert.ok(receipts.every(r => r.appliedAt));
  const unknown = receipts.find(r => r.orderItemId === f.unvaluedLineId); assert.equal(unknown.unitCost, null); assert.equal(unknown.totalCost, null);
  assert.equal(Number(receipts.find(r => r.orderItemId === f.olderLineId).totalCost), 5);
  assert.equal(await ctx.balance(f.stockId), 27);
  await go(tab, ctx.base + "/inventory");
  await (await one(tab.playwright.getByRole("checkbox", { name: "إظهار المؤرشف للوصول لمرتجعات الطلبات الأصلية", exact: true }))).check(); await tab.playwright.domSnapshot();
  await click(tab, button(await one(tab.playwright.getByRole("row").filter({ hasText: f.stockName })), "حركة مخزون"));
  await click(tab, button(dialog(tab), "مرتجع"));
  await (await one(dialog(tab).getByLabel("صنف الطلب الأصلي للمرتجع", { exact: true }))).selectOption(f.unvaluedLineId); await tab.playwright.domSnapshot();
  assert.match(await ctx.capture(tab, "RESALE-UI03-posted"), /بدون تقييم|التقييم معلّق/);
  await dialog(tab).press("Escape"); await tab.playwright.domSnapshot(); ctx.pass("RESALE-UI03", { receipts, physicalBalance: 27, lossAndReplay: "same durable receipt", countExcludedHeldReturns: true });
}

export async function ui04(tab, ctx) {
  const historical = ctx.fixtures.returns; await ctx.login(tab, historical, "waiter"); await go(tab, ctx.base + "/inventory");
  const denied = await ctx.capture(tab, "RESALE-UI04-waiter"); assert.ok(!denied.includes(historical.stockName)); assert.equal(await button(tab.playwright, "حركة مخزون").count(), 0);
  await ctx.login(tab, historical, "manager"); await go(tab, ctx.base + "/inventory");
  await tab.playwright.getByRole("checkbox", { name: "إظهار المؤرشف للوصول لمرتجعات الطلبات الأصلية", exact: true }).check(); await tab.playwright.domSnapshot();
  const row = await one(tab.playwright.getByRole("row").filter({ hasText: historical.stockName }));
  await click(tab, button(row, "حركة مخزون")); await click(tab, button(dialog(tab), "مرتجع"));
  assert.equal(await button(dialog(tab), "شراء").count(), 0); await ctx.capture(tab, "RESALE-UI04-historical");
  await dialog(tab).press("Escape"); await tab.playwright.domSnapshot();
  const f = ctx.fixtures.receiving; await ctx.login(tab, f, "manager"); await go(tab, ctx.base + "/inventory");
  assert.ok(!(await tab.playwright.domSnapshot()).includes(historical.stockName), "Other cafe history must not be disclosed");
  assert.ok(!(await tab.playwright.domSnapshot()).includes(f.otherBranchStockName), "Pinned manager cannot see another branch stock");
  for (const invoice of f.invoices) {
    await go(tab, ctx.base + "/purchases"); await click(tab, button(await one(tab.playwright.getByRole("row").filter({ hasText: invoice.invoiceNumber })), "تفاصيل"));
    await click(tab, button(dialog(tab), "تأكيد الفاتورة")); await click(tab, button(dialog(tab), "تأكيد وإضافة للمخزون"));
    await ctx.poll(() => ctx.db.purchaseInvoice.findUnique({ where: { id: invoice.id } }), p => p?.status === "CONFIRMED"); await dialog(tab).press("Escape"); await tab.playwright.domSnapshot();
  }
  const stock = await ctx.db.inventoryItem.findUniqueOrThrow({ where: { id: f.receivedStockId } }); assert.equal(Number(stock.currentStock), 20); assert.equal(Number(stock.costPerUnit), 3);
  assert.equal(await ctx.db.purchasePayment.count({ where: { purchaseInvoiceId: { in: f.invoices.map(i => i.id) } } }), 0);
  await go(tab, ctx.base + "/menu"); await click(tab, tab.playwright.getByRole("tab", { name: "تقرير التكلفة", exact: true }));
  assert.match(await ctx.capture(tab, "RESALE-UI04-costs"), /التكلفة المرجعية الحالية للفرع/);
  const costRow = await one(tab.playwright.getByRole("row").filter({ hasText: f.productName })); assert.match(await costRow.innerText(), /3/);
  ctx.pass("RESALE-UI04", { deniedWaiter: true, historicalReturnOnly: true, foreignCafeHidden: true, receiving: { pieces: 20, unitCost: 3, implicitPayments: 0 }, valuationBasis: "CURRENT_BRANCH_REFERENCE_ESTIMATE" });
}
