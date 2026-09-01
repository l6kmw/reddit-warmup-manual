# Go RAG service

Single-node RAG API for RedWarm. Qdrant stores vectors; the existing JSON file remains the source of truth and backup format.

## Run locally

```bash
go run .
```

For the complete single-machine stack (Qdrant + Ollama + this service):

```bash
docker compose -f docker-compose.rag.yml up -d qdrant ollama
docker compose -f docker-compose.rag.yml exec ollama ollama pull bge-m3
# start the API after the embedding model is available
docker compose -f docker-compose.rag.yml up -d --build redwarm-rag
```

On a host installation with Ollama already running, `go run .` uses the local `bge-m3:latest` model by default.

Environment variables:

- `RAG_ADDR` (default `:8090`)
- `QDRANT_URL` (default `http://127.0.0.1:6333`)
- `QDRANT_COLLECTION` (default `redwarm_knowledge`)
- `KB_SOURCE` (default `../state/outreach-kb.json`)
- `EMBEDDING_PROVIDER` (default `ollama`; set `openai` for OpenAI-compatible APIs)
- `EMBEDDING_BASE_URL` (default `http://127.0.0.1:11434`; OpenAI example: `https://api.openai.com/v1`)
- `EMBEDDING_MODEL` (default `bge-m3:latest`)
- `EMBEDDING_API_KEY` (required only when `EMBEDDING_PROVIDER=openai`)
- `EMBEDDING_DIM` (default `1024`; `bge-m3` uses 1024; must match the selected model)

## API

```text
GET  /health
GET  /api/kb
POST /api/kb/sync
POST /api/kb/search   {"query":"shipping time to US","limit":5}
```

`/api/kb/sync` imports active entries from the JSON source, generates embeddings, and upserts them to Qdrant. The operation is idempotent by stable hash IDs.
