package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTest(t *testing.T, max int) (*Server, *Store) {
	t.Helper()
	store, err := NewStore(t.TempDir(), max)
	if err != nil {
		t.Fatal(err)
	}
	return NewServer(store, "https://deck.example"), store
}

func do(s *Server, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
	return rec
}

func TestCreateRedirectCount(t *testing.T) {
	s, _ := newTest(t, 10)
	rec := do(s, "POST", "/links/api/links", `{"url":"https://example.org/report?x=1","slug":"Rapport"}`)
	if rec.Code != 201 {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["short"] != "https://deck.example/s/Rapport" {
		t.Fatalf("short = %v", out["short"])
	}
	rec = do(s, "GET", "/s/rapport", "") // case-insensitive lookup
	if rec.Code != 302 || rec.Header().Get("Location") != "https://example.org/report?x=1" {
		t.Fatalf("redirect: %d %s", rec.Code, rec.Header().Get("Location"))
	}
	rec = do(s, "GET", "/links/api/links", "")
	if !strings.Contains(rec.Body.String(), `"clicks":1`) || !strings.Contains(rec.Body.String(), `"used":1`) {
		t.Fatalf("list: %s", rec.Body)
	}
	if rec := do(s, "GET", "/s/nope", ""); rec.Code != 404 {
		t.Fatalf("unknown: %d", rec.Code)
	}
	if rec := do(s, "GET", "/links/api/links/Rapport/qr.png", ""); rec.Code != 200 || rec.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("qr: %d", rec.Code)
	}
}

func TestLimitAndValidation(t *testing.T) {
	s, _ := newTest(t, 2)
	for i := 0; i < 2; i++ {
		if rec := do(s, "POST", "/links/api/links", `{"url":"https://example.org/a"}`); rec.Code != 201 {
			t.Fatalf("create %d: %d %s", i, rec.Code, rec.Body)
		}
	}
	if rec := do(s, "POST", "/links/api/links", `{"url":"https://example.org/c"}`); rec.Code != 409 {
		t.Fatalf("third link should hit the limit, got %d", rec.Code)
	}
	list := do(s, "GET", "/links/api/links", "")
	var out struct {
		Links []struct{ Slug string }
	}
	_ = json.Unmarshal(list.Body.Bytes(), &out)
	if rec := do(s, "DELETE", "/links/api/links/"+out.Links[0].Slug, ""); rec.Code != 204 {
		t.Fatalf("delete: %d", rec.Code)
	}
	if rec := do(s, "POST", "/links/api/links", `{"url":"https://example.org/c","slug":"ok-1"}`); rec.Code != 201 {
		t.Fatalf("after delete: %d %s", rec.Code, rec.Body)
	}
	for body, want := range map[string]int{
		`{"url":"javascript:alert(1)"}`:               400,
		`{"url":"ftp://x/y"}`:                         400,
		`{"url":"https://example.org","slug":"a"}`:    400, // too short
		`{"url":"https://example.org","slug":"ok-1"}`: 409,
		`nope`: 400,
	} {
		if rec := do(s, "POST", "/links/api/links", body); rec.Code != want {
			t.Errorf("%s: got %d want %d", body, rec.Code, want)
		}
	}
}

func TestPersistence(t *testing.T) {
	dir := t.TempDir()
	store, _ := NewStore(dir, 10)
	if _, err := store.Create("keep", "https://example.org", "titre"); err != nil {
		t.Fatal(err)
	}
	store.Resolve("keep")
	again, _ := NewStore(dir, 10)
	links := again.List()
	if len(links) != 1 || links[0].Clicks != 1 || links[0].Title != "titre" {
		t.Fatalf("reloaded: %+v", links)
	}
}
