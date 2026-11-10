import { test } from "node:test";
import assert from "node:assert/strict";
import { assertHandoverCorrectionRoundOpen } from "../src/lib/handover-count-validation";
import { ApiError } from "../src/lib/api";

test("assertHandoverCorrectionRoundOpen permits corrections during active handover and removes stale line acknowledgement", async () => {
  let deleteCalledWith: any = null;

  const mockTx: any = {
    stockCountSession: {
      findUnique: async () => ({ handoverId: "handover_123" }),
    },
    handoverSession: {
      findUnique: async () => ({
        id: "handover_123",
        status: "INCOMING_REVIEW",
        stockCountSessionId: "session_456",
      }),
    },
    handoverStockAcknowledgement: {
      count: async () => 1,
      deleteMany: async (args: any) => {
        deleteCalledWith = args;
        return { count: 1 };
      },
    },
  };

  // Should succeed without throwing 409
  await assertHandoverCorrectionRoundOpen(mockTx, "session_456", "line_789");

  // Should have deleted the stale acknowledgement specifically for line_789
  assert.deepEqual(deleteCalledWith, {
    where: {
      handoverId: "handover_123",
      stockCountLineId: "line_789",
    },
  });
});

test("assertHandoverCorrectionRoundOpen blocks corrections only if handover is completed or accepted", async () => {
  const mockTx: any = {
    stockCountSession: {
      findUnique: async () => ({ handoverId: "handover_123" }),
    },
    handoverSession: {
      findUnique: async () => ({
        id: "handover_123",
        status: "COMPLETED",
        stockCountSessionId: "session_456",
      }),
    },
  };

  await assert.rejects(
    async () => {
      await assertHandoverCorrectionRoundOpen(mockTx, "session_456", "line_789");
    },
    (err: any) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 409);
      assert.match(err.message, /تم اكتمال هذا التسليم/);
      return true;
    }
  );
});
