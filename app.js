'use strict';

(() => {
  const API = 'https://www.svt.se/text-tv/api/';
  const HOME = '100';
  const MIN_PAGE = 100;
  const MAX_PAGE = 999;
  const REFRESH_MS = 60_000;     // auto-refresh the visible page
  const FRESH_MS = 15_000;       // the API itself sends max-age=12
  const SWIPE_MIN_X = 60;
  const EDGE_PX = 24;
  const MAX_ZOOM = 4;
  const ZOOM_SNAP = 1.15;        // a pinch ending below this snaps back to 1
  const TAP_SLOP = 10;           // px a finger may move and still count as a tap
  const DOUBLE_TAP_MS = 350;
  const DOUBLE_TAP_SLOP = 40;
  const LINK_GUARD_MS = 400;     // ignore link taps this soon after a link tap (double-tap on a link)
  const TEXT_MIN = 14;           // text mode font size range (px), set by pinching
  const TEXT_MAX = 48;
  const TEXT_DEFAULT = 22;
  const TELETEXT_COLS = 40;
  const HOLD_MS = 600;           // holding Aa this long resets the text size

  const $ = (id) => document.getElementById(id);
  const content = $('content');
  const pagesEl = $('pages');
  const messageEl = $('message');
  const spinnerEl = $('spinner');
  const input = $('page-input');
  const btnPrev = $('btn-prev');
  const btnNext = $('btn-next');
  const btnBack = $('btn-back');
  const btnText = $('btn-text');

  // page number -> { data, time }
  const cache = new Map();
  let current = null;        // page number shown (string)
  let currentData = null;    // last API data for the shown page
  let loadSeq = 0;           // ignore responses for pages we've navigated away from
  let refreshTimer = null;
  let zoom = 1;              // zoom factor of the page (1 = fit the screen)
  let lastLinkTap = 0;
  let textMode = false;      // show pages as wrapped text instead of the GIF
  let textSize = TEXT_DEFAULT;

  const isValidPage = (p) => /^\d{3}$/.test(p) && +p >= MIN_PAGE && +p <= MAX_PAGE;

  // ---------- Data ----------

  async function fetchPage(page) {
    const res = await fetch(API + page, { cache: 'no-store' });
    // Missing pages answer 200 with status "fail"; bad numbers answer 400.
    let json;
    try { json = await res.json(); } catch { json = null; }
    if (!json) throw new Error('HTTP ' + res.status);
    const d = json.data || {};
    const result = {
      ok: json.status === 'success',
      page: d.pageNumber || d.page || page,
      prevPage: d.prevPage || '',
      nextPage: d.nextPage || '',
      subPages: d.subPages || [],
      updated: d.meta && d.meta.updated,
    };
    if (json.status === 'error') throw new Error('Ogiltig sida');
    cache.set(page, { data: result, time: Date.now() });
    return result;
  }

  function prefetch(page) {
    if (!isValidPage(page)) return;
    const c = cache.get(page);
    if (c && Date.now() - c.time < FRESH_MS) return;
    fetchPage(page).catch(() => {});
  }

  // ---------- Rendering ----------

  // The image map from the API is plain HTML: <map><AREA SHAPE="RECT" COORDS="x1,y1,x2,y2" HREF="113">...
  function parseImageMap(html) {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    const areas = [];
    for (const a of doc.querySelectorAll('area')) {
      const coords = (a.getAttribute('coords') || '').split(',').map(Number);
      const href = (a.getAttribute('href') || '').trim();
      const shape = (a.getAttribute('shape') || 'rect').toLowerCase();
      if (shape !== 'rect' || coords.length !== 4 || coords.some(isNaN)) continue;
      const m = href.match(/(\d{3})(?:-(\d+))?\s*$/);
      if (!m) continue;
      areas.push({ x1: coords[0], y1: coords[1], x2: coords[2], y2: coords[3], page: m[1], sub: m[2] || null });
    }
    return areas;
  }

  // Width/height of a GIF straight from its header, so links can be placed before the image decodes.
  function gifSize(b64) {
    try {
      const bin = atob(b64.slice(0, 16));
      if (!bin.startsWith('GIF')) return null;
      const w = bin.charCodeAt(6) | (bin.charCodeAt(7) << 8);
      const h = bin.charCodeAt(8) | (bin.charCodeAt(9) << 8);
      return w && h ? { w, h } : null;
    } catch { return null; }
  }

  function renderSubPage(sp, count, index) {
    const size = gifSize(sp.gifAsBase64) || { w: 520, h: 400 };
    const wrap = document.createElement('div');
    wrap.className = 'subpage';
    wrap.id = 'sub-' + sp.subPageNumber;

    const img = document.createElement('img');
    img.src = 'data:image/gif;base64,' + sp.gifAsBase64;
    img.width = size.w;
    img.height = size.h;
    img.alt = (sp.altText || '').trim() || 'Text-TV ' + sp.subPageNumber;
    img.draggable = false;
    wrap.appendChild(img);

    for (const a of parseImageMap(sp.imageMap)) {
      const link = document.createElement('a');
      link.className = 'link';
      link.href = '#' + a.page;
      link.setAttribute('aria-label', 'Sida ' + a.page);
      link.style.left = (a.x1 / size.w * 100) + '%';
      link.style.top = (a.y1 / size.h * 100) + '%';
      link.style.width = ((a.x2 - a.x1) / size.w * 100) + '%';
      link.style.height = ((a.y2 - a.y1) / size.h * 100) + '%';
      onLinkTap(link, a.page);
      wrap.appendChild(link);
    }

    addSubPageLabel(wrap, count, index);
    return wrap;
  }

  function onLinkTap(link, page) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      // The second tap of a double-tap would otherwise hit a link on the page just opened.
      if (e.timeStamp - lastLinkTap < LINK_GUARD_MS) return;
      lastLinkTap = e.timeStamp;
      link.classList.add('flash');
      setTimeout(() => link.classList.remove('flash'), 180);
      go(page);
    });
  }

  function addSubPageLabel(wrap, count, index) {
    if (count <= 1) return;
    const label = document.createElement('div');
    label.className = 'subpage-label';
    label.textContent = (index + 1) + '/' + count;
    wrap.prepend(label);
  }

  // ---------- Text mode ----------

  // The API's altText is the page as 40-column text lines. Articles are hard-wrapped at 40 columns;
  // join those lines back into paragraphs so they wrap to the screen at a large font size.
  // Tables (columns separated by runs of spaces), headings, menu lines ending in a page number and
  // the header line are kept as they are.
  function textLines(alt) {
    const raw = alt.split('\n').map((l) => l.replace(/\s+$/, ''));
    const isProse = (l) => {
      const t = l.trim();
      return t !== '' && !/\S {2,}\S/.test(t) && !/(?<!\d)\d{3}$/.test(t) && t !== t.toUpperCase();
    };
    const out = [];
    let prevRaw = '';       // previous source line, before joining
    let seenHeader = false;
    for (const line of raw) {
      const last = out.length - 1;
      const hyphen = /[a-zåäöé]-$/.test(prevRaw) && /^\s*[a-zåäö]/.test(line);
      const firstWord = line.trim().split(' ')[0];
      // The source line was wrapped if the next word wouldn't have fitted on it.
      const wrapped = hyphen || prevRaw.length + 1 + firstWord.length > TELETEXT_COLS;
      if (seenHeader && last >= 0 && wrapped && isProse(prevRaw) && isProse(line)) {
        out[last] = hyphen ? out[last].slice(0, -1) + line.trim() : out[last] + ' ' + line.trim();
      } else if (line.trim() === '') {
        if (out.length && out[last] !== '') out.push('');   // collapse runs of blank lines
      } else {
        if (out.length) seenHeader = true;                  // the first text line is the header
        out.push(line);
      }
      prevRaw = line;
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  }

  function renderSubPageText(sp, count, index) {
    const wrap = document.createElement('div');
    wrap.className = 'subpage text';
    wrap.id = 'sub-' + sp.subPageNumber;
    // Only numbers that the page itself links to become links (not dates, temperatures, scores).
    const linked = new Set(parseImageMap(sp.imageMap).map((a) => a.page));

    const lines = textLines(sp.altText);
    // Table rows (columns separated by runs of spaces) don't wrap: each run of rows gets a font size
    // that fits its longest row across the screen, up to the chosen size (style.css, .line.table).
    const spaced = lines.map((l, i) => i > 0 && /\S {2,}\S/.test(l));
    // A single such line is no table (e.g. "Headline    -  132").
    const gapped = spaced.map((s, i) => s && (spaced[i - 1] || spaced[i + 1] || spaced[i - 2] || spaced[i + 2]));
    // A line between two rows (e.g. the period scores under each match) belongs to the table too,
    // and so does the same kind of line after the last row, unless it's the page's bottom line.
    const last = lines.length - 1;
    const between = gapped.map((g, i) => !g && lines[i] !== '' && gapped[i - 1] && gapped[i + 1]);
    const isTable = gapped.map((g, i) => g || between[i]
      || (i < last && lines[i] !== '' && gapped[i - 1] && between[i - 2]));
    const tableCols = [];
    for (let i = 0; i < lines.length; i++) {
      if (!isTable[i] || isTable[i - 1]) continue;
      let j = i;
      while (isTable[j]) j++;
      const rows = lines.slice(i, j);
      const indent = Math.min(...rows.map((l) => l.match(/^ */)[0].length));
      const cols = Math.max(...rows.map((l) => l.length)) - indent;
      for (let k = i; k < j; k++) {
        lines[k] = lines[k].slice(indent);
        tableCols[k] = cols;
      }
    }

    lines.forEach((line, i) => {
      const div = document.createElement('div');
      if (i === 0) div.className = 'line head';
      else if (line === '') div.className = 'line blank';
      else if (isTable[i]) {
        div.className = 'line table';
        div.style.setProperty('--cols', tableCols[i]);
      }
      else if (line.length > TELETEXT_COLS) div.className = 'line para';   // joined paragraph
      else div.className = 'line item';   // wrapped continuation lines are indented
      if (i > 0 && !isTable[i]) {
        // Leading spaces only position text on the 40-column screen; tables keep theirs.
        // "Headline...... 132" -> "Headline 132": dot leaders only waste space when text wraps.
        line = line.trim().replace(/ {2,}/g, ' ').replace(/(\S)\s*\.{2,}\s*(\d{3}(?:-\d{3})?)$/, '$1 $2');
      }
      for (const part of line.split(/((?<!\d)\d{3}(?!\d))/)) {
        if (!part) continue;
        if (linked.has(part)) {
          const a = document.createElement('a');
          a.href = '#' + part;
          a.textContent = part;
          onLinkTap(a, part);
          div.appendChild(a);
        } else {
          div.appendChild(document.createTextNode(part));
        }
      }
      wrap.appendChild(div);
    });

    addSubPageLabel(wrap, count, index);
    return wrap;
  }

  function setTextSize(px) {
    textSize = Math.round(Math.min(TEXT_MAX, Math.max(TEXT_MIN, px)) * 2) / 2;
    document.documentElement.style.setProperty('--text-size', textSize + 'px');
  }

  function saveTextSize() {
    try { localStorage.setItem('texttv:textsize', textSize); } catch {}
  }

  function setTextMode(on) {
    textMode = on;
    btnText.setAttribute('aria-pressed', on);
    try { localStorage.setItem('texttv:text', on ? '1' : '0'); } catch {}
  }

  function showMessage(html, buttons = []) {
    pagesEl.replaceChildren();
    messageEl.innerHTML = html;
    for (const [text, fn] of buttons) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.addEventListener('click', fn);
      messageEl.appendChild(document.createElement('br'));
      messageEl.appendChild(b);
    }
    messageEl.hidden = false;
  }

  function render(page, data, { keepScroll = false } = {}) {
    currentData = data;
    btnPrev.disabled = !data.prevPage;
    btnNext.disabled = !data.nextPage;

    if (!data.ok || data.subPages.length === 0) {
      const alt = [];
      if (data.prevPage) alt.push(['◀ ' + data.prevPage, () => go(data.prevPage)]);
      if (data.nextPage) alt.push([data.nextPage + ' ▶', () => go(data.nextPage)]);
      showMessage(`<div class="big">${page}</div>Sidan finns inte just nu.`, alt);
      return;
    }

    messageEl.hidden = true;
    const { scrollLeft, scrollTop } = content;
    const frag = document.createDocumentFragment();
    const asText = textMode && data.subPages.every((sp) => (sp.altText || '').trim());
    data.subPages.forEach((sp, i) => frag.appendChild(
      (asText ? renderSubPageText : renderSubPage)(sp, data.subPages.length, i)));
    pagesEl.classList.toggle('text', asText);
    pagesEl.replaceChildren(frag);
    if (keepScroll) content.scrollTo(scrollLeft, scrollTop);
    else content.scrollTo(0, 0);
  }

  // ---------- Zoom ----------

  // The app zooms the Text-TV page itself (not the browser), so the toolbar stays put.
  // #pages gets wider by the zoom factor and #content scrolls it; links are placed in %, so they follow.
  function setZoom(z) {
    zoom = Math.min(MAX_ZOOM, Math.max(1, z));
    pagesEl.style.setProperty('--zoom', zoom);
    content.classList.toggle('zoomed', zoom > 1);
  }

  // Zoom to z while keeping the page point at fractions (fx, fy) of the page under the screen point (x, y).
  function zoomAround(z, fx, fy, x, y) {
    setZoom(z);
    const r = pagesEl.getBoundingClientRect();
    content.scrollLeft += r.left + fx * r.width - x;
    content.scrollTop += r.top + fy * r.height - y;
  }

  function pageFraction(x, y) {
    const r = pagesEl.getBoundingClientRect();
    return { fx: (x - r.left) / r.width, fy: (y - r.top) / r.height };
  }

  function openPageInput() {
    input.focus();
  }

  // ---------- Navigation ----------

  async function load(page, { keepScroll = false, force = false } = {}) {
    const seq = ++loadSeq;
    if (page !== current) setZoom(1);
    current = page;
    input.value = '';
    input.placeholder = page;
    document.title = 'Text-TV ' + page;
    try { localStorage.setItem('texttv:last', page); } catch {}

    const cached = cache.get(page);
    if (cached) render(page, cached.data, { keepScroll });
    if (cached && !force && Date.now() - cached.time < FRESH_MS) {
      afterLoad(cached.data);
      return;
    }

    pagesEl.classList.add('loading');
    spinnerEl.hidden = false;
    try {
      const data = await fetchPage(page);
      if (seq !== loadSeq) return;
      render(page, data, { keepScroll: keepScroll || !!cached });
      afterLoad(data);
    } catch (err) {
      if (seq !== loadSeq) return;
      if (!cached) {
        showMessage(`<div class="big">${page}</div>Kunde inte hämta sidan.<br><small>${escapeHtml(err.message)}</small>`,
          [['Försök igen', () => load(page, { force: true })]]);
      }
    } finally {
      if (seq === loadSeq) {
        pagesEl.classList.remove('loading');
        spinnerEl.hidden = true;
      }
    }
  }

  function afterLoad(data) {
    // Make the arrows feel instant.
    prefetch(data.nextPage);
    prefetch(data.prevPage);
    scheduleRefresh();
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (document.visibilityState === 'visible' && current) load(current, { keepScroll: true, force: true });
      else scheduleRefresh();
    }, REFRESH_MS);
  }

  // Every page change goes into the browser history (as the URL hash), so back and reloads work.
  // history.state.depth counts in-app steps, so the back button never leaves the app.
  const depth = () => (history.state && history.state.depth) || 0;
  const updateBack = () => { btnBack.disabled = depth() <= 0; };

  function go(page) {
    if (!isValidPage(page)) return;
    if (page === current) { load(page, { force: true }); return; }
    history.pushState({ depth: depth() + 1 }, '', '#' + page);
    updateBack();
    load(page);
  }

  function onPopState() {
    const page = location.hash.replace(/^#\/?/, '');
    if (isValidPage(page)) {
      if (page !== current) load(page);
    } else {
      history.replaceState({ depth: depth() }, '', '#' + (current || HOME));
      if (!current) load(HOME);
    }
    updateBack();
  }

  function back() {
    if (depth() > 0) history.back();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Controls ----------

  btnPrev.addEventListener('click', () => currentData && go(currentData.prevPage));
  btnNext.addEventListener('click', () => currentData && go(currentData.nextPage));
  btnBack.addEventListener('click', back);
  $('btn-home').addEventListener('click', () => go(HOME));
  $('btn-reload').addEventListener('click', () => current && load(current, { keepScroll: true, force: true }));
  // Tap Aa: switch between picture and text. Hold Aa: back to the default text size (and no zoom).
  let holdTimer = null;
  let held = false;
  const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null; };
  btnText.addEventListener('pointerdown', () => {
    held = false;
    cancelHold();
    holdTimer = setTimeout(() => {
      holdTimer = null;
      held = true;
      setTextSize(TEXT_DEFAULT);
      saveTextSize();
      setZoom(1);
      btnText.classList.remove('flash');
      void btnText.offsetWidth;   // restart the animation
      btnText.classList.add('flash');
    }, HOLD_MS);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) btnText.addEventListener(type, cancelHold);
  btnText.addEventListener('contextmenu', (e) => e.preventDefault());   // Android long-press menu
  btnText.addEventListener('click', () => {
    if (held) { held = false; return; }   // the click that ends a hold doesn't switch modes
    setTextMode(!textMode);
    setZoom(1);
    if (current && currentData) render(current, currentData);
  });

  // Jump as soon as three digits are typed, like a TV remote.
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 3);
    if (input.value.length === 3) {
      const p = input.value;
      input.blur();
      if (isValidPage(p)) go(p);
      else input.value = '';
    }
  });
  input.addEventListener('focus', () => { input.value = ''; });
  input.addEventListener('blur', () => { input.value = ''; });
  $('page-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const p = input.value.padStart(3, '0');
    input.blur();
    if (isValidPage(p)) go(p);
  });

  // Hardware keyboard: digits type a page number, arrows step pages.
  let typed = '';
  let typedTimer = null;
  document.addEventListener('keydown', (e) => {
    if (e.target === input || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^\d$/.test(e.key)) {
      typed += e.key;
      input.placeholder = typed.padEnd(3, '-');
      clearTimeout(typedTimer);
      if (typed.length === 3) {
        const p = typed;
        typed = '';
        if (isValidPage(p)) go(p); else input.placeholder = current || HOME;
      } else {
        typedTimer = setTimeout(() => { typed = ''; input.placeholder = current || HOME; }, 2500);
      }
    } else if (e.key === 'ArrowLeft') {
      currentData && go(currentData.prevPage);
    } else if (e.key === 'ArrowRight') {
      currentData && go(currentData.nextPage);
    }
  });

  // ---------- Touch: pinch to zoom, double-tap for the page field, swipe for next/previous ----------

  // One gesture lasts from the first finger down until all fingers are up.
  // { type: 'one', x, y, time, edge } or { type: 'pinch', dist, zoom, fx, fy }
  let gesture = null;
  let lastTap = null;   // { time, x, y } of the previous plain tap, for double-tap detection

  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

  content.addEventListener('touchstart', (e) => {
    // The iPhone number pad has no Done key: tapping the page closes it.
    if (document.activeElement === input) input.blur();
    if (e.touches.length === 2) {
      const [a, b] = e.touches;
      const m = mid(a, b);
      gesture = { type: 'pinch', dist: Math.max(dist(a, b), 1), zoom, textSize, ...pageFraction(m.x, m.y) };
      lastTap = null;
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      gesture = {
        type: 'one', x: t.clientX, y: t.clientY, time: Date.now(),
        // Leave swipes from the screen edges to iOS (back/forward in Safari).
        edge: t.clientX < EDGE_PX || t.clientX > window.innerWidth - EDGE_PX,
      };
    }
  }, { passive: true });

  content.addEventListener('touchmove', (e) => {
    if (!gesture || gesture.type !== 'pinch' || e.touches.length !== 2) return;
    e.preventDefault();   // no scrolling while pinching
    const [a, b] = e.touches;
    const m = mid(a, b);
    const scale = dist(a, b) / gesture.dist;
    if (pagesEl.classList.contains('text')) {
      // Text mode: pinching sets the font size; the text rewraps, so there's nothing to pan.
      setTextSize(gesture.textSize * scale);
      const r = pagesEl.getBoundingClientRect();
      content.scrollTop += r.top + gesture.fy * r.height - m.y;
      return;
    }
    // Following the midpoint also lets two fingers pan while zooming.
    zoomAround(gesture.zoom * scale, gesture.fx, gesture.fy, m.x, m.y);
  }, { passive: false });

  content.addEventListener('touchend', (e) => {
    if (e.touches.length > 0) return;   // wait for the last finger
    const g = gesture;
    gesture = null;
    if (!g) return;
    if (g.type === 'pinch') {
      if (zoom < ZOOM_SNAP) setZoom(1);
      if (textSize !== g.textSize) saveTextSize();
      return;
    }

    const t = e.changedTouches[0];
    const dx = t.clientX - g.x;
    const dy = t.clientY - g.y;
    const dt = Date.now() - g.time;

    if (Math.hypot(dx, dy) < TAP_SLOP && dt < 400) {
      // Links and buttons handle their own taps.
      if (e.target.closest && e.target.closest('a, button')) { lastTap = null; return; }
      const now = Date.now();
      if (lastTap && now - lastTap.time < DOUBLE_TAP_MS
          && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < DOUBLE_TAP_SLOP) {
        lastTap = null;
        e.preventDefault();   // no click and no browser zoom
        openPageInput();      // must run inside the touch handler, or iOS won't show the keyboard
      } else {
        lastTap = { time: now, x: t.clientX, y: t.clientY };
      }
      return;
    }
    lastTap = null;

    // Swipe left/right for next/previous page; when zoomed, dragging pans instead.
    if (g.edge || zoom > 1 || !currentData) return;
    if (Math.abs(dx) < SWIPE_MIN_X || Math.abs(dx) < Math.abs(dy) * 1.5 || dt > 800) return;
    go(dx < 0 ? currentData.nextPage : currentData.prevPage);
  }, { passive: false });

  content.addEventListener('touchcancel', () => {
    if (gesture && gesture.type === 'pinch' && zoom < ZOOM_SNAP) setZoom(1);
    if (gesture && gesture.type === 'pinch' && textSize !== gesture.textSize) saveTextSize();
    gesture = null;
  });

  // Safari: stop the browser's own pinch zoom, which would also enlarge the toolbar.
  for (const type of ['gesturestart', 'gesturechange']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }

  // Computer: double-click opens the page field, Ctrl + scroll wheel (or trackpad pinch) zooms.
  content.addEventListener('dblclick', (e) => {
    if (!e.target.closest('a, button')) openPageInput();
  });
  content.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const { fx, fy } = pageFraction(e.clientX, e.clientY);
    if (pagesEl.classList.contains('text')) {
      setTextSize(textSize * Math.exp(-e.deltaY / 200));
      saveTextSize();
      const r = pagesEl.getBoundingClientRect();
      content.scrollTop += r.top + fy * r.height - e.clientY;
      return;
    }
    const z = zoom * Math.exp(-e.deltaY / 200);
    zoomAround(z < ZOOM_SNAP && e.deltaY > 0 ? 1 : z, fx, fy, e.clientX, e.clientY);
  }, { passive: false });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && current) {
      const c = cache.get(current);
      if (!c || Date.now() - c.time > FRESH_MS) load(current, { keepScroll: true, force: true });
    }
  });

  window.addEventListener('popstate', onPopState);

  // ---------- Start ----------

  let start = location.hash.replace(/^#\/?/, '');
  if (!isValidPage(start)) {
    try { start = localStorage.getItem('texttv:last') || HOME; } catch { start = HOME; }
    if (!isValidPage(start)) start = HOME;
  }
  try {
    setTextMode(localStorage.getItem('texttv:text') === '1');
    setTextSize(+localStorage.getItem('texttv:textsize') || TEXT_DEFAULT);
  } catch { setTextMode(false); setTextSize(TEXT_DEFAULT); }
  history.replaceState({ depth: 0 }, '', '#' + start);
  updateBack();
  load(start);

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
