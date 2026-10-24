import { NextResponse } from "next/server";
import { credentialFrom, isAdminConfigured, matchesCredential } from "./admin-credential";

/**
 * Admin gate for /admin and the document/log APIs.
 *
 * The chat itself is deliberately public — that is the product. Everything that can
 * change the knowledge base or read customer conversations is gated here, and the
 * gate lives in one place so no route is left unprotected by omission.
 *
 * Credential logic (password/token derivation) lives in admin-credential.ts, which
 * imports nothing from Next.js and is therefore testable under Node's test runner.
 */

export type AdminGate =
  | { ok: true }
  | { ok: false; status: 401 | 500; response: NextResponse };

export function isAuthorized(request: Request): boolean {
  const candidate = credentialFrom(request);
  return candidate.length > 0 && matchesCredential(candidate);
}

/**
 * Refuses with a ready-to-send response when the caller is not the admin.
 * When ADMIN_PASSWORD is unset, local hosts stay open (so `pnpm dev` works) and
 * anything public is refused — an open admin panel on the internet is the failure
 * mode this exists to prevent.
 */
export function requireAdmin(request: Request): AdminGate {
  // Local dev must stay frictionless (no password set yet, `pnpm dev` just works);
  // anything public without a configured password is refused outright.
  const local =
    (request.headers.get("host") || "").toLowerCase().match(/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/) !== null;

  if (!isAdminConfigured()) {
    if (local) return { ok: true };
    return {
      ok: false,
      status: 500,
      response: NextResponse.json(
        { error: "ADMIN_PASSWORD is not set. Set it before exposing this URL to the internet." },
        { status: 500 }
      ),
    };
  }

  if (isAuthorized(request)) return { ok: true };
  return {
    ok: false,
    status: 401,
    response: NextResponse.json({ error: "Admin authentication required." }, { status: 401 }),
  };
}
