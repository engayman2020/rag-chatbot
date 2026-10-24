import { NextResponse, type NextRequest } from "next/server";
import { getStore, removeDoc } from "@/lib/store";
import { installProviders } from "@/lib/llm";
import { requireAdmin } from "@/lib/admin-auth";

export const runtime = "nodejs";

/** List documents (admin). */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (!denied.ok) return denied.response;
  try {
    await installProviders();
    const docs = await getStore().listDocs();
    return NextResponse.json({ docs, kind: getStore().kind });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "failed to list documents" }, { status: 500 });
  }
}

/** Delete a document and every chunk that came from it. */
export async function DELETE(request: NextRequest) {
  const denied = requireAdmin(request);
  if (!denied.ok) return denied.response;
  try {
    await installProviders();
    const id = new URL(request.url).searchParams.get("id") ?? (await request.json().catch(() => ({} as { id?: string }))).id;
    if (!id) return NextResponse.json({ error: "Provide an `id` to delete." }, { status: 400 });

    const docs = await getStore().listDocs();
    if (!docs.some((d) => d.id === id)) return NextResponse.json({ error: "No document with that id." }, { status: 404 });

    await removeDoc(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "delete failed" }, { status: 500 });
  }
}
