package main

import (
	"sort"
	"strings"
)

// Category groups input formats that share the same conversion tools.
type Category string

const (
	CatImage    Category = "image"
	CatPDF      Category = "pdf"
	CatDoc      Category = "document"
	CatHTML     Category = "html"
	CatMarkdown Category = "markdown"
	CatSheet    Category = "spreadsheet"
	CatSlides   Category = "presentation"
	CatAudio    Category = "audio"
	CatVideo    Category = "video"
)

var categoryByExt = map[string]Category{}

func init() {
	add := func(cat Category, exts ...string) {
		for _, e := range exts {
			categoryByExt[e] = cat
		}
	}
	add(CatImage, "png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff", "ico", "heic", "heif", "avif", "svg")
	add(CatPDF, "pdf")
	add(CatDoc, "doc", "docx", "odt", "rtf", "txt")
	add(CatHTML, "html", "htm")
	add(CatMarkdown, "md", "markdown")
	add(CatSheet, "xls", "xlsx", "ods", "csv", "tsv")
	add(CatSlides, "ppt", "pptx", "odp")
	add(CatAudio, "mp3", "wav", "flac", "ogg", "m4a", "aac", "opus", "wma", "aiff")
	add(CatVideo, "mp4", "mkv", "mov", "avi", "webm", "m4v", "mpg", "mpeg", "wmv", "flv")
}

// Target is one output the UI can offer. Group is the heading it sits under.
type Target struct {
	Ext   string `json:"ext"`
	Label string `json:"label"`
	Group string `json:"group"`
	Note  string `json:"note,omitempty"`
}

var labels = map[string]Target{
	"png":  {Ext: "png", Label: "PNG", Group: "Image"},
	"jpg":  {Ext: "jpg", Label: "JPEG", Group: "Image", Note: "fond blanc si transparence"},
	"webp": {Ext: "webp", Label: "WebP", Group: "Image"},
	"gif":  {Ext: "gif", Label: "GIF", Group: "Image"},
	"bmp":  {Ext: "bmp", Label: "BMP", Group: "Image"},
	"tiff": {Ext: "tiff", Label: "TIFF", Group: "Image"},
	"ico":  {Ext: "ico", Label: "ICO", Group: "Image", Note: "icône multi-tailles jusqu'à 256 px"},
	"pdf":  {Ext: "pdf", Label: "PDF", Group: "Document"},
	"docx": {Ext: "docx", Label: "Word (docx)", Group: "Document"},
	"doc":  {Ext: "doc", Label: "Word 97 (doc)", Group: "Document"},
	"odt":  {Ext: "odt", Label: "OpenDocument (odt)", Group: "Document"},
	"rtf":  {Ext: "rtf", Label: "RTF", Group: "Document"},
	"txt":  {Ext: "txt", Label: "Texte brut", Group: "Document"},
	"html": {Ext: "html", Label: "HTML", Group: "Document"},
	"md":   {Ext: "md", Label: "Markdown", Group: "Document"},
	"epub": {Ext: "epub", Label: "EPUB", Group: "Document"},
	"xlsx": {Ext: "xlsx", Label: "Excel (xlsx)", Group: "Tableur"},
	"xls":  {Ext: "xls", Label: "Excel 97 (xls)", Group: "Tableur"},
	"ods":  {Ext: "ods", Label: "OpenDocument (ods)", Group: "Tableur"},
	"csv":  {Ext: "csv", Label: "CSV", Group: "Tableur", Note: "première feuille"},
	"pptx": {Ext: "pptx", Label: "PowerPoint (pptx)", Group: "Présentation"},
	"odp":  {Ext: "odp", Label: "OpenDocument (odp)", Group: "Présentation"},
	"mp3":  {Ext: "mp3", Label: "MP3", Group: "Audio"},
	"wav":  {Ext: "wav", Label: "WAV", Group: "Audio"},
	"flac": {Ext: "flac", Label: "FLAC", Group: "Audio"},
	"ogg":  {Ext: "ogg", Label: "OGG Vorbis", Group: "Audio"},
	"m4a":  {Ext: "m4a", Label: "M4A (AAC)", Group: "Audio"},
	"opus": {Ext: "opus", Label: "Opus", Group: "Audio"},
	"mp4":  {Ext: "mp4", Label: "MP4 (H.264)", Group: "Vidéo"},
	"webm": {Ext: "webm", Label: "WebM", Group: "Vidéo"},
	"mkv":  {Ext: "mkv", Label: "MKV", Group: "Vidéo", Note: "sans ré-encodage"},
	"mov":  {Ext: "mov", Label: "MOV", Group: "Vidéo"},
	"gifv": {Ext: "gif", Label: "GIF animé", Group: "Vidéo", Note: "20 premières secondes, 480 px"},
}

// pages* targets render each page/slide as an image; several pages come back zipped.
var pageTargets = map[string]Target{
	"png": {Ext: "png", Label: "PNG par page", Group: "Image", Note: "zip si plusieurs pages"},
	"jpg": {Ext: "jpg", Label: "JPEG par page", Group: "Image", Note: "zip si plusieurs pages"},
}

var targetsByCategory = map[Category][]string{
	CatImage:    {"png", "jpg", "webp", "gif", "bmp", "tiff", "ico", "pdf"},
	CatPDF:      {"docx", "odt", "txt", "html", "png", "jpg"},
	CatDoc:      {"pdf", "docx", "odt", "doc", "rtf", "txt", "html", "md", "epub"},
	CatHTML:     {"pdf", "docx", "odt", "txt", "md"},
	CatMarkdown: {"pdf", "html", "docx", "odt", "epub"},
	CatSheet:    {"pdf", "xlsx", "xls", "ods", "csv", "html"},
	CatSlides:   {"pdf", "pptx", "odp", "png", "jpg"},
	CatAudio:    {"mp3", "wav", "flac", "ogg", "m4a", "opus"},
	CatVideo:    {"mp4", "webm", "mkv", "mov", "gifv", "mp3", "wav"},
}

// normalizeExt maps aliases onto the canonical extension used everywhere else.
func normalizeExt(ext string) string {
	ext = strings.ToLower(strings.TrimPrefix(ext, "."))
	switch ext {
	case "jpeg":
		return "jpg"
	case "tif":
		return "tiff"
	case "htm":
		return "html"
	case "markdown":
		return "md"
	case "heif":
		return "heic"
	case "mpeg":
		return "mpg"
	}
	return ext
}

func categoryOf(ext string) (Category, bool) {
	c, ok := categoryByExt[normalizeExt(ext)]
	return c, ok
}

// targetsFor lists what a file of this extension can become, never itself.
func targetsFor(ext string) []Target {
	ext = normalizeExt(ext)
	cat, ok := categoryOf(ext)
	if !ok {
		return nil
	}
	var out []Target
	for _, key := range targetsByCategory[cat] {
		t := labels[key]
		if (cat == CatPDF || cat == CatSlides) && (key == "png" || key == "jpg") {
			t = pageTargets[key]
		}
		if t.Ext == ext {
			continue
		}
		out = append(out, t)
	}
	order := map[string]int{"Document": 0, "Tableur": 1, "Présentation": 2, "Image": 3, "Audio": 4, "Vidéo": 5}
	sort.SliceStable(out, func(i, j int) bool { return order[out[i].Group] < order[out[j].Group] })
	return out
}

// safeBase keeps a filename readable in Content-Disposition without letting
// path or header characters through.
func safeBase(name string) string {
	name = strings.TrimSpace(name)
	if i := strings.LastIndexAny(name, "/\\"); i >= 0 {
		name = name[i+1:]
	}
	if i := strings.LastIndex(name, "."); i > 0 {
		name = name[:i]
	}
	var b strings.Builder
	for _, r := range name {
		switch {
		case r == '"' || r == ';' || r < 0x20 || r == 0x7f:
			b.WriteRune('_')
		default:
			b.WriteRune(r)
		}
	}
	s := b.String()
	if s == "" {
		s = "fichier"
	}
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}
