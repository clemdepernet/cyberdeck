// Copy-paste: share a snippet between machines with a short code.
//
// Pastes are JSON files under DATA_DIR, swept every minute. Codes use an
// alphabet without look-alike characters so they can be read out loud or typed
// on a phone without mistakes.
package main

import (
	"crypto/rand"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

//go:embed static/*
var staticFS embed.FS

const (
	codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
	codeLength   = 5
	maxBody      = 1 << 20 // 1 MiB of text
)

var codeRe = regexp.MustCompile(`^[A-Z0-9]{4,12}$`)

var ttls = map[string]time.Duration{
	"10m": 10 * time.Minute,
	"1h":  time.Hour,
	"1d":  24 * time.Hour,
	"7d":  7 * 24 * time.Hour,
}

type Paste struct {
	Code      string    `json:"code"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
	Burn      bool      `json:"burn"`
}

// Store keeps pastes as one file per code. It is small enough that a mutex is
// plenty; no database to back up, just a folder.
type Store struct {
	dir string
	mu  sync.Mutex
}

func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Store{dir: dir}, nil
}

func (s *Store) path(code string) string { return filepath.Join(s.dir, code+".json") }

func (s *Store) Create(content string, ttl time.Duration, burn bool) (*Paste, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for attempt := 0; attempt < 20; attempt++ {
		code, err := newCode(codeLength)
		if err != nil {
			return nil, err
		}
		if _, err := os.Stat(s.path(code)); err == nil {
			continue
		}
		now := time.Now().UTC()
		p := &Paste{Code: code, Content: content, CreatedAt: now, ExpiresAt: now.Add(ttl), Burn: burn}
		if err := s.write(p); err != nil {
			return nil, err
		}
		return p, nil
	}
	return nil, errors.New("could not allocate a free code")
}

func (s *Store) write(p *Paste) error {
	data, err := json.Marshal(p)
	if err != nil {
		return err
	}
	tmp := s.path(p.Code) + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path(p.Code))
}

var errNotFound = errors.New("not found")

// Get returns the paste; burn-after-reading pastes are deleted on first read.
func (s *Store) Get(code string, consume bool) (*Paste, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := os.ReadFile(s.path(code))
	if err != nil {
		return nil, errNotFound
	}
	var p Paste
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, errNotFound
	}
	if time.Now().After(p.ExpiresAt) {
		_ = os.Remove(s.path(code))
		return nil, errNotFound
	}
	if p.Burn && consume {
		_ = os.Remove(s.path(code))
	}
	return &p, nil
}

func (s *Store) Delete(code string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.Remove(s.path(code)); err != nil {
		return errNotFound
	}
	return nil
}

// Sweep removes expired pastes; returns how many were removed.
func (s *Store) Sweep() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return 0
	}
	n := 0
	now := time.Now()
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		full := filepath.Join(s.dir, e.Name())
		data, err := os.ReadFile(full)
		if err != nil {
			continue
		}
		var p Paste
		if json.Unmarshal(data, &p) != nil || now.After(p.ExpiresAt) {
			if os.Remove(full) == nil {
				n++
			}
		}
	}
	return n
}

func newCode(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	out := make([]byte, n)
	for i, b := range buf {
		out[i] = codeAlphabet[int(b)%len(codeAlphabet)]
	}
	return string(out), nil
}

// Limiter is a small per-IP token bucket: enough to make guessing 5-character
// codes impractical without bothering a human who mistypes twice.
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	rate    float64 // tokens per second
	burst   float64
}

type bucket struct {
	tokens float64
	last   time.Time
}

func NewLimiter(perMinute, burst int) *Limiter {
	return &Limiter{buckets: map[string]*bucket{}, rate: float64(perMinute) / 60, burst: float64(burst)}
}

func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	b.tokens += now.Sub(b.last).Seconds() * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func (l *Limiter) gc() {
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := time.Now().Add(-10 * time.Minute)
	for k, b := range l.buckets {
		if b.last.Before(cutoff) {
			delete(l.buckets, k)
		}
	}
}

type Server struct {
	store     *Store
	reads     *Limiter
	writes    *Limiter
	publicURL string
	mux       *http.ServeMux
}

func NewServer(store *Store, publicURL string) *Server {
	s := &Server{store: store, reads: NewLimiter(30, 15), writes: NewLimiter(20, 10), publicURL: strings.TrimRight(publicURL, "/")}
	mux := http.NewServeMux()
	static, _ := fs.Sub(staticFS, "static")
	mux.Handle("GET /paste/", http.StripPrefix("/paste/", http.FileServer(http.FS(static))))
	mux.HandleFunc("POST /paste/api/pastes", s.create)
	mux.HandleFunc("GET /paste/api/pastes/{code}", s.get)
	mux.HandleFunc("GET /paste/api/pastes/{code}/raw", s.raw)
	mux.HandleFunc("GET /paste/api/pastes/{code}/qr.png", s.qr)
	mux.HandleFunc("DELETE /paste/api/pastes/{code}", s.remove)
	s.mux = mux
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *Server) baseURL(r *http.Request) string {
	if s.publicURL != "" {
		return s.publicURL
	}
	scheme := "http"
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		scheme = p
	}
	return scheme + "://" + r.Host
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (s *Server) create(w http.ResponseWriter, r *http.Request) {
	if !s.writes.Allow(clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "too many pastes, slow down")
		return
	}
	var in struct {
		Content string `json:"content"`
		TTL     string `json:"ttl"`
		Burn    bool   `json:"burn"`
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil || len(body) > maxBody {
		writeError(w, http.StatusRequestEntityTooLarge, "paste is larger than 1 MiB")
		return
	}
	if err := json.Unmarshal(body, &in); err != nil {
		writeError(w, http.StatusBadRequest, "body must be JSON {content, ttl, burn}")
		return
	}
	if strings.TrimSpace(in.Content) == "" {
		writeError(w, http.StatusBadRequest, "content is empty")
		return
	}
	ttl, ok := ttls[in.TTL]
	if !ok {
		ttl = ttls["1d"]
	}
	p, err := s.store.Create(in.Content, ttl, in.Burn)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"code":       p.Code,
		"url":        s.baseURL(r) + "/p/" + p.Code,
		"expires_at": p.ExpiresAt,
		"burn":       p.Burn,
	})
}

func (s *Server) lookup(w http.ResponseWriter, r *http.Request, consume bool) *Paste {
	code := strings.ToUpper(r.PathValue("code"))
	if !codeRe.MatchString(code) {
		writeError(w, http.StatusBadRequest, "invalid code")
		return nil
	}
	if !s.reads.Allow(clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "too many lookups, wait a minute")
		return nil
	}
	p, err := s.store.Get(code, consume)
	if err != nil {
		writeError(w, http.StatusNotFound, "no paste with this code (expired, burned, or never existed)")
		return nil
	}
	return p
}

func (s *Server) get(w http.ResponseWriter, r *http.Request) {
	p := s.lookup(w, r, r.URL.Query().Get("peek") == "")
	if p == nil {
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) raw(w http.ResponseWriter, r *http.Request) {
	p := s.lookup(w, r, true)
	if p == nil {
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, p.Content)
}

func (s *Server) qr(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(r.PathValue("code"))
	if !codeRe.MatchString(code) {
		writeError(w, http.StatusBadRequest, "invalid code")
		return
	}
	png, err := qrcode.Encode(s.baseURL(r)+"/p/"+code, qrcode.Medium, 256)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(png)
}

func (s *Server) remove(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(r.PathValue("code"))
	if !codeRe.MatchString(code) {
		writeError(w, http.StatusBadRequest, "invalid code")
		return
	}
	if err := s.store.Delete(code); err != nil {
		writeError(w, http.StatusNotFound, "no paste with this code")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	dataDir := env("DATA_DIR", "./data")
	listen := env("LISTEN", "127.0.0.1:8101")
	store, err := NewStore(dataDir)
	if err != nil {
		log.Fatalf("paste: %v", err)
	}
	srv := NewServer(store, os.Getenv("PUBLIC_URL"))
	go func() {
		for range time.Tick(time.Minute) {
			if n := store.Sweep(); n > 0 {
				log.Printf("paste: swept %d expired paste(s)", n)
			}
			srv.reads.gc()
			srv.writes.gc()
		}
	}()
	log.Printf("paste: listening on %s, data in %s", listen, dataDir)
	log.Fatal(http.ListenAndServe(listen, srv))
}

var _ = fmt.Sprintf
