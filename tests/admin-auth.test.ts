import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

/**
 * Admin credential tests.
 *
 * The chat is public by design; everything that can change the knowledge base or
 * read customer conversations must be gated. These pin the credential logic so a
 * route added later cannot silently ship open.
 *
 * Targets admin-credential.ts (no Next.js import) so Node's test runner can load it.
 */
import { adminToken, credentialFrom, isAdminConfigured, matchesCredential } from "../src/lib/admin-credential.ts";

const ORIGINAL_PASSWORD = process.env.ADMIN_PASSWORD;

function request(url: string, token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(url, { headers });
}

test("ADMIN_PASSWORD unset: nothing is authorized", () => {
  delete process.env.ADMIN_PASSWORD;
  assert.equal(isAdminConfigured(), false);
  assert.equal(matchesCredential("anything"), false, "the demo must not pretend to be gated");
  assert.equal(matchesCredential(""), false);
});

test("the password itself is accepted, a wrong password is not", () => {
  process.env.ADMIN_PASSWORD = "s3cret";
  assert.equal(isAdminConfigured(), true);

  assert.equal(matchesCredential("s3cret"), true);
  assert.equal(matchesCredential("nope"), false);
  assert.equal(matchesCredential(""), false, "an empty credential must never pass");
});

test("the token minted by login verifies, and a token from another boot does not", () => {
  process.env.ADMIN_PASSWORD = "s3cret";
  const token = adminToken();

  assert.equal(token.length, 64, "sha256 hex");
  assert.equal(matchesCredential(token), true);

  // Same salt format, different boot — must be worthless.
  const stale = createHash("sha256").update("999999:0.1:s3cret").digest("hex");
  assert.equal(matchesCredential(stale), false, "a token must not survive a restart");
});

test("credential is read from the bearer header or ?token=", () => {
  process.env.ADMIN_PASSWORD = "s3cret";

  assert.equal(credentialFrom(request("https://example.com/api/docs", "abc")), "abc");
  assert.equal(credentialFrom(request("https://example.com/api/docs?token=xyz")), "xyz");
  assert.equal(credentialFrom(request("https://example.com/api/docs")), "", "no credential");
  // A bare `Authorization:` header is not a credential.
  assert.equal(credentialFrom(request("https://example.com/api/docs")), "");
});

test("a password sent as a bearer header still works end to end", () => {
  process.env.ADMIN_PASSWORD = "s3cret";
  const candidate = credentialFrom(request("https://example.com/api/docs", "s3cret"));
  assert.equal(matchesCredential(candidate), true);
});

test.after(() => {
  if (ORIGINAL_PASSWORD === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = ORIGINAL_PASSWORD;
});
