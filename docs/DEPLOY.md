# Deployment

Hosted on Railway, wired directly to this repository. **Every push to `main`
builds and deploys automatically** — no manual step.

## URL

<https://rag-chatbot-production-bddd.up.railway.app>

| Path | Purpose |
|---|---|
| `/` | Public chat. No login. |
| `/admin` | Document management + usage/cost. Password-gated. |

## Environment variables (set in the Railway dashboard)

| Variable | Value | Why |
|---|---|---|
| `ADMIN_PASSWORD` | **set** | Gates `/admin` and every admin API. Required before the URL is public. |
| `DATA_DIR` | `.data` | Where the document store lives. Mounted on a persistent Railway volume. |
| `LLM_API_KEY` | empty | Empty = demo mode: deterministic, zero cost, no network. |
| `EMBEDDING_API_KEY` | empty | Empty = local keyword matcher. |

Leave `LLM_API_KEY` empty and the bot answers from the bundled demo corpus with the
free extractive engine. Set it to move to a real model — see below.

## Persistent storage

`DATA_DIR` is mounted on a Railway volume (`/app/.data`, 5 GB). The corpus and the
conversation log survive restarts and redeploys. Without the volume the filesystem
is ephemeral and every deploy would start from an empty knowledge base.

## Going live with a real LLM

```bash
railway variables --set "LLM_API_BASE=https://api.openai.com/v1" --set "LLM_API_KEY=sk-..." --set "LLM_MODEL=gpt-4o-mini"
railway variables --set "EMBEDDING_API_KEY=sk-..."   # real embeddings; empty keeps the local matcher
```

Any OpenAI-compatible endpoint works — OpenAI, Groq, Ollama, LM Studio, vLLM.
Set `EMBEDDING_MODEL` to a 1536-dimensional model (`text-embedding-3-small` or
`text-embedding-ada-002`); the `vector(1536)` column in
`supabase/migrations/001_init.sql` must match it.

## Updating the site

```bash
git push origin main
```

Railway builds and redeploys. Check it landed:

```bash
railway deployment list --json     # expect SUCCESS on the newest entry
railway service logs               # build + runtime output
```

## Admin password

The password is only in the Railway dashboard (`ADMIN_PASSWORD`), never in this repo.
`/admin` asks for it, exchanges it for a short-lived bearer token, and sends that
token on every request. A wrong password is refused; an unset password refuses the
whole admin surface on any public host.

## Costs

Railway Hobby: the service sleeps after inactivity and wakes on the next request, so
a not-yet-launched demo costs nothing while it idles. The demo engine makes no paid
API calls, so usage is $0 by construction — the admin panel's cost counter reads
`$0.00` until a real `LLM_API_KEY` is set.
