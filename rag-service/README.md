# Go RAG service

Single-node RAG API for RedWarm. Qdrant stores vectors; the existing JSON file remains the source of truth and backup format.

## Run locally

```bash
go run .
```

Environment variables:

- `RAG_ADDR` (default `:8090`)
- `QDRANT_URL` (default `http://127.0.0.1:6333`)
- `QDRANT_COLLECTION` (default `redwarm_knowledge`)
- `KB_SOURCE` (default `../state/outreach-kb.json`)
- `EMBEDDING_BASE_URL` (default `https://api.openai.com/v1`)
- `EMBEDDING_MODEL` (default `text-embedding-3-small`)
- `EMBEDDING_API_KEY` (required for `/api/kb/sync` and `/api/kb/search`)
- `EMBEDDING_DIM` (default `1536`; must match the selected embedding model)

## API

```text
GET  /health
GET  /api/kb
POST /api/kb/sync
POST /api/kb/search   {"query":"shipping time to US","limit":5}
```

`/api/kb/sync` imports active entries from the JSON source, generates embeddings, and upserts them to Qdrant. The operation is idempotent by stable hash IDs.
