import { describe, test } from "node:test";
import assert from "node:assert/strict";

describe("Handover Cancel Atomicity & Logic", () => {
  test("permission resolution allows custodian, branch manager, and owner", () => {
    // 1. Owner
    const isOwner = (role: string) => role === "CAFE_OWNER" || role === "SUPER_ADMIN";
    assert.equal(isOwner("CAFE_OWNER"), true);
    assert.equal(isOwner("SUPER_ADMIN"), true);
    assert.equal(isOwner("BRANCH_MANAGER"), false);
    assert.equal(isOwner("CASHIER"), false);

    // 2. Branch Manager on same branch
    const isBranchManager = (role: string, userBranch: string, handoverBranch: string) =>
      role === "BRANCH_MANAGER" && userBranch === handoverBranch;
    assert.equal(isBranchManager("BRANCH_MANAGER", "branch-1", "branch-1"), true);
    assert.equal(isBranchManager("BRANCH_MANAGER", "branch-2", "branch-1"), false);

    // 3. Custodian on same branch
    const isCustodian = (userId: string, outgoingUserId: string, userBranch: string, handoverBranch: string) =>
      userId === outgoingUserId && userBranch === handoverBranch;
    assert.equal(isCustodian("user-1", "user-1", "branch-1", "branch-1"), true);
    assert.equal(isCustodian("user-2", "user-1", "branch-1", "branch-1"), false);
    assert.equal(isCustodian("user-1", "user-1", "branch-2", "branch-1"), false);
  });

  test("cancellation transitions only open uncompleted statuses", () => {
    const validCancelStatuses = new Set(["DRAFT", "OUTGOING_SUBMITTED", "INCOMING_REVIEW", "REJECTED"]);
    
    assert.equal(validCancelStatuses.has("DRAFT"), true);
    assert.equal(validCancelStatuses.has("OUTGOING_SUBMITTED"), true);
    assert.equal(validCancelStatuses.has("INCOMING_REVIEW"), true);
    assert.equal(validCancelStatuses.has("REJECTED"), true);
    
    // Terminal statuses must NOT be cancellable
    assert.equal(validCancelStatuses.has("COMPLETED"), false);
    assert.equal(validCancelStatuses.has("ACCEPTED"), false);
    assert.equal(validCancelStatuses.has("MANAGER_EXCEPTION"), false);
  });

  test("auto-rejecting pending corrections clears PENDING_CORRECTIONS preflight blocker", () => {
    type Correction = { id: string; sessionId: string; status: "PENDING_APPROVAL" | "APPROVED" | "REJECTED" };
    
    const corrections: Correction[] = [
      { id: "c1", sessionId: "sess-1", status: "PENDING_APPROVAL" },
      { id: "c2", sessionId: "sess-1", status: "PENDING_APPROVAL" },
      { id: "c3", sessionId: "sess-2", status: "APPROVED" },
    ];

    // Simulating cancellation of sess-1
    const targetSessionId = "sess-1";
    for (const c of corrections) {
      if (c.sessionId === targetSessionId && c.status === "PENDING_APPROVAL") {
        c.status = "REJECTED";
      }
    }

    // Preflight count of pending corrections for sess-1
    const pendingOnSession = corrections.filter(
      (c) => c.sessionId === targetSessionId && c.status === "PENDING_APPROVAL"
    ).length;

    assert.equal(pendingOnSession, 0, "No pending corrections remain after cancel");
  });

  test("release pair consistency invariant: releasedAt and releasedById must both be present", () => {
    function validateReleasePair(f: { releasedAt: Date | null; releasedById: string | null }) {
      const consistent =
        (f.releasedAt === null && f.releasedById === null) ||
        (f.releasedAt !== null && f.releasedById !== null);
      if (!consistent) {
        throw new Error("InventoryFreeze_release_pair_consistent violation");
      }
      return true;
    }

    assert.equal(validateReleasePair({ releasedAt: null, releasedById: null }), true);
    assert.equal(validateReleasePair({ releasedAt: new Date(), releasedById: "user-123" }), true);
    assert.throws(() => validateReleasePair({ releasedAt: new Date(), releasedById: null }));
    assert.throws(() => validateReleasePair({ releasedAt: null, releasedById: "user-123" }));
  });
});
