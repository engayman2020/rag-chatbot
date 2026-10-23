"use client";

/** One source reference: where the answer came from, and the text it came from. */
export default function Citation({
  citation,
}: {
  citation: { docName: string; chunkId: string; index: number; preview: string };
}) {
  return (
    <li className="flex gap-2 text-sm">
      <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700">
        {citation.index}
      </span>
      <div className="min-w-0">
        <p className="font-medium text-slate-800">{citation.docName}</p>
        {citation.preview && (
          <p className="mt-0.5 line-clamp-3 text-slate-500">{citation.preview}</p>
        )}
      </div>
    </li>
  );
}
