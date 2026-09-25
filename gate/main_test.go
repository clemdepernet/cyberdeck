package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestPublicRules(t *testing.T) {
	yes := []string{
		"GET /health", "GET /theme.css", "GET /favicon.svg", "GET /deck.js",
		"GET /s/abc", "GET /s/mon-lien_2", "GET /p/K7X2M", "GET /paste/", "GET /paste/app.js", "GET /paste/?code=K7X2M",
		"GET /paste/api/pastes/K7X2M", "GET /paste/api/pastes/K7X2M/raw", "GET /paste/api/pastes/K7X2M/qr.png",
		"POST /login", "GET /login?next=/", "POST /logout", "GET /gate/status", "HEAD /s/abc",
	}
	no := []string{
		"GET /", "GET /index.html", "GET /app.js", "GET /tools.json", "GET /whiteboard/", "GET /pivot/api/maps",
		"POST /paste/api/pastes", "DELETE /paste/api/pastes/K7X2M", "GET /paste/api/pastes/", "GET /paste/api/pastes/../x",
		"GET /links/", "GET /links/api/links", "POST /links/api/links", "GET /s/", "GET /s/a", "GET /s/../etc",
		"GET /verdict/api/lookup?q=x", "GET /cyberchef/", "PUT /paste/", "GET /gate/check", "GET /sx/abc", "GET /paste",
	}
	for _, c := range yes {
		m, u, _ := strings.Cut(c, " ")
		if !public(m, u) {
			t.Errorf("%s should be public", c)
		}
	}
	for _, c := range no {
		m, u, _ := strings.Cut(c, " ")
		if public(m, u) {
			t.Errorf("%s should be protected", c)
		}
	}
}

func TestTokens(t *testing.T) {
	g := newGate("clem", "pw", []byte("secret"))
	tok := g.token(time.Now().Add(time.Hour))
	if !g.tokenOK(tok) {
		t.Fatal("fresh token refused")
	}
	if g.tokenOK(g.token(time.Now().Add(-time.Second))) {
		t.Fatal("expired token accepted")
	}
	if g.tokenOK(tok+"x") || g.tokenOK("1."+strings.Split(tok, ".")[1]) || g.tokenOK("garbage") {
		t.Fatal("tampered token accepted")
	}
	other := newGate("clem", "pw", []byte("other-secret"))
	if other.tokenOK(tok) {
		t.Fatal("token accepted with another secret")
	}
}

func check(t *testing.T, g *Gate, method, uri string, cookie string, basic [2]string) int {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/gate/check", nil)
	req.Header.Set("X-Original-Method", method)
	req.Header.Set("X-Original-URI", uri)
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: cookieName, Value: cookie})
	}
	if basic[0] != "" {
		req.SetBasicAuth(basic[0], basic[1])
	}
	rec := httptest.NewRecorder()
	g.handler().ServeHTTP(rec, req)
	return rec.Code
}

func TestCheck(t *testing.T) {
	open := newGate("clem", "", []byte("s"))
	if check(t, open, "GET", "/", "", [2]string{}) != 200 {
		t.Fatal("open deck must let everything through")
	}
	g := newGate("clem", "pw", []byte("s"))
	if check(t, g, "GET", "/", "", [2]string{}) != 401 {
		t.Fatal("protected path without session must be 401")
	}
	if check(t, g, "GET", "/s/abc", "", [2]string{}) != 200 {
		t.Fatal("short link must pass")
	}
	if check(t, g, "GET", "/", g.token(time.Now().Add(time.Hour)), [2]string{}) != 200 {
		t.Fatal("valid cookie refused")
	}
	if check(t, g, "GET", "/", "bad", [2]string{}) != 401 {
		t.Fatal("bad cookie accepted")
	}
	if check(t, g, "POST", "/paste/api/pastes", "", [2]string{"clem", "pw"}) != 200 {
		t.Fatal("basic auth refused")
	}
	if check(t, g, "POST", "/paste/api/pastes", "", [2]string{"clem", "nope"}) != 401 {
		t.Fatal("wrong basic auth accepted")
	}
}

func TestLoginFlow(t *testing.T) {
	g := newGate("clem", "pw", []byte("s"))
	h := g.handler()
	get := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec
	}
	post := func(form url.Values, ip string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/login", strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("X-Forwarded-For", ip)
		req.Header.Set("X-Forwarded-Proto", "https")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	if rec := get("/login?next=/pivot/"); rec.Code != 200 || !strings.Contains(rec.Body.String(), `value="/pivot/"`) || !strings.Contains(rec.Body.String(), "cyberdeck") {
		t.Fatalf("login page: %d %s", rec.Code, rec.Body.String()[:80])
	}
	if rec := get("/login?next=//evil.example"); !strings.Contains(rec.Body.String(), `value="/"`) {
		t.Fatal("open redirect not neutralised")
	}
	if rec := post(url.Values{"user": {"clem"}, "password": {"wrong"}, "next": {"/"}}, "10.0.0.1"); rec.Code != 401 || !strings.Contains(rec.Body.String(), "incorrect") {
		t.Fatalf("wrong password: %d", rec.Code)
	}
	rec := post(url.Values{"user": {"clem"}, "password": {"pw"}, "next": {"/whiteboard/"}}, "10.0.0.1")
	if rec.Code != 303 || rec.Header().Get("Location") != "/whiteboard/" {
		t.Fatalf("good login: %d %s", rec.Code, rec.Header().Get("Location"))
	}
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != cookieName || !cookies[0].HttpOnly || !cookies[0].Secure || !g.tokenOK(cookies[0].Value) {
		t.Fatalf("session cookie: %+v", cookies)
	}
	if check(t, g, "GET", "/", cookies[0].Value, [2]string{}) != 200 {
		t.Fatal("cookie from login refused by check")
	}
	// logged-in users are sent straight through the login page
	req := httptest.NewRequest(http.MethodGet, "/login?next=/json/", nil)
	req.AddCookie(cookies[0])
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, req)
	if rec2.Code != 302 || rec2.Header().Get("Location") != "/json/" {
		t.Fatalf("logged-in redirect: %d", rec2.Code)
	}
	// logout clears the cookie
	req = httptest.NewRequest(http.MethodPost, "/logout", nil)
	rec3 := httptest.NewRecorder()
	h.ServeHTTP(rec3, req)
	if rec3.Code != 303 || rec3.Result().Cookies()[0].MaxAge != -1 {
		t.Fatal("logout did not clear the cookie")
	}
	// brute force pause
	for i := 0; i < maxFails; i++ {
		post(url.Values{"user": {"clem"}, "password": {"x"}}, "10.0.0.9")
	}
	if rec := post(url.Values{"user": {"clem"}, "password": {"pw"}}, "10.0.0.9"); rec.Code != 429 {
		t.Fatalf("expected a pause after %d failures, got %d", maxFails, rec.Code)
	}
	if rec := post(url.Values{"user": {"clem"}, "password": {"pw"}}, "10.0.0.10"); rec.Code != 303 {
		t.Fatal("another IP must not be paused")
	}
}
