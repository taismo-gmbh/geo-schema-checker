// Darstellung. Seitendaten werden ausschließlich per textContent eingesetzt, nie als HTML.

import { CTA } from './i18n.js';
import { buildTree } from './graph.js';

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const dot = (level) => h('span', { class: `dot lvl-${level}`, 'aria-hidden': 'true' });

// Katzen-Urteil: ein Gag, abgeleitet aus den echten Ampelzahlen, keine eigene Wertung.
const FACE = { love: 'katze-verliebt.svg', look: 'katze-lupe.svg', dizzy: 'katze-schwindelig.svg', upside: 'katze-kopfueber.svg' };

export function catState(counts) {
  if (!counts) return 'upside';
  if (counts.err > 0) return 'dizzy';
  if (counts.warn >= 3) return 'look';
  return 'love';
}

function verdict(state, S) {
  return h('div', { class: `verdict v-${state}` },
    h('img', { class: 'face', src: `assets/${FACE[state]}`, alt: '' }),
    h('span', { text: S.verdict[state] }));
}

// Ein Feld bzw. Verweis wird nur gezeigt, wenn sein Ziel kein unbeschrifteter Hilfsknoten ist.
function quietTarget(t, result, S) {
  return t && !t.external && result.graph.isMinor(t) && ![...t.types].some((x) => S.chips[x]);
}

function quietField(rec, field, result, S) {
  const values = [].concat(rec.props[field]);
  return values.length > 0 && values.every((v) => {
    if (!v || typeof v !== 'object') return false;
    const t = v['@id'] ? result.graph.records.get(v['@id']) : { external: false, types: new Set([].concat(v['@type'] || [])) };
    return quietTarget(t, result, S);
  });
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    return x.host + x.pathname;
  } catch (e) {
    return u;
  }
}

function shortId(id, origin) {
  try {
    const x = new URL(id, origin);
    if (x.origin === origin) return (x.pathname === '/' ? '' : x.pathname) + x.hash || '/';
    return x.host + x.pathname + x.hash;
  } catch (e) {
    return id;
  }
}

function withUtm(url, content) {
  const u = new URL(url);
  u.searchParams.set('utm_source', 'chrome-extension');
  u.searchParams.set('utm_medium', 'popup');
  u.searchParams.set('utm_campaign', 'geo-schema-checker');
  if (content) u.searchParams.set('utm_content', content);
  return u.toString();
}

function header(S) {
  return h('header', { class: 'top' },
    h('img', { class: 'logo', src: 'assets/taismo-logo.svg', alt: 'taismo' }),
    h('div', { class: 'title', text: S.title }),
    h('div', { class: 'cat-lane', id: 'cat-lane', 'aria-hidden': 'true' }),
  );
}

// Die Katze läuft einmal durch den Kopf und setzt sich rechts hin. Sie blockiert nichts:
// Die Ergebnisse stehen da, sobald sie berechnet sind, egal wo die Katze gerade ist.
const cat = { arrived: false, done: false, happy: false, lane: null };

function sitCat() {
  if (!cat.lane || !cat.arrived || !cat.done) return;
  cat.lane.replaceChildren(h('img', { class: cat.happy ? 'cat hop' : 'cat', src: 'assets/taismo-katze.svg', alt: '' }));
}

function startCat(root) {
  cat.lane = root.querySelector('#cat-lane');
  cat.arrived = false;
  cat.done = false;
  if (!cat.lane) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    cat.arrived = true;
    return;
  }
  const walker = h('img', { class: 'walker', src: 'assets/katze-laeuft.webp', alt: '' });
  walker.addEventListener('animationend', () => {
    cat.arrived = true;
    sitCat();
  });
  cat.lane.replaceChildren(walker);
}

function finishCat(happy) {
  cat.done = true;
  cat.happy = happy;
  sitCat();
}

function mountShell(root, S, url, langKey) {
  root.replaceChildren(
    header(S),
    h('div', { class: 'url', id: 'url', text: url ? shortUrl(url) : '' }),
    h('div', { class: 'body', id: 'body' }, h('p', { class: 'muted note', text: S.checking })),
    footer(S, langKey),
  );
  startCat(root);
}

// Fußzeile: Bei Fehlern steht das GEO-Audit vorn, sonst der kostenlose GEO-Check.
function footer(S, langKey, state) {
  const links = CTA[langKey] || CTA.de;
  const check = h('a', { href: withUtm(links.check, state), target: '_blank', rel: 'noopener', text: `${S.ctaCheck} →` });
  if (state === 'dizzy') {
    return h('footer', { class: 'cta' },
      h('a', { href: withUtm(links.audit, state), target: '_blank', rel: 'noopener', text: `${S.ctaErrors} →` }),
      check);
  }
  return h('footer', { class: 'cta' },
    check,
    h('a', { href: withUtm(links.audit, state), target: '_blank', rel: 'noopener', text: `${S.ctaAudit} →` }));
}

export function renderLoading(root, S, url, langKey) {
  mountShell(root, S, url, langKey);
}

export function renderMessage(root, S, text, langKey) {
  if (!root.querySelector('#body')) mountShell(root, S, '', langKey);
  root.querySelector('#body').replaceChildren(h('div', { class: 'message' }, verdict('upside', S), h('p', { text })));
  finishCat(false);
}

// ---------------------------------------------------------------------------

function findingLine(f, S) {
  const fn = S.m[f.code];
  const msg = fn ? fn(f.vars) : f.code;
  return h('li', { class: `finding lvl-${f.level}` }, dot(f.level), h('span', { text: f.count > 1 ? `${f.count}× ${msg}` : msg }));
}

function nodeLabel(rec, S) {
  const types = [...rec.types];
  return types.length ? types.join(' · ') : S.noType;
}

function nodeName(rec) {
  const p = rec.props;
  const v = p.name || p.headline || p.alternateName || '';
  const s = typeof v === 'string' ? v : Array.isArray(v) ? String(v[0] || '') : '';
  return s.length > 48 ? s.slice(0, 47) + '…' : s;
}

function jsonBlock(obj, S) {
  const text = JSON.stringify(obj, null, 2);
  const pre = h('pre', { class: 'json', text });
  const btn = h('button', {
    class: 'link small',
    type: 'button',
    text: S.copy,
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = S.copied;
        setTimeout(() => (btn.textContent = S.copy), 1200);
      } catch (e) { /* Zwischenablage nicht verfügbar */ }
    },
  });
  return h('div', { class: 'json-wrap' }, btn, pre);
}

function nodeDetail(rec, result, S, origin) {
  const own = result.findings.filter((f) => f.nodes && f.nodes.includes(rec.key));
  const fields = Object.keys(rec.props).filter((f) => !quietField(rec, f, result, S));
  const shown = fields.slice(0, 18);
  let jsonOpen = false;
  const jsonSlot = h('div');
  const toggle = h('button', {
    class: 'link small',
    type: 'button',
    text: S.showJson,
    onclick: () => {
      jsonOpen = !jsonOpen;
      toggle.textContent = jsonOpen ? S.hideJson : S.showJson;
      jsonSlot.replaceChildren(...(jsonOpen ? [jsonBlock(rec.defs.length === 1 ? rec.defs[0].data : rec.defs.map((x) => x.data), S)] : []));
    },
  });
  const linkList = (result.graph.edges.get(rec.key) || []).filter((e) => !quietTarget(result.graph.records.get(e.to), result, S)).map((e) => {
    const t = result.graph.records.get(e.to);
    const label = t && !t.external && t.types.size ? [...t.types][0] : shortId(e.to, origin);
    return `${e.prop} → ${label}`;
  });
  const uniqueLinks = [...new Set(linkList)];
  let subOpen = false;
  const subSlot = h('div');
  const row = result.tree.find((r) => r.key === rec.key);
  const subBtn = row && row.collapsed ? h('button', {
    class: 'link small',
    type: 'button',
    text: S.showLinked(row.collapsed),
    onclick: () => {
      subOpen = !subOpen;
      subBtn.textContent = subOpen ? S.hideLinked : S.showLinked(row.collapsed);
      if (!subOpen) {
        subSlot.replaceChildren();
        return;
      }
      const rows = buildTree(result.graph, { starts: [rec.key], expandStart: true, maxDepth: 3, levelOf: (k) => result.nodeLevel.get(k) || 'ok' }).slice(1);
      subSlot.replaceChildren(h('ul', { class: 'tree sub' }, ...rows.map((r) => treeRow({ ...r, depth: r.depth - 1 }, result, S, origin))));
    },
  }) : null;
  return h('div', { class: 'detail' },
    rec.id ? h('div', { class: 'kv' }, h('span', { class: 'k', text: '@id' }), h('code', { text: shortId(rec.id, origin) })) : null,
    h('div', { class: 'kv' }, h('span', { class: 'k', text: S.source }),
      h('span', { text: [...rec.sources].map((b) => `${S.block} ${b}`).join(', ') })),
    h('div', { class: 'kv' }, h('span', { class: 'k', text: S.fields }),
      h('span', { class: 'chips' }, ...shown.map((f) => h('span', { class: 'chip', text: f })),
        fields.length > shown.length ? h('span', { class: 'chip more', text: `+${fields.length - shown.length}` }) : null)),
    uniqueLinks.length ? h('div', { class: 'kv' }, h('span', { class: 'k', text: S.links }),
      h('span', { class: 'chips' }, ...uniqueLinks.slice(0, 14).map((l) => h('span', { class: 'chip soft', text: l })),
        uniqueLinks.length > 14 ? h('span', { class: 'chip more', text: `+${uniqueLinks.length - 14}` }) : null)) : null,
    own.length ? h('ul', { class: 'findings' }, ...own.map((f) => findingLine({ ...f, count: 1 }, S))) : null,
    h('div', { class: 'actions' }, toggle, subBtn),
    jsonSlot,
    subSlot,
  );
}

function treeRow(row, result, S, origin) {
  const rec = result.graph.records.get(row.key);
  const level = row.kind === 'node' ? result.nodeLevel.get(row.key) || 'ok' : 'info';
  const pad = { style: `padding-left:${8 + row.depth * 18}px` };
  const prop = row.prop ? h('span', { class: 'prop', text: `${row.count > 1 ? row.count + '× ' : ''}${row.prop} →` }) : (row.count > 1 ? h('span', { class: 'prop', text: `${row.count}×` }) : null);

  if (row.kind === 'external') {
    return h('li', { class: 'row ref', ...pad },
      prop,
      h('code', { class: 'id', text: shortId(rec.id, origin) }),
      h('span', { class: 'tag', text: rec.sitewide ? S.sitewide : S.externalRef }),
    );
  }
  if (row.kind === 'group') {
    const counts = {};
    for (const k of row.keys) {
      const t = [...(result.graph.records.get(k).types)][0] || S.noType;
      counts[t] = (counts[t] || 0) + 1;
    }
    const slot = h('div', { class: 'detail-slot' });
    let open = false;
    const line = h('div', {
      class: 'row-line',
      role: 'button',
      tabindex: '0',
      onclick: () => {
        open = !open;
        li.classList.toggle('open', open);
        const rows = open ? buildTree(result.graph, { starts: row.keys, withSiteGroup: false, maxDepth: 3, levelOf: (k) => result.nodeLevel.get(k) || 'ok' }) : [];
        slot.replaceChildren(...(open ? [h('ul', { class: 'tree sub' }, ...rows.map((r) => treeRow(r, result, S, origin)))] : []));
      },
    },
    h('span', { class: 'type muted', text: S.siteGroup(row.keys.length) }),
    h('span', { class: 'chips' }, ...Object.entries(counts).map(([t, n]) => h('span', { class: 'chip soft', text: n > 1 ? `${n}× ${t}` : t }))),
    h('span', { class: 'spacer' }),
    dot('info'));
    line.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        line.click();
      }
    });
    const li = h('li', { class: 'row node group', style: 'padding-left:8px' }, line, slot);
    return li;
  }
  if (row.kind === 'seen') {
    return h('li', { class: 'row ref', ...pad },
      prop,
      h('span', { class: 'type', text: nodeLabel(rec, S) }),
      rec.id ? h('code', { class: 'id', text: shortId(rec.id, origin) }) : null,
      h('span', { class: 'tag', text: S.seenAbove }),
    );
  }

  const chips = Object.entries(row.chips || {}).filter(([type]) => S.chips[type]).map(([type, n]) => {
    const forms = S.chips[type];
    return h('span', { class: 'chip', text: n > 1 ? `${n} ${forms[1]}` : forms[0] });
  });
  const name = nodeName(rec);
  const detailSlot = h('div', { class: 'detail-slot' });
  let open = false;
  const line = h('div', {
    class: 'row-line',
    role: 'button',
    tabindex: '0',
    onclick: () => {
      open = !open;
      li.classList.toggle('open', open);
      detailSlot.replaceChildren(...(open ? [nodeDetail(rec, result, S, origin)] : []));
    },
  },
  prop,
  h('span', { class: 'type', text: nodeLabel(rec, S) }),
  name ? h('span', { class: 'name', text: name }) : null,
  h('span', { class: 'chips' }, ...chips, row.collapsed ? h('span', { class: 'chip soft', text: S.linked(row.collapsed) }) : null),
  h('span', { class: 'spacer' }),
  dot(level));
  line.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      line.click();
    }
  });
  const li = h('li', { class: `row node${row.key === result.main ? ' main' : ''}`, ...pad }, line, detailSlot);
  return li;
}

function schemaPanel(data, result, S) {
  const origin = data.origin;
  const pageLevel = result.findings.filter((f) => f.area === 'schema' && !f.node);
  const mainFinding = result.findings.find((f) => f.code === 'mainType');
  const mainLevel = mainFinding ? 'ok' : (pageLevel.find((f) => ['onlyGeneric', 'kindMismatch', 'noJsonLd'].includes(f.code)) || {}).level || 'info';

  let rawOpen = false;
  const rawSlot = h('div');
  const rawBtn = h('button', {
    class: 'link small',
    type: 'button',
    text: S.showJson,
    onclick: () => {
      rawOpen = !rawOpen;
      rawBtn.textContent = rawOpen ? S.hideJson : S.showJson;
      rawSlot.replaceChildren(...(rawOpen ? (data.jsonLd || []).map((b) =>
        h('div', { class: 'raw-block' }, h('div', { class: 'k', text: `${S.block} ${b.index}` }), jsonBlock(b.ok ? b.data : b.raw || '', S))) : []));
    },
  });

  const enc = encodeURIComponent(data.url);
  return h('section', { class: 'panel-inner' },
    h('div', { class: 'headline' },
      result.kind !== 'unknown' ? h('span', { class: 'muted', text: `${S.pageLooksLike}: ` }) : null,
      result.kind !== 'unknown' ? h('strong', { text: S[`kind_${result.kind}`] }) : null,
      result.kind !== 'unknown' ? h('span', { class: 'sep', text: '·' }) : null,
      h('span', { class: 'muted', text: `${S.mainTypeLabel}: ` }),
      h('strong', { text: result.mainType || S.none }),
      dot(mainLevel),
    ),
    result.tree.length ? h('ul', { class: 'tree' }, ...result.tree.map((row) => treeRow(row, result, S, origin))) : null,
    pageLevel.length ? h('div', { class: 'block' },
      h('div', { class: 'k', text: S.pageFindings }),
      h('ul', { class: 'findings' }, ...pageLevel.map((f) => findingLine(f, S)))) : null,
    h('div', { class: 'statsline' },
      h('span', { class: 'muted', text: S.stats(result.graph.stats) }),
      h('span', { class: 'spacer' }),
      rawBtn,
      h('a', { class: 'link small', href: `https://search.google.com/test/rich-results?url=${enc}`, target: '_blank', rel: 'noopener', text: S.richResults }),
      h('a', { class: 'link small', href: `https://validator.schema.org/#url=${enc}`, target: '_blank', rel: 'noopener', text: S.validator }),
    ),
    rawSlot,
  );
}

function anchorGroups(anchors, S) {
  return h('div', { class: 'anchors' }, ...['knowledge', 'ids', 'profiles', 'social'].map((g) =>
    h('div', { class: 'kv' },
      h('span', { class: 'k', text: S.anchors[g] }),
      anchors[g].length
        ? h('span', { class: 'chips' }, ...anchors[g].slice(0, 16).map((l) => h('span', { class: g === 'knowledge' ? 'chip strong' : 'chip', text: l })),
          anchors[g].length > 16 ? h('span', { class: 'chip more', text: `+${anchors[g].length - 16}` }) : null)
        : h('span', { class: 'muted', text: S.dash }))));
}

function entityPanel(data, result, S) {
  const e = result.entity || {};
  const list = result.findings.filter((f) => f.area === 'entity');
  const cards = [];
  if (e.org) {
    cards.push(h('div', { class: 'card' },
      e.org.logo ? h('img', { class: 'card-logo', src: e.org.logo, alt: '' }) : null,
      h('div', {},
        h('div', { class: 'k', text: S.orgCard }),
        h('div', { class: 'card-name', text: e.org.name }),
        e.org.legalName ? h('div', { class: 'muted', text: e.org.legalName }) : null)));
  }
  if (e.person) {
    cards.push(h('div', { class: 'card' },
      h('div', {},
        h('div', { class: 'k', text: S.authorCard }),
        h('div', { class: 'card-name', text: e.person.name }),
        e.person.jobTitle ? h('div', { class: 'muted', text: e.person.jobTitle }) : null)));
  }
  return h('section', { class: 'panel-inner' },
    cards.length ? h('div', { class: 'cards' }, ...cards) : null,
    e.orgAnchors ? anchorGroups(e.orgAnchors, S) : null,
    e.topics && e.topics.length ? h('div', { class: 'kv' }, h('span', { class: 'k', text: S.topicsLabel }),
      h('span', { class: 'chips' }, ...e.topics.map((t) => h('span', { class: t.kb ? 'chip strong' : 'chip', text: t.label })))) : null,
    h('ul', { class: 'findings' }, ...list.map((f) => findingLine(f, S))),
  );
}

function accessPanel(data, result, S) {
  const access = result.findings.filter((f) => f.area === 'access');
  const content = result.findings.filter((f) => f.area === 'content');
  const botList = (group) => h('ul', { class: 'bots' }, ...result.bots.filter((b) => b.group === group).map((b) =>
    h('li', { class: `bot lvl-${b.level}` }, dot(b.level), h('span', { class: 'bot-name', text: b.name }),
      h('span', { class: 'muted', text: b.allowed ? S.allowed : S.blocked }))));
  return h('section', { class: 'panel-inner' },
    h('div', { class: 'k section', text: S.secContent }),
    h('ul', { class: 'findings' }, ...content.map((f) => findingLine(f, S))),
    h('div', { class: 'k section', text: S.secAccess }),
    h('ul', { class: 'findings' }, ...access.map((f) => findingLine(f, S))),
    h('div', { class: 'bot-grid' },
      h('div', {}, h('div', { class: 'k', text: S.botsSearch }), botList('search')),
      h('div', {}, h('div', { class: 'k', text: S.botsTraining }), botList('training')),
    ),
  );
}

const ROW_OF = {
  titleMissing: 'title', titleLong: 'title', title: 'title',
  descMissing: 'desc', descLong: 'desc', desc: 'desc',
  h1Missing: 'h1', h1Multiple: 'h1', h1: 'h1',
  langMissing: 'lang', lang: 'lang',
  canonicalMissing: 'canonical', canonicalSelf: 'canonical', canonicalOther: 'canonical',
  noindex: 'index', indexable: 'index',
  ogOk: 'og', ogMissing: 'og',
  sitemapRobots: 'sitemap', sitemapNotInRobots: 'sitemap', sitemapMissing: 'sitemap',
  hreflang: 'hreflang', hreflangNone: 'hreflang',
  headingOrder: 'headings', headingSkips: 'headings', headingEmpty: 'headings',
};

function basicsPanel(data, result, S) {
  const list = result.findings.filter((f) => f.area === 'basics');
  const rows = h('tbody');
  for (const f of list) {
    const row = ROW_OF[f.code];
    const fn = S.cell[f.code];
    rows.append(h('tr', { class: `lvl-${f.level}` },
      h('th', { scope: 'row', text: row ? S.rows[row] : f.code }),
      h('td', { class: 'dotcell' }, dot(f.level)),
      h('td', { text: fn ? fn(f.vars) : f.code })));
  }
  const headings = data.headings || [];
  let prev = 0;
  const outline = h('ol', { class: 'outline' }, ...headings.map((x) => {
    const jump = prev && x.level > prev + 1;
    if (!x.chrome) prev = x.level;
    return h('li', { class: `hl hl-${x.level}${x.chrome ? ' chrome' : ''}${jump && !x.chrome ? ' jump' : ''}`, style: `padding-left:${(x.level - 1) * 18}px` },
      h('span', { class: 'htag', text: `H${x.level}` }),
      h('span', { class: x.text ? 'htext' : 'htext muted', text: x.text || S.emptyHeading }),
      x.chrome ? h('span', { class: 'tag', text: S.inChrome }) : null);
  }));
  return h('section', { class: 'panel-inner' },
    h('table', { class: 'facts' }, rows),
    headings.length ? h('div', { class: 'k section', text: S.headingsTitle }) : null,
    headings.length ? outline : null,
  );
}

export function render(root, data, result, S, langKey) {
  const c = result.counts;
  const tabs = [
    { id: 'schema', label: S.tabSchema, areas: ['schema'], build: () => schemaPanel(data, result, S) },
    { id: 'entity', label: S.tabEntity, areas: ['entity'], build: () => entityPanel(data, result, S) },
    { id: 'access', label: S.tabAccess, areas: ['access', 'content'], build: () => accessPanel(data, result, S) },
    { id: 'basics', label: S.tabBasics, areas: ['basics'], build: () => basicsPanel(data, result, S) },
  ];
  const panel = h('main', { class: 'panel' });
  const buttons = tabs.map((t) => {
    const a = t.areas.reduce((acc, id) => ({ err: acc.err + result.perArea[id].err, warn: acc.warn + result.perArea[id].warn }), { err: 0, warn: 0 });
    const badge = a.err ? h('span', { class: 'badge lvl-err', text: a.err }) : a.warn ? h('span', { class: 'badge lvl-warn', text: a.warn }) : null;
    const b = h('button', {
      class: 'tab',
      type: 'button',
      role: 'tab',
      onclick: () => select(t.id),
    }, t.label, badge);
    b.dataset.tab = t.id;
    return b;
  });
  function select(id) {
    buttons.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
    panel.replaceChildren(tabs.find((t) => t.id === id).build());
    panel.scrollTop = 0;
  }

  if (!root.querySelector('#body')) mountShell(root, S, data.url, langKey);
  const url = root.querySelector('#url');
  url.textContent = shortUrl(data.url);
  url.title = data.url;
  root.querySelector('#body').replaceChildren(
    h('div', { class: 'summary' },
      h('span', { class: 'pill lvl-ok' }, dot("ok"), S.pill.ok(c.ok)),
      h('span', { class: 'pill lvl-warn' }, dot("warn"), S.pill.warn(c.warn)),
      h('span', { class: 'pill lvl-err' }, dot("err"), S.pill.err(c.err)),
      h('span', { class: 'spacer' }),
      verdict(catState(c), S),
    ),
    h('nav', { class: 'tabs', role: 'tablist' }, ...buttons),
    panel,
  );
  const foot = root.querySelector('footer.cta');
  if (foot) foot.replaceWith(footer(S, langKey, catState(c)));
  finishCat(c.err === 0);
  select('schema');
}
