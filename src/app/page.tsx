import ChatWidget from "@/components/ChatWidget";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col px-4 py-10">
      <header className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-indigo-600">Northwind</p>
        <h1 className="text-3xl font-bold tracking-tight">Support Assistant</h1>
        <p className="mt-2 text-slate-600">
          Ask about refunds, shipping, plans or troubleshooting. Answers come only from
          Northwind&apos;s own documents, with sources cited.
        </p>
      </header>
      <ChatWidget />
    </main>
  );
}
