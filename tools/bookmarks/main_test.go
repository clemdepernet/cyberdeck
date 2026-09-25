package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testServer(t *testing.T) (*Server, *Store) {
	t.Helper()
	store, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return newServer(store), store
}

func do(t *testing.T, s *Server, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		json.NewEncoder(&buf).Encode(body)
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func TestSeedAndList(t *testing.T) {
	s, _ := testServer(t)
	rec := do(t, s, "GET", "/bookmarks/api/sites", nil)
	var out struct {
		Sites    []Site
		Families []string
	}
	json.Unmarshal(rec.Body.Bytes(), &out)
	if len(out.Sites) != 6 || strings.Join(out.Families, ",") != "Cracking,Cybersécurité,DevOps,Forensic,News,OSINT" {
		t.Fatalf("seed: %d sites, families %v", len(out.Sites), out.Families)
	}
	for _, x := range out.Sites {
		if x.ID == "" || x.Name == "" || x.Description == "" {
			t.Fatalf("incomplete seed %+v", x)
		}
	}
}

func TestCRUD(t *testing.T) {
	s, store := testServer(t)
	rec := do(t, s, "POST", "/bookmarks/api/sites", map[string]string{"url": "hashes.com/en/decrypt/hash", "family": "  cracking  "})
	if rec.Code != 201 {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	var site Site
	json.Unmarshal(rec.Body.Bytes(), &site)
	if site.URL != "https://hashes.com/en/decrypt/hash" || site.Name != "hashes.com" || site.Family != "Cracking" { // existing spelling reused
		t.Fatalf("normalised: %+v", site)
	}
	if rec := do(t, s, "POST", "/bookmarks/api/sites", map[string]string{"url": "https://hashes.com/en/decrypt/hash/"}); rec.Code != 409 {
		t.Fatalf("duplicate must be 409, got %d", rec.Code)
	}
	if rec := do(t, s, "POST", "/bookmarks/api/sites", map[string]string{"url": "not a url"}); rec.Code != 409 && rec.Code != 400 {
		t.Fatalf("invalid url: %d", rec.Code)
	}
	rec = do(t, s, "PUT", "/bookmarks/api/sites/"+site.ID, map[string]string{"url": site.URL, "name": "Hashes.com", "description": strings.Repeat("x", 500), "family": "Cracking"})
	if rec.Code != 200 {
		t.Fatalf("update: %d %s", rec.Code, rec.Body.String())
	}
	json.Unmarshal(rec.Body.Bytes(), &site)
	if site.Name != "Hashes.com" || len([]rune(site.Description)) != maxDesc || site.Family != "Cracking" {
		t.Fatalf("updated: %+v", site)
	}
	if rec := do(t, s, "PUT", "/bookmarks/api/sites/nope", map[string]string{"url": "https://a.b"}); rec.Code != 404 {
		t.Fatal("update of unknown id must be 404")
	}
	if n := store.renameFamily("cracking", "Mots de passe"); n != 3 { // 2 sites + the kept family entry
		t.Fatalf("rename touched %d", n)
	}
	if rec := do(t, s, "DELETE", "/bookmarks/api/sites/"+site.ID, nil); rec.Code != 204 {
		t.Fatalf("delete: %d", rec.Code)
	}
	if rec := do(t, s, "DELETE", "/bookmarks/api/sites/"+site.ID, nil); rec.Code != 404 {
		t.Fatal("second delete must be 404")
	}
	// persisted: a fresh store reads the same files, the emptied family survives
	again, err := openStore(store.path[:len(store.path)-len("/sites.json")])
	if err != nil || len(again.sites) != 6 {
		t.Fatalf("reload: %v, %d sites", err, len(again.sites))
	}
	if _, fams := again.list(); !strings.Contains(strings.Join(fams, ","), "Mots de passe") {
		t.Fatalf("emptied family lost: %v", fams)
	}
}

func TestFamilies(t *testing.T) {
	s, store := testServer(t)
	if rec := do(t, s, "POST", "/bookmarks/api/families", map[string]string{"name": "  Veille  "}); rec.Code != 201 || !strings.Contains(rec.Body.String(), `"Veille"`) {
		t.Fatalf("create family: %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(t, s, "POST", "/bookmarks/api/families", map[string]string{"name": "veille"}); rec.Code != 409 {
		t.Fatal("duplicate family (case-insensitive) must be 409")
	}
	if rec := do(t, s, "POST", "/bookmarks/api/families", map[string]string{"name": "devops"}); rec.Code != 409 {
		t.Fatal("family already used by sites must be 409")
	}
	_, fams := store.list()
	if !strings.Contains(strings.Join(fams, ","), "Veille") {
		t.Fatalf("empty family not listed: %v", fams)
	}
	// a site typed in lowercase joins the existing family spelling
	rec := do(t, s, "POST", "/bookmarks/api/sites", map[string]string{"url": "https://feedly.com", "family": "veille"})
	var site Site
	json.Unmarshal(rec.Body.Bytes(), &site)
	if site.Family != "Veille" {
		t.Fatalf("family spelling not reused: %q", site.Family)
	}
	if rec := do(t, s, "DELETE", "/bookmarks/api/families/Veille", nil); rec.Code != 409 {
		t.Fatal("a family with sites must not be deletable")
	}
	do(t, s, "DELETE", "/bookmarks/api/sites/"+site.ID, nil)
	if rec := do(t, s, "DELETE", "/bookmarks/api/families/veille", nil); rec.Code != 204 {
		t.Fatalf("delete empty family: %d", rec.Code)
	}
	if rec := do(t, s, "DELETE", "/bookmarks/api/families/veille", nil); rec.Code != 404 {
		t.Fatal("second delete must be 404")
	}
}

func TestBulk(t *testing.T) {
	s, _ := testServer(t)
	text := `# Dev
https://devdocs.io | DevDocs | Toute la doc au même endroit
github.com/trending

# News
https://www.zataz.com | ZATAZ | | Actu FR
https://roadmap.sh/devops
`
	rec := do(t, s, "POST", "/bookmarks/api/sites/bulk", map[string]string{"text": text})
	var out struct {
		Added  []Site
		Errors []string
	}
	json.Unmarshal(rec.Body.Bytes(), &out)
	if len(out.Added) != 3 || len(out.Errors) != 1 {
		t.Fatalf("bulk: %+v", out)
	}
	if out.Added[0].Family != "Dev" || out.Added[1].Name != "github.com" || out.Added[1].Family != "Dev" || out.Added[2].Family != "Actu FR" || out.Added[2].Description != "" {
		t.Fatalf("bulk parse: %+v", out.Added)
	}
	if !strings.Contains(out.Errors[0], "déjà") {
		t.Fatalf("duplicate error: %v", out.Errors)
	}
}

func TestExtractAndPeek(t *testing.T) {
	page := `<html><head><title> Mon &amp; Site </title>
<meta name="description" content="Une description &quot;simple&quot;.">
<meta property="og:description" content='La meilleure'></head></html>`
	title, desc := extract([]byte(page))
	if title != "Mon & Site" || desc != "La meilleure" {
		t.Fatalf("extract: %q %q", title, desc)
	}
	if _, err := peek("http://localhost:1/x"); err == nil {
		t.Fatal("local addresses must be refused")
	}
	if _, err := peek("nope"); err == nil {
		t.Fatal("bad url must be refused")
	}
	if u, err := cleanURL("example.org/path?q=1"); err != nil || u != "https://example.org/path?q=1" {
		t.Fatalf("cleanURL: %q %v", u, err)
	}
	// the API surface answers JSON errors
	s, _ := testServer(t)
	if rec := do(t, s, "GET", "/bookmarks/api/peek?url=localhost", nil); rec.Code != 502 || !strings.Contains(rec.Body.String(), "error") {
		t.Fatalf("peek error: %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(t, s, "GET", "/bookmarks/api/export", nil); rec.Code != 200 || !strings.Contains(rec.Header().Get("Content-Disposition"), "signets.json") {
		t.Fatal("export")
	}
	_ = http.StatusOK
}
