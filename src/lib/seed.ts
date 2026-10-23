import { DEMO_DOCS } from "./demo-docs.ts";

/**
 * Loads the bundled demo corpus on first use.
 * Purely additive: if the admin has already uploaded documents, nothing is seeded.
 *
 * The quarantine check runs here for the same reason it runs in the ingest route:
 * a guardrail that only exists at one call site is a guardrail that gets bypassed.
 */
import { chunkDocument } from "./rag.ts";
import { getStore, ingestDoc, type StoredDoc } from "./store.ts";
import { isQuarantined } from "./guardrails.ts";

export async function seedDemoDocsIfEmpty(): Promise<{ seeded: number; docs: StoredDoc[] }> {
  const existing = await getStore().listDocs();
  if (existing.length > 0) return { seeded: 0, docs: existing };

  let seeded = 0;
  for (const doc of DEMO_DOCS) {
    await ingestDoc({
      name: doc.name,
      mimeType: doc.mimeType,
      byteSize: Buffer.byteLength(doc.body, "utf8"),
      text: doc.body,
      chunks: chunkDocument(doc.body),
      quarantined: isQuarantined(doc.body),
    });
    seeded += 1;
  }
  return { seeded, docs: await getStore().listDocs() };
}

/** The admin panel's "reset to demo data" action. */
export async function resetToDemoDocs(): Promise<{ seeded: number }> {
  const store = getStore();
  for (const doc of await store.listDocs()) await store.deleteDoc(doc.id);
  const { seeded } = await seedDemoDocsIfEmpty();
  return { seeded };
}
