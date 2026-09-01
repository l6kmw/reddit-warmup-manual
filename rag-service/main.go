package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr              string
	QdrantURL         string
	Collection        string
	KBSource          string
	EmbeddingBaseURL  string
	EmbeddingModel    string
	EmbeddingAPIKey   string
	EmbeddingProvider string
	EmbeddingDim      int
}

type KB struct {
	SchemaVersion int      `json:"schemaVersion"`
	Items         []KBItem `json:"items"`
}

type KBItem struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	Keywords  []string `json:"keywords"`
	Content   string   `json:"content"`
	Status    string   `json:"status,omitempty"`
	CreatedAt string   `json:"createdAt,omitempty"`
	UpdatedAt string   `json:"updatedAt,omitempty"`
}

type App struct {
	cfg    Config
	client *http.Client
}

type qdrantPoint struct {
	ID      uint64                 `json:"id"`
	Vector  []float32              `json:"vector"`
	Payload map[string]interface{} `json:"payload"`
}

type qdrantSearchResult struct {
	ID      uint64                 `json:"id"`
	Score   float64                `json:"score"`
	Payload map[string]interface{} `json:"payload"`
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func loadConfig() (Config, error) {
	dim, err := strconv.Atoi(env("EMBEDDING_DIM", "1024"))
	if err != nil || dim <= 0 {
		return Config{}, errors.New("EMBEDDING_DIM must be a positive integer")
	}
	return Config{
		Addr:              env("RAG_ADDR", ":8090"),
		QdrantURL:         strings.TrimRight(env("QDRANT_URL", "http://127.0.0.1:6333"), "/"),
		Collection:        env("QDRANT_COLLECTION", "redwarm_knowledge"),
		KBSource:          env("KB_SOURCE", "../state/outreach-kb.json"),
		EmbeddingBaseURL:  strings.TrimRight(env("EMBEDDING_BASE_URL", "http://127.0.0.1:11434"), "/"),
		EmbeddingModel:    env("EMBEDDING_MODEL", "bge-m3:latest"),
		EmbeddingAPIKey:   strings.TrimSpace(os.Getenv("EMBEDDING_API_KEY")),
		EmbeddingProvider: strings.ToLower(env("EMBEDDING_PROVIDER", "ollama")),
		EmbeddingDim:      dim,
	}, nil
}

func writeJSON(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func decodeJSON(r *http.Request, target interface{}) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 2<<20))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func (a *App) doJSON(method, url string, body interface{}, target interface{}, headers map[string]string) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	res, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(data)))
	}
	if target == nil || len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, target)
}

func readKB(path string) (KB, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return KB{}, err
	}
	var kb KB
	if err := json.Unmarshal(data, &kb); err != nil {
		return KB{}, err
	}
	return kb, nil
}

func activeItems(kb KB) []KBItem {
	items := make([]KBItem, 0, len(kb.Items))
	for _, item := range kb.Items {
		if item.Status == "disabled" || item.Status == "draft" {
			continue
		}
		if strings.TrimSpace(item.Content) == "" {
			continue
		}
		items = append(items, item)
	}
	return items
}

func stablePointID(id string) uint64 {
	sum := sha256.Sum256([]byte(id))
	var value uint64
	for _, part := range sum[:8] {
		value = (value << 8) | uint64(part)
	}
	if value == 0 {
		return 1
	}
	return value
}

func itemText(item KBItem) string {
	return strings.Join([]string{item.Title, strings.Join(item.Keywords, ", "), item.Content}, "\n")
}

func (a *App) embed(inputs []string) ([][]float32, error) {
	if len(inputs) == 0 {
		return [][]float32{}, nil
	}
	var vectors [][]float32
	var err error
	if a.cfg.EmbeddingProvider == "ollama" {
		request := map[string]interface{}{"model": a.cfg.EmbeddingModel, "input": inputs}
		var response struct {
			Embeddings [][]float32 `json:"embeddings"`
		}
		err = a.doJSON(http.MethodPost, a.cfg.EmbeddingBaseURL+"/api/embed", request, &response, nil)
		vectors = response.Embeddings
	} else {
		if a.cfg.EmbeddingAPIKey == "" {
			return nil, errors.New("EMBEDDING_API_KEY is not configured")
		}
		request := map[string]interface{}{"model": a.cfg.EmbeddingModel, "input": inputs}
		var response struct {
			Data []struct {
				Index     int       `json:"index"`
				Embedding []float32 `json:"embedding"`
			} `json:"data"`
		}
		err = a.doJSON(http.MethodPost, a.cfg.EmbeddingBaseURL+"/embeddings", request, &response, map[string]string{"Authorization": "Bearer " + a.cfg.EmbeddingAPIKey})
		vectors = make([][]float32, len(inputs))
		for _, row := range response.Data {
			if row.Index < 0 || row.Index >= len(vectors) {
				return nil, errors.New("embedding response has invalid index")
			}
			vectors[row.Index] = row.Embedding
		}
	}
	if err != nil {
		return nil, err
	}
	if len(vectors) != len(inputs) {
		return nil, fmt.Errorf("embedding response count %d, expected %d", len(vectors), len(inputs))
	}
	for _, vector := range vectors {
		if len(vector) != a.cfg.EmbeddingDim {
			return nil, fmt.Errorf("embedding dimension %d, expected %d", len(vector), a.cfg.EmbeddingDim)
		}
	}
	return vectors, nil
}

func (a *App) ensureCollection() error {
	var result struct{}
	body := map[string]interface{}{"vectors": map[string]interface{}{"size": a.cfg.EmbeddingDim, "distance": "Cosine"}}
	return a.doJSON(http.MethodPut, a.cfg.QdrantURL+"/collections/"+a.cfg.Collection, body, &result, nil)
}

func (a *App) upsert(items []KBItem, vectors [][]float32) error {
	points := make([]qdrantPoint, 0, len(items))
	for index, item := range items {
		points = append(points, qdrantPoint{ID: stablePointID(item.ID), Vector: vectors[index], Payload: map[string]interface{}{
			"id": item.ID, "title": item.Title, "keywords": item.Keywords, "content": item.Content,
			"status": item.Status, "updatedAt": item.UpdatedAt, "createdAt": item.CreatedAt,
		}})
	}
	body := map[string]interface{}{"points": points}
	return a.doJSON(http.MethodPut, a.cfg.QdrantURL+"/collections/"+a.cfg.Collection+"/points?wait=true", body, nil, nil)
}

func (a *App) syncKB() (int, error) {
	kb, err := readKB(a.cfg.KBSource)
	if err != nil {
		return 0, err
	}
	items := activeItems(kb)
	if len(items) == 0 {
		return 0, errors.New("no active knowledge items")
	}
	if err := a.ensureCollection(); err != nil {
		return 0, err
	}
	texts := make([]string, len(items))
	for index, item := range items {
		texts[index] = itemText(item)
	}
	vectors, err := a.embed(texts)
	if err != nil {
		return 0, err
	}
	if err := a.upsert(items, vectors); err != nil {
		return 0, err
	}
	return len(items), nil
}

func payloadString(payload map[string]interface{}, key string) string {
	value, _ := payload[key].(string)
	return value
}

func (a *App) search(query string, limit int) ([]map[string]interface{}, error) {
	if strings.TrimSpace(query) == "" {
		return nil, errors.New("query is required")
	}
	if limit <= 0 || limit > 50 {
		limit = 5
	}
	vectors, err := a.embed([]string{query})
	if err != nil {
		return nil, err
	}
	body := map[string]interface{}{"vector": vectors[0], "limit": limit, "with_payload": true}
	var response struct {
		Result []qdrantSearchResult `json:"result"`
	}
	if err := a.doJSON(http.MethodPost, a.cfg.QdrantURL+"/collections/"+a.cfg.Collection+"/points/search", body, &response, nil); err != nil {
		return nil, err
	}
	results := make([]map[string]interface{}, 0, len(response.Result))
	for _, result := range response.Result {
		results = append(results, map[string]interface{}{
			"id": payloadString(result.Payload, "id"), "title": payloadString(result.Payload, "title"),
			"content": payloadString(result.Payload, "content"), "score": result.Score,
			"keywords": result.Payload["keywords"], "matchedBy": []string{"vector"},
		})
	}
	return results, nil
}

func (a *App) handle(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/health":
		var collections struct{}
		err := a.doJSON(http.MethodGet, a.cfg.QdrantURL+"/collections", nil, &collections, nil)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]interface{}{"ok": false, "qdrant": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "qdrant": true, "collection": a.cfg.Collection})
	case r.Method == http.MethodGet && r.URL.Path == "/api/kb":
		kb, err := readKB(a.cfg.KBSource)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"items": kb.Items, "total": len(kb.Items)})
	case r.Method == http.MethodPost && r.URL.Path == "/api/kb/sync":
		count, err := a.syncKB()
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "synced": count, "collection": a.cfg.Collection})
	case r.Method == http.MethodPost && r.URL.Path == "/api/kb/search":
		var request struct {
			Query string `json:"query"`
			Limit int    `json:"limit"`
		}
		if err := decodeJSON(r, &request); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		results, err := a.search(request.Query, request.Limit)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"query": request.Query, "items": results})
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	}
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	if !filepath.IsAbs(cfg.KBSource) {
		cfg.KBSource = filepath.Clean(filepath.Join(".", cfg.KBSource))
	}
	app := &App{cfg: cfg, client: &http.Client{Timeout: 60 * time.Second}}
	server := &http.Server{Addr: cfg.Addr, Handler: http.HandlerFunc(app.handle), ReadHeaderTimeout: 10 * time.Second}
	log.Printf("redwarm-rag listening on %s, qdrant=%s, collection=%s", cfg.Addr, cfg.QdrantURL, cfg.Collection)
	log.Fatal(server.ListenAndServe())
}
