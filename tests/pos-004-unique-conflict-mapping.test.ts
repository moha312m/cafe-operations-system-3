// POS-004 (R-POS-02B1) — a lost race is a conflict, not a crash.
//
// The counterpart to POS-CONC-002. That suite proves two tills end up with
// distinct numbers; this one pins the behaviour that makes it possible to
// say so honestly — that a unique-constraint violation reaching the error
// handler is answered as a conflict the caller can understand, and never as
// "حصل خطأ غير متوقع".
//
// `handleApiError` already recognises schema drift (P2021/P2022) and a dead
// connection, but not P2002, so every uniqueness collision in the product —
// order numbers, shift numbers, and the two partial indexes deferred to
// R-POS-02B2 — fell through to the 500 at the bottom. Mapping it here is
// what lets those constraints be added without turning routine contention
// into an error page.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { handleApiError, ApiError, retryOnUniqueConflict } from "@/lib/api";

function uniqueViolation(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: Prisma.prismaVersion.client,
    meta: { target },
  });
}

describe("POS-004 unique-constraint conflicts are reported as conflicts", () => {
  test("a P2002 is answered 409, not 500", async () => {
    const res = handleApiError(uniqueViolation(["branchId", "orderNumber"]));
    assert.equal(res.status, 409, "a lost race must not look like a server fault");
  });

  test("the message is the café's language, not Prisma's", async () => {
    const res = handleApiError(uniqueViolation(["branchId", "orderNumber"]));
    const body = (await res.json()) as { error?: string };
    assert.ok(body.error, "a conflict must still explain itself");
    assert.doesNotMatch(
      body.error!,
      /P2002|Unique constraint|prisma/i,
      "the database's wording must not reach the till"
    );
    assert.doesNotMatch(
      body.error!,
      /حصل خطأ غير متوقع/,
      "a known conflict must not be reported as an unexpected error"
    );
  });

  test("unrelated failures are left exactly as they were", async () => {
    // The mapping must be narrow. An ApiError still owns its own status,
    // and a genuinely unknown error is still a 500 — otherwise this change
    // would quietly reclassify every fault in the product as a conflict.
    const explicit = handleApiError(new ApiError(404, "الطلب مش موجود"));
    assert.equal(explicit.status, 404);

    const unknown = handleApiError(new Error("boom"));
    assert.equal(unknown.status, 500);
  });
});

describe("POS-004 the bounded retry", () => {
  test("a first-attempt conflict is retried, not reported", async () => {
    let calls = 0;
    const result = await retryOnUniqueConflict(
      async () => {
        calls += 1;
        if (calls === 1) throw uniqueViolation(["branchId", "orderNumber"]);
        return "committed";
      },
      { field: "orderNumber", message: "conflict" }
    );
    assert.equal(result, "committed");
    assert.equal(calls, 2, "the losing attempt must be run again");
  });

  test("it gives up, and gives up as a 409", async () => {
    // Bounded: a conflict that outlives the retries is reported, never looped
    // on forever.
    let calls = 0;
    await assert.rejects(
      () =>
        retryOnUniqueConflict(
          async () => {
            calls += 1;
            throw uniqueViolation(["branchId", "orderNumber"]);
          },
          { field: "orderNumber", message: "رقم الطلب اتاخد في نفس اللحظة — جرّب تاني" }
        ),
      (e: Error) => {
        assert.ok(e instanceof ApiError, "exhaustion must not leak the Prisma error");
        assert.equal((e as ApiError).status, 409);
        return true;
      }
    );
    assert.equal(calls, 3, "three attempts, then stop");
  });

  test("it does not swallow a different constraint or a different fault", async () => {
    // Narrowing matters: retrying a collision on some OTHER unique column
    // would re-run a transaction that is going to fail again every time.
    let calls = 0;
    await assert.rejects(
      () =>
        retryOnUniqueConflict(
          async () => {
            calls += 1;
            throw uniqueViolation(["cafeId", "normalizedPhone"]);
          },
          { field: "orderNumber", message: "conflict" }
        ),
      (e: Error) => e.message.includes("Unique constraint")
    );
    assert.equal(calls, 1, "an unrelated conflict is raised at once");

    let other = 0;
    await assert.rejects(
      () =>
        retryOnUniqueConflict(
          async () => {
            other += 1;
            throw new Error("boom");
          },
          { field: "orderNumber", message: "conflict" }
        ),
      /boom/
    );
    assert.equal(other, 1);
  });
});
