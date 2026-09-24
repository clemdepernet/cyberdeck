package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newTestServer(t *testing.T) *Server {
	t.Helper()
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return NewServer(store, "https://deck.example")
}

func post(t *testing.T, s *Server, body string) map[string]any {
	t.Helper()
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest("POST", "/paste/api/pastes", bytes.NewBufferString(body)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: status %d body %s", rec.Code, rec.Body)
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return out
}

func TestCreateAndFetch(t *testing.T) {
	s := newTestServer(t)
	out := post(t, s, `{"content":"hello deck","ttl":"1h"}`)
	code := out["code"].(string)
	if len(code) != codeLength {
		t.Fatalf("code %q has wrong length", code)
	}
	if !strings.HasPrefix(out["url"].(string), "https://deck.example/p/") {
		t.Fatalf("url %q should use PUBLIC_URL", out["url"])
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest("GET", "/paste/api/pastes/"+strings.ToLower(code)+"/raw", nil))
	if rec.Code != 200 || rec.Body.String() != "hello deck" {
		t.Fatalf("raw: %d %q (lower-case code must work)", rec.Code, rec.Body)
	}
}

func TestBurnAfterReading(t *testing.T) {
	s := newTestServer(t)
	code := post(t, s, `{"content":"once","burn":true}`)["code"].(string)
	// peek does not consume
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest("GET", "/paste/api/pastes/"+code+"?peek=1", nil))
	if rec.Code != 200 {
		t.Fatalf("peek: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest("GET", "/paste/api/pastes/"+code, nil))
	if rec.Code != 200 {
		t.Fatalf("first read: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest("GET", "/paste/api/pastes/"+code, nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("second read should be gone, got %d", rec.Code)
	}
}

func TestExpirySweep(t *testing.T) {
	store, _ := NewStore(t.TempDir())
	p, err := store.Create("bye", time.Millisecond, false)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	if _, err := store.Get(p.Code, false); err == nil {
		t.Fatal("expired paste should not be readable")
	}
	if _, err := store.Create("x", time.Millisecond, false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	if n := store.Sweep(); n != 1 {
		t.Fatalf("sweep removed %d, want 1", n)
	}
}

func TestValidation(t *testing.T) {
	s := newTestServer(t)
	for _, tc := range []struct {
		body string
		want int
	}{
		{`{"content":"   "}`, 400},
		{`not json`, 400},
		{`{"content":"` + strings.Repeat("a", maxBody+10) + `"}`, 413},
	} {
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, httptest.NewRequest("POST", "/paste/api/pastes", bytes.NewBufferString(tc.body)))
		if rec.Code != tc.want {
			t.Errorf("body %.20q: got %d want %d", tc.body, rec.Code, tc.want)
		}
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest("GET", "/paste/api/pastes/ZZZZZ", nil))
	if rec.Code != 404 {
		t.Errorf("unknown code: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest("GET", "/paste/api/pastes/ABCDE/qr.png", nil))
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "image/png" {
		t.Errorf("qr: %d %s", rec.Code, rec.Header().Get("Content-Type"))
	}
}

func TestRateLimit(t *testing.T) {
	l := NewLimiter(60, 3)
	for i := 0; i < 3; i++ {
		if !l.Allow("ip") {
			t.Fatalf("request %d should pass", i)
		}
	}
	if l.Allow("ip") {
		t.Fatal("burst exhausted, should be denied")
	}
	if !l.Allow("other") {
		t.Fatal("other ip should pass")
	}
}
