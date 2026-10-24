import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Admin credential checking — the part of the gate with no Next.js dependency.
 *
 * Kept free of `next/server` so it is directly testable under Node's test runner;
 * the route-facing gate that returns HTTP responses lives in admin-auth.ts.
 */

// Per-process salt, captured once at module load so the token minted by
// /api/admin/login and the one checked here agree for the life of the process.
// process.uptime() must NOT be read at request time: it advances between calls.
const BOOT_SALT = `${process.pid}:${process.uptime()}`;

function adminPassword(): string {
  return (process.env.ADMIN_PASSWORD || "").trim();
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function isAdminConfigured(): boolean {
  return adminPassword().length > 0;
}

/** The bearer token /api/admin/login mints and every admin route verifies. */
export function adminToken(): string {
  return createHash("sha256").update(`${BOOT_SALT}:${adminPassword()}`).digest("hex");
}

/** The password itself, or the token adminToken() mints. */
export function matchesCredential(candidate: string): boolean {
  const password = adminPassword();
  if (!password) return false;
  return safeEqual(candidate, password) || safeEqual(candidate, adminToken());
}

/** Extracts the credential a request carries, if any: bearer header, else `?token=`. */
export function credentialFrom(request: Request): string {
  const header = request.headers.get("authorization") || "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  return bearer || new URL(request.url).searchParams.get("token") || "";
}
