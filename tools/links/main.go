// Liens courts: a deliberately small URL shortener. MAX_LINKS (default 10)
// links live in one JSON file; each redirect bumps a click counter.
package main

import (
	"crypto/rand"
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

//go:embed static/*
var staticFS embed.FS

const slugAlphabet = "abcdefghijkmnpqrstuvwxyz23456789"

var slugRe = regexp.MustCompile(`^[A-Za-z0-9_-]{2,32}$`)

type Link struct {
	Slug      string    `json:"slug"`
	URL       string    `json:"url"`
	Title     string    `json:"title,omitempty"`
	Clicks    int       `json:"clicks"`
	CreatedAt time.Time `json:"created_at"`
	LastClick time.Time `json:"last_click,omitempty"`
}

type Store struct {
	path  string
	max   int
	mu    sync.Mutex
	links map[string]*Link
}

func NewStore(dir string, max int) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, "links.json"), max: max, links: map[string]*Link{}}
	if data, err := os.ReadFile(s.path); err == nil {
		var list []*Link
		if json.Unmarshal(data, &list) == nil {
			for _, l := range list {
				s.links[strings.ToLower(l.Slug)] = l
			}
		}
	}
	return s, nil
}

func (s *Store) persist() error {
	list := s.list()
	data, _ := json.MarshalIndent(list, "", "  ")
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *Store) list() []*Link {
	out := make([]*Link, 0, len(s.links))
	for _, l := range s.links {
		out = append(out, l)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out
}

func (s *Store) List() []*Link {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.list()
}

var (
	errFull   = errors.New("limite atteinte : supprime un lien avant d'en créer un autre")
	errTaken  = errors.New("ce raccourci est déjà pris")
	errSlug   = errors.New("raccourci invalide : 2 à 32 caractères, lettres, chiffres, - et _")
	errURL    = errors.New("URL invalide : elle doit commencer par http:// ou https://")
	errNotFnd = errors.New("lien inconnu")
)

func validateURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", errURL
	}
	if len(raw) > 2048 {
		return "", errURL
	}
	return raw, nil
}

func randomSlug() string {
	buf := make([]byte, 6)
	_, _ = rand.Read(buf)
	out := make([]byte, len(buf))
	for i, b := range buf {
		out[i] = slugAlphabet[int(b)%len(slugAlphabet)]
	}
	return string(out)
}

func (s *Store) Create(slug, target, title string) (*Link, error) {
	target, err := validateURL(target)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	slug = strings.TrimSpace(slug)
	if slug != "" {
		if !slugRe.MatchString(slug) {
			return nil, errSlug
		}
		if _, taken := s.links[strings.ToLower(slug)]; taken {
			return nil, errTaken
		}
	}
	if len(s.links) >= s.max {
		return nil, errFull
	}
	if slug == "" {
		for {
			slug = randomSlug()
			if _, taken := s.links[slug]; !taken {
				break
			}
		}
	}
	l := &Link{Slug: slug, URL: target, Title: strings.TrimSpace(title), CreatedAt: time.Now().UTC()}
	if len(l.Title) > 80 {
		l.Title = l.Title[:80]
	}
	s.links[strings.ToLower(slug)] = l
	return l, s.persist()
}

func (s *Store) Delete(slug string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.links[strings.ToLower(slug)]; !ok {
		return errNotFnd
	}
	delete(s.links, strings.ToLower(slug))
	return s.persist()
}

// Resolve returns the target and counts the click.
func (s *Store) Resolve(slug string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.links[strings.ToLower(slug)]
	if !ok {
		return "", false
	}
	l.Clicks++
	l.LastClick = time.Now().UTC()
	_ = s.persist()
	return l.URL, true
}

type Server struct {
	store     *Store
	publicURL string
	mux       *http.ServeMux
}

func NewServer(store *Store, publicURL string) *Server {
	s := &Server{store: store, publicURL: strings.TrimRight(publicURL, "/")}
	mux := http.NewServeMux()
	static, _ := fs.Sub(staticFS, "static")
	files := http.StripPrefix("/links/", http.FileServer(http.FS(static)))
	mux.Handle("GET /links/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	}))
	mux.HandleFunc("GET /links/api/links", s.list)
	mux.HandleFunc("POST /links/api/links", s.create)
	mux.HandleFunc("DELETE /links/api/links/{slug}", s.remove)
	mux.HandleFunc("GET /links/api/links/{slug}/qr.png", s.qr)
	mux.HandleFunc("GET /s/{slug}", s.redirect)
	s.mux = mux
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

func (s *Server) base(r *http.Request) string {
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
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) view(r *http.Request, l *Link) map[string]any {
	return map[string]any{
		"slug": l.Slug, "url": l.URL, "title": l.Title, "clicks": l.Clicks,
		"created_at": l.CreatedAt, "last_click": l.LastClick, "short": s.base(r) + "/s/" + l.Slug,
	}
}

func (s *Server) list(w http.ResponseWriter, r *http.Request) {
	links := s.store.List()
	out := make([]map[string]any, 0, len(links))
	for _, l := range links {
		out = append(out, s.view(r, l))
	}
	writeJSON(w, http.StatusOK, map[string]any{"links": out, "max": s.store.max, "used": len(links)})
}

func (s *Server) create(w http.ResponseWriter, r *http.Request) {
	var in struct{ URL, Slug, Title string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON attendu : {url, slug?, title?}"})
		return
	}
	l, err := s.store.Create(in.Slug, in.URL, in.Title)
	if err != nil {
		status := http.StatusBadRequest
		switch err {
		case errFull:
			status = http.StatusConflict
		case errTaken:
			status = http.StatusConflict
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, s.view(r, l))
}

func (s *Server) remove(w http.ResponseWriter, r *http.Request) {
	if err := s.store.Delete(r.PathValue("slug")); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) qr(w http.ResponseWriter, r *http.Request) {
	slug := r.PathValue("slug")
	if !slugRe.MatchString(slug) {
		http.NotFound(w, r)
		return
	}
	png, err := qrcode.Encode(s.base(r)+"/s/"+slug, qrcode.Medium, 256)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	_, _ = w.Write(png)
}

func (s *Server) redirect(w http.ResponseWriter, r *http.Request) {
	target, ok := s.store.Resolve(r.PathValue("slug"))
	if !ok {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		http.Error(w, "Ce lien court n'existe pas ou a été supprimé.", http.StatusNotFound)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	http.Redirect(w, r, target, http.StatusFound)
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	max, err := strconv.Atoi(env("MAX_LINKS", "10"))
	if err != nil || max < 1 {
		max = 10
	}
	store, err := NewStore(env("DATA_DIR", "./data"), max)
	if err != nil {
		log.Fatalf("links: %v", err)
	}
	listen := env("LISTEN", "127.0.0.1:8106")
	log.Printf("links: listening on %s, %d link(s) max", listen, max)
	log.Fatal(http.ListenAndServe(listen, NewServer(store, os.Getenv("PUBLIC_URL"))))
}
