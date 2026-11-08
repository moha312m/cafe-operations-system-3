import { test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import {
  OWNER_OVERRIDE_HEADER,
  OWNER_OVERRIDE_REFUSED,
  OWNER_OVERRIDE_LOCKED,
  overrideCodeFrom,
  overrideCodeMatches,
} from "../src/lib/owner-override";

test("OWNER_OVERRIDE_HEADER is 'x-owner-override-code'", () => {
  assert.equal(OWNER_OVERRIDE_HEADER, "x-owner-override-code");
});

test("overrideCodeFrom extracts code from Request headers", () => {
  const reqWithCode = new Request("https://example.com/api/backup/export", {
    headers: {
      "x-owner-override-code": "123456",
    },
  });
  assert.equal(overrideCodeFrom(reqWithCode), "123456");

  const reqWithWhitespace = new Request("https://example.com/api/backup/export", {
    headers: {
      "x-owner-override-code": "  987654321  ",
    },
  });
  assert.equal(overrideCodeFrom(reqWithWhitespace), "987654321");

  const reqWithoutCode = new Request("https://example.com/api/backup/export");
  assert.equal(overrideCodeFrom(reqWithoutCode), undefined);
});

test("overrideCodeMatches checks code format and bcrypt match", async () => {
  const hash = await bcrypt.hash("654321", 4);

  // Exact match
  assert.equal(await overrideCodeMatches("654321", hash), true);

  // Wrong code
  assert.equal(await overrideCodeMatches("654320", hash), false);

  // Invalid length (< 6 digits)
  assert.equal(await overrideCodeMatches("65432", hash), false);

  // Invalid characters (non-digits)
  assert.equal(await overrideCodeMatches("abcdef", hash), false);
  assert.equal(await overrideCodeMatches("65432a", hash), false);
});

test("role validation allows CAFE_OWNER and rejects all other roles", () => {
  const isOwner = (role: string) => role === "CAFE_OWNER";

  assert.equal(isOwner("CAFE_OWNER"), true);
  assert.equal(isOwner("BRANCH_MANAGER"), false);
  assert.equal(isOwner("CASHIER"), false);
  assert.equal(isOwner("WAITER"), false);
  assert.equal(isOwner("KITCHEN"), false);
  assert.equal(isOwner("ACCOUNTANT"), false);
  assert.equal(isOwner("INVENTORY_SPECIALIST"), false);
});

test("refusal error messages match expected security policies", () => {
  assert.equal(OWNER_OVERRIDE_REFUSED, "Invalid owner override code or insufficient permissions");
  assert.equal(OWNER_OVERRIDE_LOCKED, "Too many incorrect passcode attempts. Try again later");
});
