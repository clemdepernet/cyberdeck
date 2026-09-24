#!/usr/bin/env bash
# Integration check run inside the real image: starts the service and converts
# real files through every engine (ImageMagick, img2pdf, Poppler, LibreOffice,
# Pandoc, ffmpeg). Fails loudly if any tool is missing or misbehaves.
set -euo pipefail
export WORK_DIR=/tmp/convert-smoke HOME=/tmp/convert-smoke-home LISTEN=127.0.0.1:8199
mkdir -p "$WORK_DIR" "$HOME"
/app/tools/convert/convert &
pid=$!
trap 'kill $pid 2>/dev/null || true' EXIT
for i in $(seq 1 50); do curl -fs http://127.0.0.1:8199/convert/api/formats >/dev/null 2>&1 && break; sleep 0.2; done
B=http://127.0.0.1:8199/convert/api/files
up() { curl -fs -F "file=@$1" $B | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'; }
to() { code=$(curl -s -o "$3" -w '%{http_code}' -X POST "$B/$1/to/$2"); [ "$code" = 200 ] || { echo "FAIL ($code): $1 -> $2"; cat "$3" 2>/dev/null; echo; exit 1; }; }
cd /tmp/convert-smoke-home

convert -size 40x30 xc:red -fill blue -draw "circle 20,15 25,15" in.png
printf 'Bonjour le deck\n\nDeuxième paragraphe.\n' > in.txt
printf '# Titre\n\nUn **gras** et une liste :\n\n- un\n- deux\n' > in.md
printf 'a,b,c\n1,2,3\n4,5,6\n' > in.csv
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "sine=frequency=440:duration=1" in.wav
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "testsrc=duration=1:size=160x120:rate=10" -f lavfi -i "sine=frequency=440:duration=1" -pix_fmt yuv420p -c:a aac -shortest in.mp4

png=$(up in.png); to $png jpg out.jpg; to $png webp out.webp; to $png pdf out.pdf; to $png ico out.ico
txt=$(up in.txt); to $txt pdf txt.pdf; to $txt docx txt.docx; to $txt md txt.md
docx=$(up txt.docx); to $docx pdf docx.pdf; to $docx odt docx.odt; to $docx html docx.html
pdf=$(up docx.pdf); to $pdf png pdf.png; to $pdf txt pdf.txt; to $pdf docx pdf.docx
md=$(up in.md); to $md html md.html; to $md docx md.docx; to $md pdf md.pdf
csv=$(up in.csv); to $csv xlsx csv.xlsx; to $csv pdf csv.pdf
xlsx=$(up csv.xlsx); to $xlsx csv xlsx.csv; to $xlsx ods xlsx.ods
wav=$(up in.wav); to $wav mp3 out.mp3; to $wav opus out.opus
mp4=$(up in.mp4); to $mp4 webm out.webm; to $mp4 gifv out.gif; to $mp4 mp3 mp4.mp3

file out.jpg out.webp out.pdf out.ico txt.pdf txt.docx docx.pdf docx.odt pdf.png pdf.docx md.html md.docx md.pdf csv.xlsx csv.pdf xlsx.ods out.mp3 out.opus out.webm out.gif mp4.mp3
grep -q "Bonjour" pdf.txt && grep -q "Bonjour" txt.md && grep -q "gras" md.html && grep -q '"1"\|^1,' xlsx.csv
for f in out.jpg out.webp out.pdf out.ico txt.pdf txt.docx docx.pdf docx.odt docx.html pdf.png pdf.docx md.html md.docx md.pdf csv.xlsx csv.pdf xlsx.ods out.mp3 out.opus out.webm out.gif mp4.mp3; do
  [ -s "$f" ] || { echo "FAIL: $f is empty"; exit 1; }
done
# a refused conversion must be a clean 4xx, not a crash
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/$png/to/mp3"); [ "$code" = 422 ] || { echo "FAIL: png->mp3 returned $code"; exit 1; }
echo "convert smoke: all conversions OK"
