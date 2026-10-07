// Bewertung der gesammelten Rohdaten. Drei Stufen: ok (passt), warn (prüfen), err (Fehler),
// dazu info ohne Wertung. Keine Punktzahl, keine Gewichtung.
// Die Schema-Regeln folgen dem Web-Check (Kriterien D1 bis D9), damit beide Werkzeuge
// dieselbe Seite gleich beurteilen. Seitenbezogene Prüfungen (Artikel, Datum, Sprache)
// gelten nur für die seiteneigenen Knoten, nicht für die sitewide Organisation.

import { SCHEMA_TYPES, ARTICLE_TYPES, ORGANIZATION_TYPES, LOCALBUSINESS_TYPES, PRODUCT_TYPES } from './schema-types.js';
import { buildGraph, buildTree, isEntity, isPage } from './graph.js';
import { evaluateEntity } from './entity.js';

const MAIN_TYPES = new Set([
  ...ARTICLE_TYPES, ...PRODUCT_TYPES, 'Service', 'ProductGroup', 'DefinedTerm', 'AboutPage', 'ContactPage',
  'FAQPage', 'QAPage', 'HowTo', 'Course', 'Event', 'Recipe', 'JobPosting', 'SoftwareApplication',
  'WebApplication', 'MobileApplication', 'ProfilePage', 'Book', 'PodcastEpisode', 'PodcastSeries',
  'VideoObject', 'Dataset', 'Movie', 'MedicalWebPage', 'CollectionPage', 'ItemList',
]);

const BOTS = [
  { name: 'Googlebot', group: 'search' },
  { name: 'Bingbot', group: 'search' },
  { name: 'OAI-SearchBot', group: 'search' },
  { name: 'ChatGPT-User', group: 'search' },
  { name: 'PerplexityBot', group: 'search' },
  { name: 'Claude-SearchBot', group: 'search' },
  { name: 'GPTBot', group: 'training' },
  { name: 'ClaudeBot', group: 'training' },
  { name: 'Google-Extended', group: 'training' },
  { name: 'Applebot-Extended', group: 'training' },
  { name: 'CCBot', group: 'training' },
];

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const isOrg = (rec) => [...rec.types].some((t) => ORGANIZATION_TYPES.has(t));

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function isQuestion(text) {
  const t = norm(text);
  return t.endsWith('?') || /^(was|wie|warum|wann|wer|welche|welcher|welches|wo|wofür|ist|kann|sollte|lohnt|what|how|why|when|who|which|where|is|can|should|does|do)(?!\p{L})/u.test(t);
}

function pageKind(d) {
  const p = (d.path || '/').toLowerCase();
  if (/^\/([a-z]{2}(-[a-z]{2})?\/?)?$/.test(p)) return 'home';
  if (/\/(was-ist|what-is|glossar|glossary|lexikon|wiki)\//.test(p)) return 'glossary';
  if (d.ogType === 'product' || /\/(products?|produkte?)\//.test(p)) return 'product';
  if (d.articlePublished || /\/(blog|magazin|magazine|seo-magazin|seo-magazine|news|ratgeber|artikel|journal|beitrag)\//.test(p)) {
    return 'article';
  }
  return 'unknown';
}

// --- robots.txt -------------------------------------------------------------

function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    const clean = line.replace(/#.*/, '').trim();
    if (!clean || !clean.includes(':')) continue;
    const idx = clean.indexOf(':');
    const field = clean.slice(0, idx).trim().toLowerCase();
    const value = clean.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      if (current) current.rules.push({ allow: field === 'allow', path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function ruleMatches(pattern, path) {
  if (!pattern) return false;
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  try {
    return new RegExp('^' + body + (anchored ? '$' : '')).test(path);
  } catch (e) {
    return false;
  }
}

function robotsVerdict(groups, bot, path) {
  const name = bot.toLowerCase();
  const specific = groups.filter((g) => g.agents.includes(name));
  const rules = (specific.length ? specific : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
  let best = null;
  for (const r of rules) {
    if (!r.path || !ruleMatches(r.path, path)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return { allowed: best ? best.allow : true, specific: specific.length > 0 };
}

// --- Hauptfunktion ------------------------------------------------------------

export function evaluate(d) {
  const raw = [];
  const add = (area, level, code, vars = {}, node = null) => raw.push({ area, level, code, vars, node });

  const graph = buildGraph(d.jsonLd || [], d.origin, d.url);
  const kind = pageKind(d);
  const recs = graph.nodes;
  const local = recs.filter((r) => graph.local.has(r.key));
  const text = d.text || '';

  // ---------- Schema ----------
  if (!d.jsonLd || d.jsonLd.length === 0) add('schema', 'err', 'noJsonLd');
  for (const b of d.jsonLd || []) {
    if (!b.ok) add('schema', 'err', 'parseError', { n: b.index });
  }

  for (const r of recs) {
    if (!r.types.size && Object.keys(r.props).length) add('schema', 'err', 'noType', {}, r.key);
    for (const t of r.types) {
      if (!SCHEMA_TYPES.has(t)) add('schema', 'err', 'invalidType', { type: t }, r.key);
    }
  }
  if (graph.pageNodes.length > 1) add('schema', 'warn', 'pageDuplicate', { n: graph.pageNodes.length });

  // Haupttyp: worauf der Seitenknoten per mainEntity/about zeigt, sonst der erste
  // seiteneigene Inhaltstyp, auf der Startseite auch die Organisation.
  let main = null;
  const contentType = (r) => [...r.types].find((t) => MAIN_TYPES.has(t));
  const pageRecs = [...new Set([graph.pageNode, ...graph.pageNodes].filter(Boolean))];
  for (const pageRec of pageRecs) {
    for (const prop of ['mainEntity', 'about']) {
      for (const e of graph.edges.get(pageRec.key) || []) {
        if (main || e.prop !== prop) continue;
        const t = graph.records.get(e.to);
        if (t && !t.external && (contentType(t) || (kind === 'home' && isOrg(t)))) main = t;
      }
    }
  }
  if (!main) main = local.find((r) => contentType(r) && !isEntity(r) && r !== graph.pageNode) || null;
  if (!main && graph.pageNode && contentType(graph.pageNode)) main = graph.pageNode;
  if (!main && kind === 'home') main = recs.find((r) => isOrg(r) && r.fullDefs > 0) || null;
  const mainType = main ? contentType(main) || [...main.types].find((t) => ORGANIZATION_TYPES.has(t)) || [...main.types][0] : null;

  if (recs.length) {
    if (!main) add('schema', 'warn', 'onlyGeneric');
    else if (kind === 'article' && !ARTICLE_TYPES.has(mainType)) add('schema', 'warn', 'kindMismatch', { kind, type: mainType });
    else if (kind === 'glossary' && mainType !== 'DefinedTerm' && !ARTICLE_TYPES.has(mainType)) add('schema', 'warn', 'kindMismatch', { kind, type: mainType });
    else if (kind === 'product' && !PRODUCT_TYPES.has(mainType) && mainType !== 'ProductGroup') add('schema', 'warn', 'kindMismatch', { kind, type: mainType });
    else add('schema', 'ok', 'mainType', { type: mainType }, main.key);
  }

  // Artikel der Seite
  for (const r of local.filter((x) => [...x.types].some((t) => ARTICLE_TYPES.has(t)))) {
    if (!r.props.author) add('schema', 'err', 'articleNoAuthor', {}, r.key);
    if (!r.props.datePublished) add('schema', 'err', 'articleNoDate', {}, r.key);
    if (!r.props.headline && !r.props.name) add('schema', 'warn', 'articleNoHeadline', {}, r.key);
  }
  for (const r of local) {
    for (const e of graph.edges.get(r.key) || []) {
      if (e.prop !== 'author') continue;
      const t = graph.records.get(e.to);
      if (t && !t.external && !t.props.name) add('schema', 'err', 'authorNoName', {}, t.key);
    }
  }

  // BreadcrumbList
  for (const r of recs.filter((x) => x.types.has('BreadcrumbList'))) {
    if (r.listConflicts.has('itemListElement')) add('schema', 'err', 'listConflict', { blocks: [...r.sources].join(', ') }, r.key);
    const items = asArray(r.props.itemListElement);
    const missing = items.filter((it, i) => i < items.length - 1 && it && typeof it === 'object' && !('item' in it));
    if (missing.length) add('schema', 'err', 'breadcrumbNoItem', { n: missing.length }, r.key);
  }

  // FAQPage (D6)
  const faqRecs = recs.filter((x) => x.types.has('FAQPage'));
  for (const r of faqRecs) {
    const questions = [];
    for (const q of asArray(r.props.mainEntity)) {
      if (!q || typeof q !== 'object') continue;
      const ref = q['@id'] && graph.records.get(q['@id']);
      const name = q.name || (ref && ref.props.name);
      if (name) questions.push(norm(decodeEntities(name)));
    }
    if (!questions.length) {
      add('schema', 'err', 'faqEmpty', {}, r.key);
    } else {
      const visible = questions.filter((q) => text.includes(q.slice(0, Math.min(30, q.length))));
      if (visible.length === questions.length) add('schema', 'ok', 'faqVisible', { n: questions.length }, r.key);
      else add('schema', 'err', 'faqHidden', { n: questions.length - visible.length, total: questions.length }, r.key);
    }
  }
  const visibleQuestions = (d.subheadings || []).filter(isQuestion).length;
  if (!faqRecs.length && visibleQuestions >= 3) add('schema', 'warn', 'faqUnmarked', { n: visibleQuestions });

  // Datum und Sprache der Seite (D9)
  const isoTz = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/.test(v);
  const isoDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const isoAny = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);
  const contentNodes = local.filter((r) => isPage(r) || r === main || [...r.types].some((t) => ARTICLE_TYPES.has(t)));
  for (const r of contentNodes) {
    for (const field of ['datePublished', 'dateModified']) {
      for (const v of asArray(r.props[field])) {
        if (isoTz(v) || isoDate(v)) continue;
        if (isoAny(v)) add('schema', 'warn', 'dateNoTz', { field }, r.key);
        else add('schema', 'err', 'dateFormat', { field, value: String(v) }, r.key);
      }
    }
    const lang = r.props.inLanguage;
    if (Array.isArray(lang)) add('schema', 'warn', 'langArray', { value: lang.join(', ') }, r.key);
    else if (typeof lang === 'string' && d.lang && lang.slice(0, 2).toLowerCase() !== d.lang.slice(0, 2).toLowerCase()) {
      add('schema', 'warn', 'langMismatch', { value: lang, lang: d.lang }, r.key);
    }
  }

  // Organisation der Website (D3): sitewide @id dieser Domain, sonst der Herausgeber
  const orgs = recs.filter((r) => isOrg(r) && r.fullDefs > 0);
  const sameSite = (r) => {
    try {
      return r.id && new URL(r.id, d.origin).origin === d.origin;
    } catch (e) {
      return false;
    }
  };
  let primary = orgs.filter(sameSite);
  if (!primary.length) {
    const publishers = new Set();
    for (const r of local) for (const e of graph.edges.get(r.key) || []) if (e.prop === 'publisher' || e.prop === 'provider') publishers.add(e.to);
    primary = orgs.filter((r) => publishers.has(r.key));
  }
  if (!primary.length && orgs.length) primary = [orgs[0]];
  // Zweitstandorte (eigene LocalBusiness mit parentOrganization) zählen nicht als Hauptorganisation
  primary = primary.filter((r) => !r.props.parentOrganization || primary.length === 1);
  for (const r of primary) {
    if (r.props.aggregateRating) add('schema', 'warn', 'orgSelfRating', {}, r.key);
  }
  for (const r of orgs) {
    if ([...r.types].some((t) => LOCALBUSINESS_TYPES.has(t)) && !r.props.address) add('schema', 'err', 'localNoAddress', {}, r.key);
  }

  // ---------- Entität ----------
  const entityCard = evaluateEntity(d, graph, { primaryOrg: primary[0] || null, main, kind }, add);

  // Produkte der Seite
  for (const r of local.filter((x) => [...x.types].some((t) => PRODUCT_TYPES.has(t)))) {
    if (!r.props.offers && !r.props.review && !r.props.aggregateRating) add('schema', 'warn', 'productNoOffer', {}, r.key);
  }

  // Schema nur per JavaScript
  if (d.raw && typeof d.raw.jsonLdBlocks === 'number' && d.jsonLd && d.raw.jsonLdBlocks < d.jsonLd.length) {
    add('schema', 'warn', 'schemaViaJs', { raw: d.raw.jsonLdBlocks, total: d.jsonLd.length });
  }
  if (d.microdata) add('schema', 'info', 'microdata', { n: d.microdata });
  if (d.rdfa) add('schema', 'info', 'rdfa', { n: d.rdfa });

  // ---------- KI-Zugang ----------
  const bots = [];
  const rt = d.robotsTxt || {};
  const robotsUsable = rt.status === 200 && !/text\/html/i.test(rt.contentType || '');
  const groups = robotsUsable ? parseRobots(rt.text) : [];
  let path = d.path || '/';
  try {
    const u = new URL(d.url);
    path = u.pathname + u.search;
  } catch (e) { /* bleibt beim Pfad */ }
  if (rt.error || (rt.status && rt.status >= 500)) add('access', 'warn', 'robotsUnavailable');
  else if (!robotsUsable) add('access', 'info', 'robotsNone');
  for (const bot of BOTS) {
    const v = robotsVerdict(groups, bot.name, path);
    bots.push({ ...bot, allowed: v.allowed, level: v.allowed ? 'ok' : bot.group === 'search' ? 'err' : 'warn' });
  }
  const blockedSearch = bots.filter((b) => b.group === 'search' && !b.allowed);
  const blockedTraining = bots.filter((b) => b.group === 'training' && !b.allowed);
  if (blockedSearch.length) add('access', 'err', 'botsBlockedSearch', { bots: blockedSearch.map((b) => b.name).join(', ') });
  else add('access', 'ok', 'botsSearchOk');
  if (blockedTraining.length) add('access', 'warn', 'botsBlockedTraining', { bots: blockedTraining.map((b) => b.name).join(', ') });

  // llms.txt (D8)
  const lt = d.llmsTxt || {};
  const llmsExists = lt.status === 200 && lt.text && !/text\/html/i.test(lt.contentType || '') && !/^\s*</.test(lt.text);
  if (!llmsExists) {
    add('access', 'warn', 'llmsMissing');
  } else {
    const t = lt.text;
    const complete = /^#\s+/m.test(t) && /^>\s*/m.test(t) && /^##\s+/m.test(t) && /^\s*-\s*\[.+\]\(https?:\/\/[^)]+\)/m.test(t);
    add('access', complete ? 'ok' : 'warn', complete ? 'llmsOk' : 'llmsFormat');
    const self = String(d.url).split('#')[0].split('?')[0].replace(/\/$/, '');
    add('access', 'info', t.includes(self) ? 'llmsLinksPage' : 'llmsNotLinksPage');
  }

  // Snippet-Steuerung
  const directives = [...(d.robotsMeta || []), (d.raw && d.raw.xRobotsTag) || '']
    .join(',')
    .toLowerCase()
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
  const noindex = directives.some((x) => x === 'noindex' || x === 'none');
  const maxSnippet = directives.map((x) => /^max-snippet\s*:\s*(-?\d+)/.exec(x)).filter(Boolean).map((m) => Number(m[1]));
  if (directives.includes('nosnippet')) add('access', 'err', 'nosnippet');
  else if (maxSnippet.includes(0)) add('access', 'err', 'maxSnippetZero');
  else if (maxSnippet.some((n) => n > 0 && n < 50)) add('access', 'warn', 'maxSnippetLow', { n: Math.min(...maxSnippet.filter((n) => n > 0)) });
  else add('access', 'ok', 'snippetOk');
  if (d.dataNosnippet) add('access', 'info', 'dataNosnippet', { n: d.dataNosnippet });

  // Inhalt ohne JavaScript
  if (!d.raw || d.raw.error) {
    add('access', 'info', 'rawUnavailable');
  } else if ((d.renderedWords || 0) >= 50) {
    const pct = Math.round(Math.min(1, (d.raw.words || 0) / d.renderedWords) * 100);
    if (pct < 50) add('access', 'err', 'jsContent', { pct });
    else if (pct < 70) add('access', 'warn', 'jsContent', { pct });
    else add('access', 'ok', 'jsContentOk', { pct });
  }

  // ---------- Inhalt für KI-Antworten ----------
  if (d.firstParagraph) {
    const first = (d.firstParagraph.split(/(?<=[.!?])\s+/)[0] || '').trim();
    const head = first.split(/\s+/).slice(0, 15).join(' ');
    const quote = first.length > 140 ? first.slice(0, 139) + '…' : first;
    const greeting = /^(willkommen|herzlich willkommen|hallo|hi|welcome|hello)\b/i.test(first);
    const answer = /(?<!\p{L})(ist|sind|bezeichnet|bedeutet|beschreibt|umfasst|meint|heißt|steht für|nennt man|versteht man|gilt als|is|are|means|refers to|describes|covers|includes|stands for)(?!\p{L})/iu.test(head);
    add('content', !greeting && answer ? 'ok' : 'warn', !greeting && answer ? 'answerFirst' : 'answerNotFirst', { quote });
  } else {
    add('content', 'info', 'noFirstParagraph');
  }
  const subs = d.subheadings || [];
  if (subs.length >= 3) {
    const q = subs.filter(isQuestion).length;
    add('content', q / subs.length >= 0.3 ? 'ok' : 'warn', q / subs.length >= 0.3 ? 'questionsOk' : 'questionsFew', { n: q, total: subs.length });
  }
  const now = new Date(d.collectedAt || Date.now());
  const toDay = (v) => {
    if (typeof v !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  };
  const schemaMod = [main, ...graph.pageNodes, graph.pageNode].filter(Boolean).map((r) => toDay(asArray(r.props.dateModified)[0])).find(Boolean) || null;
  const modified = schemaMod || toDay(d.modifiedMeta) || d.visibleUpdated || null;
  if (!modified) {
    add('content', kind === 'article' || kind === 'glossary' ? 'warn' : 'info', 'noModified');
  } else {
    const days = Math.max(0, Math.round((now - new Date(modified + 'T12:00:00Z')) / 86400000));
    add('content', days > 365 ? 'warn' : 'ok', days > 365 ? 'staleContent' : 'freshContent', { date: modified, days });
    if (schemaMod && d.visibleUpdated) {
      const diff = Math.abs(new Date(schemaMod) - new Date(d.visibleUpdated)) / 86400000;
      if (diff > 2) add('content', 'warn', 'dateMismatch', { schema: schemaMod, visible: d.visibleUpdated });
    }
  }

  // ---------- Grundlagen ----------
  if (!d.title) add('basics', 'err', 'titleMissing');
  else if (d.title.length > 65) add('basics', 'warn', 'titleLong', { value: d.title, n: d.title.length });
  else add('basics', 'ok', 'title', { value: d.title, n: d.title.length });

  if (!d.description) add('basics', 'warn', 'descMissing');
  else if (d.description.length > 160) add('basics', 'warn', 'descLong', { value: d.description, n: d.description.length });
  else add('basics', 'ok', 'desc', { value: d.description, n: d.description.length });

  const h1 = d.h1 || [];
  if (h1.length === 0) add('basics', 'err', 'h1Missing');
  else if (h1.length > 1) add('basics', 'warn', 'h1Multiple', { n: h1.length, value: h1.join(' | ') });
  else add('basics', 'ok', 'h1', { value: h1[0] });

  if (!d.lang) add('basics', 'warn', 'langMissing');
  else add('basics', 'ok', 'lang', { value: d.lang });

  if (!d.canonical) {
    add('basics', 'warn', 'canonicalMissing');
  } else {
    const strip = (u) => {
      try {
        const x = new URL(u);
        return x.origin + x.pathname;
      } catch (e) {
        return u;
      }
    };
    if (strip(d.canonical) === strip(d.url)) add('basics', 'ok', 'canonicalSelf');
    else add('basics', 'warn', 'canonicalOther', { value: d.canonical });
  }

  if (noindex) add('basics', 'err', 'noindex');
  else add('basics', 'ok', 'indexable');

  // Überschriften-Hierarchie (ohne Navigation, Kopf und Fuß)
  const hs = (d.headings || []).filter((x) => !x.chrome);
  let skips = 0;
  for (let i = 1; i < hs.length; i++) if (hs[i].level > hs[i - 1].level + 1) skips += 1;
  const empty = hs.filter((x) => !x.text).length;
  if (hs.length) {
    if (skips) add('basics', 'warn', 'headingSkips', { n: skips });
    else add('basics', 'ok', 'headingOrder');
    if (empty) add('basics', 'warn', 'headingEmpty', { n: empty });
  }

  const og = d.og || {};
  const ogMissing = [['og:title', og.title], ['og:description', og.description], ['og:image', og.image]].filter(([, v]) => !v).map(([k]) => k);
  if (ogMissing.length) add('basics', ogMissing.includes('og:image') || ogMissing.includes('og:title') ? 'warn' : 'info', 'ogMissing', { list: ogMissing.join(', ') });
  else add('basics', 'ok', 'ogOk');

  const robotsSitemaps = robotsUsable ? (rt.text.match(/^\s*sitemap\s*:/gim) || []).length : 0;
  const sitemapFound = [d.sitemap, d.sitemapIndex].some((x) => x && x.status === 200 && !/text\/html/i.test(x.contentType || ''));
  if (robotsSitemaps) add('basics', 'ok', 'sitemapRobots', { n: robotsSitemaps });
  else if (sitemapFound) add('basics', 'warn', 'sitemapNotInRobots');
  else add('basics', 'warn', 'sitemapMissing');

  const hl = d.hreflang || [];
  if (hl.length) add('basics', 'info', 'hreflang', { n: hl.length, xdefault: hl.some((h) => h.lang === 'x-default') });
  else add('basics', 'info', 'hreflangNone');

  // ---------- Gleiche Befunde zusammenfassen ----------
  const findings = [];
  const byKey = new Map();
  for (const f of raw) {
    const k = `${f.area}|${f.level}|${f.code}|${JSON.stringify(f.vars)}`;
    if (byKey.has(k)) {
      const g = byKey.get(k);
      g.count += 1;
      if (f.node) g.nodes.push(f.node);
    } else {
      const g = { ...f, count: 1, nodes: f.node ? [f.node] : [] };
      byKey.set(k, g);
      findings.push(g);
    }
  }

  const counts = { ok: 0, warn: 0, err: 0 };
  const perArea = {};
  for (const a of ['schema', 'entity', 'access', 'content', 'basics']) perArea[a] = { ok: 0, warn: 0, err: 0 };
  for (const f of findings) {
    if (f.level === 'info') continue;
    counts[f.level] += 1;
    perArea[f.area][f.level] += 1;
  }

  const order = { info: 0, ok: 1, warn: 2, err: 3 };
  const nodeLevel = new Map();
  for (const f of findings) {
    for (const key of f.nodes) {
      const cur = nodeLevel.get(key);
      if (!cur || order[f.level] > order[cur]) nodeLevel.set(key, f.level);
    }
  }

  const tree = buildTree(graph, { levelOf: (key) => nodeLevel.get(key) || 'ok' });

  return { kind, main: main ? main.key : null, mainType, graph, tree, findings, bots, counts, perArea, nodeLevel, entity: entityCard };
}
