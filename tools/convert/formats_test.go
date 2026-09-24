package main

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTargetsNeverIncludeSelf(t *testing.T) {
	for ext := range categoryByExt {
		for _, tg := range targetsFor(ext) {
			if tg.Ext == normalizeExt(ext) {
				t.Errorf("%s offers itself", ext)
			}
			if tg.Label == "" || tg.Group == "" {
				t.Errorf("%s -> %s has no label/group", ext, tg.Ext)
			}
		}
		if len(targetsFor(ext)) == 0 {
			t.Errorf("%s has no target", ext)
		}
	}
}

func TestAliases(t *testing.T) {
	if normalizeExt(".JPEG") != "jpg" || normalizeExt("htm") != "html" || normalizeExt("markdown") != "md" {
		t.Fatal("aliases not normalised")
	}
	if c, _ := categoryOf("XLSX"); c != CatSheet {
		t.Fatalf("xlsx -> %s", c)
	}
	// pdf pages come back as images, so the label says so
	for _, tg := range targetsFor("pdf") {
		if tg.Ext == "png" && tg.Note == "" {
			t.Fatal("pdf->png should warn about zip")
		}
	}
}

func TestSafeBase(t *testing.T) {
	cases := map[string]string{
		"rapport final.docx":    "rapport final",
		"../../etc/passwd":      "passwd",
		`C:\Users\x\évil";.pdf`: "évil__",
		"":                      "fichier",
		".hidden":               ".hidden",
	}
	for in, want := range cases {
		if got := safeBase(in); got != want {
			t.Errorf("safeBase(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestUploadRejectsUnknownAndReportsTargets(t *testing.T) {
	s, err := NewServer(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	post := func(name string, content []byte) *httptest.ResponseRecorder {
		var body bytes.Buffer
		mw := multipart.NewWriter(&body)
		fw, _ := mw.CreateFormFile("file", name)
		fw.Write(content)
		mw.Close()
		req := httptest.NewRequest("POST", "/convert/api/files", &body)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		return rec
	}
	if rec := post("virus.exe", []byte("MZ")); rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("exe: %d", rec.Code)
	}
	if rec := post("empty.png", nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("empty: %d", rec.Code)
	}
	rec := post("notes.md", []byte("# hi"))
	if rec.Code != http.StatusCreated || !bytes.Contains(rec.Body.Bytes(), []byte(`"ext":"pdf"`)) {
		t.Fatalf("md: %d %s", rec.Code, rec.Body)
	}
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest("POST", "/convert/api/files/0123456789abcdef/to/pdf", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown id: %d", rec.Code)
	}
}
