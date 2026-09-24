// Convertisseur: upload a file, get every sensible output format, download.
//
// Each upload lives in its own folder under WORK_DIR for 30 minutes. External
// tools (LibreOffice, ImageMagick, Poppler, Pandoc, img2pdf, ffmpeg) do the work;
// this service only validates, dispatches and streams the result back.
package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed static/*
var staticFS embed.FS

const (
	maxUpload = 512 << 20
	keepFor   = 30 * time.Minute
)

var idRe = regexp.MustCompile(`^[a-f0-9]{16}$`)

type Server struct {
	work  string
	mux   *http.ServeMux
	sem   chan struct{} // bounds concurrent conversions
	metaM sync.Mutex
}

type Meta struct {
	Name     string    `json:"name"`
	Ext      string    `json:"ext"`
	Category Category  `json:"category"`
	Size     int64     `json:"size"`
	Created  time.Time `json:"created"`
}

func NewServer(work string) (*Server, error) {
	if err := os.MkdirAll(work, 0o755); err != nil {
		return nil, err
	}
	s := &Server{work: work, sem: make(chan struct{}, 2)}
	mux := http.NewServeMux()
	static, _ := fs.Sub(staticFS, "static")
	mux.Handle("GET /convert/", http.StripPrefix("/convert/", http.FileServer(http.FS(static))))
	mux.HandleFunc("GET /convert/api/formats", s.formats)
	mux.HandleFunc("POST /convert/api/files", s.upload)
	mux.HandleFunc("GET /convert/api/files/{id}", s.info)
	mux.HandleFunc("POST /convert/api/files/{id}/to/{target}", s.convert)
	mux.HandleFunc("DELETE /convert/api/files/{id}", s.remove)
	s.mux = mux
	return s, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (s *Server) formats(w http.ResponseWriter, r *http.Request) {
	type entry struct {
		Category Category `json:"category"`
		Targets  []Target `json:"targets"`
	}
	out := map[string]entry{}
	for ext, cat := range categoryByExt {
		out[ext] = entry{Category: cat, Targets: targetsFor(ext)}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) dir(id string) string { return filepath.Join(s.work, id) }

func (s *Server) readMeta(id string) (*Meta, error) {
	if !idRe.MatchString(id) {
		return nil, errors.New("invalid id")
	}
	data, err := os.ReadFile(filepath.Join(s.dir(id), "meta.json"))
	if err != nil {
		return nil, errors.New("fichier inconnu ou expiré : renvoie-le")
	}
	var m Meta
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload)
	mr, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "multipart attendu")
		return
	}
	var part io.Reader
	var name string
	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if p.FormName() == "file" {
			part, name = p, p.FileName()
			break
		}
	}
	if part == nil {
		writeError(w, http.StatusBadRequest, "champ 'file' manquant")
		return
	}
	ext := normalizeExt(filepath.Ext(name))
	cat, ok := categoryOf(ext)
	if !ok {
		writeError(w, http.StatusUnsupportedMediaType, "extension ."+ext+" non prise en charge (pour l'instant)")
		return
	}
	buf := make([]byte, 8)
	_, _ = rand.Read(buf)
	id := hex.EncodeToString(buf)
	dir := s.dir(id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	dst, err := os.Create(filepath.Join(dir, "input."+ext))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	n, err := io.Copy(dst, part)
	dst.Close()
	if err != nil {
		_ = os.RemoveAll(dir)
		writeError(w, http.StatusRequestEntityTooLarge, "fichier trop gros (512 Mo max) ou transfert interrompu")
		return
	}
	if n == 0 {
		_ = os.RemoveAll(dir)
		writeError(w, http.StatusBadRequest, "fichier vide")
		return
	}
	m := Meta{Name: safeBase(name), Ext: ext, Category: cat, Size: n, Created: time.Now()}
	data, _ := json.Marshal(m)
	_ = os.WriteFile(filepath.Join(dir, "meta.json"), data, 0o600)
	writeJSON(w, http.StatusCreated, map[string]any{
		"id": id, "name": m.Name, "ext": ext, "category": cat, "size": n, "targets": targetsFor(ext),
	})
}

func (s *Server) info(w http.ResponseWriter, r *http.Request) {
	m, err := s.readMeta(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": r.PathValue("id"), "name": m.Name, "ext": m.Ext, "category": m.Category, "size": m.Size, "targets": targetsFor(m.Ext)})
}

func (s *Server) convert(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	m, err := s.readMeta(id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	target := strings.ToLower(r.PathValue("target"))
	if _, known := labels[target]; !known {
		writeError(w, http.StatusBadRequest, "format cible inconnu")
		return
	}
	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	case <-time.After(2 * time.Minute):
		writeError(w, http.StatusServiceUnavailable, "trop de conversions en cours, réessaie dans un instant")
		return
	}
	jobDir := filepath.Join(s.dir(id), "job-"+target+"-"+strconv.FormatInt(time.Now().UnixNano(), 36))
	if err := os.MkdirAll(jobDir, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer os.RemoveAll(jobDir)
	// LibreOffice names its output after the input file: give it a readable name.
	in := filepath.Join(jobDir, m.Name+"."+m.Ext)
	if err := os.Link(filepath.Join(s.dir(id), "input."+m.Ext), in); err != nil {
		if err := copyFile(filepath.Join(s.dir(id), "input."+m.Ext), in); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	start := time.Now()
	out, err := convertFile(r.Context(), jobDir, in, target, m.Name)
	if err != nil {
		log.Printf("convert: %s.%s -> %s failed: %v", m.Name, m.Ext, target, err)
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	f, err := os.Open(out)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer f.Close()
	st, _ := f.Stat()
	outExt := strings.TrimPrefix(filepath.Ext(out), ".")
	ctype := mime.TypeByExtension("." + outExt)
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	log.Printf("convert: %s.%s -> %s (%d bytes, %s)", m.Name, m.Ext, outExt, st.Size(), time.Since(start).Round(time.Millisecond))
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Length", strconv.FormatInt(st.Size(), 10))
	w.Header().Set("Content-Disposition", `attachment; filename="`+m.Name+"."+outExt+`"; filename*=UTF-8''`+urlEscape(m.Name+"."+outExt))
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.Copy(w, f)
}

func urlEscape(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '-' || c == '_' {
			b.WriteByte(c)
		} else {
			b.WriteString("%" + strings.ToUpper(hex.EncodeToString([]byte{c})))
		}
	}
	return b.String()
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func (s *Server) remove(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !idRe.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	_ = os.RemoveAll(s.dir(id))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) sweep() {
	entries, err := os.ReadDir(s.work)
	if err != nil {
		return
	}
	for _, e := range entries {
		info, err := e.Info()
		if err == nil && time.Since(info.ModTime()) > keepFor {
			_ = os.RemoveAll(filepath.Join(s.work, e.Name()))
		}
	}
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	work := env("WORK_DIR", "./work")
	listen := env("LISTEN", "127.0.0.1:8104")
	_ = os.MkdirAll(env("HOME", "/tmp"), 0o755)
	srv, err := NewServer(work)
	if err != nil {
		log.Fatalf("convert: %v", err)
	}
	go func() {
		for range time.Tick(5 * time.Minute) {
			srv.sweep()
		}
	}()
	log.Printf("convert: listening on %s, work dir %s", listen, work)
	log.Fatal(http.ListenAndServe(listen, srv))
}

var _ = context.Background
