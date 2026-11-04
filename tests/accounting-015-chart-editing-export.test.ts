// ACCOUNTING-015 (Step 4B.2B): creating root groups, sub-groups and posting accounts;
// what editing may and may not do (with the reason); and the export endpoint end to end —
// scope, permissions, tenant isolation, real XLSX/CSV parsing, and that ledger links and
// saved mappings keep resolving after a permitted rename or recode.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, COUNT_PASSWORD } from "./helpers/count";
import { BASE, as, jarFor, login, requireServer } from "./helpers/http";
import { ensureAccountingEntity } from "@/lib/accounting/chart";
import { openPeriod, closePeriod, postEntry } from "@/lib/accounting/ledger";
import { addDays, dateStrInTz } from "@/lib/date-range";

after(async () => { await db.$disconnect(); });

const TODAY = dateStrInTz(new Date());
type Acc = { account: { id: string; code: string; normalBalance: string; isPostable: boolean; parentId: string | null } };
const send = (email: string, path: string, method: "POST" | "PATCH", body: unknown, key = randomUUID()) =>
  as<Acc & { error?: string }>(email, path, { method, body: JSON.stringify(body), headers: { "Idempotency-Key": key } });

async function download(email: string, query: string) {
  const response = await fetch(`${BASE}/api/accounting/chart-of-accounts/export?${query}`, { headers: { cookie: jarFor(email) } });
  return { status: response.status, type: response.headers.get("content-type") ?? "", disposition: response.headers.get("content-disposition") ?? "", buffer: Buffer.from(await response.arrayBuffer()) };
}

test("create: root group, sub-group, posting account; refuse duplicates, cycles, foreign and posting parents", { timeout: 180000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC015CREATE");
  const other = await countCafe("ACC015CREATEX");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    await login(other.owner.email, COUNT_PASSWORD);
    const entity = await db.$transaction(tx => ensureAccountingEntity(tx, fx.cafeId));
    const otherEntity = await db.$transaction(tx => ensureAccountingEntity(tx, other.cafeId));
    const foreignHeader = await db.accountingAccount.findFirstOrThrow({ where: { entityId: otherEntity.id, systemKey: "HEADER_EXPENSES" } });
    const posting = await db.accountingAccount.findFirstOrThrow({ where: { entityId: entity.id, systemKey: "COST_OF_SALES" } });
    const entriesBefore = await db.journalEntry.count({ where: { cafeId: fx.cafeId } });

    const root = await send(fx.owner.email, "/api/accounting/accounts", "POST", { code: "0600", name: "مجموعة جذر", type: "EXPENSE", parentId: null, isPostable: false, reason: "مجموعة جديدة" });
    assert.equal(root.status, 201, root.text);
    assert.deepEqual([root.body.account.isPostable, root.body.account.parentId, root.body.account.normalBalance], [false, null, "DEBIT"]);
    assert.equal(root.body.account.code, "0600", "leading zero preserved");
    const sub = await send(fx.owner.email, "/api/accounting/accounts", "POST", { code: "0610", name: "مجموعة فرعية", type: "EXPENSE", parentId: root.body.account.id, isPostable: false, reason: "مجموعة فرعية" });
    assert.equal(sub.status, 201, sub.text);
    const leaf = await send(fx.owner.email, "/api/accounting/accounts", "POST", { code: "0611", name: "حساب يقبل قيود", type: "EXPENSE", parentId: sub.body.account.id, isPostable: true, reason: "حساب" });
    assert.equal(leaf.status, 201, leaf.text);
    assert.equal(leaf.body.account.isPostable, true);
    const credit = await send(fx.owner.email, "/api/accounting/accounts", "POST", { code: "0612", name: "عكسي", type: "EXPENSE", parentId: sub.body.account.id, isPostable: true, contra: true, reason: "حساب عكسي" });
    assert.equal(credit.body.account.normalBalance, "CREDIT", "a controlled contra account flips the side");
    const revenueRoot = await send(fx.owner.email, "/api/accounting/accounts", "POST", { code: "4500", name: "إيرادات أخرى", type: "REVENUE", parentId: null, isPostable: false, reason: "جذر إيرادات" });
    assert.equal(revenueRoot.body.account.normalBalance, "CREDIT");

    const create = (over: Record<string, unknown>) => send(fx.owner.email, "/api/accounting/accounts", "POST", { code: "0620", name: "اختبار", type: "EXPENSE", parentId: root.body.account.id, isPostable: true, reason: "اختبار", ...over });
    assert.equal((await create({ code: "0600" })).status, 409, "duplicate code");
    assert.equal((await create({ parentId: null, isPostable: true })).status, 400, "a posting root is refused");
    assert.equal((await create({ parentId: null, isPostable: false, contra: true })).status, 400, "a contra group is refused");
    assert.equal((await create({ parentId: leaf.body.account.id })).status, 400, "a posting account cannot be a parent");
    assert.equal((await create({ parentId: posting.id })).status, 400, "an existing posting account cannot be a parent");
    assert.equal((await create({ type: "ASSET" })).status, 400, "incompatible type");
    assert.equal((await create({ parentId: foreignHeader.id })).status, 404, "another business's parent");
    assert.equal((await create({ code: "62" })).status, 400, "code format");
    assert.equal((await create({ name: "ا" })).status, 400, "name too short");
    assert.equal((await create({ reason: "" })).status, 400, "reason required");

    // Depth: the tree stops at six levels.
    let parentId = root.body.account.id;
    let deepest = 1;
    for (let i = 1; i <= 7; i++) {
      const next = await send(fx.owner.email, "/api/accounting/accounts", "POST", { code: `07${i}0`, name: `مستوى ${i + 1}`, type: "EXPENSE", parentId, isPostable: false, reason: "عمق" });
      if (next.status !== 201) { assert.equal(next.status, 400, next.text); break; }
      deepest = i + 1; parentId = next.body.account.id;
    }
    assert.equal(deepest, 6, "six levels allowed, the seventh refused");

    // Cycles: a group cannot move under its own descendant.
    const cycle = await send(fx.owner.email, `/api/accounting/accounts/${root.body.account.id}`, "PATCH", { parentId: sub.body.account.id, reason: "دورة" });
    assert.ok([400, 409].includes(cycle.status), cycle.text);
    assert.equal((await db.accountingAccount.findUniqueOrThrow({ where: { id: root.body.account.id } })).parentId, null, "nothing moved");

    assert.equal(await db.journalEntry.count({ where: { cafeId: fx.cafeId } }), entriesBefore, "creation never posts");
    assert.ok(await db.auditLog.count({ where: { cafeId: fx.cafeId, action: "ACCOUNTING_ACCOUNT_CREATED" } }) >= 5);
  } finally {
    await teardownTaggedCafe([fx.cafeId, other.cafeId]);
  }
});

test("edit: the chart says what is locked and why; renames and recodes keep ledger links and mappings", { timeout: 180000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC015EDIT");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const entity = await db.$transaction(tx => ensureAccountingEntity(tx, fx.cafeId));
    const header = await db.accountingAccount.findFirstOrThrow({ where: { entityId: entity.id, systemKey: "HEADER_EXPENSES" } });
    const used = await db.accountingAccount.create({ data: { cafeId: fx.cafeId, entityId: entity.id, code: "5440", name: "مرافق", type: "EXPENSE", normalBalance: "DEBIT", parentId: header.id } });
    const posted = await db.accountingAccount.create({ data: { cafeId: fx.cafeId, entityId: entity.id, code: "5450", name: "إيجار", type: "EXPENSE", normalBalance: "DEBIT", parentId: header.id } });
    const group = await db.accountingAccount.create({ data: { cafeId: fx.cafeId, entityId: entity.id, code: "5460", name: "مجموعة", type: "EXPENSE", normalBalance: "DEBIT", parentId: header.id, isPostable: false } });
    const inGroup = await db.accountingAccount.create({ data: { cafeId: fx.cafeId, entityId: entity.id, code: "5461", name: "تحت المجموعة", type: "EXPENSE", normalBalance: "DEBIT", parentId: group.id } });
    const cat = await db.expenseCategory.create({ data: { cafeId: fx.cafeId, code: "S4B2_EDIT", nameAr: "مرافق", createdById: fx.owner.id } });
    await db.expenseCategoryAccountMapping.create({ data: { cafeId: fx.cafeId, entityId: entity.id, categoryId: cat.id, accountId: used.id, effectiveFrom: new Date(`${addDays(TODAY, -10)}T00:00:00Z`), reason: "ربط", approvalRef: "ACC-EDIT", createdById: fx.owner.id } });
    // Posted lines in a period that is then closed.
    await db.$transaction(tx => openPeriod(tx, { cafeId: fx.cafeId, startsOn: addDays(TODAY, -120), endsOn: addDays(TODAY, -91) }));
    await db.$transaction(tx => postEntry(tx, { cafeId: fx.cafeId, entryDate: addDays(TODAY, -100), description: "إيجار", sourceType: "TEST", sourceKey: "acc015-rent", lines: [{ account: { id: inGroup.id }, debit: 50 }, { account: { key: "CASH_DRAWER" }, credit: 50 }] }));
    const period = await db.accountingPeriod.findFirstOrThrow({ where: { entityId: entity.id } });
    await db.$transaction(tx => closePeriod(tx, { cafeId: fx.cafeId, periodId: period.id, actorId: fx.owner.id }));

    type Row = { id: string; code: string; locks?: { identity: string; deactivate: string | null; move: string | null; code: string | null; facts: { lineCount: number; closedPeriodLines: boolean; hasChildren: boolean; mappedInForce: boolean; mappedEver: boolean } } };
    const chart = await as<{ canSetup: boolean; canExport: boolean; rows: Row[]; mapping: { expenseAccounts: { code: string }[]; rows: { saved: { current: { accountCode: string } | null } }[] } }>(fx.owner.email, "/api/accounting/chart-of-accounts");
    assert.equal(chart.status, 200, chart.text);
    assert.deepEqual([chart.body.canSetup, chart.body.canExport], [true, true]);
    const row = (code: string) => chart.body.rows.find(r => r.code === code)!;
    assert.match(row("1110").locks!.deactivate!, /حساب نظام/);
    assert.match(row("1110").locks!.move!, /حساب نظام/);
    assert.match(row("5440").locks!.deactivate!, /ربط تصنيف مصروف/, "needed by a mapping in force");
    assert.equal(row("5440").locks!.move, null);
    assert.match(row("5440").locks!.identity, /اتربط بتصنيف مصروف/);
    assert.equal(row("5450").locks!.deactivate, null, "unused and unmapped: may be stopped");
    assert.equal(row("5461").locks!.facts.lineCount, 1);
    assert.match(row("5461").locks!.move!, /فترة مقفولة/, "closed-period lines pin it");
    assert.match(row("5460").locks!.move!, /فترة مقفولة/, "and its group, through the account under it");
    assert.match(row("5460").locks!.identity, /تحته حسابات فرعية/);
    assert.ok(!chart.body.mapping.expenseAccounts.some(a => ["5100", "5110", "5200", "5300"].includes(a.code)), "the selector excludes non-operating system accounts");

    // The server enforces what the chart says.
    const patch = (id: string, body: Record<string, unknown>) => send(fx.owner.email, `/api/accounting/accounts/${id}`, "PATCH", { reason: "اختبار", ...body });
    assert.equal((await patch(used.id, { isActive: false })).status, 409);
    assert.equal((await patch(inGroup.id, { parentId: header.id })).status, 409);
    assert.equal((await patch(posted.id, { isActive: false })).status, 200);

    // Rename + recode: the saved mapping and the ledger link follow the account, not its old code.
    assert.equal((await patch(used.id, { name: "مرافق وكهرباء", code: "5470" })).status, 200);
    const after = await as<{ mapping: { rows: { categoryCode: string; saved: { current: { accountCode: string; accountName: string } | null } }[] } }>(fx.owner.email, "/api/accounting/chart-of-accounts");
    const saved = after.body.mapping.rows.find(r => r.categoryCode === "S4B2_EDIT")!.saved.current!;
    assert.deepEqual([saved.accountCode, saved.accountName], ["5470", "مرافق وكهرباء"]);
    const ledger = await as<{ account: { code: string; name: string } }>(fx.owner.email, `/api/accounting/ledger?accountId=${used.id}&from=${addDays(TODAY, -5)}&to=${TODAY}`);
    assert.equal(ledger.status, 200, ledger.text);
    assert.deepEqual([ledger.body.account.code, ledger.body.account.name], ["5470", "مرافق وكهرباء"]);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("mapping eligibility over HTTP: non-operating system accounts are refused, 5900 and custom accounts are not", { timeout: 120000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC015ELIG");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const entity = await db.$transaction(tx => ensureAccountingEntity(tx, fx.cafeId));
    const cat = await db.expenseCategory.create({ data: { cafeId: fx.cafeId, code: "S4B2_ELIG", nameAr: "مرافق", createdById: fx.owner.id } });
    const key = (systemKey: string) => db.accountingAccount.findFirstOrThrow({ where: { entityId: entity.id, systemKey } });
    const map = (accountId: string) => send(fx.owner.email, "/api/accounting/expense-category-mappings", "POST", { categoryId: cat.id, accountId, effectiveFrom: addDays(TODAY, -1), expectedLatestEffectiveFrom: null, reason: "اختبار", approvalRef: "ACC-ELIG" } as never);
    for (const systemKey of ["COST_OF_SALES", "PURCHASE_DISCOUNTS", "INVENTORY_LOSS", "CASH_OVER_SHORT"]) {
      const account = await key(systemKey);
      const preview = await as<{ account: { eligible: boolean; reason: string } }>(fx.owner.email, `/api/accounting/expense-category-mappings/preview?categoryId=${cat.id}&effectiveFrom=${TODAY}&accountId=${account.id}`);
      assert.equal(preview.body.account.eligible, false, `${systemKey} preview`);
      const refused = await map(account.id);
      assert.equal(refused.status, 400, `${systemKey}: ${refused.text}`);
    }
    assert.equal(await db.expenseCategoryAccountMapping.count({ where: { cafeId: fx.cafeId } }), 0);
    const other = await key("OTHER_OPERATING_EXPENSE");
    assert.equal((await as<{ account: { eligible: boolean } }>(fx.owner.email, `/api/accounting/expense-category-mappings/preview?categoryId=${cat.id}&effectiveFrom=${TODAY}&accountId=${other.id}`)).body.account.eligible, true);
    assert.equal((await map(other.id)).status, 201);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("export: full and filtered scope match the chart; permissions, tenants, real XLSX/CSV, injection", { timeout: 240000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC015EXPORT");
  const other = await countCafe("ACC015EXPORTX");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    await login(fx.manager.email, COUNT_PASSWORD);
    await login(fx.cashier.email, COUNT_PASSWORD);
    await login(other.owner.email, COUNT_PASSWORD);
    const entity = await db.$transaction(tx => ensureAccountingEntity(tx, fx.cafeId));
    await db.$transaction(tx => ensureAccountingEntity(tx, other.cafeId));
    const header = await db.accountingAccount.findFirstOrThrow({ where: { entityId: entity.id, systemKey: "HEADER_EXPENSES" } });
    const group = await db.accountingAccount.create({ data: { cafeId: fx.cafeId, entityId: entity.id, code: "0900", name: "مجموعة، فيها \"علامات\"", type: "EXPENSE", normalBalance: "DEBIT", parentId: header.id, isPostable: false } });
    await db.accountingAccount.create({ data: { cafeId: fx.cafeId, entityId: entity.id, code: "0910", name: "=1+1 نظافة", type: "EXPENSE", normalBalance: "DEBIT", parentId: group.id } });
    await db.accountingAccount.create({ data: { cafeId: fx.cafeId, entityId: entity.id, code: "0920", name: "@cmd نظافة", type: "EXPENSE", normalBalance: "DEBIT", parentId: group.id, isActive: false } });
    await db.accountingAccount.create({ data: { cafeId: other.cafeId, entityId: (await db.accountingEntity.findUniqueOrThrow({ where: { cafeId: other.cafeId } })).id, code: "0990", name: "حساب منشأة تانية", type: "EXPENSE", normalBalance: "DEBIT" } });
    const cat = await db.expenseCategory.create({ data: { cafeId: fx.cafeId, code: "S4B2_EXP", nameAr: "نظافة", createdById: fx.owner.id } });
    const mapped = await db.accountingAccount.findFirstOrThrow({ where: { entityId: entity.id, code: "0910" } });
    await db.expenseCategoryAccountMapping.create({ data: { cafeId: fx.cafeId, entityId: entity.id, categoryId: cat.id, accountId: mapped.id, effectiveFrom: new Date(`${addDays(TODAY, -3)}T00:00:00Z`), reason: "ربط", approvalRef: "ACC-EXP", createdById: fx.owner.id } });

    const chart = await as<{ total: number; rows: { code: string }[] }>(fx.owner.email, "/api/accounting/chart-of-accounts");
    const filteredChart = await as<{ matchCount: number; rows: { code: string; matched: boolean }[] }>(fx.owner.email, `/api/accounting/chart-of-accounts?q=${encodeURIComponent("نظافة")}`);

    // Full workbook: every account, text codes, no formulas, mapping sheet for a reader who may see it.
    const full = await download(fx.owner.email, "format=xlsx&scope=full&includeMapping=1");
    assert.equal(full.status, 200);
    assert.match(full.type, /spreadsheetml/);
    assert.match(full.disposition, /attachment; filename="chart-of-accounts-\d{4}-\d{2}-\d{2}-full\.xlsx"/);
    const book = XLSX.read(full.buffer, { type: "buffer", cellFormula: true });
    assert.deepEqual(book.SheetNames, ["الملخص", "دليل الحسابات", "ربط التصنيفات"]);
    const chartSheet = XLSX.utils.sheet_to_json<string[]>(book.Sheets["دليل الحسابات"], { header: 1 });
    assert.equal(chartSheet.length - 1, chart.body.total, "every account, whatever the screen shows");
    assert.deepEqual(chartSheet.slice(1).map(r => r[0]), chart.body.rows.map(r => r.code), "same order as the chart");
    const sheet = book.Sheets["دليل الحسابات"];
    const codes = Object.keys(sheet).filter(k => /^A\d+$/.test(k)).map(k => sheet[k]);
    assert.ok(codes.every(c => c.t === "s"), "every code is text");
    assert.ok(codes.some(c => c.v === "0900"), "a leading zero survives");
    assert.ok(Object.values(sheet).every(c => !(c as { f?: string }).f), "no formulas");
    const row0910 = chartSheet.find(r => r[0] === "0910")!;
    assert.equal(row0910[1], "=1+1 نظافة", "the text is kept, as text");
    assert.deepEqual([row0910[3], row0910[5], row0910[6]], ["0900", 3, "قابل للترحيل"]);
    const mappingRows = XLSX.utils.sheet_to_json<string[]>(book.Sheets["ربط التصنيفات"], { header: 1 });
    assert.deepEqual(mappingRows[1].slice(0, 3).concat(mappingRows[1][5]), ["نظافة", "S4B2_EXP", "0910", "ساري"]);
    const summary = XLSX.utils.sheet_to_json<string[]>(book.Sheets["الملخص"], { header: 1 });
    assert.ok(summary.some(r => r[0] === "نطاق التصدير" && r[1] === "دليل الحسابات كاملًا"));
    assert.ok(!full.buffer.toString("latin1").includes("0990"), "another business's account never appears");

    // Filtered scope = the chart's own filtered rows, with context rows labelled.
    const filtered = await download(fx.owner.email, `format=xlsx&scope=filtered&q=${encodeURIComponent("نظافة")}`);
    const fbook = XLSX.read(filtered.buffer, { type: "buffer" });
    const frows = XLSX.utils.sheet_to_json<string[]>(fbook.Sheets["دليل الحسابات"], { header: 1 });
    assert.deepEqual(frows.slice(1).map(r => r[0]), filteredChart.body.rows.map(r => r.code));
    assert.equal(frows.slice(1).filter(r => r[9] === "نتيجة").length, filteredChart.body.matchCount);
    assert.ok(frows.slice(1).some(r => r[9] === "سياق (حساب أب)"), "ancestors are included and labelled");
    assert.match(filtered.disposition, /-filtered\.xlsx/);
    assert.equal(fbook.SheetNames.length, 2, "no mapping sheet unless asked");

    // CSV.
    const csv = await download(fx.owner.email, "format=csv&scope=full");
    assert.match(csv.type, /text\/csv; charset=utf-8/);
    const text = csv.buffer.toString("utf8");
    assert.ok(text.startsWith("﻿"), "BOM");
    assert.match(text, /"'=1\+1 نظافة"/, "formula-looking text neutralised");
    assert.match(text, /"'@cmd نظافة"/);
    assert.match(text, /"مجموعة، فيها ""علامات"""/, "comma and quotes inside one cell");
    assert.equal(text.split("\r\n").length - 2, chart.body.total, "header + every account + trailing CRLF");
    const mappingCsv = await download(fx.owner.email, "format=csv&dataset=mapping");
    assert.match(mappingCsv.buffer.toString("utf8"), /"نظافة","S4B2_EXP","0910","=1\+1 نظافة"|"نظافة","S4B2_EXP","0910","'=1\+1 نظافة"/);

    // Contract and permissions, all server-side.
    assert.equal((await download(fx.owner.email, "format=xlsx&scope=filtered")).status, 400, "filtered scope needs a filter");
    assert.equal((await download(fx.owner.email, "format=pdf")).status, 400);
    assert.equal((await download(fx.cashier.email, "format=csv")).status, 403, "no accounting key at all");
    assert.equal((await download(fx.manager.email, "format=csv")).status, 403, "view alone is not export");
    const grant = await as(fx.owner.email, `/api/users/${fx.manager.id}/permissions`, { method: "PUT", body: JSON.stringify({ overrides: [{ key: "accounting.view", allowed: true }, { key: "accounting.export", allowed: true }, { key: "expenses.view", allowed: false }] }) });
    assert.equal(grant.status, 200, grant.text);
    await login(fx.manager.email, COUNT_PASSWORD);
    assert.equal((await download(fx.manager.email, "format=csv")).status, 200, "export key granted");
    assert.equal((await download(fx.manager.email, "format=xlsx&includeMapping=1")).status, 403, "the mapping sheet needs the expense-mapping permission");
    assert.equal((await download(fx.manager.email, "format=csv&dataset=mapping")).status, 403);
    const plain = XLSX.read((await download(fx.manager.email, "format=xlsx")).buffer, { type: "buffer" });
    assert.deepEqual(plain.SheetNames, ["الملخص", "دليل الحسابات"], "no mapping content leaks without the permission");

    // Tenants: another café's owner exports only their own chart, even naming our café.
    const theirs = await download(other.owner.email, `format=csv&cafeId=${fx.cafeId}`);
    assert.equal(theirs.status, 200);
    const theirText = theirs.buffer.toString("utf8");
    assert.ok(theirText.includes("حساب منشأة تانية") && !theirText.includes("نظافة"), "their chart only");
  } finally {
    await teardownTaggedCafe([fx.cafeId, other.cafeId]);
  }
});
