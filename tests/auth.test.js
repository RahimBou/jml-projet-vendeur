"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { parseCookies, sha256, safeEqualText, COOKIE_NAME, hashPassword, verifyPassword } = require("../auth");

test("parseCookies handles multiple cookies and malformed encoding safely", () => {
  assert.deepEqual(
    { ...parseCookies("a=1; jml_session=abc%2F123; broken=%E0%A4%A") },
    { a: "1", jml_session: "abc/123", broken: "" }
  );
});

test("session token fingerprints are deterministic and do not expose the token", () => {
  const token = crypto.randomBytes(32).toString("base64url");
  const digest = sha256(token);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(digest, token);
  assert.equal(sha256(token), digest);
  assert.equal(COOKIE_NAME, "jml_session");
});

test("constant-time text comparison rejects unequal lengths and values", () => {
  assert.equal(safeEqualText("abc", "abc"), true);
  assert.equal(safeEqualText("abc", "abd"), false);
  assert.equal(safeEqualText("abc", "abcd"), false);
});

test("Argon2id password hashing verifies only the correct password", async () => {
  const password = "JML-Temporary-Test-Password-2026!";
  const hash = await hashPassword(password);
  assert.match(hash, /^\$argon2id\$/);
  assert.equal(await verifyPassword(hash, password), true);
  assert.equal(await verifyPassword(hash, "wrong password"), false);
  assert.equal(await verifyPassword("not-a-hash", password), false);
});

test("password policy rejects short and oversized values", async () => {
  await assert.rejects(() => hashPassword("short"), /12 et 1024/);
  await assert.rejects(() => hashPassword("x".repeat(1025)), /12 et 1024/);
});
