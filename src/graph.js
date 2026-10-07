// Baut aus allen JSON-LD-Blöcken einer Seite einen Graphen, so wie Google ihn liest:
// @graph wird aufgelöst, Knoten mit gleicher @id werden zusammengeführt,
// {"@id": "…"} ohne weitere Angaben ist ein Verweis.

import { ORGANIZATION_TYPES, PERSON_TYPES, WEBPAGE_TYPES } from './schema-types.js';

const META_KEYS = new Set(['@context', '@type', '@id', '@graph', '@language', '@vocab', '@reverse']);

// Listen-Eigenschaften: Liefern zwei Quellen dieselbe Liste unter derselben @id,
// ergänzen sie sich nicht, sie widersprechen sich (E4).
const LIST_KEYS = new Set(['itemListElement', 'mainEntity', 'hasPart']);

// Hilfsknoten erscheinen im Baum nicht als eigene Zeile, sondern als Chip am Elternknoten.
export const MINOR_TYPES = new Set([
  'PostalAddress', 'GeoCoordinates', 'GeoShape', 'ContactPoint', 'OpeningHoursSpecification',
  'PropertyValue', 'PropertyValueSpecification', 'ListItem', 'EntryPoint', 'SearchAction', 'ReadAction',
  'CommunicateAction', 'SpeakableSpecification', 'Question', 'Answer', 'Rating', 'AggregateRating', 'Review',
  'Offer', 'AggregateOffer', 'PriceSpecification', 'UnitPriceSpecification', 'QuantitativeValue',
  'MonetaryAmount', 'Country', 'City', 'State', 'AdministrativeArea', 'Place', 'ImageObject',
  'VideoObject', 'Language', 'DefinedRegion', 'OfferShippingDetails', 'MerchantReturnPolicy',
  'ShippingDeliveryTime', 'InteractionCounter', 'Audience', 'BusinessAudience', 'Duration',
  'EducationalOccupationalCredential', 'Occupation', 'OrganizationRole', 'Role', 'EmployeeRole',
  'ShippingService', 'ServicePeriod', 'ShippingConditions',
]);

const ENTITY_EXTRA = new Set(['WebSite', 'Brand']);

export function normType(t) {
  return String(t).replace(/^https?:\/\/schema\.org\//, '').replace(/^schema:/, '');
}

export function typesOf(obj) {
  const t = obj && obj['@type'];
  const list = typeof t === 'string' ? [t] : Array.isArray(t) ? t.filter((x) => typeof x === 'string') : [];
  return list.map(normType);
}

export const isEntity = (rec) => [...rec.types].some((t) => ORGANIZATION_TYPES.has(t) || PERSON_TYPES.has(t) || ENTITY_EXTRA.has(t));
export const isPage = (rec) => [...rec.types].some((t) => WEBPAGE_TYPES.has(t));

function sameOrigin(id, origin) {
  try {
    return new URL(id, origin).origin === origin;
  } catch (e) {
    return false;
  }
}

function cleanUrl(u, origin) {
  try {
    const x = new URL(u, origin);
    return (x.origin + x.pathname).replace(/\/$/, '');
  } catch (e) {
    return String(u || '');
  }
}

export function buildGraph(blocks, origin, pageUrl) {
  const records = new Map();
  const edges = new Map();
  let anon = 0;

  const ensure = (key, id) => {
    if (!records.has(key)) {
      records.set(key, {
        key,
        id: id || null,
        types: new Set(),
        sources: new Set(),
        defs: [],
        props: {},
        propSource: {},
        listConflicts: new Set(),
        fullDefs: 0,
        external: false,
      });
    }
    return records.get(key);
  };

  const addEdge = (from, prop, to, kind) => {
    if (!edges.has(from)) edges.set(from, []);
    const list = edges.get(from);
    if (!list.some((e) => e.prop === prop && e.to === to)) list.push({ prop, to, kind });
  };

  function walkValue(value, prop, fromKey, block) {
    if (Array.isArray(value)) {
      value.forEach((v) => walkValue(v, prop, fromKey, block));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const hasId = typeof value['@id'] === 'string';
    const onlyRef = hasId && Object.keys(value).every((k) => k === '@id' || k === '@context');
    if (onlyRef) {
      addEdge(fromKey, prop, value['@id'], 'ref');
      return;
    }
    if (value['@type'] || hasId) {
      const childKey = register(value, block);
      addEdge(fromKey, prop, childKey, hasId ? 'ref' : 'inline');
      return;
    }
    for (const v of Object.values(value)) walkValue(v, prop, fromKey, block);
  }

  function register(obj, block) {
    const id = typeof obj['@id'] === 'string' ? obj['@id'] : null;
    const key = id || `_:${++anon}`;
    const rec = ensure(key, id);
    typesOf(obj).forEach((t) => rec.types.add(t));
    rec.sources.add(block);
    rec.defs.push({ block, data: obj });
    const propKeys = Object.keys(obj).filter((k) => !META_KEYS.has(k));
    if (propKeys.length >= 2) rec.fullDefs += 1;
    for (const k of propKeys) {
      if (k in rec.props) {
        if (LIST_KEYS.has(k) && rec.propSource[k] !== block) rec.listConflicts.add(k);
      } else {
        rec.props[k] = obj[k];
        rec.propSource[k] = block;
      }
    }
    for (const k of propKeys) walkValue(obj[k], k, key, block);
    return key;
  }

  function top(value, block) {
    if (Array.isArray(value)) {
      value.forEach((v) => top(v, block));
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value['@graph'])) {
      value['@graph'].forEach((v) => top(v, block));
      const rest = Object.keys(value).filter((k) => !META_KEYS.has(k));
      if (rest.length) {
        const copy = { ...value };
        delete copy['@graph'];
        register(copy, block);
      }
      return;
    }
    register(value, block);
  }

  for (const b of blocks) if (b.ok) top(b.data, b.index);

  // Verweise auf @ids, die auf der Seite nicht definiert sind
  for (const list of edges.values()) {
    for (const e of list) {
      if (!records.has(e.to)) {
        const rec = ensure(e.to, e.to);
        rec.external = true;
        rec.sitewide = sameOrigin(e.to, origin);
      }
    }
  }

  const incoming = new Map();
  for (const [from, list] of edges) {
    for (const e of list) {
      if (e.to === from) continue;
      if (!incoming.has(e.to)) incoming.set(e.to, new Set());
      incoming.get(e.to).add(from);
    }
  }

  const isMinor = (rec) => rec.types.size > 0 && [...rec.types].every((t) => MINOR_TYPES.has(t));
  const nodes = [...records.values()].filter((r) => !r.external);

  // Erreichbarkeit
  function reach(start, stopAtEntities) {
    const seen = new Set();
    const stack = [start];
    while (stack.length) {
      const k = stack.pop();
      if (seen.has(k)) continue;
      seen.add(k);
      const rec = records.get(k);
      if (!rec || rec.external) continue;
      if (stopAtEntities && k !== start && isEntity(rec)) continue;
      for (const e of edges.get(k) || []) stack.push(e.to);
    }
    return seen;
  }

  // Seitenknoten: die WebPage dieser URL, sonst die erste Seite im Graphen
  const base = pageUrl || origin;
  const target = cleanUrl(pageUrl, origin);
  const pages = nodes.filter((r) => isPage(r));
  const matches = (r) => [r.id, r.props.url].some((u) => u && cleanUrl(String(u).split('#')[0] || base, base) === target);
  const notFaq = (r) => !r.types.has('FAQPage');
  const pageNodes = pages.filter((r) => matches(r) && notFaq(r));
  const pageNode = pageNodes[0] || pages.find(notFaq) || pages.find(matches) || pages[0] || null;

  // Weitere Wurzeln: was vom Seitenknoten aus nicht erreichbar ist
  const covered = pageNode ? reach(pageNode.key, false) : new Set();
  const extras = [];
  const rank = (r) => (isPage(r) ? 0 : isEntity(r) ? 2 : isMinor(r) ? 3 : 1);
  let rest = nodes.filter((r) => !covered.has(r.key));
  while (rest.length) {
    const restKeys = new Set(rest.map((r) => r.key));
    const roots = rest.filter((r) => ![...(incoming.get(r.key) || [])].some((k) => restKeys.has(k) && k !== r.key));
    const pick = (roots.length ? roots : rest).sort((a, b) => rank(a) - rank(b))[0];
    extras.push(pick);
    for (const k of reach(pick.key, false)) covered.add(k);
    rest = nodes.filter((r) => !covered.has(r.key));
  }

  // Weitere Wurzeln trennen: Was zur Seite gehört (@id unter dieser URL, ohne @id, Seitentyp),
  // und was sitewide mitgeliefert wird (z. B. Podcast, Buch, Presseartikel der Organisation).
  const isHome = (() => {
    try {
      return new URL(base).pathname === '/';
    } catch (e) {
      return false;
    }
  })();
  const pageKeys = new Set(pages.map((r) => r.key));
  const linksToPage = (r) => (edges.get(r.key) || []).some((e) => pageKeys.has(e.to));
  const ownId = (r) => !r.id || (!isHome && cleanUrl(String(r.id).split('#')[0] || base, base) === target);
  const pageExtras = extras.filter((r) => !pageNode || isPage(r) || ownId(r) || linksToPage(r));
  const siteExtras = extras.filter((r) => !pageExtras.includes(r));

  // Seiteneigene Knoten: erreichbar, ohne sitewide Entitäten aufzuklappen
  const local = new Set();
  for (const start of [pageNode, ...pageExtras].filter(Boolean)) {
    if (start !== pageNode && isEntity(start)) {
      local.add(start.key);
      continue;
    }
    for (const k of reach(start.key, true)) local.add(k);
  }

  const isolated = nodes.filter((r) => !incoming.get(r.key) && !(edges.get(r.key) || []).length);

  return {
    records,
    edges,
    incoming,
    nodes,
    pageNode,
    pageNodes,
    extras: pageExtras,
    siteExtras,
    local,
    isMinor,
    reach,
    stats: {
      blocks: blocks.length,
      nodes: nodes.length,
      isolated: nodes.length > 1 ? isolated.length : 0,
      external: [...records.values()].filter((r) => r.external).length,
    },
  };
}

// Baum für die Anzeige. Hilfsknoten werden zu Chips, sitewide Entitäten (Organisation,
// Person, WebSite, Marke) bleiben eingeklappt, gleiche Geschwister werden zusammengefasst.
export function buildTree(graph, opts = {}) {
  const {
    starts = [graph.pageNode, ...graph.extras].filter(Boolean).map((r) => r.key),
    expandStart = false,
    maxDepth = 5,
    levelOf = () => 'ok',
  } = opts;
  const rows = [];
  const shown = new Set();
  const entityCount = (key) => [...graph.reach(key, false)].filter((k) => {
    const r = graph.records.get(k);
    return k !== key && r && !r.external && !graph.isMinor(r);
  }).length;

  function visit(key, depth, prop, count = 1) {
    const rec = graph.records.get(key);
    if (!rec) return;
    if (rec.external) {
      rows.push({ depth, key, prop, kind: 'external', count });
      return;
    }
    if (shown.has(key)) {
      if (isPage(rec)) rows.push({ depth, key, prop, kind: 'seen', count });
      return;
    }
    shown.add(key);
    const row = { depth, key, prop, kind: 'node', chips: {}, collapsed: 0, count };
    rows.push(row);
    if (isEntity(rec) && !(depth === 0 && expandStart)) {
      row.collapsed = entityCount(key);
      return;
    }
    if (depth >= maxDepth) return;

    const children = [];
    for (const e of graph.edges.get(key) || []) {
      const t = graph.records.get(e.to);
      if (!t || e.to === key) continue;
      if (!t.external && graph.isMinor(t)) {
        const label = [...t.types][0];
        row.chips[label] = (row.chips[label] || 0) + 1;
        continue;
      }
      children.push(e);
    }
    // Gleiche Geschwister zusammenfassen (z. B. 40 Produktvarianten)
    const groups = new Map();
    for (const e of children) {
      const t = graph.records.get(e.to);
      const sig = t.external ? `x|${e.prop}|${e.to}` : `${e.prop}|${[...t.types].sort().join(',')}|${levelOf(e.to)}`;
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig).push(e);
    }
    for (const list of groups.values()) {
      const first = list[0];
      const t = graph.records.get(first.to);
      if (list.length >= 3 && !t.external) {
        list.slice(1).forEach((e) => shown.add(e.to));
        visit(first.to, depth + 1, first.prop, list.length);
      } else {
        list.forEach((e) => visit(e.to, depth + 1, e.prop));
      }
    }
  }

  for (const k of starts) visit(k, 0, null);
  if (opts.withSiteGroup !== false && !opts.starts && graph.siteExtras.length) {
    rows.push({ depth: 0, kind: 'group', keys: graph.siteExtras.map((r) => r.key) });
  }
  return rows;
}
