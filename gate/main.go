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
//
// Open to everyone: the shell itself (home page and manifest), the tools
// flagged "public" in their tool.json, short links, reading a paste, health.
func (g *Gate) public(method, uri string) bool {
	path := uri
	if i := strings.IndexAny(path, "?#"); i >= 0 {
		path = path[:i]
	}
	switch path {
	case "/login", "/logout", "/gate/status":
		return true
	}
	for _, prefix := range g.publicPrefixes {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	if method != http.MethodGet && method != http.MethodHead {
		return false
	}
	switch path {
	case "/", "/index.html", "/app.js", "/app.css", "/tools.json", "/health", "/theme.css", "/deck.js", "/favicon.svg",
		"/paste/", "/paste/index.html", "/paste/app.js", "/paste/app.css":
		return true
	}
	return shortLink.MatchString(path) || pasteCode.MatchString(path) || pasteRead.MatchString(path)
}

// loadPublicTools reads the shell manifest and returns the paths of the tools
// flagged "public": true in their tool.json (e.g. /paste/, /links/).
func loadPublicTools(manifest string) []string {
	raw, err := os.ReadFile(manifest)
	if err != nil {
		log.Printf("gate: no manifest at %s (%v): only the built-in public paths apply", manifest, err)
		return nil
	}
	var tools []struct {
		ID     string `json:"id"`
		Path   string `json:"path"`
		Public bool   `json:"public"`
	}
	if err := json.Unmarshal(raw, &tools); err != nil {
		log.Printf("gate: unreadable manifest %s: %v", manifest, err)
		return nil
	}
	var out []string
	for _, t := range tools {
		if t.Public && strings.HasPrefix(t.Path, "/") && len(t.Path) > 1 {
			p := t.Path
			if !strings.HasSuffix(p, "/") {
				p += "/"
			}
			out = append(out, p)
		}
	}
	return out
}

type Gate struct {
	accounts       map[string]string // user -> password
	admin          string            // the main account (APP_USER): full rights in the tools
	secret         []byte
	publicPrefixes []string
	tmpl           *template.Template
	mu             sync.Mutex
	fails          map[string][]time.Time
}

func newGate(accounts map[string]string, admin string, secret []byte, publicPrefixes []string) *Gate {
	t := template.Must(template.ParseFS(loginFS, "login.html"))
	if accounts == nil {
		accounts = map[string]string{}
	}
	return &Gate{accounts: accounts, admin: admin, secret: secret, publicPrefixes: publicPrefixes, tmpl: t, fails: map[string][]time.Time{}}
}

// role is what the tools get: "admin" for the main account, "user" for the
// others, "anon" for a visitor on a public tool, "" when the deck is open
// (no login at all, so no distinction).
func (g *Gate) role(user string) string {
	switch {
	case !g.enabled():
		return ""
	case user != "" && user == g.admin:
		return "admin"
	case user != "":
		return "user"
	}
	return "anon"
}

// parseAccounts builds the account list from APP_USER/APP_PASSWORD plus
// APP_USERS ("alice:secret,bob:other"). Entries without a password are dropped.
func parseAccounts(user, password, extra string) map[string]string {
	out := map[string]string{}
	if password != "" {
		if user == "" {
			user = "toolbox"
		}
		out[user] = password
	}
	for _, pair := range strings.Split(extra, ",") {
		u, p, ok := strings.Cut(strings.TrimSpace(pair), ":")
		u, p = strings.TrimSpace(u), strings.TrimSpace(p)
		if ok && u != "" && p != "" {
			out[u] = p
		}
	}
	return out
}

func (g *Gate) enabled() bool { return len(g.accounts) > 0 }

// credentialsOK compares against every account so timing does not reveal
// which identifiers exist.
func (g *Gate) credentialsOK(user, password string) bool {
	found := 0
	for u, p := range g.accounts {
		uOK := subtle.ConstantTimeCompare(hashOf(user), hashOf(u))
		pOK := subtle.ConstantTimeCompare(hashOf(password), hashOf(p))
		found |= uOK & pOK
	}
	return found == 1
}

func hashOf(s string) []byte { h := sha256.Sum256([]byte(s)); return h[:] }

// token is "<user b64>.<expiry unix>.<hmac>": the user is only there to be
// shown in the shell, the signature is what grants access.
func (g *Gate) token(user string, expiry time.Time) string {
	payload := base64.RawURLEncoding.EncodeToString([]byte(user)) + "." + strconv.FormatInt(expiry.Unix(), 10)
	return payload + "." + g.sign(payload)
}

func (g *Gate) sign(payload string) string {
	m := hmac.New(sha256.New, g.secret)
	m.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// tokenUser returns the user of a valid token, or "" when it is not valid.
func (g *Gate) tokenUser(tok string) string {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return ""
	}
	payload := parts[0] + "." + parts[1]
	if !hmac.Equal([]byte(parts[2]), []byte(g.sign(payload))) {
		return ""
	}
	n, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || time.Now().Unix() >= n {
		return ""
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return ""
	}
	if _, known := g.accounts[string(raw)]; !known {
		return "" // account removed since the cookie was issued
	}
	return string(raw)
}

func (g *Gate) tokenOK(tok string) bool { return g.tokenUser(tok) != "" }

// sessionUser returns who is asking: cookie first, then Basic auth for scripts.
func (g *Gate) sessionUser(r *http.Request) string {
	if c, err := r.Cookie(cookieName); err == nil {
		if u := g.tokenUser(c.Value); u != "" {
			return u
		}
	}
	if u, p, ok := r.BasicAuth(); ok && g.credentialsOK(u, p) {
		return u
	}
	return ""
}

func (g *Gate) sessionOK(r *http.Request) bool { return g.sessionUser(r) != "" }

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
	user := g.sessionUser(r)
	if !g.enabled() || user != "" || g.public(r.Header.Get("X-Original-Method"), r.Header.Get("X-Original-URI")) {
		// nginx copies these into X-Deck-User / X-Deck-Role for the tools.
		w.Header().Set("X-Deck-User", user)
		w.Header().Set("X-Deck-Role", g.role(user))
		w.WriteHeader(http.StatusOK)
		return
	}
	w.WriteHeader(http.StatusUnauthorized)
}

func (g *Gate) status(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	user := g.sessionUser(r)
	json.NewEncoder(w).Encode(map[string]any{"auth": g.enabled(), "logged_in": !g.enabled() || user != "", "user": user, "role": g.role(user), "public": g.publicPrefixes})
}

func wantsJSON(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept"), "application/json")
}

// render answers the standalone page, or JSON when the shell's modal asks.
func (g *Gate) render(w http.ResponseWriter, r *http.Request, status int, next, errMsg string) {
	w.Header().Set("Cache-Control", "no-store")
	if wantsJSON(r) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if errMsg != "" {
			json.NewEncoder(w).Encode(map[string]string{"error": errMsg})
		} else {
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "user": r.PostFormValue("user")})
		}
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
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
		g.render(w, r, http.StatusOK, next, "")
	case http.MethodPost:
		if err := r.ParseForm(); err != nil {
			g.render(w, r, http.StatusBadRequest, "/", "formulaire illisible")
			return
		}
		next := safeNext(r.PostFormValue("next"))
		ip := clientIP(r)
		if g.tooManyFails(ip) {
			g.render(w, r, http.StatusTooManyRequests, next, "Trop d'essais. Attends une minute.")
			return
		}
		user := r.PostFormValue("user")
		if !g.credentialsOK(user, r.PostFormValue("password")) {
			g.noteFail(ip)
			log.Printf("gate: refused login from %s", ip)
			g.render(w, r, http.StatusUnauthorized, next, "Identifiant ou mot de passe incorrect.")
			return
		}
		http.SetCookie(w, &http.Cookie{Name: cookieName, Value: g.token(user, time.Now().Add(sessionTTL)), Path: "/", HttpOnly: true, Secure: secure(r), SameSite: http.SameSiteLaxMode, MaxAge: int(sessionTTL.Seconds())})
		log.Printf("gate: login of %q from %s", user, ip)
		if wantsJSON(r) {
			g.render(w, r, http.StatusOK, next, "")
			return
		}
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
	admin := os.Getenv("APP_USER")
	if admin == "" {
		admin = "toolbox"
	}
	accounts := parseAccounts(admin, os.Getenv("APP_PASSWORD"), os.Getenv("APP_USERS"))
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8100"
	}
	manifest := os.Getenv("TOOLS_MANIFEST")
	if manifest == "" {
		manifest = "/app/shell/tools.json"
	}
	g := newGate(accounts, admin, loadSecret(dataDir), loadPublicTools(manifest))
	log.Printf("gate: public tools: %v", g.publicPrefixes)
	if g.enabled() {
		names := make([]string, 0, len(accounts))
		for u := range accounts {
			names = append(names, u)
		}
		log.Printf("gate: login required (accounts %v), listening on %s", names, port)
	} else {
		log.Printf("gate: APP_PASSWORD unset, deck is open; listening on %s", port)
	}
	log.Fatal(http.ListenAndServe("127.0.0.1:"+port, g.handler()))
}
