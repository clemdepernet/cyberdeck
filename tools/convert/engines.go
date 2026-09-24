package main

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// LibreOffice does not like two headless instances sharing a profile: serialise it.
var sofficeMu sync.Mutex

const convertTimeout = 8 * time.Minute

func run(ctx context.Context, dir string, name string, args ...string) error {
	ctx, cancel := context.WithTimeout(ctx, convertTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "LC_ALL=C.UTF-8")
	out, err := cmd.CombinedOutput()
	if err != nil {
		tail := strings.TrimSpace(string(out))
		if len(tail) > 600 {
			tail = "…" + tail[len(tail)-600:]
		}
		if ctx.Err() != nil {
			return fmt.Errorf("%s: délai dépassé", name)
		}
		return fmt.Errorf("%s: %v\n%s", name, err, tail)
	}
	return nil
}

// soffice converts `in` to `ext` inside dir and returns the produced path.
func soffice(ctx context.Context, dir, in, ext string, extra ...string) (string, error) {
	sofficeMu.Lock()
	defer sofficeMu.Unlock()
	profile := filepath.Join(os.Getenv("HOME"), "lo-profile")
	_ = os.MkdirAll(profile, 0o755)
	args := []string{"--headless", "--norestore", "--nolockcheck", "-env:UserInstallation=file://" + profile}
	args = append(args, extra...)
	args = append(args, "--convert-to", ext, "--outdir", dir, in)
	if err := run(ctx, dir, "soffice", args...); err != nil {
		return "", err
	}
	want := strings.TrimSuffix(filepath.Base(in), filepath.Ext(in)) + "." + strings.SplitN(ext, ":", 2)[0]
	out := filepath.Join(dir, want)
	if _, err := os.Stat(out); err != nil {
		return "", errors.New("LibreOffice n'a rien produit : format d'entrée non reconnu ?")
	}
	return out, nil
}

func imagemagick(ctx context.Context, dir, in, ext string) (string, error) {
	out := filepath.Join(dir, "output."+ext)
	src := in
	switch ext {
	case "png", "jpg", "webp", "bmp", "ico":
		src = in + "[0]" // first frame of animated/multi-page inputs
	}
	args := []string{src}
	switch ext {
	case "jpg", "bmp":
		args = append(args, "-background", "white", "-alpha", "remove", "-alpha", "off", "-quality", "92")
	case "webp":
		args = append(args, "-quality", "90")
	case "ico":
		args = append(args, "-resize", "256x256>", "-define", "icon:auto-resize=256,128,64,48,32,16")
	}
	args = append(args, out)
	if err := run(ctx, dir, "convert", args...); err != nil {
		return "", err
	}
	return out, nil
}

func imageToPDF(ctx context.Context, dir, in string) (string, error) {
	out := filepath.Join(dir, "output.pdf")
	// img2pdf embeds losslessly; SVG/ICO/HEIC need rasterising first.
	src := in
	switch normalizeExt(filepath.Ext(in)) {
	case "svg", "ico", "heic", "avif", "gif", "bmp":
		var err error
		if src, err = imagemagick(ctx, dir, in, "png"); err != nil {
			return "", err
		}
	}
	if err := run(ctx, dir, "img2pdf", "--output", out, src); err != nil {
		return "", err
	}
	return out, nil
}

// pdfToImages renders every page; one page returns the image, more return a zip.
func pdfToImages(ctx context.Context, dir, in, ext, base string) (string, error) {
	pages := filepath.Join(dir, "pages")
	_ = os.MkdirAll(pages, 0o755)
	flag := "-png"
	if ext == "jpg" {
		flag = "-jpeg"
	}
	if err := run(ctx, dir, "pdftoppm", "-r", "150", flag, in, filepath.Join(pages, "page")); err != nil {
		return "", err
	}
	files, _ := filepath.Glob(filepath.Join(pages, "page*"))
	sort.Strings(files)
	if len(files) == 0 {
		return "", errors.New("aucune page rendue")
	}
	if len(files) == 1 {
		out := filepath.Join(dir, "output."+ext)
		return out, os.Rename(files[0], out)
	}
	out := filepath.Join(dir, "output.zip")
	return out, zipFiles(out, base, files)
}

func zipFiles(out, prefix string, files []string) error {
	f, err := os.Create(out)
	if err != nil {
		return err
	}
	defer f.Close()
	w := zip.NewWriter(f)
	for _, p := range files {
		src, err := os.Open(p)
		if err != nil {
			return err
		}
		dst, err := w.Create(prefix + "-" + filepath.Base(p))
		if err == nil {
			_, err = io.Copy(dst, src)
		}
		src.Close()
		if err != nil {
			return err
		}
	}
	return w.Close()
}

func pandoc(ctx context.Context, dir, in, ext string) (string, error) {
	out := filepath.Join(dir, "output."+ext)
	args := []string{in, "-o", out}
	if ext == "html" {
		args = append(args, "--standalone", "--metadata", "title="+strings.TrimSuffix(filepath.Base(in), filepath.Ext(in)))
	}
	if ext == "md" {
		args = append(args, "-t", "gfm", "--wrap=none")
	}
	if err := run(ctx, dir, "pandoc", args...); err != nil {
		return "", err
	}
	return out, nil
}

func ffmpeg(ctx context.Context, dir, in, target string) (string, error) {
	ext := target
	if target == "gifv" {
		ext = "gif"
	}
	out := filepath.Join(dir, "output."+ext)
	args := []string{"-y", "-hide_banner", "-loglevel", "error", "-i", in}
	switch target {
	case "mp3":
		args = append(args, "-vn", "-c:a", "libmp3lame", "-q:a", "2")
	case "wav", "flac":
		args = append(args, "-vn")
	case "ogg":
		args = append(args, "-vn", "-c:a", "libvorbis", "-q:a", "5")
	case "m4a":
		args = append(args, "-vn", "-c:a", "aac", "-b:a", "192k")
	case "opus":
		args = append(args, "-vn", "-c:a", "libopus", "-b:a", "128k")
	case "mp4":
		args = append(args, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart")
	case "mov":
		args = append(args, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac")
	case "webm":
		args = append(args, "-c:v", "libvpx", "-crf", "10", "-b:v", "1500k", "-cpu-used", "4", "-c:a", "libvorbis")
	case "mkv":
		args = append(args, "-c", "copy")
	case "gifv":
		args = append(args, "-t", "20", "-vf", "fps=10,scale=480:-1:flags=lanczos", "-loop", "0")
	default:
		return "", fmt.Errorf("cible audio/vidéo inconnue: %s", target)
	}
	args = append(args, out)
	if err := run(ctx, dir, "ffmpeg", args...); err != nil {
		if strings.Contains(err.Error(), "does not contain any stream") {
			return "", errors.New("ce fichier n'a pas de piste audio à extraire")
		}
		return "", err
	}
	return out, nil
}

// convertFile dispatches on (category, target) and returns the produced file path.
func convertFile(ctx context.Context, dir, in, target, base string) (string, error) {
	srcExt := normalizeExt(filepath.Ext(in))
	cat, ok := categoryOf(srcExt)
	if !ok {
		return "", errors.New("format d'entrée non pris en charge")
	}
	allowed := false
	for _, t := range targetsByCategory[cat] {
		if t == target {
			allowed = true
		}
	}
	if !allowed || target == srcExt {
		return "", errors.New("cette conversion n'est pas proposée pour ce fichier")
	}

	switch cat {
	case CatImage:
		if target == "pdf" {
			return imageToPDF(ctx, dir, in)
		}
		return imagemagick(ctx, dir, in, target)

	case CatPDF:
		switch target {
		case "png", "jpg":
			return pdfToImages(ctx, dir, in, target, base)
		case "txt":
			out := filepath.Join(dir, "output.txt")
			return out, run(ctx, dir, "pdftotext", "-layout", in, out)
		case "html":
			out := filepath.Join(dir, "output.html")
			return out, run(ctx, dir, "pdftohtml", "-s", "-i", "-noframes", in, strings.TrimSuffix(out, ".html"))
		default: // docx, odt
			return soffice(ctx, dir, in, target, "--infilter=writer_pdf_import")
		}

	case CatDoc, CatHTML:
		if target == "md" {
			src := in
			if srcExt == "doc" || srcExt == "rtf" || srcExt == "txt" { // pandoc reads docx/odt/html, not the legacy ones
				var err error
				if src, err = soffice(ctx, dir, in, "docx"); err != nil {
					return "", err
				}
			}
			return pandoc(ctx, dir, src, "md")
		}
		if target == "txt" {
			return soffice(ctx, dir, in, "txt:Text (encoded):UTF8")
		}
		return soffice(ctx, dir, in, target)

	case CatMarkdown:
		switch target {
		case "html", "docx", "odt", "epub":
			return pandoc(ctx, dir, in, target)
		case "pdf":
			docx, err := pandoc(ctx, dir, in, "docx")
			if err != nil {
				return "", err
			}
			return soffice(ctx, dir, docx, "pdf")
		}

	case CatSheet:
		if target == "csv" {
			return soffice(ctx, dir, in, "csv:Text - txt - csv (StarCalc):44,34,76,1")
		}
		return soffice(ctx, dir, in, target)

	case CatSlides:
		if target == "png" || target == "jpg" {
			pdf, err := soffice(ctx, dir, in, "pdf")
			if err != nil {
				return "", err
			}
			return pdfToImages(ctx, dir, pdf, target, base)
		}
		return soffice(ctx, dir, in, target)

	case CatAudio, CatVideo:
		return ffmpeg(ctx, dir, in, target)
	}
	return "", errors.New("conversion non implémentée")
}
