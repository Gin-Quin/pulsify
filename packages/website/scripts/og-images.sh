#!/usr/bin/env bash
# Share images (Open Graph, X, LinkedIn, Slack…) in public/og, captured from the
# running dev server with agent-browser: bun run dev, then bash scripts/og-images.sh.
# Each page is shot at 1600×840 CSS pixels, rendered at 2x, and saved as a 1200×630 JPEG.
set -euo pipefail
cd "$(dirname "$0")/.."
url=${URL:-http://localhost:3000}
tmp=$(mktemp -d)
ab() { agent-browser --session pulsify-og "$@" >/dev/null; }

# Hide the dev toolbar, and whatever starts near the bottom edge, so nothing is cut in half.
hide='document.querySelectorAll("body > div:not(#app)").forEach((e) => (e.style.display = "none"));
for (const e of document.querySelectorAll("#app *"))
	if (e.getBoundingClientRect().top > innerHeight - 100) e.style.visibility = "hidden";'

ab set viewport 1600 840 2
for page in home docs cloud benchmarks pricing; do
	path=/${page#home}
	ab open "$url${path%/}"
	ab wait 2500
	ab eval "$hide"
	ab screenshot "$tmp/$page.png"
	# ponytail: sips is macOS only; elsewhere, magick "$tmp/$page.png" -resize 1200x630 -quality 85 public/og/$page.jpg
	sips -s format jpeg -s formatOptions 85 -z 630 1200 "$tmp/$page.png" --out "public/og/$page.jpg" >/dev/null
	echo "public/og/$page.jpg"
done
agent-browser --session pulsify-og close >/dev/null
