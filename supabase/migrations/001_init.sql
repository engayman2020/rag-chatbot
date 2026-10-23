-- RAG support chatbot — schema + pgvector index
-- Run once in the Supabase SQL editor (or `supabase db push`).

create extension if not exists vector;
-- rag_ingest_document() generates document ids with digest(); that lives in pgcrypto.
create extension if not exists pgcrypto;

-- ────────────────────────── documents ──────────────────────────

create table if not exists public.rag_documents (
  id          text primary key,
  name        text not null,
  mime_type   text not null,
  byte_size   integer not null,
  char_count  integer not null,
  chunk_count integer not null,
  created_at  timestamptz not null default now(),
  quarantined boolean not null default false
);

-- ────────────────────────── chunks ──────────────────────────

-- The dimension is fixed by the embedding model, not by us: 1536 is
-- text-embedding-3-small / text-embedding-ada-002. Changing the model means changing
-- BOTH this column and EMBEDDING_DIM.
create table if not exists public.rag_chunks (
  id        text primary key,
  doc_id    text not null references public.rag_documents(id) on delete cascade,
  doc_name  text not null,
  idx       integer not null,
  text      text not null,
  embedding public.vector(1536) not null
);

-- IVFFlat needs a few thousand rows before it beats a seq scan; for a support corpus
-- of a few hundred chunks the planner will pick a seq scan anyway, which is fine.
create index if not exists rag_chunks_embedding_idx
  on public.rag_chunks
  using ivfflat (embedding public.vector_cosine_ops)
  with (lists = 100);

create index if not exists rag_chunks_doc_idx on public.rag_chunks (doc_id);

-- ────────────────────────── functions ──────────────────────────

-- Used by src/lib/store.ts. Kept as functions so the API never needs table grants.
create or replace function public.rag_list_docs()
returns table (id text, name text, mime_type text, byte_size integer, char_count integer, chunk_count integer, created_at timestamptz, quarantined boolean)
language sql security definer set search_path = public as $$
  select d.id, d.name, d.mime_type, d.byte_size, d.char_count, d.chunk_count, d.created_at, d.quarantined
  from public.rag_documents d
  order by d.created_at desc;
$$;

create or replace function public.rag_ingest_document(
  p_name       text,
  p_mime_type  text,
  p_byte_size  integer,
  p_chunks     text[],
  p_embeddings text[],
  p_quarantined boolean default false
)
returns table (id text, name text, mime_type text, byte_size integer, char_count integer, chunk_count integer, created_at timestamptz, quarantined boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_doc_id text := substr(encode(digest(p_name || clock_timestamp()::text, 'sha1'), 'hex'), 1, 16);
  v_chars  integer := length(array_to_string(p_chunks, ''));
begin
  if array_length(p_chunks, 1) is distinct from array_length(p_embeddings, 1) then
    raise exception 'chunks and embeddings must be the same length';
  end if;

  delete from public.rag_chunks where doc_id = v_doc_id;
  delete from public.rag_documents where id = v_doc_id;

  insert into public.rag_documents (id, name, mime_type, byte_size, char_count, chunk_count, quarantined)
  values (v_doc_id, p_name, p_mime_type, p_byte_size, v_chars, coalesce(array_length(p_chunks, 1), 0), coalesce(p_quarantined, false));

  for i in 1..coalesce(array_length(p_chunks, 1), 0) loop
    insert into public.rag_chunks (id, doc_id, doc_name, idx, text, embedding)
    values (v_doc_id || ':' || (i - 1), v_doc_id, p_name, i - 1, p_chunks[i], p_embeddings[i]::public.vector);
  end loop;

  return query
    select d.id, d.name, d.mime_type, d.byte_size, d.char_count, d.chunk_count, d.created_at, d.quarantined
    from public.rag_documents d where d.id = v_doc_id;
end;
$$;

create or replace function public.rag_delete_document(p_doc_id text)
returns void
language sql security definer set search_path = public as $$
  delete from public.rag_chunks where doc_id = p_doc_id;
  delete from public.rag_documents where id = p_doc_id;
$$;

create or replace function public.rag_search(p_query text, p_embedding text, p_k integer)
returns table (chunk_id text, doc_id text, doc_name text, idx integer, text text, score double precision)
language sql security definer set search_path = public as $$
  select c.id as chunk_id, c.doc_id, c.doc_name, c.idx, c.text,
         1 - (c.embedding <=> p_embedding::public.vector) as score
  from public.rag_chunks c
  order by c.embedding <=> p_embedding::public.vector
  limit greatest(1, least(coalesce(p_k, 5), 50));
$$;

-- ────────────────────────── admin audit log ──────────────────────────

create table if not exists public.rag_chat_logs (
  id              text primary key,
  conversation_id text not null,
  question        text not null,
  answer          text not null,
  engine          text not null,
  citations       jsonb not null default '[]'::jsonb,
  usage           jsonb not null,
  grounded        boolean not null,
  created_at      timestamptz not null default now()
);

create index if not exists rag_chat_logs_created_idx on public.rag_chat_logs (created_at desc);

create or replace function public.rag_list_logs()
returns table (id text, conversation_id text, question text, answer text, engine text, citations jsonb, usage jsonb, grounded boolean, created_at timestamptz)
language sql security definer set search_path = public as $$
  select l.id, l.conversation_id, l.question, l.answer, l.engine, l.citations, l.usage, l.grounded, l.created_at
  from public.rag_chat_logs l
  order by l.created_at desc
  limit 500;
$$;

create or replace function public.rag_save_log(
  p_id text, p_conversation_id text, p_question text, p_answer text,
  p_engine text, p_citations jsonb, p_usage jsonb, p_grounded boolean
)
returns void
language sql security definer set search_path = public as $$
  insert into public.rag_chat_logs (id, conversation_id, question, answer, engine, citations, usage, grounded)
  values (p_id, p_conversation_id, p_question, p_answer, p_engine, p_citations, p_usage, p_grounded);
$$;

create or replace function public.rag_delete_log(p_id text)
returns void
language sql security definer set search_path = public as $$
  delete from public.rag_chat_logs where id = p_id;
$$;

create or replace function public.rag_clear_logs()
returns void
language sql security definer set search_path = public as $$
  delete from public.rag_chat_logs;
$$;
