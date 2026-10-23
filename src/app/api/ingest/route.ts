import { NextResponse } from "next/server";

/**
 * The one place a document becomes answerable.
 *
 * Order matters: validate at the boundary, redact what we persist, then index.
 * A document is never written to the store until it has at least one chunk — a
 * half-ingested document would be silently unanswerable.
 */
import { chunkDocument } from "@/lib/rag";
import { ingestDoc, getStore } from "@/lib/store";
import { installProviders } from "@/lib/llm";
import { isQuarantined } from "@/lib/guardrails";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — a support doc is never larger than this
const ALLOWED_EXTENSIONS = new Set(["txt", "md", "markdown", "pdf"]);

export async function POST(request: Request) {
  try {
    await installProviders();

    const form = await request.formData().catch(() => null);
    const file = form?.get("file");

    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "Attach a file named `file` (multipart/form-data)." }, { status: 400 });
    }
    if (file.size === 0) {
      return NextResponse.json({ error: "That file is empty." }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: `File is ${Math.round(file.size / 1024 / 1024)} MB. The limit is ${MAX_BYTES / 1024 / 1024} MB.` }, { status: 413 });
    }

    const name = (file.name || "untitled.txt").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
    const extension = name.split(".").pop()?.toLowerCase() ?? "";
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      return NextResponse.json({ error: `Unsupported file type ".${extension}". Upload .txt, .md or .pdf.` }, { status: 415 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const text = await extractText(buffer, extension);
    if (!text.trim()) {
      return NextResponse.json({ error: "Could not read any text from that file. Is it a scanned PDF?" }, { status: 422 });
    }

    const chunks = chunkDocument(text);
    if (chunks.length === 0) {
      return NextResponse.json({ error: "Could not split that document into readable sections." }, { status: 422 });
    }

    // Reject instruction-shaped uploads at the boundary. A document that is mostly
    // commands is a prompt-injection payload, not knowledge — storing it would let it
    // hijack retrieval for unrelated questions.
    const quarantined = isQuarantined(text);

    const doc = await ingestDoc({
      name,
      mimeType: file.type || `text/${extension}`,
      byteSize: buffer.byteLength,
      text,
      chunks,
      quarantined,
    });

    return NextResponse.json({
      doc,
      quarantined,
      message: quarantined
        ? `${name} was stored but excluded from answers — it looks like an instruction payload, not a document.`
        : `Indexed ${chunks.length} sections from ${name}.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "ingest failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Text extraction.
 * .txt/.md are already text. .pdf uses pdfjs-dist when it is installed and falls
 * back to a raw-stream scan otherwise — enough to index text-layer PDFs without
 * pulling a native dependency into a sales demo.
 */
async function extractText(buffer: Buffer, extension: string): Promise<string> {
  if (extension === "pdf") {
    return extractPdf(buffer);
  }
  // Strip a UTF-8 BOM so it does not end up inside the first chunk.
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

async function extractPdf(buffer: Buffer): Promise<string> {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
    const pages: string[] = [];
    for (let page = 1; page <= doc.numPages; page += 1) {
      const content = await (await doc.getPage(page)).getTextContent();
      pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    return pages.join("\n\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return scanPdfStreams(buffer);
  }
}

/** Last-resort: pull readable text runs out of the PDF's content streams. */
function scanPdfStreams(buffer: Buffer): string {
  const raw = buffer.toString("latin1");
  const runs = [...raw.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)]
    .map((m) => m[1].replace(/\\([()\\])/g, "$1").replace(/\\[nrt]/g, " "))
    .filter((s) => /[A-Za-z؀-ۿ]{3,}/.test(s));
  return runs.join("\n").trim();
}

export async function GET() {
  await installProviders();
  const docs = await getStore().listDocs();
  return NextResponse.json({ docs, kind: getStore().kind });
}
