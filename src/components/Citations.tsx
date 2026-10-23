import Citation from "@/components/Citation";

/**
 * Renders the [n] markers the assistant uses as clickable source references.
 * Every marker maps back to the exact chunk that was fed to the model.
 */
export default function Citations({ citations }: { citations: { docName: string; chunkId: string; index: number; preview: string }[] }) {
  if (citations.length === 0) return null;

  return (
    <div className="mt-3 border-t border-slate-200 pt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Sources</p>
      <ul className="mt-2 space-y-2">
        {citations.map((citation) => (
          <Citation key={citation.chunkId} citation={citation} />
        ))}
      </ul>
    </div>
  );
}
