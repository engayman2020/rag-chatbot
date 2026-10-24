/**
 * Admin login: exchanges ADMIN_PASSWORD for a short-lived bearer token.
 *
 * The password is never stored or echoed back, and the token is salted with a
 * per-boot value so it is worthless after a restart. This covers only the admin
 * surface — the chat itself stays public, which is the product.
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { adminToken } from "@/lib/admin-credential";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export async function POST(request: NextRequest) {
  const password = (process.env.ADMIN_PASSWORD || "").trim();
  if (!password) {
    return NextResponse.json(
      { error: "ADMIN_PASSWORD is not set. Set it before exposing this URL to the internet." },
      { status: 500 }
    );
  }

  const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
  const given = typeof body?.password === "string" ? body.password : "";

  if (!given || !safeEqual(given, password)) {
    return NextResponse.json({ error: "Invalid password." }, { status: 401 });
  }

  // Same derivation admin-auth checks, so the token verifies on later requests.
  return NextResponse.json({ token: adminToken() });
}
