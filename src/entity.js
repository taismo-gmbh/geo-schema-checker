// Entitäts-Signale der Seite: Wer steht dahinter, wie fest ist die Entität verankert
// (Wissensdatenbanken, Kennungen, Profile), stimmen Schema und sichtbare Seite überein,
// und sind Autor und Themen eindeutig verknüpft. Alles nur aus der Seite selbst,
// keine Abfrage fremder Dienste.

import { ORGANIZATION_TYPES, PERSON_TYPES } from './schema-types.js';

const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

const GROUPS = [
  ['knowledge', /(^|\.)(wikidata\.org|wikipedia\.org|dbpedia\.org)$/],
  ['ids', /(^|\.)(isni\.org|orcid\.org|viaf\.org|d-nb\.info|opencorporates\.com|northdata\.(de|com)|handelsregister\.de|unternehmensregister\.de|gleif\.org|lei-lookup\.com)$/],
  ['social', /(^|\.)(facebook\.com|instagram\.com|x\.com|twitter\.com|youtube\.com|tiktok\.com|pinterest\.[a-z.]+|threads\.net|bsky\.app)$/],
];

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch (e) {
    return '';
  }
}

function anchorLabel(url) {
  const host = hostOf(url);
  if (host === 'wikidata.org') {
    const q = /\/(Q\d+)/.exec(url);
    return q ? `Wikidata ${q[1]}` : 'Wikidata';
  }
  if (host.endsWith('wikipedia.org')) return `Wikipedia (${host.split('.')[0]})`;
  if (host === 'isni.org') return 'ISNI';
  if (host === 'orcid.org') return 'ORCID';
  if (host === 'd-nb.info') return 'DNB';
  return host;
}

export function classifyAnchors(rec) {
  const groups = { knowledge: [], ids: [], profiles: [], social: [] };
  if (!rec) return groups;
  for (const url of asArray(rec.props.sameAs)) {
    if (typeof url !== 'string') continue;
    const host = hostOf(url);
    if (!host) continue;
    const group = (GROUPS.find(([, re]) => re.test(host)) || ['profiles'])[0];
    const label = anchorLabel(url);
    if (!groups[group].includes(label)) groups[group].push(label);
  }
  for (const id of asArray(rec.props.identifier)) {
    if (id && typeof id === 'object' && id.propertyID) {
      const label = String(id.propertyID);
      if (!groups.ids.includes(label)) groups.ids.push(label);
    }
  }
  return groups;
}

const isOrg = (rec) => [...rec.types].some((t) => ORGANIZATION_TYPES.has(t));
const isPerson = (rec) => [...rec.types].some((t) => PERSON_TYPES.has(t));

function streetKey(s) {
  return norm(s).replace(/straße|strasse/g, 'str').replace(/[.,]/g, '').replace(/\s+/g, ' ');
}

const lastDigits = (s, n = 8) => String(s || '').replace(/\D/g, '').slice(-n);

function logoUrl(rec, graph) {
  for (const v of asArray(rec.props.logo)) {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const ref = v['@id'] && graph.records.get(v['@id']);
      const src = v.url || v.contentUrl || (ref && (ref.props.url || ref.props.contentUrl));
      if (typeof src === 'string') return src;
    }
  }
  return null;
}

export function evaluateEntity(d, graph, ctx, add) {
  const { primaryOrg, main, kind } = ctx;
  const text = d.text || '';
  const textStreets = streetKey(text);
  const textDigits = String(text).replace(/\D/g, '') + ' ' + (d.telLinks || []).map((t) => t.replace(/\D/g, '')).join(' ');

  const card = { org: null, person: null, orgAnchors: null, personAnchors: null, topics: [] };

  // Organisation hinter der Seite
  if (!primaryOrg) {
    add('entity', 'warn', 'entNoOrg');
  } else {
    const r = primaryOrg;
    card.org = {
      name: r.props.name || r.props.legalName || '',
      legalName: r.props.legalName && r.props.legalName !== r.props.name ? r.props.legalName : '',
      logo: logoUrl(r, graph),
      url: typeof r.props.url === 'string' ? r.props.url : '',
    };
    const anchors = classifyAnchors(r);
    card.orgAnchors = anchors;
    const sameAs = asArray(r.props.sameAs).length;
    if (sameAs === 0) add('entity', 'warn', 'orgNoSameAs', {}, r.key);
    else if (sameAs < 3) add('entity', 'warn', 'orgFewSameAs', { n: sameAs }, r.key);
    else add('entity', 'ok', 'orgSameAs', { n: sameAs }, r.key);
    if (anchors.knowledge.length) add('entity', 'ok', 'entKnowledge', { list: anchors.knowledge.join(', ') }, r.key);
    else add('entity', 'warn', 'entNoKnowledge', {}, r.key);
    if (anchors.ids.length) add('entity', 'ok', 'entIds', { list: anchors.ids.join(', ') }, r.key);
    else add('entity', 'info', 'entNoIds');

    // Konsistenz Schema gegen sichtbare Seite
    const names = [r.props.name, r.props.legalName, ...asArray(r.props.alternateName)].filter((x) => typeof x === 'string' && x.trim());
    if (names.length) {
      if (names.some((n) => text.includes(norm(n)))) add('entity', 'ok', 'entNameVisible');
      else add('entity', 'warn', 'entNameHidden', { name: names[0] });
    }
    const phones = [r.props.telephone, ...asArray(r.props.contactPoint).map((c) => c && c.telephone)]
      .filter((x) => typeof x === 'string' && lastDigits(x).length >= 6);
    if (phones.length) {
      if (phones.some((p) => textDigits.includes(lastDigits(p)))) add('entity', 'ok', 'entPhoneVisible');
      else add('entity', 'warn', 'entPhoneHidden', { phone: phones[0] });
      const tel = (d.telLinks || []).filter((t) => lastDigits(t).length >= 6);
      if (tel.length && !tel.some((t) => phones.some((p) => lastDigits(t) === lastDigits(p)))) {
        add('entity', 'warn', 'entPhoneMismatch', { page: tel[0], schema: phones[0] });
      }
    }
    const addr = asArray(r.props.address).find((a) => a && typeof a === 'object');
    if (addr && (addr.streetAddress || addr.postalCode)) {
      const streetOk = !addr.streetAddress || textStreets.includes(streetKey(addr.streetAddress));
      const zipOk = !addr.postalCode || text.includes(norm(addr.postalCode));
      if (streetOk && zipOk) add('entity', 'ok', 'entAddressVisible');
      else add('entity', 'warn', 'entAddressHidden', { address: [addr.streetAddress, addr.postalCode, addr.addressLocality].filter(Boolean).join(', ') });
    }
  }

  // Gleiche Organisation unter verschiedenen @ids
  const byName = new Map();
  for (const r of graph.nodes.filter((x) => isOrg(x) && x.fullDefs > 0)) {
    const name = norm(r.props.name);
    if (name) byName.set(name, (byName.get(name) || []).concat(r));
  }
  for (const list of byName.values()) {
    if (list.length > 1) add('entity', 'warn', 'orgDuplicate', { name: list[0].props.name, n: list.length });
  }

  // Autor
  const sources = [main, graph.pageNode, ...(graph.pageNodes || [])].filter(Boolean);
  let author = null;
  for (const s of sources) {
    const e = (graph.edges.get(s.key) || []).find((x) => x.prop === 'author');
    if (e) {
      author = graph.records.get(e.to);
      break;
    }
  }
  if (author && author.external) {
    add('entity', 'info', 'entAuthorRef');
  } else if (author) {
    card.person = { name: author.props.name || '', jobTitle: typeof author.props.jobTitle === 'string' ? author.props.jobTitle : '' };
    card.personAnchors = classifyAnchors(author);
    const name = typeof author.props.name === 'string' ? author.props.name : '';
    if (name) {
      if (text.includes(norm(name))) add('entity', 'ok', 'entAuthorVisible', { name });
      else add('entity', 'warn', 'entAuthorHidden', { name });
    }
    if (isPerson(author)) {
      const n = asArray(author.props.sameAs).length;
      if (n) add('entity', 'ok', 'entAuthorSameAs', { n });
      else add('entity', 'warn', 'entAuthorNoSameAs');
    }
  } else if (kind === 'article' || kind === 'glossary') {
    add('entity', 'warn', 'entNoAuthor');
  }

  // Themen: about und mentions mit Verweis auf eine Wissensdatenbank
  const seen = new Set();
  for (const s of sources) {
    for (const e of graph.edges.get(s.key) || []) {
      if (e.prop !== 'about' && e.prop !== 'mentions') continue;
      const t = graph.records.get(e.to);
      if (!t || t.external || seen.has(t.key) || isOrg(t) || isPerson(t)) continue;
      seen.add(t.key);
      const kb = classifyAnchors(t).knowledge.length > 0;
      card.topics.push({ label: t.props.name || [...t.types][0] || '', kb });
    }
  }
  const linked = card.topics.filter((t) => t.kb).length;
  if (card.topics.length && linked) add('entity', 'ok', 'entTopicsLinked', { n: linked, total: card.topics.length });
  else if (card.topics.length) add('entity', 'warn', 'entTopicsUnlinked', { n: card.topics.length });
  else add('entity', kind === 'article' || kind === 'glossary' ? 'warn' : 'info', 'entNoTopics');

  return card;
}
