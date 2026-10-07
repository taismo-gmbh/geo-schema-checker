// Läuft IN der geprüften Seite (chrome.scripting.executeScript, func).
// Die Funktion muss in sich geschlossen sein: Chrome überträgt nur ihren Quelltext,
// Verweise auf andere Module oder Variablen außerhalb gibt es dort nicht.
// Sie sammelt nur Rohdaten. Bewertet wird im Popup (rules.js).

export async function collectPageData() {
  const MAX_TEXT = 400000;
  const MAX_FILE = 300000;
  const MAX_PAGE = 5000000;
  const STRIP = 'nav,header,footer,aside,script,style,noscript,svg,form,template,iframe';

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const words = (s) => norm(s).split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

  function bodyWords(root) {
    if (!root) return 0;
    const clone = root.cloneNode(true);
    clone.querySelectorAll(STRIP).forEach((el) => el.remove());
    return words(clone.textContent);
  }

  function textIndex(root) {
    if (!root) return '';
    const parts = [];
    let size = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode() && size < MAX_TEXT) {
      const t = walker.currentNode.nodeValue;
      if (t && t.trim()) {
        parts.push(t);
        size += t.length;
      }
    }
    return norm(parts.join(' ')).toLowerCase().slice(0, MAX_TEXT);
  }

  async function fetchText(url, ms, opts, maxLen = MAX_FILE) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { cache: 'no-store', redirect: 'follow', signal: ctrl.signal, ...opts });
      const text = (await res.text()).slice(0, maxLen);
      return {
        ok: true,
        status: res.status,
        finalUrl: res.url,
        contentType: res.headers.get('content-type') || '',
        xRobotsTag: res.headers.get('x-robots-tag') || '',
        text,
      };
    } catch (e) {
      return { ok: false, error: String((e && e.name) || e) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchStatus(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { cache: 'no-store', redirect: 'follow', credentials: 'omit', signal: ctrl.signal });
      const type = res.headers.get('content-type') || '';
      if (res.body) res.body.cancel().catch(() => {});
      return { status: res.status, contentType: type, finalUrl: res.url };
    } catch (e) {
      return { error: String((e && e.name) || e) };
    } finally {
      clearTimeout(timer);
    }
  }

  // Erster inhaltlicher Absatz nach der H1 (mindestens 8 Wörter, nicht in Navigation/Kopf/Fuß)
  function firstParagraph(doc) {
    const h1 = doc.querySelector('h1');
    for (const p of doc.querySelectorAll('p')) {
      if (h1 && !(h1.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      if (p.closest('nav,header,footer,aside,form')) continue;
      // Autorenboxen, Bylines, Cookie- und Newsletter-Bausteine sind kein Einstieg in den Inhalt
      if (p.closest('[class*="author" i],[class*="autor" i],[class*="byline" i],[class*="cookie" i],[class*="consent" i],[class*="newsletter" i],[id*="author" i],[id*="autor" i]')) continue;
      // Zugeklappte Akkordeons, Tabs und versteckte Bereiche überspringen
      if (typeof p.checkVisibility === 'function' ? !p.checkVisibility() : !p.offsetParent) continue;
      const t = norm(p.textContent);
      // Autoren- und Datumszeilen („Von …“, „Zuletzt aktualisiert …“, „Lesedauer …“) überspringen
      if (/^(von|by)\s/i.test(t) || /(zuletzt aktualisiert|last updated|lesedauer|reading time)/i.test(t)) continue;
      if (words(t) >= 8) return t.slice(0, 600);
    }
    return null;
  }

  function readJsonLd(doc) {
    const out = [];
    doc.querySelectorAll('script').forEach((s) => {
      const type = (s.getAttribute('type') || '').toLowerCase();
      if (!type.includes('ld+json')) return;
      const raw = (s.textContent || '').trim();
      const block = { index: out.length + 1, size: raw.length, ok: false };
      try {
        block.data = JSON.parse(raw);
        block.ok = true;
      } catch (e) {
        block.error = String((e && e.message) || e).slice(0, 200);
        block.raw = raw.slice(0, 2000);
      }
      out.push(block);
    });
    return out;
  }

  const doc = document;
  const meta = (name) => {
    const el = [...doc.querySelectorAll('meta')].find(
      (m) => (m.getAttribute('name') || m.getAttribute('property') || '').toLowerCase() === name,
    );
    return el ? norm(el.getAttribute('content')) : null;
  };

  const blocks = readJsonLd(doc);

  const [raw, robots, llms, sitemap, sitemapIndex] = await Promise.all([
    fetchText(location.href, 8000, { credentials: 'include' }, MAX_PAGE),
    fetchText(location.origin + '/robots.txt', 6000, { credentials: 'omit' }),
    fetchText(location.origin + '/llms.txt', 6000, { credentials: 'omit' }),
    fetchStatus(location.origin + '/sitemap.xml', 6000),
    fetchStatus(location.origin + '/sitemap_index.xml', 6000),
  ]);

  // Sichtbares Änderungsdatum („Zuletzt aktualisiert: 05.10.2026“, „Updated October 5, 2026“)
  const visibleText = norm(doc.body ? doc.body.innerText : '');
  const updated = /(aktualisiert|updated|zuletzt ge(ä|ae)ndert|last modified|stand)\s*(am|on|:)?\s*:?\s*(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})/i.exec(visibleText);
  const updatedIso = /(aktualisiert|updated|zuletzt ge(ä|ae)ndert|last modified)\s*(am|on|:)?\s*:?\s*(\d{4})-(\d{2})-(\d{2})/i.exec(visibleText);
  let visibleUpdated = null;
  if (updated) visibleUpdated = `${updated[6]}-${updated[5].padStart(2, '0')}-${updated[4].padStart(2, '0')}`;
  else if (updatedIso) visibleUpdated = `${updatedIso[4]}-${updatedIso[5]}-${updatedIso[6]}`;

  let rawInfo = null;
  if (raw.ok) {
    const rawDoc = new DOMParser().parseFromString(raw.text, 'text/html');
    rawInfo = {
      status: raw.status,
      contentType: raw.contentType,
      xRobotsTag: raw.xRobotsTag,
      words: bodyWords(rawDoc.body),
      jsonLdBlocks: readJsonLd(rawDoc).length,
      truncated: raw.text.length >= MAX_PAGE,
    };
  } else {
    rawInfo = { error: raw.error };
  }

  const pick = (r) => (r.ok
    ? { status: r.status, finalUrl: r.finalUrl, contentType: r.contentType, text: r.text }
    : { error: r.error });

  return {
    url: location.href,
    origin: location.origin,
    path: location.pathname,
    collectedAt: new Date().toISOString(),
    title: norm(doc.title),
    description: meta('description'),
    robotsMeta: [meta('robots'), meta('googlebot')].filter(Boolean),
    ogType: meta('og:type'),
    articlePublished: meta('article:published_time'),
    lang: (doc.documentElement.getAttribute('lang') || '').trim(),
    canonical: (doc.querySelector('link[rel="canonical" i]') || {}).href || null,
    hreflang: [...doc.querySelectorAll('link[rel="alternate" i][hreflang]')].map((l) => ({
      lang: l.getAttribute('hreflang'),
      href: l.href,
    })),
    h1: [...doc.querySelectorAll('h1')].map((h) => norm(h.textContent)).slice(0, 10),
    subheadings: [...doc.querySelectorAll('h2,h3')].map((h) => norm(h.textContent)).slice(0, 300),
    headings: [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6')].slice(0, 400).map((h) => ({
      level: Number(h.tagName[1]),
      text: norm(h.textContent).slice(0, 160),
      chrome: !!h.closest('nav,header,footer,aside'),
    })),
    hasArticleTag: !!doc.querySelector('article'),
    dataNosnippet: doc.querySelectorAll('[data-nosnippet]').length,
    microdata: doc.querySelectorAll('[itemscope]').length,
    rdfa: doc.querySelectorAll('[typeof]').length,
    renderedWords: bodyWords(doc.body),
    text: textIndex(doc.body),
    jsonLd: blocks,
    raw: rawInfo,
    robotsTxt: pick(robots),
    llmsTxt: pick(llms),
    sitemap,
    sitemapIndex,
    og: {
      title: meta('og:title'),
      description: meta('og:description'),
      image: meta('og:image'),
      url: meta('og:url'),
      twitterCard: meta('twitter:card'),
    },
    modifiedMeta: meta('article:modified_time'),
    visibleUpdated,
    timeValues: [...doc.querySelectorAll('time[datetime]')].map((t) => t.getAttribute('datetime')).slice(0, 10),
    telLinks: [...doc.querySelectorAll('a[href^="tel:" i]')].map((a) => a.getAttribute('href').slice(4)).slice(0, 20),
    firstParagraph: firstParagraph(doc),
  };
}
