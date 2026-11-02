/**
 * Retained workspace runtime checks. PREPARED ONLY: this module has no runner,
 * database initialization, fixture writes, server control or cleanup.
 *
 * Parent must verifyWorkspace({requireCorrespondence:true}) before invoking
 * run(), and supply the verified Prisma client and synthetic fixture cookies.
 * Any optional mutation callbacks belong to that guarded parent runner.
 * Results deliberately omit cookies and signed snapshots.
 */
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import type { ReportOutput } from '../src/lib/report-output';
import type { PurchaseReportRow, PurchaseReportTotals } from '../src/lib/purchase-report';

type JsonResponse<T = unknown> = { status: number; body: T; text?: string };
type RequestOptions = { cookie?: string; method?: 'GET' | 'POST'; body?: unknown };
export type WorkspaceRequest = (path: string, options: RequestOptions) => Promise<JsonResponse>;
type Actor = { cookie: string; userId: string };
type ConfiguredAccountingFixture = {
  cafeId: string; branchId: string; secondBranchId: string; ownerCookie: string;
  ownerUserId: string; branchPinnedCookie: string; from: string; to: string;
};
export type ReportRuntimeFixtures = {
  cafeId: string; branchId: string; secondBranchId: string; supplierId: string;
  ownerCookie: string; ownerUserId: string; restrictedCookie: string;
  branchPinnedCookie: string; otherTenantCookie: string; revokedCookie: string;
  otherTenantCafeId?: string;
  reportFrom?: string; reportTo?: string; reportSearch?: string; reportSupplierId?: string;
  reportActorCookie?: string; reportActorUserId?: string;
  configuredAccounting?: ConfiguredAccountingFixture;
};
type CaseResult = { name: string; status: 'PASS' | 'FAIL' | 'NOT_RUN'; detail?: string };
type MutationHooks = {
  withDeniedPermission?: (actor: Actor, key: string, operation: () => Promise<void>) => Promise<void>;
  withBranchAssignment?: (actor: Actor, branchId: string, operation: () => Promise<void>) => Promise<void>;
};
type RunArgs = MutationHooks & { db: PrismaClient; baseUrl: string; fx: ReportRuntimeFixtures; request?: WorkspaceRequest };
type PurchaseResult = { rows: PurchaseReportRow[]; totals: PurchaseReportTotals; selection: { from: string; to: string; branchId: string; supplierId: string; search: string; status: string; paymentStatus: string; page: number }; pageSize: number; outputSnapshot: string };
type StatementResult = { configured: boolean; kind: string; mode?: string; branchId?: string | null; result?: Record<string, unknown>; outputSnapshot: string | null; notice: string };
type OutputFiles = { csv: string; html: string; xlsx: string };

function snapshotReport(snapshot: string): ReportOutput {
  // Inspection only: actual signature/current authority is exercised through
  // the HTTP output endpoint. This decoder never grants authorization.
  const value = JSON.parse(Buffer.from(snapshot.split('.')[0], 'base64url').toString('utf8')) as { report: ReportOutput };
  assert.ok(value.report && Array.isArray(value.report.rows));
  return value.report;
}

async function accountingCounts(db: PrismaClient, cafeId: string) {
  const where = { cafeId };
  const counts = await Promise.all([
    db.accountingEntity.count({ where }), db.accountingAccount.count({ where }),
    db.accountingPeriod.count({ where }), db.journalEntry.count({ where }),
    db.journalLine.count({ where }), db.accountingProjectionRun.count({ where }),
    db.accountingProjectionIssue.count({ where }),
  ]);
  return Object.fromEntries(['entities', 'accounts', 'periods', 'entries', 'lines', 'projectionRuns', 'projectionIssues'].map((key, index) => [key, counts[index]]));
}

export async function run({ db, baseUrl, fx, request, withDeniedPermission, withBranchAssignment }: RunArgs) {
  const startedAt = new Date().toISOString(), cases: CaseResult[] = [];
  const send: WorkspaceRequest = request ?? (async (path, options) => {
    const response = await fetch(new URL(path, baseUrl), { method: options.method ?? 'GET', headers: { ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: options.body === undefined ? undefined : JSON.stringify(options.body), redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = { nonJsonResponse: true }; }
    return { status: response.status, body };
  });
  async function req<T>(path: string, cookie: string, body?: unknown): Promise<JsonResponse<T>> {
    return await send(path, { cookie, ...(body === undefined ? {} : { method: 'POST' as const, body }) }) as JsonResponse<T>;
  }
  async function check(name: string, action: () => Promise<void>) {
    try { await action(); cases.push({ name, status: 'PASS' }); }
    catch (error) { cases.push({ name, status: 'FAIL', detail: error instanceof Error ? error.message : String(error) }); }
  }
  function unavailable(name: string, reason: string) { cases.push({ name, status: 'NOT_RUN', detail: reason }); }
  const { reportOutputFiles } = await import('../src/lib/report-output');
  const { zonedDayStart, addDays, dateStrInTz } = await import('../src/lib/date-range');
  const from = fx.reportFrom ?? dateStrInTz(new Date()), to = fx.reportTo ?? from;
  const supplierId = fx.reportSupplierId ?? fx.supplierId;
  const actor: Actor = { cookie: fx.reportActorCookie ?? fx.ownerCookie, userId: fx.reportActorUserId ?? fx.ownerUserId };
  const params = new URLSearchParams({ from, to, branchId: fx.branchId, supplierId, status: 'CONFIRMED', paymentStatus: 'PARTIAL', search: fx.reportSearch ?? '', page: '1' });
  const purchasePath = '/api/report-center/purchases?', statementPath = '/api/accounting/statements?';
  let purchase: PurchaseResult | undefined;

  await check('unconfigured statement GET creates no entity/chart/period/journal/projection rows', async () => {
    const before = await accountingCounts(db, fx.cafeId);
    assert.equal(before.entities, 0, 'Primary fixture must start without accounting books');
    for (const kind of ['income', 'balance-sheet', 'cash-flow']) {
      const response = await req<StatementResult>(statementPath + new URLSearchParams({ kind, from, to }), fx.ownerCookie);
      assert.equal(response.status, 200, kind);
      assert.equal(response.body.configured, false, kind);
      assert.equal(response.body.outputSnapshot, null, kind);
      assert.ok(response.body.notice.includes('تجريبي'), 'Unconfigured notice must stay explicit');
    }
    assert.deepEqual(await accountingCounts(db, fx.cafeId), before);
  });

  await check('missing report/accounting permissions and revoked current login fail server-side', async () => {
    for (const path of [purchasePath + params, statementPath + new URLSearchParams({ kind: 'income', from, to })]) {
      assert.equal((await req(path, fx.restrictedCookie)).status, 403, path);
      assert.ok([401, 403].includes((await req(path, fx.revokedCookie)).status), 'Revoked current session must fail before data loading');
    }
  });

  await check('branch-pinned reader cannot widen purchase or cafe-wide financial statement scope', async () => {
    const wrongBranch = new URLSearchParams(params); wrongBranch.set('branchId', fx.secondBranchId);
    assert.equal((await req(purchasePath + wrongBranch, fx.branchPinnedCookie)).status, 403);
    for (const kind of ['balance-sheet', 'cash-flow']) assert.equal((await req(statementPath + new URLSearchParams({ kind, from, to, branchId: fx.secondBranchId }), fx.branchPinnedCookie)).status, 403, kind);
    const ownBranch = await req<PurchaseResult>(purchasePath + params, fx.branchPinnedCookie);
    assert.equal(ownBranch.status, 200); assert.equal(ownBranch.body.selection.branchId, fx.branchId);
  });

  await check('purchase canonical query agrees with pagination and full-filter totals', async () => {
    const where = { cafeId: fx.cafeId, branchId: fx.branchId, supplierId, status: 'CONFIRMED' as const, paymentStatus: 'PARTIAL' as const, invoiceDate: { gte: zonedDayStart(from), lt: zonedDayStart(addDays(to, 1)) }, ...(fx.reportSearch ? { OR: [{ invoiceNumber: { contains: fx.reportSearch, mode: 'insensitive' as const } }, { supplier: { name: { contains: fx.reportSearch, mode: 'insensitive' as const } } }] } : {}) };
    const expected = await db.purchaseInvoice.findMany({ where, orderBy: [{ invoiceDate: 'desc' }, { id: 'desc' }], include: { supplier: { select: { name: true } }, branch: { select: { name: true } } } });
    assert.ok(expected.length > 25, 'Requires at least26 matching retained synthetic invoices to exercise pagination');
    const aggregate = await db.purchaseInvoice.aggregate({ where, _count: true, _sum: { totalAmount: true, paidAmount: true, remainingAmount: true } });
    const page1 = await req<PurchaseResult>(purchasePath + params, actor.cookie);
    assert.equal(page1.status, 200); purchase = page1.body;
    assert.equal(purchase.pageSize, 25); assert.equal(purchase.rows.length, 25);
    assert.deepEqual(purchase.rows.map(row => row.id), expected.slice(0, 25).map(row => row.id));
    assert.deepEqual(purchase.totals, { count: aggregate._count, totalAmount: aggregate._sum.totalAmount?.toFixed(2) ?? '0.00', paidAmount: aggregate._sum.paidAmount?.toFixed(2) ?? '0.00', remainingAmount: aggregate._sum.remainingAmount?.toFixed(2) ?? '0.00' });
    for (const [index, row] of purchase.rows.entries()) {
      const source = expected[index];
      assert.deepEqual([row.totalAmount, row.paidAmount, row.remainingAmount], [source.totalAmount.toFixed(2), source.paidAmount.toFixed(2), source.remainingAmount.toFixed(2)]);
    }
    const page2Params = new URLSearchParams(params); page2Params.set('page', '2');
    const page2 = await req<PurchaseResult>(purchasePath + page2Params, actor.cookie);
    assert.equal(page2.status, 200); assert.deepEqual(page2.body.rows.map(row => row.id), expected.slice(25, 50).map(row => row.id));
    assert.deepEqual(page2.body.totals, purchase.totals);
    assert.equal(new Set([...purchase.rows, ...page2.body.rows].map(row => row.id)).size, purchase.rows.length + page2.body.rows.length);
  });

  await check('purchase screen/snapshot/CSV/print/Excel agree; Arabic formulas remain text', async () => {
    assert.ok(purchase, 'Canonical purchase case must succeed first');
    const snapshot = snapshotReport(purchase.outputSnapshot), expected = reportOutputFiles(snapshot);
    const response = await req<OutputFiles>('/api/report-center/purchases/output', actor.cookie, { snapshot: purchase.outputSnapshot });
    assert.equal(response.status, 200); assert.deepEqual(response.body, expected);
    assert.equal(snapshot.rows.length, purchase.rows.length);
    assert.deepEqual(snapshot.metrics.totals, purchase.totals);
    const metadata = snapshot.reporting as { cafeId: string; branchId: string; filters: Record<string, unknown>; windows: { from: string; to: string }[] };
    assert.equal(metadata.cafeId, fx.cafeId); assert.equal(metadata.branchId, fx.branchId);
    for (const key of ['from', 'to', 'branchId', 'supplierId', 'search', 'status', 'paymentStatus']) assert.equal(metadata.filters[key], purchase.selection[key as keyof PurchaseResult['selection']], key);
    assert.equal(metadata.windows[0].from, zonedDayStart(from).toISOString());
    assert.equal(metadata.windows[0].to, zonedDayStart(addDays(to, 1)).toISOString());
    assert.ok(response.body.csv.startsWith('\uFEFF'));
    const formulaCells = snapshot.rows.flatMap(row => Object.values(row)).filter((value): value is string => typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@-]/.test(value) && !/^-?\d+(\.\d+)?$/.test(value));
    assert.ok(formulaCells.some(value => /[\u0600-\u06ff]/.test(value)), 'Requires Arabic formula-looking synthetic supplier/invoice text');
    for (const value of formulaCells) assert.ok(response.body.csv.includes('"\'' + value.replaceAll('"', '""') + '"'), 'CSV must prefix formula-like text');
    assert.equal((await req('/api/reports/output', actor.cookie, { snapshot: purchase.outputSnapshot })).status, 400, 'Generic endpoint must refuse domain-separated purchase snapshot');
    assert.ok([401, 403].includes((await req('/api/report-center/purchases/output', fx.revokedCookie, { snapshot: purchase.outputSnapshot })).status));
    assert.equal((await req('/api/report-center/purchases/output', fx.otherTenantCookie, { snapshot: purchase.outputSnapshot })).status, 400, 'Other-tenant owner cannot use actor-bound snapshot');
  });

  await check('wrong tenant cannot select fixture branch or drill into original purchase', async () => {
    const response = await req(purchasePath + params + '&cafeId=' + encodeURIComponent(fx.cafeId), fx.otherTenantCookie);
    assert.equal(response.status, 403);
    assert.ok(purchase?.rows.length, 'Requires canonical purchase result');
    const detail = await req<{ invoice: { id: string } }>('/api/report-center/purchases/' + encodeURIComponent(purchase.rows[0].id), actor.cookie);
    assert.equal(detail.status, 200); assert.equal(detail.body.invoice.id, purchase.rows[0].id);
    assert.equal((await req('/api/report-center/purchases/' + encodeURIComponent(purchase.rows[0].id), fx.otherTenantCookie)).status, 404);
  });

  if (withDeniedPermission) {
    await check('old purchase snapshot is refused after each current source/export permission is revoked', async () => {
      assert.ok(purchase);
      for (const key of ['purchases.view', 'purchases.view_cost', 'reports.export']) await withDeniedPermission(actor, key, async () => {
        assert.equal((await req('/api/report-center/purchases/output', actor.cookie, { snapshot: purchase!.outputSnapshot })).status, 403, key);
      });
      assert.equal((await req('/api/report-center/purchases/output', actor.cookie, { snapshot: purchase.outputSnapshot })).status, 200, 'Hook must restore original permission state');
    });
  } else unavailable('purchase source permission revocation', 'Parent must supply withDeniedPermission hook, saving/restoring the exact fixture override state.');

  if (withBranchAssignment) {
    await check('same actor cannot export purchase snapshot after assignment changes to another branch', async () => {
      assert.ok(purchase);
      await withBranchAssignment(actor, fx.secondBranchId, async () => {
        assert.equal((await req('/api/report-center/purchases/output', actor.cookie, { snapshot: purchase!.outputSnapshot })).status, 403);
      });
    });
  } else unavailable('purchase snapshot current assignment change', 'Parent must supply withBranchAssignment hook on an exclusively owned fixture actor.');

  const configured = fx.configuredAccounting;
  if (!configured) {
    unavailable('configured statement canonical values/export/scope/revocation', 'Supply a separate retained configuredAccounting fixture with nonzero distinct branch postings through existing accounting services.');
  } else {
    assert.notEqual(configured.cafeId, fx.cafeId, 'Configured books must be a distinct wholly synthetic cafe; preserve unconfigured fixture');
    const { incomeStatement, balanceSheet, cashFlow } = await import('../src/lib/accounting/statements');
    const statementActor = { cookie: configured.ownerCookie, userId: configured.ownerUserId };
    let income: StatementResult | undefined;
    await check('configured statements equal canonical backend calculations and GET/output create no accounting rows', async () => {
      const before = await accountingCounts(db, configured.cafeId);
      assert.equal(before.entities, 1); assert.ok(before.entries > 0, 'Retained fixture must contain nonzero balanced service-posted entries');
      for (const kind of ['income', 'balance-sheet', 'cash-flow']) {
        const args: { cafeId: string; from: string; to: string } = { cafeId: configured.cafeId, from: configured.from, to: configured.to };
        const expected: Record<string, unknown> = kind === 'income' ? await incomeStatement(args) : kind === 'balance-sheet' ? await balanceSheet({ cafeId: configured.cafeId, asOf: configured.to }) : await cashFlow(args);
        const response: JsonResponse<StatementResult> = await req<StatementResult>(statementPath + new URLSearchParams({ kind, from: configured.from, to: configured.to }), configured.ownerCookie);
        assert.equal(response.status, 200, kind); assert.equal(response.body.configured, true); assert.equal(response.body.mode, 'SHADOW');
        assert.deepEqual(response.body.result, expected, kind); assert.ok(response.body.outputSnapshot, kind);
        if (kind === 'income') { income = response.body; assert.notEqual(expected.netIncome, 0, 'Fixture must have nonzero income'); }
        const decoded = snapshotReport(response.body.outputSnapshot);
        const metadata = decoded.reporting as { cafeId: string; branchId: string | null; kind: string };
        assert.equal(metadata.cafeId, configured.cafeId); assert.equal(metadata.branchId, null); assert.equal(metadata.kind, kind);
        const output: JsonResponse<OutputFiles> = await req<OutputFiles>('/api/accounting/statements/output', configured.ownerCookie, { snapshot: response.body.outputSnapshot });
        assert.equal(output.status, 200, kind); assert.deepEqual(output.body, reportOutputFiles(decoded), kind);
        for (const [key, value] of Object.entries(expected)) if (typeof value === 'number' || typeof value === 'boolean') assert.equal(decoded.metrics[key], value, kind + '.' + key);
        assert.equal((await req('/api/reports/output', configured.ownerCookie, { snapshot: response.body.outputSnapshot })).status, 400);
        assert.ok([401, 403].includes((await req('/api/accounting/statements/output', fx.revokedCookie, { snapshot: response.body.outputSnapshot })).status));
      }
      assert.deepEqual(await accountingCounts(db, configured.cafeId), before);
    });
    await check('configured branch income remains scoped despite wider requested branch/cafe', async () => {
      const response = await req<StatementResult>(statementPath + new URLSearchParams({ kind: 'income', from: configured.from, to: configured.to, branchId: configured.secondBranchId, cafeId: fx.cafeId }), configured.branchPinnedCookie);
      assert.equal(response.status, 200); assert.equal(response.body.branchId, configured.branchId);
      const expected = await incomeStatement({ cafeId: configured.cafeId, branchId: configured.branchId, from: configured.from, to: configured.to });
      assert.deepEqual(response.body.result, expected);
      assert.ok(income?.result); assert.notEqual(expected.netIncome, income.result.netIncome, 'Fixture needs distinct second-branch or cafe-wide income');
      for (const kind of ['balance-sheet', 'cash-flow']) assert.equal((await req(statementPath + new URLSearchParams({ kind, from: configured.from, to: configured.to }), configured.branchPinnedCookie)).status, 403);
    });
    await check('owner-selected branch income uses canonical branch query and exports its exact snapshot', async () => {
      const response = await req<StatementResult>(statementPath + new URLSearchParams({ kind: 'income', from: configured.from, to: configured.to, branchId: configured.branchId }), configured.ownerCookie);
      assert.equal(response.status, 200); assert.equal(response.body.branchId, configured.branchId);
      assert.deepEqual(response.body.result, await incomeStatement({ cafeId: configured.cafeId, branchId: configured.branchId, from: configured.from, to: configured.to }));
      assert.ok(response.body.outputSnapshot);
      const output = await req<OutputFiles>('/api/accounting/statements/output', configured.ownerCookie, { snapshot: response.body.outputSnapshot });
      assert.equal(output.status, 200); assert.deepEqual(output.body, reportOutputFiles(snapshotReport(response.body.outputSnapshot)));
      for (const kind of ['balance-sheet', 'cash-flow']) assert.equal((await req(statementPath + new URLSearchParams({ kind, from: configured.from, to: configured.to, branchId: configured.branchId }), configured.ownerCookie)).status, 403, 'Cafe-wide calculations must refuse a selected branch');
      assert.equal((await req('/api/accounting/statements/output', fx.otherTenantCookie, { snapshot: response.body.outputSnapshot })).status, 400);
    });
    if (withDeniedPermission) {
      await check('old statement snapshot requires current accounting.view/accounting.export/reports.export', async () => {
        assert.ok(income?.outputSnapshot);
        for (const key of ['accounting.view', 'accounting.export', 'reports.export']) await withDeniedPermission(statementActor, key, async () => {
          assert.equal((await req('/api/accounting/statements/output', statementActor.cookie, { snapshot: income!.outputSnapshot })).status, 403, key);
        });
      });
    } else unavailable('statement source/export permission revocation', 'Parent withDeniedPermission hook is required.');
    if (withBranchAssignment) {
      await check('old cafe-wide statement snapshot fails after current owner assignment narrows to branch', async () => {
        assert.ok(income?.outputSnapshot);
        await withBranchAssignment(statementActor, configured.branchId, async () => {
          assert.equal((await req('/api/accounting/statements/output', statementActor.cookie, { snapshot: income!.outputSnapshot })).status, 403);
        });
      });
    } else unavailable('statement snapshot assignment narrowing', 'Parent withBranchAssignment hook is required.');
  }
  return { startedAt, completedAt: new Date().toISOString(), status: cases.some(row => row.status === 'FAIL') ? 'FAIL' : cases.some(row => row.status === 'NOT_RUN') ? 'PARTIAL' : 'PASS', cases, totals: { pass: cases.filter(row => row.status === 'PASS').length, fail: cases.filter(row => row.status === 'FAIL').length, notRun: cases.filter(row => row.status === 'NOT_RUN').length }, retained: true };
}
