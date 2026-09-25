// Signets: a catalogue of useful sites, grouped by family. One JSON file,
// no database; adding a site is a URL, the title and description are
// fetched from the page when possible.
package main

import (
	"bytes"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"html"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

//go:embed static/*
var staticFS embed.FS

//go:embed seed.json
var seedJSON []byte

const (
	maxName  = 80
	maxDesc  = 240
	maxFam   = 40
	peekMax  = 512 * 1024
	peekWait = 8 * time.Second
)

type Site struct {
	ID          string    `json:"id"`
	URL         string    `json:"url"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Family      string    `json:"family"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type Store struct {
	mu       sync.Mutex
	path     string // sites.json
	famPath  string // families.json: families kept even when empty
	sites    []Site
	families []string
}

func newID() string {
	b := make([]byte, 6)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func openStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, "sites.json"), famPath: filepath.Join(dir, "families.json")}
	if raw, err := os.ReadFile(s.famPath); err == nil {
		json.Unmarshal(raw, &s.families)
	}
	raw, err := os.ReadFile(s.path)
	switch {
	case err == nil:
		if err := json.Unmarshal(raw, &s.sites); err != nil {
			return nil, err
		}
	case errors.Is(err, os.ErrNotExist):
		// First start: a handful of examples, one per family, to show the idea.
		var seeds []Site
		if err := json.Unmarshal(seedJSON, &seeds); err != nil {
			return nil, err
		}
		now := time.Now().UTC()
		for i := range seeds {
			seeds[i].ID, seeds[i].CreatedAt, seeds[i].UpdatedAt = newID(), now, now
		}
		s.sites = seeds
		for _, x := range seeds {
			s.keepFamily(x.Family)
		}
		if err := s.save(); err != nil {
			return nil, err
		}
	default:
		return nil, err
	}
	// Families that only exist through their sites are adopted once, so
	// emptying one later does not make it vanish.
	adopted := false
	for _, x := range s.sites {
		if s.keepFamily(x.Family) {
			adopted = true
		}
	}
	if adopted {
		if err := s.save(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func writeAtomic(path string, v any) error {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (s *Store) save() error {
	if err := writeAtomic(s.famPath, s.families); err != nil {
		return err
	}
	return writeAtomic(s.path, s.sites)
}

// keepFamily records a family name so it survives with no site in it.
func (s *Store) keepFamily(name string) bool {
	name = clip(name, maxFam)
	if name == "" {
		return false
	}
	for _, f := range s.families {
		if strings.EqualFold(f, name) {
			return false
		}
	}
	s.families = append(s.families, name)
	return true
}

// ---------------------------------------------------------------- validation

func cleanURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("URL manquante")
	}
	if !regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*://`).MatchString(raw) {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || !strings.Contains(u.Hostname(), ".") {
		return "", errors.New("URL invalide : http(s)://site.tld attendu")
	}
	return u.String(), nil
}

func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len([]rune(s)) > n {
		return string([]rune(s)[:n-1]) + "…"
	}
	return s
}

func hostOf(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	return strings.TrimPrefix(u.Hostname(), "www.")
}

func normalise(in Site) (Site, error) {
	u, err := cleanURL(in.URL)
	if err != nil {
		return in, err
	}
	in.URL = u
	in.Name = clip(in.Name, maxName)
	if in.Name == "" {
		in.Name = hostOf(u)
	}
	in.Description = clip(in.Description, maxDesc)
	in.Family = clip(in.Family, maxFam)
	if in.Family == "" {
		in.Family = "Divers"
	}
	return in, nil
}

// ---------------------------------------------------------------- store ops

func (s *Store) list() ([]Site, []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := append([]Site(nil), s.sites...)
	sort.Slice(out, func(i, j int) bool {
		if !strings.EqualFold(out[i].Family, out[j].Family) {
			return strings.ToLower(out[i].Family) < strings.ToLower(out[j].Family)
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	seen := map[string]bool{}
	var fams []string
	for _, x := range out {
		if !seen[strings.ToLower(x.Family)] {
			seen[strings.ToLower(x.Family)] = true
			fams = append(fams, x.Family)
		}
	}
	for _, f := range s.families {
		if !seen[strings.ToLower(f)] {
			seen[strings.ToLower(f)] = true
			fams = append(fams, f)
		}
	}
	sort.Slice(fams, func(i, j int) bool { return strings.ToLower(fams[i]) < strings.ToLower(fams[j]) })
	return out, fams
}

func (s *Store) addFamily(name string) (string, error) {
	name = clip(name, maxFam)
	if name == "" {
		return "", errors.New("nom de famille manquant")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, x := range s.sites {
		if strings.EqualFold(x.Family, name) {
			return x.Family, errors.New("cette famille existe déjà")
		}
	}
	if !s.keepFamily(name) {
		return name, errors.New("cette famille existe déjà")
	}
	return name, s.save()
}

// removeFamily only drops an empty family; sites are never deleted this way.
func (s *Store) removeFamily(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, x := range s.sites {
		if strings.EqualFold(x.Family, name) {
			return errors.New("la famille contient encore des sites")
		}
	}
	kept := s.families[:0]
	found := false
	for _, f := range s.families {
		if strings.EqualFold(f, name) {
			found = true
			continue
		}
		kept = append(kept, f)
	}
	s.families = kept
	if !found {
		return os.ErrNotExist
	}
	return s.save()
}

func (s *Store) add(in Site) (Site, error) {
	site, err := normalise(in)
	if err != nil {
		return site, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, x := range s.sites {
		if strings.EqualFold(strings.TrimRight(x.URL, "/"), strings.TrimRight(site.URL, "/")) {
			return x, errors.New("déjà dans les signets : " + x.Name)
		}
	}
	now := time.Now().UTC()
	site.ID, site.CreatedAt, site.UpdatedAt = newID(), now, now
	site.Family = s.canonicalFamily(site.Family)
	s.sites = append(s.sites, site)
	s.keepFamily(site.Family)
	return site, s.save()
}

// canonicalFamily reuses the existing spelling of a family ("devops" -> "DevOps").
func (s *Store) canonicalFamily(name string) string {
	for _, f := range s.families {
		if strings.EqualFold(f, name) {
			return f
		}
	}
	for _, x := range s.sites {
		if strings.EqualFold(x.Family, name) {
			return x.Family
		}
	}
	return name
}

func (s *Store) update(id string, in Site) (Site, error) {
	site, err := normalise(in)
	if err != nil {
		return site, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, x := range s.sites {
		if x.ID == id {
			site.ID, site.CreatedAt, site.UpdatedAt = x.ID, x.CreatedAt, time.Now().UTC()
			site.Family = s.canonicalFamily(site.Family)
			s.sites[i] = site
			s.keepFamily(site.Family)
			return site, s.save()
		}
	}
	return site, os.ErrNotExist
}

func (s *Store) remove(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, x := range s.sites {
		if x.ID == id {
			s.sites = append(s.sites[:i], s.sites[i+1:]...)
			return s.save()
		}
	}
	return os.ErrNotExist
}

func (s *Store) renameFamily(from, to string) int {
	to = clip(to, maxFam)
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for i := range s.sites {
		if strings.EqualFold(s.sites[i].Family, from) && to != "" {
			s.sites[i].Family = to
			n++
		}
	}
	for i := range s.families {
		if strings.EqualFold(s.families[i], from) && to != "" {
			s.families[i] = to
			n++
		}
	}
	if n > 0 {
		s.save()
	}
	return n
}

// parseBulk reads "url | name | description | family" lines; a line with a
// single URL is fine, a line starting with # sets the family for what follows.
func parseBulk(text string) []Site {
	var out []Site
	family := ""
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") {
			family = strings.TrimSpace(strings.TrimLeft(line, "# "))
			continue
		}
		parts := strings.Split(line, "|")
		for i := range parts {
			parts[i] = strings.TrimSpace(parts[i])
		}
		site := Site{URL: parts[0], Family: family}
		if len(parts) > 1 {
			site.Name = parts[1]
		}
		if len(parts) > 2 {
			site.Description = parts[2]
		}
		if len(parts) > 3 && parts[3] != "" {
			site.Family = parts[3]
		}
		out = append(out, site)
	}
	return out
}

// ---------------------------------------------------------------- peek

var (
	titleRe = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	metaRe  = regexp.MustCompile(`(?is)<meta\s+[^>]*>`)
	attrRe  = regexp.MustCompile(`(?is)([a-z:-]+)\s*=\s*("([^"]*)"|'([^']*)')`)
)

func attrs(tag string) map[string]string {
	out := map[string]string{}
	for _, m := range attrRe.FindAllStringSubmatch(tag, -1) {
		v := m[3]
		if v == "" {
			v = m[4]
		}
		out[strings.ToLower(m[1])] = v
	}
	return out
}

// extract pulls a title and a description out of an HTML page.
func extract(page []byte) (title, desc string) {
	if m := titleRe.FindSubmatch(page); m != nil {
		title = html.UnescapeString(string(m[1]))
	}
	best := ""
	for _, tag := range metaRe.FindAll(page, -1) {
		a := attrs(string(tag))
		key := a["name"] + " " + a["property"]
		content := html.UnescapeString(a["content"])
		if content == "" {
			continue
		}
		switch {
		case strings.Contains(key, "og:title") && title == "":
			title = content
		case strings.Contains(key, "og:description"):
			best = content
		case strings.Contains(key, "description") && best == "":
			best = content
		}
	}
	return clip(title, maxName), clip(best, maxDesc)
}

func privateHost(host string) bool {
	if host == "localhost" || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") {
		return true
	}
	ips, err := net.LookupIP(host)
	if err != nil {
		return false
	}
	for _, ip := range ips {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
			return true
		}
	}
	return false
}

func peek(rawURL string) (map[string]string, error) {
	u, err := cleanURL(rawURL)
	if err != nil {
		return nil, err
	}
	parsed, _ := url.Parse(u)
	if privateHost(parsed.Hostname()) {
		return nil, errors.New("adresse locale : renseigne le nom à la main")
	}
	client := &http.Client{Timeout: peekWait}
	req, _ := http.NewRequest(http.MethodGet, u, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; cyberdeck-signets/1.0)")
	req.Header.Set("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5")
	req.Header.Set("Accept-Language", "fr,en;q=0.7")
	resp, err := client.Do(req)
	if err != nil {
		return nil, errors.New("site injoignable")
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, peekMax))
	title, desc := extract(body)
	if title == "" {
		title = hostOf(u)
	}
	return map[string]string{"url": u, "name": title, "description": desc, "host": hostOf(u), "status": http.StatusText(resp.StatusCode)}, nil
}

// ---------------------------------------------------------------- http

type Server struct {
	store *Store
	mux   *http.ServeMux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func readSite(r *http.Request) (Site, error) {
	var in Site
	if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&in); err != nil {
		return in, errors.New("corps JSON attendu {url, name, description, family}")
	}
	return in, nil
}

func newServer(store *Store) *Server {
	s := &Server{store: store, mux: http.NewServeMux()}
	sub, _ := fs.Sub(staticFS, "static")
	files := http.StripPrefix("/bookmarks/", http.FileServer(http.FS(sub)))
	s.mux.Handle("GET /bookmarks/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".js") || strings.HasSuffix(r.URL.Path, ".css") || strings.HasSuffix(r.URL.Path, "/") {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	}))
	s.mux.HandleFunc("GET /bookmarks/api/sites", func(w http.ResponseWriter, r *http.Request) {
		sites, fams := store.list()
		writeJSON(w, 200, map[string]any{"sites": sites, "families": fams})
	})
	s.mux.HandleFunc("POST /bookmarks/api/sites", func(w http.ResponseWriter, r *http.Request) {
		in, err := readSite(r)
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		site, err := store.add(in)
		if err != nil {
			fail(w, 409, err.Error())
			return
		}
		writeJSON(w, 201, site)
	})
	s.mux.HandleFunc("PUT /bookmarks/api/sites/{id}", func(w http.ResponseWriter, r *http.Request) {
		in, err := readSite(r)
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		site, err := store.update(r.PathValue("id"), in)
		if errors.Is(err, os.ErrNotExist) {
			fail(w, 404, "signet introuvable")
			return
		}
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		writeJSON(w, 200, site)
	})
	s.mux.HandleFunc("DELETE /bookmarks/api/sites/{id}", func(w http.ResponseWriter, r *http.Request) {
		if err := store.remove(r.PathValue("id")); err != nil {
			fail(w, 404, "signet introuvable")
			return
		}
		w.WriteHeader(204)
	})
	s.mux.HandleFunc("POST /bookmarks/api/sites/bulk", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Text string `json:"text"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(&in); err != nil {
			fail(w, 400, "corps JSON attendu {text}")
			return
		}
		var added []Site
		var errs []string
		for _, site := range parseBulk(in.Text) {
			created, err := store.add(site)
			if err != nil {
				errs = append(errs, site.URL+" : "+err.Error())
				continue
			}
			added = append(added, created)
		}
		writeJSON(w, 200, map[string]any{"added": added, "errors": errs})
	})
	s.mux.HandleFunc("POST /bookmarks/api/families", func(w http.ResponseWriter, r *http.Request) {
		var in struct{ Name string }
		if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in); err != nil {
			fail(w, 400, "corps JSON attendu {name}")
			return
		}
		name, err := store.addFamily(in.Name)
		if err != nil {
			fail(w, 409, err.Error())
			return
		}
		writeJSON(w, 201, map[string]string{"name": name})
	})
	s.mux.HandleFunc("DELETE /bookmarks/api/families/{name}", func(w http.ResponseWriter, r *http.Request) {
		err := store.removeFamily(r.PathValue("name"))
		if errors.Is(err, os.ErrNotExist) {
			fail(w, 404, "famille introuvable")
			return
		}
		if err != nil {
			fail(w, 409, err.Error())
			return
		}
		w.WriteHeader(204)
	})
	s.mux.HandleFunc("POST /bookmarks/api/families/rename", func(w http.ResponseWriter, r *http.Request) {
		var in struct{ From, To string }
		if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in); err != nil || in.From == "" || strings.TrimSpace(in.To) == "" {
			fail(w, 400, "corps JSON attendu {from, to}")
			return
		}
		writeJSON(w, 200, map[string]int{"renamed": store.renameFamily(in.From, in.To)})
	})
	s.mux.HandleFunc("GET /bookmarks/api/peek", func(w http.ResponseWriter, r *http.Request) {
		info, err := peek(r.URL.Query().Get("url"))
		if err != nil {
			fail(w, 502, err.Error())
			return
		}
		writeJSON(w, 200, info)
	})
	s.mux.HandleFunc("GET /bookmarks/api/export", func(w http.ResponseWriter, r *http.Request) {
		sites, _ := store.list()
		w.Header().Set("Content-Disposition", `attachment; filename="signets.json"`)
		writeJSON(w, 200, sites)
	})
	s.mux.HandleFunc("GET /bookmarks/api/health", func(w http.ResponseWriter, r *http.Request) {
		sites, fams := store.list()
		writeJSON(w, 200, map[string]int{"sites": len(sites), "families": len(fams)})
	})
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

func main() {
	dir := os.Getenv("DATA_DIR")
	if dir == "" {
		dir = "./data"
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8109"
	}
	store, err := openStore(dir)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("bookmarks: %d site(s) in %s, listening on %s", len(store.sites), store.path, port)
	log.Fatal(http.ListenAndServe("127.0.0.1:"+port, newServer(store)))
}

var _ = bytes.MinRead
