# Text-TV

A small web app (PWA) for SVT Text-TV on the iPhone. It shows the pages from
<https://www.svt.se/text-tv>, and you tap the page numbers on the page to go there.
Added to the home screen, it opens full-screen like a native app.

## Using it

- **Tap a page number** on the page to go to that page.
- **Swipe left / right** (not from the screen edge) for the next / previous page.
- **Pinch** to zoom the page (up to 4×) and drag to move around. The toolbar stays as it is.
  Pinch back in to return to normal size. A new page always opens at normal size.
- **Double-tap** the page to open the page number field with the number pad. Tap the page
  again to close it without changing page.
- **Toolbar:** ↩ back · ◀ previous · page number field · ▶ next · `100` home · ⟳ reload.
  Typing three digits in the field jumps straight to that page, like a TV remote.
- Pages with several subpages (e.g. 360) are shown one below the other, marked `1/2`, `2/2`.
- Missing page numbers show links to the nearest existing pages.
- The visible page reloads every minute and when the app comes back to the foreground.
- The app remembers the last page shown. `#377` in the URL opens page 377 directly.
- On a computer: type digits to jump to a page, and use ←/→ for previous/next.
  Ctrl + scroll wheel (or a trackpad pinch) zooms, and double-click opens the page field.

## How it works

It's plain static files with no build step and no server code. The app calls SVT's JSON API
`https://www.svt.se/text-tv/api/<page>` straight from the phone (the API allows this with
`Access-Control-Allow-Origin: *`). Each subpage comes back as a 520×400 GIF plus an HTML
image map of the page-number rectangles. The app shows the GIF and puts tappable links over
those rectangles, scaled to the screen size.

| File | Purpose |
|------|---------|
| `index.html` | Page skeleton and toolbar |
| `app.js` | Fetching, rendering, navigation, gestures |
| `style.css` | Layout (portrait and landscape, iPhone safe areas) |
| `sw.js` | Service worker: caches the app itself so it starts offline |
| `manifest.webmanifest`, `icons/` | Home-screen app metadata and icons |
| `tools/make_icons.py` | Regenerates the icons (needs Pillow) |

## Installing on the iPhone

The files must be served over **HTTPS** to work fully (the service worker needs it). Any
static hosting will do, for example GitHub Pages, Netlify, Cloudflare Pages, or a web server of
your own. Copy the files from this directory, without `tools/` and `README.md`.

Then, on the iPhone:

1. Open the URL in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Start Text-TV from the home-screen icon.

### Quick test on the local network

```sh
python3 -m http.server 8000 --bind 0.0.0.0
```

Open `http://<computer-ip>:8000` in Safari on the iPhone. Everything works except the
offline start, because the service worker isn't allowed over plain HTTP.

## Updating

After changing a file, bump `VERSION` in `sw.js` (e.g. `texttv-v2`) so installed copies drop
the old cached files.

## Note

SVT's API isn't documented as a public API, so it may change without notice.
