// Gate: the deck's front door. nginx asks it, through auth_request, whether a
// request may pass; it serves the login page, signs a session cookie and
// decides which paths stay public (short links, reading a paste, health…).
//
// Without APP_PASSWORD everything is open, exactly as before.
package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"html/template"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed login.html
var loginFS embed.FS

const (
	cookieName = "deck_session"
	sessionTTL = 30 * 24 * time.Hour
	maxFails   = 6 // failed logins per IP per minute before a pause
)

var (
	pasteRead = regexp.MustCompile(`^/paste/api/pastes/[A-Za-z0-9]{3,16}(/raw|/qr\.png)?$`)
	shortLink = regexp.MustCompile(`^/s/[A-Za-z0-9_-]{2,32}$`)
	pasteCode = regexp.MustCompile(`^/p/[A-Za-z0-9]{3,16}$`)
)

// public says whether a request may pass without a session. Kept in one place
// so the rule is readable and tested: nginx only forwards method and URI.
func public(method, uri string) bool {
	path := uri
	if i := strings.IndexAny(path, "?#"); i >= 0 {
		path = path[:i]
	}
	switch path {
	case "/login", "/logout", "/gate/status":
		return true
	}
	if method != http.MethodGet && method != http.MethodHead {
		return false
	}
	switch path {
	case "/health", "/theme.css", "/deck.js", "/favicon.svg", "/paste/", "/paste/index.html", "/paste/app.js", "/paste/app.css":
		return true
	}
	return shortLink.MatchString(path) || pasteCode.MatchString(path) || pasteRead.MatchString(path)
}

type Gate struct {
	user, password string
	secret         []byte
	tmpl           *template.Template
	mu             sync.Mutex
	fails          map[string][]time.Time
}

func newGate(user, password string, secret []byte) *Gate {
	t := template.Must(template.ParseFS(loginFS, "login.html"))
	return &Gate{user: user, password: password, secret: secret, tmpl: t, fails: map[string][]time.Time{}}
}

func (g *Gate) enabled() bool { return g.password != "" }

func (g *Gate) credentialsOK(user, password string) bool {
	u := subtle.ConstantTimeCompare(hashOf(user), hashOf(g.user))
	p := subtle.ConstantTimeCompare(hashOf(password), hashOf(g.password))
	return u == 1 && p == 1
}

func hashOf(s string) []byte { h := sha256.Sum256([]byte(s)); return h[:] }

// token is "<expiry unix>.<hmac>" — no user data inside, one account only.
func (g *Gate) token(expiry time.Time) string {
	exp := strconv.FormatInt(expiry.Unix(), 10)
	return exp + "." + g.sign(exp)
}

func (g *Gate) sign(payload string) string {
	m := hmac.New(sha256.New, g.secret)
	m.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (g *Gate) tokenOK(tok string) bool {
	exp, sig, found := strings.Cut(tok, ".")
	if !found || !hmac.Equal([]byte(sig), []byte(g.sign(exp))) {
		return false
	}
	n, err := strconv.ParseInt(exp, 10, 64)
	return err == nil && time.Now().Unix() < n
}

func (g *Gate) sessionOK(r *http.Request) bool {
	if c, err := r.Cookie(cookieName); err == nil && g.tokenOK(c.Value) {
		return true
	}
	if u, p, ok := r.BasicAuth(); ok && g.credentialsOK(u, p) {
		return true
	}
	return false
}

func clientIP(r *http.Request) string {
	if f := r.Header.Get("X-Forwarded-For"); f != "" {
		return strings.TrimSpace(strings.Split(f, ",")[0])
	}
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return h
}

func (g *Gate) tooManyFails(ip string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now()
	keep := g.fails[ip][:0]
	for _, t := range g.fails[ip] {
		if now.Sub(t) < time.Minute {
			keep = append(keep, t)
		}
	}
	g.fails[ip] = keep
	return len(keep) >= maxFails
}

func (g *Gate) noteFail(ip string) {
	g.mu.Lock()
	g.fails[ip] = append(g.fails[ip], time.Now())
	g.mu.Unlock()
}

func secure(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") || r.TLS != nil
}

func safeNext(next string) string {
	if next == "" || !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") || strings.HasPrefix(next, "/login") {
		return "/"
	}
	return next
}

// ---------------------------------------------------------------- handlers

func (g *Gate) check(w http.ResponseWriter, r *http.Request) {
	if !g.enabled() || public(r.Header.Get("X-Original-Method"), r.Header.Get("X-Original-URI")) || g.sessionOK(r) {
		w.WriteHeader(http.StatusOK)
		return
	}
	w.WriteHeader(http.StatusUnauthorized)
}

func (g *Gate) status(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{"auth": g.enabled(), "logged_in": !g.enabled() || g.sessionOK(r), "user": g.user})
}

func (g *Gate) render(w http.ResponseWriter, status int, next, errMsg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	g.tmpl.Execute(w, map[string]string{"Next": next, "Error": errMsg})
}

func (g *Gate) login(w http.ResponseWriter, r *http.Request) {
	if !g.enabled() {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	switch r.Method {
	case http.MethodGet:
		next := safeNext(r.URL.Query().Get("next"))
		if g.sessionOK(r) {
			http.Redirect(w, r, next, http.StatusFound)
			return
		}
		g.render(w, http.StatusOK, next, "")
	case http.MethodPost:
		if err := r.ParseForm(); err != nil {
			g.render(w, http.StatusBadRequest, "/", "formulaire illisible")
			return
		}
		next := safeNext(r.PostFormValue("next"))
		ip := clientIP(r)
		if g.tooManyFails(ip) {
			g.render(w, http.StatusTooManyRequests, next, "Trop d'essais. Attends une minute.")
			return
		}
		if !g.credentialsOK(r.PostFormValue("user"), r.PostFormValue("password")) {
			g.noteFail(ip)
			log.Printf("gate: refused login from %s", ip)
			g.render(w, http.StatusUnauthorized, next, "Identifiant ou mot de passe incorrect.")
			return
		}
		http.SetCookie(w, &http.Cookie{Name: cookieName, Value: g.token(time.Now().Add(sessionTTL)), Path: "/", HttpOnly: true, Secure: secure(r), SameSite: http.SameSiteLaxMode, MaxAge: int(sessionTTL.Seconds())})
		log.Printf("gate: login from %s", ip)
		http.Redirect(w, r, next, http.StatusSeeOther)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (g *Gate) logout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", HttpOnly: true, Secure: secure(r), SameSite: http.SameSiteLaxMode, MaxAge: -1})
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}

func (g *Gate) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/gate/check", g.check)
	mux.HandleFunc("/gate/status", g.status)
	mux.HandleFunc("/login", g.login)
	mux.HandleFunc("/logout", g.logout)
	return mux
}

// loadSecret keeps sessions valid across restarts: SESSION_SECRET if given,
// else a random secret persisted under DATA_DIR.
func loadSecret(dataDir string) []byte {
	if s := os.Getenv("SESSION_SECRET"); s != "" {
		return []byte(s)
	}
	path := filepath.Join(dataDir, "secret")
	if b, err := os.ReadFile(path); err == nil && len(b) >= 32 {
		return b
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		log.Fatal(err)
	}
	b := []byte(hex.EncodeToString(raw))
	os.MkdirAll(dataDir, 0o700)
	if err := os.WriteFile(path, b, 0o600); err != nil {
		log.Printf("gate: cannot persist secret (%v): sessions will not survive a restart", err)
	}
	return b
}

func main() {
	user := os.Getenv("APP_USER")
	if user == "" {
		user = "toolbox"
	}
	password := os.Getenv("APP_PASSWORD")
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8100"
	}
	g := newGate(user, password, loadSecret(dataDir))
	if g.enabled() {
		log.Printf("gate: login required (user %q), listening on %s", user, port)
	} else {
		log.Printf("gate: APP_PASSWORD unset, deck is open; listening on %s", port)
	}
	log.Fatal(http.ListenAndServe("127.0.0.1:"+port, g.handler()))
}
