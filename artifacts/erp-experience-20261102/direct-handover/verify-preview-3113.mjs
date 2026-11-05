import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import bcrypt from "bcryptjs";
import * as XLSX from "xlsx";
import { db, teardownTaggedCafe } from "../../../tests/helpers/db.ts";
import { countCafe, countItem, COUNT_PASSWORD } from "../../../tests/helpers/count.ts";
import { as, login, jarFor, requireServer } from "../../../tests/helpers/http.ts";

const OUT_DIR = path.resolve("artifacts/erp-experience-20261102/direct-handover");
fs.mkdirSync(OUT_DIR, { recursive: true });

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3113";
const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const EDGE_BIN = EDGE_PATHS.find((p) => fs.existsSync(p));
if (!EDGE_BIN) throw new Error("Microsoft Edge not found");

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

async function launchBrowser() {
  const port = await getFreePort();
  const userDataDir = path.join(OUT_DIR, `.edge-profile-${Date.now()}`);
  const proc = spawn(
    EDGE_BIN,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,960",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const tabs = await res.json();
      const page = tabs.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) {
        wsUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch {
      // wait
    }
  }
  if (!wsUrl) {
    proc.kill();
    throw new Error("Failed to connect to Edge CDP");
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const data = JSON.parse(String(ev.data));
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result);
    }
  };

  function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");
  await send("Network.enable");

  async function setSessionCookie(cookieHeader) {
    await send("Network.clearBrowserCookies");
    const m = cookieHeader.match(/cafeops_session=([^;]+)/);
    if (!m) throw new Error(`Invalid cookie header: ${cookieHeader}`);
    await send("Network.setCookie", {
      name: "cafeops_session",
      value: m[1],
      url: BASE_URL,
      domain: "localhost",
      path: "/",
      httpOnly: true,
    });
  }

  async function setViewport(width, height) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    });
  }

  async function evaluate(expression) {
    const res = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`JS eval error: ${res.exceptionDetails.text}`);
    }
    return res.result?.value;
  }

  async function waitForText(text, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = await evaluate(`document.body && document.body.innerText.includes(${JSON.stringify(text)})`);
      if (found) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    const bodyText = await evaluate(`document.body ? document.body.innerText.slice(0, 1200) : ""`);
    throw new Error(`Timeout waiting for text "${text}". Current body: ${bodyText}`);
  }

  async function goto(url) {
    await send("Page.navigate", { url });
    const start = Date.now();
    while (Date.now() - start < 20000) {
      const state = await evaluate(`document.readyState`);
      if (state === "complete") break;
      await new Promise((r) => setTimeout(r, 150));
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  async function checkOverflow(label) {
    const metrics = await evaluate(`({
      innerWidth: window.innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body ? document.body.scrollWidth : 0
    })`);
    if (metrics.scrollWidth > metrics.innerWidth + 1) {
      throw new Error(`Horizontal overflow on ${label}: ${JSON.stringify(metrics)}`);
    }
    return metrics;
  }

  async function screenshot(filename, fullPage = true) {
    if (fullPage) {
      const layout = await send("Page.getLayoutMetrics");
      const width = Math.ceil(layout.cssContentSize?.width || 1280);
      const height = Math.min(Math.max(Math.ceil(layout.cssContentSize?.height || 900), 600), 4000);
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await new Promise((r) => setTimeout(r, 150));
    }
    const { data } = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
    const outPath = path.join(OUT_DIR, filename);
    fs.writeFileSync(outPath, Buffer.from(data, "base64"));
    return outPath;
  }

  async function close() {
    try { ws.close(); } catch {}
    try {
      if (proc.pid) spawnSync("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { stdio: "ignore" });
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }

  return { send, setSessionCookie, setViewport, evaluate, waitForText, goto, checkOverflow, screenshot, close };
}

test("verify 3113 guarded preview split-cash direct handover journey, screenshots, PDF, and XLSX", { timeout: 240000 }, async () => {
  const configFile = path.resolve("artifacts/workspace-redesign-20261102/private-direct-handover-config.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  process.env.NEXTCUP_WORKSPACE_CONFIG = configFile;
  process.env.NEXTCUP_WORKSPACE_FIXTURES = path.resolve("artifacts/workspace-redesign-20261102/private-fixtures.json");
  const { verifyWorkspace } = await import("../../workspace-redesign-20261102/workspace-guard-direct-handover.mjs");
  const { proof: guardProof } = await verifyWorkspace({ requireCorrespondence: true });

  await requireServer();

  const DEMO_TAG = "workspace20261102-1949053d4248-DH3113";
  const oldCafes = await db.cafe.findMany({ where: { name: { contains: DEMO_TAG } }, select: { id: true, branches: { select: { id: true } } } });
  for (const c of oldCafes) {
    for (const b of c.branches) {
      await db.$transaction(async (tx) => {
        const guards = [
          ["CashDeliveryDeclaration", "CashDeliveryDeclaration_immutable_guard"],
          ["ShiftCashDisposition", "ShiftCashDisposition_immutable_guard"],
          ["HandoverIssue", "HandoverIssue_immutable_guard"],
        ];
        for (const [t, g] of guards) await tx.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER "${g}"`);
        await tx.$executeRawUnsafe(`DELETE FROM "HandoverIssue" WHERE "branchId" = $1`, b.id);
        await tx.$executeRawUnsafe(`DELETE FROM "CashDeliveryDeclaration" WHERE "branchId" = $1`, b.id);
        await tx.$executeRawUnsafe(`DELETE FROM "ShiftCashDisposition" WHERE "branchId" = $1`, b.id);
        for (const [t, g] of guards) await tx.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER "${g}"`);
      });
    }
    await teardownTaggedCafe([c.id]).catch(() => {});
  }

  const fx = await countCafe(DEMO_TAG);
  await db.cafe.update({
    where: { id: fx.cafeId },
    data: { name: `${DEMO_TAG} — مقهى ومحمصة نكست كاب المختصة (الإدارة العامة)`, currency: "EGP" },
  });
  await db.cafeSettings.update({
    where: { cafeId: fx.cafeId },
    data: {
      stockCountPolicy: "HYBRID",
      handoverCountType: "CRITICAL",
      periodicFullCountSchedule: "MANUAL_ONLY",
      periodicFullCountWeekday: null,
      varianceBlocksHandover: false,
      varianceHardBlockAmount: null,
    },
  });
  await db.branch.update({
    where: { id: fx.branchId },
    data: {
      name: "فرع المعادي الرئيسي — شارع التسعين الجنوبي والتجمع",
      stockCountPolicyOverride: null,
      handoverCountTypeOverride: null,
      periodicFullCountScheduleOverride: null,
      periodicFullCountWeekdayOverride: null,
    },
  });
  await db.branchOpeningSettings.deleteMany({ where: { branchId: fx.branchId } });

  await db.user.update({ where: { id: fx.owner.id }, data: { name: "أحمد محمود الشناوي — المالك والمدير العام" } });
  await db.user.update({ where: { id: fx.manager.id }, data: { name: "محمود حسن إبراهيم — مدير تشغيل الفرع" } });
  await db.user.update({ where: { id: fx.cashier.id }, data: { name: "سارة عبد الرحمن محمد — كاشير الوردية الصباحية" } });

  const incomingEmail = `dh3113-incoming-${Date.now()}@example.invalid`;
  const incomingUser = await db.user.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      name: "عمر خالد مصطفى — كاشير الوردية المسائية والاستلام",
      email: incomingEmail,
      passwordHash: await bcrypt.hash(COUNT_PASSWORD, 4),
      role: "CASHIER",
      isActive: true,
    },
  });

  const itemCoffee = await countItem(fx, "alpha", { stock: 4.25, isCritical: true });
  await db.inventoryItem.update({
    where: { id: itemCoffee.id },
    data: { name: "حبوب بن إسبريسو إثيوبي ييرجاشيف تحميص متوسط مختص", unit: "KG", currentStock: "4.25", isCritical: true },
  });
  const itemMilk = await countItem(fx, "bravo", { stock: 12.5, isCritical: true });
  await db.inventoryItem.update({
    where: { id: itemMilk.id },
    data: { name: "حليب أبقار طبيعي طازج كامل الدسم مبستر للباريستا", unit: "KG", currentStock: "12.5", isCritical: true },
  });

  await login(fx.owner.email, COUNT_PASSWORD);
  await login(fx.manager.email, COUNT_PASSWORD);
  await login(fx.cashier.email, COUNT_PASSWORD);
  await login(incomingEmail, COUNT_PASSWORD);

  const ownerCookie = jarFor(fx.owner.email);
  const cashierCookie = jarFor(fx.cashier.email);
  const incomingCookie = jarFor(incomingEmail);

  // Open outgoing shift #101 with 2,950 EGP opening cash
  const shift1 = await db.shift.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      cashierId: fx.cashier.id,
      shiftNumber: 101,
      status: "OPEN",
      openingCashAmount: 2950,
      expectedCashAmount: 2950,
    },
  });
  const { ensureCustodyForShift } = await import("@/lib/custody");
  await db.$transaction((tx) =>
    ensureCustodyForShift(tx, {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      shiftId: shift1.id,
      userId: fx.cashier.id,
      openingCashAmount: 2950,
    }),
  );

  const browser = await launchBrowser();
  const report = {
    at: new Date().toISOString(),
    baseUrl: BASE_URL,
    buildId: fs.readFileSync(".next-integration/BUILD_ID", "utf8").trim(),
    sourceSha256: config.source.sha256,
    guardProof,
    previewDemo: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      outgoingShiftId: shift1.id,
      handoverId: null,
      incomingShiftId: null,
      handoverUrl: null,
      shiftReportUrl: `${BASE_URL}/reports/shift/${shift1.id}`,
      printReportUrl: null,
      xlsxReportUrl: null,
      credentials: {
        password: COUNT_PASSWORD,
        ownerEmail: fx.owner.email,
        managerEmail: fx.manager.email,
        outgoingCashierEmail: fx.cashier.email,
        incomingCashierEmail: incomingEmail,
      },
    },
    screenshots: [],
    overflowChecks: {},
    posReadiness: {},
    xlsx: {},
    pdf: {},
  };

  try {
    // 1. Outgoing financial close + count lines prepared so /close-shift opens on Materials + CashDispositionEditor + Unified Review
    const { closeShiftWithSettlement } = await import("@/lib/cash-close");
    const closed = await closeShiftWithSettlement({
      shiftId: shift1.id,
      actualCash: 3000,
      actorId: fx.cashier.id,
      closedByManager: false,
      handoverTarget: "SHIFT_TO_SHIFT",
      directHandover: true,
      grants: { handoverSubmit: true, handoverException: true },
      reason: "زيادة فكة مسائية في درج الكاشير الرئيسي",
    });
    const handoverId = closed.handoverId;
    assert.ok(handoverId, "Handover session created");
    report.previewDemo.handoverId = handoverId;
    report.previewDemo.handoverUrl = `${BASE_URL}/handovers?branchId=${fx.branchId}&handoverId=${handoverId}#cash`;
    report.previewDemo.printReportUrl = `${BASE_URL}/api/handovers/${handoverId}/report?format=html`;
    report.previewDemo.xlsxReportUrl = `${BASE_URL}/api/handovers/${handoverId}/report?format=xlsx`;

    const startRes = await as(fx.cashier.email, "/api/handovers", {
      method: "POST",
      body: JSON.stringify({ action: "start_count", handoverId }),
    });
    assert.equal(startRes.status, 200, startRes.text);
    const countSessionId = startRes.body.countSession.id;
    const lines = await db.stockCountLine.findMany({ where: { sessionId: countSessionId }, include: { inventoryItem: true } });
    for (const l of lines) {
      const qty = l.inventoryItem.name.includes("حبوب") ? 4.25 : 12.5;
      const r = await as(fx.cashier.email, `/api/stock-counts/${countSessionId}/lines/${l.id}`, {
        method: "PATCH",
        body: JSON.stringify({ countedQuantity: qty }),
      });
      assert.ok(r.status < 300, r.text);
    }

    // Open /close-shift as outgoing cashier: allocate 2,000 Owner + 500 Manager + 500 Retained = 3,000 Counted
    await browser.setSessionCookie(cashierCookie);
    await browser.setViewport(1280, 960);
    await browser.goto(`${BASE_URL}/close-shift`);
    await browser.waitForText("تحديد مصير النقدية المعدودة");
    await browser.waitForText("إغلاق الوردية وتسليم العهدة");

    await browser.evaluate(`(() => {
      const ownerChk = document.querySelector('[data-testid="disposition-toggle-owner"]');
      if (ownerChk && !ownerChk.checked) ownerChk.click();
      const mgrChk = document.querySelector('[data-testid="disposition-toggle-manager"]');
      if (mgrChk && !mgrChk.checked) mgrChk.click();
    })()`);
    await new Promise((r) => setTimeout(r, 300));

    await browser.evaluate(`(() => {
      const setReactInput = (el, val) => {
        if (!el) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const setReactTextarea = (el, val) => {
        if (!el) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };

      setReactInput(document.querySelector('#disp-owner-amount'), '2000');
      setReactInput(document.querySelector('#disp-owner-ref'), 'تسليم مسائي للمالك والمدير العام');
      setReactInput(document.querySelector('#disp-manager-amount'), '500');
      setReactInput(document.querySelector('#disp-manager-ref'), 'عهدة مشتريات تشغيلية لمدير الفرع');
      setReactInput(document.querySelector('#disp-retained-amount'), '500.00');
      setReactTextarea(document.querySelector('#materials-note'), 'زيادة فكة مسائية في درج الكاشير الرئيسي — تم تسليم 2000 للمالك و500 للمدير');
    })()`);
    await new Promise((r) => setTimeout(r, 300));

    report.screenshots.push(await browser.screenshot("desktop-01-outgoing-allocation-review.png", true));

    await browser.setViewport(390, 844);
    await new Promise((r) => setTimeout(r, 300));
    report.overflowChecks.mobile390_outgoing = await browser.checkOverflow("mobile-390-outgoing");
    report.screenshots.push(await browser.screenshot("mobile-390-01-outgoing-allocation-review.png", false));

    await browser.setViewport(375, 812);
    await new Promise((r) => setTimeout(r, 250));
    report.overflowChecks.mobile375_outgoing = await browser.checkOverflow("mobile-375-outgoing");

    const dispRes = await as(fx.cashier.email, `/api/shifts/${shift1.id}/cash-disposition`, {
      method: "POST",
      body: JSON.stringify({
        deliveries: [
          { destination: "OWNER", recipientId: fx.owner.id, amount: 2000, reference: "تسليم مسائي للمالك والمدير العام" },
          { destination: "MANAGER", recipientId: fx.manager.id, amount: 500, reference: "عهدة مشتريات تشغيلية لمدير الفرع" },
        ],
        retainedAmount: 500,
        note: "توزيع نقدية الإغلاق المسائي",
        idempotencyKey: `disp-3113-${Date.now()}`,
      }),
    });
    assert.equal(dispRes.status, 201, `Disposition recorded: ${dispRes.text}`);

    const finRes = await as(fx.cashier.email, "/api/handovers", {
      method: "POST",
      body: JSON.stringify({ action: "finish_outgoing", handoverId }),
    });
    assert.equal(finRes.status, 200, finRes.text);

    // 2. Incoming employee reviews DirectHandoverPanel, reports an issue, and accepts in one click
    await browser.setSessionCookie(incomingCookie);
    await browser.setViewport(1280, 960);
    await browser.goto(`${BASE_URL}/handovers?branchId=${fx.branchId}&handoverId=${handoverId}`);
    await browser.waitForText("ملخص استلام العهدة المباشر");
    await browser.waitForText("فتح ورديتي واستلام العهدة");

    await browser.evaluate(`(() => {
      const btn = document.querySelector('[data-testid="direct-handover-report-issue-toggle"]');
      if (btn) btn.click();
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    await browser.evaluate(`(() => {
      const setReactSelect = (el, val) => {
        if (!el) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const setReactTextarea = (el, val) => {
        if (!el) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setReactSelect(document.querySelector('[data-testid="issue-kind-select"]'), 'OTHER');
      setReactTextarea(document.querySelector('#issue-desc'), 'ملاحظة استلام: كيس حبوب البن الإثيوبي المفتوح يحتاج إحكام غلق — الرصيد الفعلي مطابق للملخص');
    })()`);
    await new Promise((r) => setTimeout(r, 200));
    await browser.evaluate(`(() => {
      const submitBtn = document.querySelector('[data-testid="direct-handover-issue-submit"]');
      if (submitBtn) submitBtn.click();
    })()`);
    await browser.waitForText("كيس حبوب البن الإثيوبي المفتوح يحتاج إحكام غلق");

    report.screenshots.push(await browser.screenshot("desktop-02-incoming-direct-acceptance.png", true));

    await browser.setViewport(390, 844);
    await new Promise((r) => setTimeout(r, 300));
    report.overflowChecks.mobile390_incoming = await browser.checkOverflow("mobile-390-incoming");
    report.screenshots.push(await browser.screenshot("mobile-390-02-incoming-direct-acceptance.png", false));

    await browser.setViewport(375, 812);
    await new Promise((r) => setTimeout(r, 250));
    report.overflowChecks.mobile375_incoming = await browser.checkOverflow("mobile-375-incoming");

    // Click "فتح ورديتي واستلام العهدة"
    await browser.setViewport(1280, 960);
    await browser.evaluate(`(() => {
      const acceptBtn = document.querySelector('[data-testid="direct-handover-accept"]');
      if (acceptBtn) acceptBtn.click();
    })()`);
    await browser.waitForText("تم استلام العهدة وفتح الوردية");

    const acceptedHandover = await db.handoverSession.findUniqueOrThrow({ where: { id: handoverId } });
    assert.equal(acceptedHandover.status, "COMPLETED");
    assert.equal(acceptedHandover.directAcknowledgedById, incomingUser.id);
    assert.ok(acceptedHandover.incomingShiftId);
    report.previewDemo.incomingShiftId = acceptedHandover.incomingShiftId;

    const incomingShift = await db.shift.findUniqueOrThrow({ where: { id: acceptedHandover.incomingShiftId } });
    assert.equal(Number(incomingShift.openingCashAmount), 500, "Incoming shift opened with 500 EGP");
    assert.equal(incomingShift.custodyGateReason, null, "Custody gate cleared");

    const ackCount = await db.handoverStockAcknowledgement.count({ where: { handoverId } });
    assert.equal(ackCount, 0, "Zero fake per-line acknowledgements created");

    // Verify POS readiness via assertOpeningReady and branchReadiness
    const { assertOpeningReady } = await import("@/lib/opening-readiness");
    const { branchReadiness } = await import("@/lib/handover-readiness");
    await assert.doesNotReject(() => assertOpeningReady(db, { shiftId: incomingShift.id, scope: "OPERATIONS" }));
    const readyNoPlace = (await branchReadiness(fx.cafeId, fx.branchId)).find((r) => r.shiftId === incomingShift.id);
    assert.equal(readyNoPlace.operational, true, "Shift is operationally ready when place check is not required");

    // Temporarily enable placeAcceptanceRequired to prove independent place gate still governs readiness
    await db.branchOpeningSettings.create({
      data: {
        branchId: fx.branchId,
        cafeId: fx.cafeId,
        placeAcceptanceRequired: true,
        updatedById: fx.owner.id,
        updatedAt: new Date(Date.now() - 3600_000),
      },
    });
    const gatedReady = (await branchReadiness(fx.cafeId, fx.branchId)).find((r) => r.shiftId === incomingShift.id);
    assert.equal(gatedReady.operational, false, "POS gated when placeAcceptanceRequired is enabled");
    await assert.rejects(() => assertOpeningReady(db, { shiftId: incomingShift.id, scope: "OPERATIONS" }));
    await db.branchOpeningSettings.deleteMany({ where: { branchId: fx.branchId } });

    report.posReadiness = {
      openingCashEgp: Number(incomingShift.openingCashAmount),
      custodyGateReason: incomingShift.custodyGateReason,
      readyWithoutPlaceRequirement: readyNoPlace.operational,
      gatedWhenPlaceRequired: !gatedReady.operational,
    };

    // 3. Recipient delivery confirmation panel on /handovers as Owner
    await browser.setSessionCookie(ownerCookie);
    await browser.setViewport(1280, 960);
    await browser.goto(`${BASE_URL}/handovers?branchId=${fx.branchId}`);
    await browser.waitForText("تأكيد استلام النقدية المُسلّمة للمالك / المدير");
    await browser.waitForText("بانتظار تأكيدك");

    report.screenshots.push(await browser.screenshot("desktop-03-recipient-confirmation-panel.png", true));

    await browser.setViewport(390, 844);
    await new Promise((r) => setTimeout(r, 300));
    report.overflowChecks.mobile390_recipient = await browser.checkOverflow("mobile-390-recipient");
    report.screenshots.push(await browser.screenshot("mobile-390-03-recipient-confirmation-panel.png", false));

    await browser.setViewport(375, 812);
    await new Promise((r) => setTimeout(r, 250));
    report.overflowChecks.mobile375_recipient = await browser.checkOverflow("mobile-375-recipient");

    // Owner confirms their 2,000 EGP delivery via the live UI button; Manager's 500 EGP stays pending
    await browser.setViewport(1280, 960);
    await browser.evaluate(`(() => {
      const btn = document.querySelector('[data-testid^="confirm-delivery-"]');
      if (btn) btn.click();
    })()`);
    await new Promise((r) => setTimeout(r, 900));

    // 4. Handover Overview (#cash), Print HTML, PDF, Shift Close Report & XLSX
    await browser.goto(`${BASE_URL}/handovers?branchId=${fx.branchId}&handoverId=${handoverId}#cash`);
    await browser.waitForText("توزيع النقدية المعدودة عند الإغلاق");
    await browser.waitForText("تم تأكيد الاستلام");
    report.screenshots.push(await browser.screenshot("desktop-04-handover-report-overview.png", true));

    await browser.setViewport(390, 844);
    await new Promise((r) => setTimeout(r, 300));
    report.overflowChecks.mobile390_overview = await browser.checkOverflow("mobile-390-overview");
    report.screenshots.push(await browser.screenshot("mobile-390-04-handover-report-overview.png", false));

    await browser.setViewport(375, 812);
    await new Promise((r) => setTimeout(r, 250));
    report.overflowChecks.mobile375_overview = await browser.checkOverflow("mobile-375-overview");

    // Print HTML & PDF
    await browser.setViewport(1280, 960);
    await browser.goto(`${BASE_URL}/api/handovers/${handoverId}/report?format=html`);
    await browser.waitForText("توزيع النقدية والتسليمات");
    report.screenshots.push(await browser.screenshot("desktop-05-handover-print-report.png", true));
    const htmlContent = await browser.evaluate(`document.documentElement.outerHTML`);
    fs.writeFileSync(path.join(OUT_DIR, "handover-report.html"), htmlContent);
    const pdfRes = await browser.send("Page.printToPDF", { landscape: true, printBackground: true });
    const pdfBuf = Buffer.from(pdfRes.data, "base64");
    const pdfPath = path.join(OUT_DIR, "handover-report.pdf");
    fs.writeFileSync(pdfPath, pdfBuf);
    const pdfPages = (pdfBuf.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length;
    report.pdf = { path: pdfPath, bytes: pdfBuf.length, pages: pdfPages };

    // Shift Close Report (/reports/shift/:id)
    await browser.goto(`${BASE_URL}/reports/shift/${shift1.id}`);
    await browser.waitForText("توزيع نقدية الإغلاق والعهدة");
    report.screenshots.push(await browser.screenshot("desktop-06-shift-close-report.png", true));

    // XLSX Download & SheetJS Verification
    const xlsxRes = await fetch(`${BASE_URL}/api/handovers/${handoverId}/report?format=xlsx`, {
      headers: { Cookie: ownerCookie },
    });
    assert.equal(xlsxRes.status, 200, "XLSX download 200");
    const xlsxBuf = Buffer.from(await xlsxRes.arrayBuffer());
    const xlsxPath = path.join(OUT_DIR, "handover-report.xlsx");
    fs.writeFileSync(xlsxPath, xlsxBuf);
    const wb = XLSX.read(xlsxBuf, { type: "buffer", cellFormula: true });
    const formulaCount = wb.SheetNames.reduce(
      (acc, name) => acc + Object.values(wb.Sheets[name]).filter((c) => c && typeof c === "object" && c.f).length,
      0,
    );
    assert.equal(formulaCount, 0, "Zero formula cells in XLSX");
    assert(wb.SheetNames.includes("الملخص"), "XLSX has الملخص sheet");
    assert(wb.SheetNames.includes("توزيع النقدية والتسليمات"), "XLSX has توزيع النقدية والتسليمات sheet");
    assert(wb.SheetNames.includes("الجرد"), "XLSX has الجرد sheet");
    const issuesSheetName = wb.SheetNames.find((n) => n.startsWith("الاختلافات والملاحظات"));
    assert(issuesSheetName, "XLSX has الاختلافات والملاحظات sheet");
    const cashDispRows = XLSX.utils.sheet_to_json(wb.Sheets["توزيع النقدية والتسليمات"], { header: 1 });
    const issuesRows = XLSX.utils.sheet_to_json(wb.Sheets[issuesSheetName], { header: 1 });
    report.xlsx = {
      path: xlsxPath,
      bytes: xlsxBuf.length,
      sheetNames: wb.SheetNames,
      formulaCount,
      cashDispositionRows: cashDispRows,
      issueRows: issuesRows,
    };

    fs.writeFileSync(path.join(OUT_DIR, "verification-summary.json"), JSON.stringify(report, null, 2));
    console.log("PREVIEW_3113_VERIFY_SUCCESS", JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
    await db.$disconnect().catch(() => {});
  }
});
