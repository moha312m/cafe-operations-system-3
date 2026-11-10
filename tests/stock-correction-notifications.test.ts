import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("Stock Correction Owner Notifications & Quick Approval", () => {
  test("src/app/api/corrections/pending/route.ts supports countOnly query parameter", () => {
    const route = source("src/app/api/corrections/pending/route.ts");
    assert.match(route, /countOnly/);
    assert.match(route, /db\.stockCountCorrection\.count/);
    assert.match(route, /NextResponse\.json\(\{\s*count\s*\}\)/);
    assert.match(route, /NextResponse\.json\(\{\s*count:\s*pendingCorrections\.length,\s*pendingCorrections\s*\}\)/);
  });

  test("StockCorrectionBell component renders notification bell and quick approval modal", () => {
    const bell = source("src/components/notifications/stock-correction-bell.tsx");
    assert.match(bell, /export function StockCorrectionBell/);
    assert.match(bell, /Bell className="size-5"/);
    assert.match(bell, /count > 0 &&/);
    assert.match(bell, /animate-pulse/);
    assert.match(bell, /handleApprove/);
    assert.match(bell, /handleReject/);
    assert.match(bell, /\/api\/corrections\/\$\{id\}\/approve/);
    assert.match(bell, /\/api\/corrections\/\$\{id\}\/reject/);
  });

  test("PendingCorrectionsBanner renders top alert for owner and managers", () => {
    const banner = source("src/components/notifications/pending-corrections-banner.tsx");
    assert.match(banner, /export function PendingCorrectionsBanner/);
    assert.match(banner, /CAFE_OWNER/);
    assert.match(banner, /BRANCH_MANAGER/);
    assert.match(banner, /countOnly=1/);
    assert.match(banner, /مراجعة واعتماد الآن/);
    assert.match(banner, /href="\/approvals"/);
  });

  test("AppShell integrates StockCorrectionBell and PendingCorrectionsBanner", () => {
    const shell = source("src/components/app-shell.tsx");
    assert.match(shell, /import \{ StockCorrectionBell \} from "@\/components\/notifications\/stock-correction-bell"/);
    assert.match(shell, /import \{ PendingCorrectionsBanner \} from "@\/components\/notifications\/pending-corrections-banner"/);
    assert.match(shell, /<StockCorrectionBell \/>/);
    assert.match(shell, /<PendingCorrectionsBanner pathname=\{pathname\} \/>/);
    assert.match(shell, /pendingCorrectionsCount/);
  });
});
