/* Fusion AI Studio Explorer — knowledge-graph explorer for the Oracle AI Studio corpus.
 *
 * Reads window.FUSION_GRAPH (tools/build-search-app.mjs). Metrics — pagerank,
 * betweenness, bridgeScore, community, blastRadius, clustering, articulation —
 * are precomputed by tools/compute-graph-metrics.mjs over the typed dependency
 * graph, so this file only presents them.
 *
 * Two surfaces:
 *   Graph     focus a node, walk its neighbourhood, read its structural signals
 *   Data Lab  the whole corpus as a sortable table, plus path and impact tools
 */

'use strict';

const G = window.FUSION_GRAPH;
const NODES = G.nodes;
const EDGES = G.edges;
const N = NODES.length;

// ---------------------------------------------------------------- indexes

const byId = new Map(NODES.map((n) => [n.id, n]));
const idx = new Map(NODES.map((n, i) => [n.id, i]));
const outAdj = Array.from({ length: N }, () => []);
const inAdj = Array.from({ length: N }, () => []);
for (const e of EDGES) {
  const s = idx.get(e.source);
  const t = idx.get(e.target);
  if (s === undefined || t === undefined) continue;
  outAdj[s].push(e);
  inAdj[t].push(e);
}

const hay = NODES.map((n) =>
  [n.label, n.code, n.summary, n.workflow, n.family, n.product, n.nodeType, n.type, n.body, n.owner, n.section]
    .filter(Boolean).join('  ').toLowerCase());

const relCounts = new Map();
for (const e of EDGES) relCounts.set(e.relation, (relCounts.get(e.relation) ?? 0) + 1);

const COMMUNITIES = new Set(NODES.map((n) => n.community).filter((c) => c !== undefined));

/**
 * Oracle AI Agent Studio's hierarchy, top down. Assigned in the extractor;
 * `stackRole` distinguishes a supervising team from a plain agent workflow.
 */
const STACK = [
  // the authoring corpus — the skill package this repo exists to ship
  { layer: 11, name: 'Skills', note: 'the entry point', color: '#f28b82', half: 'authoring' },
  { layer: 10, name: 'Playbooks & references', note: 'the prose a skill routes to', color: '#f6aea9', half: 'authoring' },
  { layer: 9, name: 'Rules & conventions', note: 'what that prose requires and forbids', color: '#fbc02d', half: 'authoring' },
  { layer: 8, name: 'Specs & vocabulary', note: 'artifact types, node types, test kinds', color: '#e8c46a', half: 'authoring' },
  { layer: 7, name: 'CLI surface', note: 'the commands that enforce it', color: '#bdae6d', half: 'authoring' },
  // the sample corpus — Oracle's worked example of that contract
  { layer: 5, name: 'Business outcomes', note: 'the result', color: '#f2b57a', half: 'sample' },
  { layer: 4, name: 'Agentic applications', note: 'the product', color: '#c58af9', half: 'sample' },
  { layer: 3, name: 'Agent teams', note: 'supervisor + workflow', color: '#8ab4f8', half: 'sample' },
  { layer: 2, name: 'Agents', note: 'compose tools', color: '#5ec8bf', half: 'sample' },
  { layer: 1, name: 'Tools', note: 'used by agents', color: '#6dd58c', half: 'sample' },
  { layer: 0, name: 'Agent internals', note: 'workflow steps', color: '#6d8fc4', half: 'sample' },
  { layer: -1, name: 'Findings', note: 'unwired branches, unresolved refs', color: '#9aa0a6', half: 'findings' },
];
const STACK_BY_LAYER = new Map(STACK.map((x) => [x.layer, x]));
const layerColor = (l) => STACK_BY_LAYER.get(l)?.color ?? cssVar('--t-other');

/** Edges that attach many artifacts to one shared label. Hidden by default: they
 *  bury the dependency structure the graph view is for. Metrics already exclude them. */
const CLASSIFICATION_RELS = new Set([
  'in_family', 'in_product', 'belongs_to_family', 'is_artifact_type', 'in_group',
  'has_verb', 'routes_artifact', 'operates_on', 'documents_artifact',
  'targets_family', 'uses_model', 'governed_by', 'reads_app_context',
  'routes_app_stage', 'has_issue', 'is_tool_type', 'uses_tool_type',
  'is_node_type', 'operates_on_test', 'exercises',
]);
const FLOW_RELS = new Set(['flows_to', 'converges_to', 'on_error_to']);
const DATA_RELS = new Set(['reads_output_of', 'calls_bo_function', 'uses_business_object',
  'depends_on_data', 'calls_rest', 'exposes_rest_resource', 'belongs_to']);

// ---------------------------------------------------------------- dom helpers

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return e;
};
const num = (v, d = 0) => (typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: d }) : '—');
const sci = (v) => (typeof v === 'number' ? (v < 1e-3 ? v.toExponential(1) : v.toFixed(4)) : '—');

// ---------------------------------------------------------------- colour + size

const CSS = getComputedStyle(document.documentElement);
const cssVar = (name, fallback = '#888') => CSS.getPropertyValue(name).trim() || fallback;

// Memoised because paint() asks for a colour per node per frame. The cache holds
// resolved values from one theme, so setTheme() has to drop it.
const typeColorCache = new Map();
const typeColor = (t) => {
  if (!typeColorCache.has(t)) typeColorCache.set(t, cssVar(`--t-${t}`, cssVar('--t-other')));
  return typeColorCache.get(t);
};

/** Golden-angle hue so adjacent community ids never share a colour. */
const hashColor = (k) => {
  if (k === undefined || k === null) return cssVar('--t-other');
  const s = String(k);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `hsl(${(Math.abs(h) * 137.508) % 360} 58% 62%)`;
};

function colorOf(node) {
  switch (state.colorBy) {
    case 'layer': return layerColor(node.layer);
    case 'community': return hashColor(node.community);
    case 'family': return node.family ? hashColor(node.family) : cssVar('--t-other');
    case 'nodeType': return node.nodeType ? hashColor(node.nodeType) : cssVar('--t-other');
    default: return typeColor(node.type);
  }
}

const SIZE_MAX = new Map();
function sizeOf(node) {
  const key = state.sizeBy;
  if (key === 'uniform') return 5.5;
  if (!SIZE_MAX.has(key)) SIZE_MAX.set(key, Math.max(...NODES.map((x) => x[key] ?? 0)) || 1);
  const frac = (node[key] ?? 0) / SIZE_MAX.get(key);
  return 3.4 + Math.sqrt(Math.max(frac, 0)) * 12;
}

// ---------------------------------------------------------------- state

const state = {
  tab: 'graph',
  rtab: 'node',
  focus: null,
  depth: 1,
  colorBy: 'community',
  sizeBy: 'pagerank',
  layout: 'concentric',
  hiddenRels: new Set(CLASSIFICATION_RELS),
  lab: { q: '', layer: '', type: '', family: '', flag: '', sort: 'pagerank', dir: -1 },
  browse: { q: '', by: 'section', open: new Set(['Applications']), expanded: new Set() },
  leftCollapsed: false,
  rightCollapsed: false,
};

const relVisible = (r) => !state.hiddenRels.has(r);

// ---------------------------------------------------------------- neighbourhood

let slice = { ids: [], edges: [], hop: new Map() };

function computeSlice() {
  if (!state.focus) { slice = { ids: [], edges: [], hop: new Map() }; return; }
  const hop = new Map([[state.focus, 0]]);
  let frontier = [state.focus];
  for (let d = 1; d <= state.depth; d++) {
    const next = [];
    for (const id of frontier) {
      const i = idx.get(id);
      if (i === undefined) continue;
      for (const e of outAdj[i]) {
        if (!relVisible(e.relation) || hop.has(e.target)) continue;
        hop.set(e.target, d); next.push(e.target);
      }
      for (const e of inAdj[i]) {
        if (!relVisible(e.relation) || hop.has(e.source)) continue;
        hop.set(e.source, d); next.push(e.source);
      }
    }
    frontier = next;
    if (hop.size > 420) break; // keep the canvas readable
  }
  const ids = [...hop.keys()];
  const set = new Set(ids);
  const edges = EDGES.filter((e) => set.has(e.source) && set.has(e.target) && relVisible(e.relation));
  slice = { ids, edges, hop };
}

// ---------------------------------------------------------------- layouts

let sim = { nodes: [], at: new Map(), edges: [], tx: 0, ty: 0, scale: 1, raf: 0, alpha: 0, energy: 0 };

function seedPositions() {
  const { ids, edges, hop } = slice;
  const w = cv.clientWidth || 900;
  const h = cv.clientHeight || 600;
  const nodes = ids.map((id) => ({ id, x: 0, y: 0, vx: 0, vy: 0, deg: 0, hop: hop.get(id) ?? 0 }));
  const at = new Map(nodes.map((x) => [x.id, x]));
  for (const e of edges) {
    const a = at.get(e.source); if (a) a.deg++;
    const b = at.get(e.target); if (b) b.deg++;
  }

  const byHop = new Map();
  for (const x of nodes) {
    if (!byHop.has(x.hop)) byHop.set(x.hop, []);
    byHop.get(x.hop).push(x);
  }

  if (state.layout === 'stack') {
    // One band per layer of the Agent Studio hierarchy, outcomes on top.
    // Band heights follow their content so a 250-node band cannot spill into
    // its neighbour, and the geometry is handed to paint() so the captions and
    // separators live in the same coordinate space as the nodes.
    const present = STACK
      .filter((L) => nodes.some((x) => byId.get(x.id)?.layer === L.layer))
      .map((L) => {
        const list = nodes
          .filter((x) => byId.get(x.id)?.layer === L.layer)
          .sort((a, b) => (byId.get(b.id)?.pagerank ?? 0) - (byId.get(a.id)?.pagerank ?? 0));
        // Aim each band at roughly 3:1, and tighten spacing as the band grows —
        // a 280-node band laid out at label spacing is 5,000px wide, which makes
        // fit() crush the whole stack into a strip.
        const n = list.length;
        const perRow = Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n * 3))));
        const subRows = Math.ceil(n / perRow);
        const spacing = Math.max(24, Math.min(132, 1700 / perRow));
        const subRowH = Math.max(19, Math.min(32, spacing * 0.34));
        return {
          ...L, list, perRow, subRows, spacing, subRowH,
          height: Math.max(96, subRows * subRowH + 54),
        };
      });

    let y = 0;
    for (const B of present) {
      B.yTop = y;
      B.list.forEach((x, k) => {
        const sub = Math.floor(k / B.perRow);
        const col = k % B.perRow;
        const rowCount = Math.min(B.perRow, B.list.length - sub * B.perRow);
        x.x = (col - (rowCount - 1) / 2) * B.spacing;
        x.y = y + 38 + sub * B.subRowH;
      });
      y += B.height;
    }
    // centre the whole stack on the origin
    const mid = y / 2;
    for (const x of nodes) x.y -= mid;
    for (const B of present) B.yTop -= mid;

    sim = {
      nodes, at, edges,
      tx: w / 2, ty: h / 2, scale: 1, raf: 0, alpha: 0, energy: 0,
      bands: present, stackHeight: y,
    };
    return;
  }

  if (state.layout === 'layered') {
    // Levels follow edge direction outward from the focus, so a workflow
    // pipeline reads left to right instead of curling into a ball.
    const level = new Map([[state.focus, 0]]);
    let frontier = [state.focus];
    for (let d = 1; d < 30 && frontier.length; d++) {
      const next = [];
      for (const id of frontier) {
        const i = idx.get(id);
        if (i === undefined) continue;
        for (const e of outAdj[i]) {
          if (!relVisible(e.relation) || !at.has(e.target) || level.has(e.target)) continue;
          level.set(e.target, d); next.push(e.target);
        }
      }
      frontier = next;
    }
    // anything not downstream of the focus sits to its left
    for (const x of nodes) if (!level.has(x.id)) level.set(x.id, -1);
    const groups = new Map();
    for (const x of nodes) {
      const L = level.get(x.id);
      if (!groups.has(L)) groups.set(L, []);
      groups.get(L).push(x);
    }
    const keys = [...groups.keys()].sort((a, b) => a - b);
    keys.forEach((L, col) => {
      const list = groups.get(L).sort((a, b) => (b.deg - a.deg) || String(a.id).localeCompare(String(b.id)));
      list.forEach((x, r) => {
        x.x = (col - (keys.length - 1) / 2) * 210;
        x.y = (r - (list.length - 1) / 2) * 52;
      });
    });
  } else if (state.layout === 'radial') {
    const maxHop = Math.max(...byHop.keys(), 1);
    for (const [hp, list] of byHop) {
      const R = hp === 0 ? 0 : (hp / maxHop) * (Math.min(w, h) / 2 - 70) + 70;
      list.sort((a, b) => b.deg - a.deg).forEach((x, k) => {
        const a = (k / Math.max(list.length, 1)) * Math.PI * 2;
        x.x = Math.cos(a) * R;
        x.y = Math.sin(a) * R;
      });
    }
  } else if (state.layout === 'concentric') {
    const groups = new Map();
    for (const x of nodes) {
      const c = byId.get(x.id)?.community ?? -1;
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(x);
    }
    const keys = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length);
    const R = Math.min(w, h) / 2 - 90;
    keys.forEach((c, gi) => {
      const list = groups.get(c);
      const ga = (gi / keys.length) * Math.PI * 2;
      const cx = keys.length === 1 ? 0 : Math.cos(ga) * R * 0.62;
      const cy = keys.length === 1 ? 0 : Math.sin(ga) * R * 0.62;
      const r = 14 + Math.sqrt(list.length) * 13;
      list.forEach((x, k) => {
        if (list.length === 1) { x.x = cx; x.y = cy; return; }
        const a = (k / list.length) * Math.PI * 2;
        x.x = cx + Math.cos(a) * r;
        x.y = cy + Math.sin(a) * r;
      });
    });
  } else if (state.layout === 'grid') {
    const key = state.sizeBy === 'uniform' ? 'pagerank' : state.sizeBy;
    const sorted = [...nodes].sort((a, b) => ((byId.get(b.id)?.[key] ?? 0) - (byId.get(a.id)?.[key] ?? 0)));
    const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length * 1.7)));
    const rows = Math.ceil(sorted.length / cols);
    sorted.forEach((x, k) => {
      x.x = ((k % cols) - (cols - 1) / 2) * 96;
      x.y = (Math.floor(k / cols) - (rows - 1) / 2) * 62;
    });
  } else {
    // force: seed on hop rings, then relax
    const maxHop = Math.max(...byHop.keys(), 1);
    for (const [hp, list] of byHop) {
      const R = hp === 0 ? 0 : (hp / maxHop) * 240 + 60;
      list.forEach((x, k) => {
        const a = (k / Math.max(list.length, 1)) * Math.PI * 2 + hp;
        x.x = Math.cos(a) * R;
        x.y = Math.sin(a) * R;
      });
    }
  }

  sim = {
    nodes, at, edges,
    tx: w / 2, ty: h / 2,
    scale: 1, raf: 0,
    alpha: state.layout === 'force' ? 1 : 0,
    energy: 0,
  };
}

function relax() {
  const { nodes, edges, at } = sim;
  if (!nodes.length) return;
  const K = 78 + nodes.length * 0.55;
  let energy = 0;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) { d2 = 1; dx = (i % 7) - 3; dy = (j % 7) - 3; }
      const d = Math.sqrt(d2);
      const f = (K * K) / d2;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
  }
  for (const e of edges) {
    const a = at.get(e.source), b = at.get(e.target);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const f = (d - K) * 0.02;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
  }
  for (const x of nodes) {
    x.vx -= x.x * 0.006;
    x.vy -= x.y * 0.006;
    if (x.id === state.focus) { x.x = 0; x.y = 0; x.vx = 0; x.vy = 0; continue; }
    x.x += x.vx * sim.alpha;
    x.y += x.vy * sim.alpha;
    energy += Math.abs(x.vx) + Math.abs(x.vy);
    x.vx *= 0.82; x.vy *= 0.82;
  }
  sim.energy = energy;
  sim.alpha *= 0.985;
  paint();
  if (sim.alpha > 0.02) sim.raf = requestAnimationFrame(relax);
  else { fit(); renderStatus(); }
}

function startLayout() {
  cancelAnimationFrame(sim.raf);
  seedPositions();
  if (state.layout === 'force') relax();
  else { fit(); renderStatus(); }
}

function fit() {
  if (!sim.nodes.length) { paint(); return; }
  const xs = sim.nodes.map((x) => x.x), ys = sim.nodes.map((x) => x.y);
  const w = Math.max(...xs) - Math.min(...xs) || 1;
  const h = Math.max(...ys) - Math.min(...ys) || 1;
  let s = Math.min((cv.clientWidth - 140) / w, (cv.clientHeight - 120) / h, 2.4);
  if (!Number.isFinite(s) || s <= 0) s = 1;
  sim.scale = s;
  sim.tx = cv.clientWidth / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * s;
  sim.ty = cv.clientHeight / 2 - ((Math.max(...ys) + Math.min(...ys)) / 2) * s;
  paint();
}

// ---------------------------------------------------------------- canvas

const cv = $('#cv');
const ctx = cv.getContext('2d');

function paint() {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const empty = $('#stage-empty');
  if (!sim.nodes.length) { if (empty) empty.hidden = false; return; }
  if (empty) empty.hidden = true;

  const px = (x) => x * sim.scale + sim.tx;
  const py = (y) => y * sim.scale + sim.ty;
  const dim = cssVar('--fg-dim');
  const fg = cssVar('--fg');
  const mid = cssVar('--fg-mid');
  const bg = cssVar('--bg');
  const accent = cssVar('--accent');

  // Edge labels are the first thing to turn a dense slice into noise. Label
  // focus-incident edges first, cap the count, and skip segments too short to
  // hold text without colliding with the nodes at either end.
  const EDGE_LABEL_BUDGET = 10;
  // stack bands, drawn first so everything else sits on top
  if (sim.bands) {
    ctx.save();
    for (const B of sim.bands) {
      const yTop = py(B.yTop);
      const yBot = py(B.yTop + B.height);
      if (yBot < -20 || yTop > h + 20) continue;
      ctx.fillStyle = cssVar('--panel');
      ctx.globalAlpha = 0.35;
      ctx.fillRect(0, yTop, w, yBot - yTop);
      ctx.globalAlpha = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = cssVar('--border');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, yTop);
      ctx.lineTo(w, yTop);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  const labelable = sim.scale > 0.55
    ? sim.edges
        .filter((e) => e.source === state.focus || e.target === state.focus)
        .slice(0, EDGE_LABEL_BUDGET)
    : [];
  const labelSet = new Set(labelable);
  const labelBoxes = [];

  for (const e of sim.edges) {
    const a = sim.at.get(e.source), b = sim.at.get(e.target);
    if (!a || !b) continue;
    const isFocus = e.source === state.focus || e.target === state.focus;
    const data = DATA_RELS.has(e.relation);
    ctx.setLineDash(data ? [3, 3] : []);
    ctx.strokeStyle = FLOW_RELS.has(e.relation)
      ? (isFocus ? 'rgba(141,124,224,0.95)' : 'rgba(141,124,224,0.42)')
      : data ? (isFocus ? 'rgba(79,179,165,0.95)' : 'rgba(79,179,165,0.40)')
      : (isFocus ? 'rgba(224,134,60,0.85)' : 'rgba(150,140,130,0.26)');
    ctx.lineWidth = isFocus ? 1.5 : 1;
    const x1 = px(a.x), y1 = py(a.y), x2 = px(b.x), y2 = py(b.y);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    // arrow head, pulled back to the target's rim
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const r = sizeOf(byId.get(e.target) ?? {}) * Math.min(Math.max(sim.scale, 0.6), 1.5) + 3;
    const hx = x2 - Math.cos(ang) * r, hy = y2 - Math.sin(ang) * r;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx - Math.cos(ang - 0.42) * 6, hy - Math.sin(ang - 0.42) * 6);
    ctx.lineTo(hx - Math.cos(ang + 0.42) * 6, hy - Math.sin(ang + 0.42) * 6);
    ctx.closePath();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();

    if (labelSet.has(e) && Math.hypot(x2 - x1, y2 - y1) > 96) {
      const t = e.context && e.context !== 'success' ? `${e.relation}: ${e.context}` : e.relation;
      // 0.62 along the edge rather than the midpoint: on a star topology every
      // midpoint sits at the same radius and the labels pile up
      const mx = x1 + (x2 - x1) * 0.62, my = y1 + (y2 - y1) * 0.62;
      ctx.font = '9px ui-monospace, monospace';
      const box = { x: mx, y: my, w: ctx.measureText(t).width, h: 11 };
      const clash = labelBoxes.some((b) =>
        Math.abs(b.x - box.x) < (b.w + box.w) / 2 + 6 && Math.abs(b.y - box.y) < 14);
      if (!clash) {
        labelBoxes.push(box);
        ctx.save();
        ctx.translate(mx, my);
        let a2 = ang;
        if (a2 > Math.PI / 2 || a2 < -Math.PI / 2) a2 += Math.PI;
        ctx.rotate(a2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.strokeStyle = bg;
        ctx.lineWidth = 3;
        ctx.strokeText(t, 0, -2);
        ctx.fillStyle = dim;
        ctx.fillText(t, 0, -2);
        ctx.restore();
      }
    }
  }
  ctx.setLineDash([]);
  ctx.lineWidth = 1;

  for (const x of sim.nodes) {
    const node = byId.get(x.id);
    if (!node) continue;
    const r = sizeOf(node) * Math.min(Math.max(sim.scale, 0.6), 1.5);
    ctx.beginPath();
    ctx.arc(px(x.x), py(x.y), r, 0, Math.PI * 2);
    ctx.fillStyle = colorOf(node);
    ctx.fill();
    if (node.articulation) {
      ctx.strokeStyle = cssVar('--danger');
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (x.id === state.focus) {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(px(x.x), py(x.y), r + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.lineWidth = 1;
  }

  // Node labels, most important first, dropping any that would overlap one
  // already drawn. Better to show 20 readable names than 40 illegible ones.
  const ranked = [...sim.nodes].sort((a, b) => {
    if (a.id === state.focus) return -1;
    if (b.id === state.focus) return 1;
    const na = byId.get(a.id), nb = byId.get(b.id);
    return (nb?.pagerank ?? 0) - (na?.pagerank ?? 0) || b.deg - a.deg;
  });
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  // A panel and the workflow rendering it often share a name; inside one slice
  // two identical labels are just confusing, so qualify the repeats by kind.
  const labelSeen = new Map();
  for (const x of sim.nodes) {
    const l = byId.get(x.id)?.label;
    if (l) labelSeen.set(l, (labelSeen.get(l) ?? 0) + 1);
  }

  const drawn = [];
  const LABEL_CAP = sim.nodes.length > 120 ? 14 : sim.nodes.length > 60 ? 22 : 30;
  for (const x of ranked) {
    if (drawn.length >= LABEL_CAP && x.id !== state.focus) continue;
    const node = byId.get(x.id);
    if (!node) continue;
    const isFocus = x.id === state.focus;
    ctx.font = isFocus ? '600 12.5px -apple-system, sans-serif' : '11px -apple-system, sans-serif';
    const base = String(node.label ?? '');
    const label = ((labelSeen.get(base) ?? 0) > 1 ? `${base} · ${node.type}` : base).slice(0, 42);
    const X = px(x.x);
    const Y = py(x.y) - sizeOf(node) * Math.min(Math.max(sim.scale, 0.6), 1.5) - 5;
    const w = ctx.measureText(label).width;
    if (X < -w || X > w + cv.clientWidth || Y < 0 || Y > cv.clientHeight + 12) continue;
    const box = { x: X, y: Y, w, h: 13 };
    const clash = !isFocus && drawn.some((b) =>
      Math.abs(b.x - box.x) < (b.w + box.w) / 2 + 4 && Math.abs(b.y - box.y) < 13);
    if (clash) continue;
    drawn.push(box);
    ctx.strokeStyle = bg;
    ctx.lineWidth = 3.5;
    ctx.strokeText(label, X, Y);
    ctx.fillStyle = isFocus ? fg : mid;
    ctx.fillText(label, X, Y);
  }
  ctx.lineWidth = 1;

  // Band captions last, on a plate: in a dense band the node labels would
  // otherwise bury them, and they are the key to reading the whole view.
  if (sim.bands) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    for (const B of sim.bands) {
      const yTop = py(B.yTop);
      const yBot = py(B.yTop + B.height);
      if (yBot < 24 || yTop > h - 4) continue;
      const cy = Math.min(Math.max(yTop + 16, 16), h - 10);
      ctx.font = '600 10px ui-monospace, monospace';
      const wName = ctx.measureText(B.name.toUpperCase()).width;
      ctx.font = '9px ui-monospace, monospace';
      const sub = `${B.note} · ${B.list.length}`;
      const wSub = ctx.measureText(sub).width;
      const plate = Math.max(wName, wSub) + 34;
      ctx.fillStyle = cssVar('--bg');
      ctx.globalAlpha = 0.82;
      ctx.fillRect(6, cy - 13, plate, 28);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(16, cy - 4, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = B.color;
      ctx.fill();
      ctx.font = '600 10px ui-monospace, monospace';
      ctx.fillStyle = cssVar('--fg-mid');
      ctx.fillText(B.name.toUpperCase(), 26, cy);
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillStyle = dim;
      ctx.fillText(sub, 26, cy + 12);
    }
  }
}

const hitTest = (mx, my) => {
  let best = null, bestD = 20 * 20;
  for (const x of sim.nodes) {
    const dx = x.x * sim.scale + sim.tx - mx;
    const dy = x.y * sim.scale + sim.ty - my;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = x; }
  }
  return best;
};

/** Hover readout, so suppressing labels in a dense band costs nothing. */
const tip = el('div', { class: 'tip', hidden: '' });
document.querySelector('.stage').append(tip);

function showTip(node, cx, cy) {
  const L = STACK_BY_LAYER.get(node.layer);
  // replaceChildren() is the native DOM method: a null argument becomes the
  // text "null" rather than being skipped, so filter before passing them in.
  tip.replaceChildren(...[
    el('b', { text: node.label }),
    el('span', { text: [L?.name, node.type, node.nodeType].filter(Boolean).join(' · ') }),
    node.summary ? el('i', { text: node.summary.slice(0, 120) }) : null,
  ].filter(Boolean));
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const stage = document.querySelector('.stage').getBoundingClientRect();
  tip.style.left = `${Math.min(cx + 14, stage.width - r.width - 10)}px`;
  tip.style.top = `${Math.max(8, cy - r.height - 12)}px`;
}
const hideTip = () => { tip.hidden = true; };

(() => {
  let dragging = false, lx = 0, ly = 0, moved = false;
  cv.addEventListener('pointerdown', (e) => {
    dragging = true; moved = false; lx = e.clientX; ly = e.clientY;
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!dragging) {
      const rect = cv.getBoundingClientRect();
      const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
      const node = hit ? byId.get(hit.id) : null;
      if (node) showTip(node, e.clientX - rect.left, e.clientY - rect.top);
      else hideTip();
      return;
    }
    hideTip();
    if (Math.abs(e.clientX - lx) > 3 || Math.abs(e.clientY - ly) > 3) moved = true;
    sim.tx += e.clientX - lx; sim.ty += e.clientY - ly;
    lx = e.clientX; ly = e.clientY;
    paint();
  });
  cv.addEventListener('pointerleave', hideTip);
  cv.addEventListener('pointerup', (e) => {
    dragging = false;
    if (moved) return;
    const rect = cv.getBoundingClientRect();
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (hit) focusNode(hit.id);
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const ns = Math.max(0.12, Math.min(5, sim.scale * Math.exp(-e.deltaY * 0.0015)));
    sim.tx = mx - ((mx - sim.tx) * ns) / sim.scale;
    sim.ty = my - ((my - sim.ty) * ns) / sim.scale;
    sim.scale = ns;
    paint();
  }, { passive: false });
  window.addEventListener('resize', () => { setPanelWidths(); paint(); });
})();

// ---------------------------------------------------------------- focus panel

const nodeLink = (id, display) =>
  el('a', { class: 'nl', onclick: () => focusNode(id) }, display ?? byId.get(id)?.label ?? id);

const chip = (text, cls = '') => el('span', { class: `badge ${cls}`.trim(), text });

/** Outbound / inbound edges of one relation, as target nodes. */
const targetsOf = (id, ...rels) => {
  const i = idx.get(id);
  if (i === undefined) return [];
  const want = new Set(rels);
  return outAdj[i].filter((e) => want.has(e.relation)).map((e) => byId.get(e.target)).filter(Boolean);
};
const sourcesOf = (id, ...rels) => {
  const i = idx.get(id);
  if (i === undefined) return [];
  const want = new Set(rels);
  return inAdj[i].filter((e) => want.has(e.relation)).map((e) => byId.get(e.source)).filter(Boolean);
};

/** A capped list of links with a "+N more" tail. */
function linkList(list, cap = 5) {
  const uniq = [...new Map(list.map((x) => [x.id, x])).values()];
  const shown = uniq.slice(0, cap);
  const out = shown.map((x, k) => [k ? ', ' : '', nodeLink(x.id)]).flat();
  if (uniq.length > cap) out.push(`, +${uniq.length - cap} more`);
  return out.length ? out : ['—'];
}

const kv = (rows) => {
  const dl = el('dl', { class: 'kv' });
  for (const [k, v] of rows) {
    if (v === null || v === undefined || v === '' || v === '—') continue;
    dl.append(el('dt', { text: k }), el('dd', {}, ...(Array.isArray(v) ? v : [v])));
  }
  return dl.children.length ? dl : null;
};

/**
 * What an AI Studio developer wants to know about this artifact, in Oracle's
 * own vocabulary. Graph-theory numbers are real but secondary, so they live in
 * their own demoted card lower down.
 */
function domainCard(n) {
  const rows = [];
  const composition = [];
  const deps = [];

  if (n.type === 'appPanel' || n.type === 'appSubPanel') {
    const app = sourcesOf(n.id, 'contains').find((x) => x.type === 'app' || x.type === 'appPanel');
    const agents = targetsOf(n.id, 'rendered_by');
    const subs = targetsOf(n.id, 'contains');
    rows.push(
      ['Kind', n.type === 'appPanel' ? 'Agent container (panel)' : 'Additional panel'],
      ['In app', app ? linkList([app], 1) : (n.app ?? null)],
    );
    deps.push(
      ['Rendered by', agents.length ? linkList(agents, 4) : null],
      ['Sub-panels', subs.length ? linkList(subs, 5) : null],
    );
  } else if (n.type === 'appAction') {
    const app = sourcesOf(n.id, 'contains')[0];
    const navs = targetsOf(n.id, 'navigates_to');
    const invokes = targetsOf(n.id, 'invokes_agent');
    rows.push(
      ['Kind', 'App action'],
      ['Action code', el('code', { class: 'mono', text: n.code ?? '—' })],
      ['In app', app ? linkList([app], 1) : (n.app ?? null)],
    );
    deps.push(
      ['Navigates to', navs.length ? linkList(navs, 3) : null],
      ['Invokes agent', invokes.length ? linkList(invokes, 3) : null],
    );
  } else if (n.type === 'agent') {
    const tools = targetsOf(n.id, 'uses_tool');
    const topics = targetsOf(n.id, 'uses_topic');
    const usedBy = sourcesOf(n.id, 'invokes_agent_resource', 'uses_agent');
    rows.push(
      ['Business area', [n.family, n.product].filter(Boolean).join(' · ') || '—'],
      ['Agent code', el('code', { class: 'mono', text: n.code ?? '—' })],
      ['Agent type', n.agentKind],
      ['Status', [n.status, n.reusable ? '· reusable' : ''].filter(Boolean).join(' ')],
      ['Namespace', n.namespace],
      ['Max interactions', n.maxInteractions],
    );
    deps.push(
      ['Tools', tools.length ? linkList(tools, 6) : null],
      ['Topics', topics.length ? linkList(topics, 4) : null],
      ['Invoked by', usedBy.length ? linkList(usedBy, 5) : null],
    );
  } else if (n.layer === 4) {
    // Agentic application
    const agents = targetsOf(n.id, 'exposes_agent');
    const panels = targetsOf(n.id, 'contains').filter((x) => x.type === 'appPanel');
    const actions = targetsOf(n.id, 'contains').filter((x) => x.type === 'appAction');
    const navs = targetsOf(n.id, 'navigates_to');
    const data = targetsOf(n.id, 'depends_on_data');
    rows.push(
      ['Business area', [n.family, n.product].filter(Boolean).join(' · ') || '—'],
      ['App code', el('code', { class: 'mono', text: n.code ?? '—' })],
      ['Page pattern', n.pagePattern],
      ['Status', n.status],
      ['File upload', n.enableFileUpload ? 'enabled' : null],
    );
    deps.push(
      ['Agents surfaced', agents.length ? linkList(agents, 6) : null],
      ['Panels', panels.length ? String(panels.length) : null],
      ['Actions', actions.length ? linkList(actions, 4) : null],
      ['Navigates to', navs.length ? linkList(navs, 3) : null],
      ['Data reached', data.length ? linkList(data, 5) : null],
    );
  } else if (n.layer === 3 || n.layer === 2) {
    // Agent team / agent — both are .wf workflows
    const steps = targetsOf(n.id, 'contains');
    const mix = new Map();
    for (const st of steps) mix.set(st.nodeType, (mix.get(st.nodeType) ?? 0) + 1);
    const bos = targetsOf(n.id, 'depends_on_data');
    const tools = targetsOf(n.id, 'uses_tool');
    const subs = targetsOf(n.id, 'calls', 'invokes_workflow');
    const model = targetsOf(n.id, 'uses_model');
    const apps = sourcesOf(n.id, 'exposes_agent', 'rendered_by', 'summarized_by', 'subtitle_by', 'communicates_via', 'invokes_agent');
    const callers = sourcesOf(n.id, 'calls', 'invokes_workflow');
    const stages = targetsOf(n.id, 'routes_app_stage');

    rows.push(
      ['Business area', [n.family, n.product].filter(Boolean).join(' · ') || '—'],
      ['Workflow code', el('code', { class: 'mono', text: n.code ?? '—' })],
      ['Status', [n.status, n.seeded ? '· seeded' : '', n.aiAppsCompatible ? '· app-compatible' : ''].filter(Boolean).join(' ')],
      ['Architecture', n.architecture],
      ['Trigger', (n.triggers ?? []).join(', ')],
      ['Human approval', n.humanApproval ? 'required' : null],
      ['Model', model.length ? linkList(model, 2) : null],
      ['Time saved', n.timeSavings ? `${n.timeSavings} min per run (as declared)` : null],
    );

    const ORDER = ['LLM', 'BO_FUNCTION', 'TOOL', 'CODE', 'SWITCH', 'CONDITION', 'WORKFLOW', 'LOOP', 'WHILE', 'PARALLEL', 'SET_FIELDS', 'RETURN', 'DOCUMENT_PROCESSOR'];
    const chips = ORDER.filter((k) => mix.has(k)).map((k) => chip(`${k} ${mix.get(k)}`));
    if (chips.length) composition.push(['Steps', `${n.nodeCount ?? steps.length} nodes`], ['Mix', chips]);

    deps.push(
      ['Exposed by app', apps.length ? linkList(apps, 3) : null],
      ['Called by', callers.length ? linkList(callers, 4) : null],
      ['Business objects', bos.length ? linkList(bos, 5) : null],
      ['Tools', tools.length ? linkList(tools, 4) : null],
      ['Sub-workflows', subs.length ? linkList(subs, 4) : null],
      ['App stages routed', stages.length ? stages.map((x) => chip(x.label)) : null],
    );
  } else if (n.layer === 1) {
    // Tool layer
    const fns = targetsOf(n.id, 'contains').filter((x) => x.type === 'boFunction');
    const users = sourcesOf(n.id, 'depends_on_data', 'uses_tool', 'uses_business_object');
    const callers = sourcesOf(n.id, 'calls_bo_function');
    const rest = targetsOf(n.id, 'exposes_rest_resource', 'calls_rest');
    rows.push(
      ['Business area', [n.family, n.product].filter(Boolean).join(' · ') || '—'],
      ['Code', el('code', { class: 'mono', text: n.code ?? '—' })],
      ['Tool type', n.toolTypeName ? [n.toolTypeName, n.toolTypeSource ? `(${n.toolTypeSource})` : ''].join(' ') : null],
      ['Kind', [n.type, n.toolType, n.operationType].filter(Boolean).join(' · ')],
      ['Object source', n.objectSource],
      ['REST', n.restResourcePath ?? (rest.length ? rest[0].label : null)],
      ['Parameters', (n.params ?? []).join(', ')],
    );
    deps.push(
      ['Functions', fns.length ? linkList(fns, 6) : null],
      ['Used by agents', users.length ? linkList(users, 6) : null],
      ['Called from steps', callers.length ? `${callers.length} workflow step${callers.length > 1 ? 's' : ''}` : null],
    );
  } else if (n.layer === 0) {
    // A step inside an agent
    const wf = sourcesOf(n.id, 'contains');
    const reads = targetsOf(n.id, 'reads_output_of');
    const next = targetsOf(n.id, 'flows_to');
    const calls = targetsOf(n.id, 'calls_bo_function', 'uses_tool', 'invokes_workflow');
    rows.push(
      ['Step type', n.nodeType],
      ['In agent', wf.length ? linkList(wf, 1) : null],
      ['Step code', el('code', { class: 'mono', text: n.code ?? '—' })],
      ['Inputs', (n.inputNames ?? []).join(', ')],
      ['Carries', [n.prompt ? 'LLM prompt' : null, n.src ? `${n.sourceCodeLines ?? '?'} lines of JS` : null, n.expr ? 'routing expression' : null].filter(Boolean).join(' · ')],
    );
    deps.push(
      ['Calls', calls.length ? linkList(calls, 4) : null],
      ['Reads output of', reads.length ? linkList(reads, 4) : null],
      ['Then', next.length ? linkList(next, 4) : null],
    );
  } else if (n.type === 'toolType') {
    const users = sourcesOf(n.id, 'is_tool_type', 'uses_tool_type');
    rows.push(
      ['Supported since', n.supportedSince ? `release ${n.supportedSince}` : null],
      ['Used in this corpus', n.usedHere ? `yes — ${num(n.artifactCount)} artifact${n.artifactCount === 1 ? '' : 's'}` : 'no — supported but not exercised here'],
    );
    deps.push(['Artifacts', users.length ? linkList(users, 8) : null]);
  } else if (n.layer === 5) {
    const members = sourcesOf(n.id, 'in_product', 'in_family', 'belongs_to_family');
    const wfs = members.filter((x) => x.type === 'workflow');
    const apps = members.filter((x) => x.type === 'app');
    rows.push(
      ['Scope', n.type === 'family' ? 'Fusion family' : 'Product / business capability'],
      ['Agents', wfs.length ? String(wfs.length) : null],
      ['Applications', apps.length ? String(apps.length) : null],
    );
    deps.push(['Applications', apps.length ? linkList(apps, 5) : null],
      ['Agents', wfs.length ? linkList(wfs, 6) : null]);
  } else {
    const cmds = targetsOf(n.id, 'prescribes_command', 'documents_command');
    const arts = targetsOf(n.id, 'routes_artifact', 'documents_artifact', 'operates_on');
    rows.push(
      ['Kind', n.type],
      ['Code', n.code ? el('code', { class: 'mono', text: n.code }) : null],
      ['Group', n.group],
      ['Verb', n.verb],
      ['Lines', n.lines],
    );
    deps.push(
      ['CLI commands', cmds.length ? linkList(cmds, 5) : null],
      ['Artifact types', arts.length ? linkList(arts, 5) : null],
    );
  }

  const cards = [];
  const facts = kv(rows);
  if (facts) cards.push(el('div', { class: 'card' }, el('span', { class: 'lbl' }, 'In Oracle terms'), facts));
  const comp = kv(composition);
  if (comp) cards.push(el('div', { class: 'card' }, el('span', { class: 'lbl' }, 'Composition'), comp));
  const dep = kv(deps);
  if (dep) cards.push(el('div', { class: 'card' }, el('span', { class: 'lbl' }, 'Wiring'), dep));
  return cards;
}

/** Impact and risk, in sentences rather than coefficients. */
function riskCard(n) {
  const lines = [];
  if (n.blastRadius > 0) {
    lines.push(['If you change this',
      `${num(n.blastRadius)} artifact${n.blastRadius === 1 ? '' : 's'} can reach it, so that many may need re-testing.`]);
  } else {
    lines.push(['If you change this',
      'Nothing depends on it — it is an entry point, so the risk is contained to itself.']);
  }
  if (n.articulation) {
    lines.push(['Single point of failure',
      'Remove it and its part of the graph splits in two. Nothing else bridges the gap.']);
  } else if ((n.bridgeScore ?? 0) >= 95) {
    lines.push(['Connector',
      `More paths run through this than through ${Math.round(n.bridgeScore)}% of the corpus.`]);
  }
  if (n.issues?.length) lines.push(['Findings', n.issues.join('; ')]);
  if (n._stub) lines.push(['Not in this repo', 'Referenced by name and resolved by the platform at runtime.']);

  const card = el('div', { class: 'card' }, el('span', { class: 'lbl' }, 'Impact & risk'));
  for (const [head, body] of lines) {
    card.append(el('div', { class: 'insight' },
      el('span', { class: 'bullet', style: head === 'Single point of failure' || head === 'Findings' ? `background:${cssVar('--danger')}` : null }),
      el('div', { class: 'body' }, el('b', { text: head }), body)));
  }
  const next = nextToInspect(n);
  if (next) {
    card.append(el('div', { class: 'insight' },
      el('span', { class: 'bullet', style: `background:${cssVar('--teal')}` }),
      el('div', { class: 'body' }, el('b', { text: 'What to inspect next' }),
        el('a', { class: 'nl', onclick: () => focusNode(next.id) }, next.text))));
  }
  return card;
}

/** The graph-theory view, kept but demoted. */
function structureCard(n) {
  return el('div', { class: 'card' },
    el('span', { class: 'lbl' }, 'Graph structure'),
    el('p', { class: 'ctx', style: 'margin:0 0 8px;font-size:11.5px' },
      'Position in the dependency graph, not an Oracle property.'),
    el('div', { class: 'metric-grid' },
      el('div', { class: 'metric hot' },
        el('div', { class: 'k', text: 'Most depended-on' }),
        el('div', { class: 'v', text: `#${n.pagerankRank ?? '—'}` }),
        el('div', { class: 's', text: `of ${num(N)} artifacts` })),
      el('div', { class: 'metric' },
        el('div', { class: 'k', text: 'Connections' }),
        el('div', { class: 'v', text: num(n.degree) }),
        el('div', { class: 's', text: `${num(n.inDegree)} in · ${num(n.outDegree)} out` })),
      el('div', { class: 'metric' },
        el('div', { class: 'k', text: 'Cluster' }),
        el('div', { class: 'v', text: `C-${n.community ?? '—'}` }),
        el('div', { class: 's', text: `${num(n.communitySize)} members` })),
      el('div', { class: 'metric' },
        el('div', { class: 'k', text: 'Bridge score' }),
        el('div', { class: 'v', text: (n.bridgeScore ?? 0).toFixed(1) }),
        el('div', { class: 's', text: 'path traffic percentile' }))));
}

/** The neighbour most worth opening next, and the edge that gets you there. */
function nextToInspect(n) {
  const i = idx.get(n.id);
  if (i === undefined) return null;
  const cand = new Map();
  for (const e of outAdj[i]) if (relVisible(e.relation)) cand.set(e.target, e);
  for (const e of inAdj[i]) if (relVisible(e.relation) && !cand.has(e.source)) cand.set(e.source, e);
  let best = null;
  for (const [id, e] of cand) {
    const t = byId.get(id);
    if (!t || id === n.id) continue;
    const score = (t.articulation ? 0.5 : 0) + (t.bridgeScore ?? 0) / 100 + (t.pagerank ?? 0) * 40;
    if (!best || score > best.score) best = { id, e, score, node: t };
  }
  if (!best) return null;
  const via = best.e.source === n.id ? `${best.e.relation} →` : `← ${best.e.relation}`;
  return { id: best.id, text: `${via} ${best.node.label}` };
}

function renderFocusPanel() {
  const box = $('#focus-panel');
  box.replaceChildren();

  if (!state.focus) {
    renderBrowse(box);
    const cov = toolCoverageCard();
    if (cov) box.append(cov);
    return;
  }

  const n = byId.get(state.focus);
  const L = STACK_BY_LAYER.get(n.layer);
  box.append(el('button', {
    class: 'back-browse',
    onclick: () => { state.focus = null; refreshGraph(); },
    text: '‹ back to browse',
  }));
  const head = el('div', { class: 'card' },
    el('span', { class: 'lbl' }, 'Current focus'),
    el('h2', { class: 'focus-title', text: n.label }),
    el('div', { class: 'focus-kind' },
      el('span', { class: 'dot', style: `display:inline-block;background:${L?.color};margin-right:6px` }),
      [L?.name, n.stackRole].filter(Boolean).join(' · ')));
  if (n.summary) head.append(el('p', { class: 'ctx', style: 'margin:8px 0 0' }, n.summary));
  box.append(head);

  for (const c of domainCard(n)) box.append(c);
  box.append(riskCard(n));
  box.append(structureCard(n));
  renderPressure(box);
}

/**
 * The catalogue the left panel shows when nothing is selected: everything you
 * can open, grouped the way the stack is organised. Tools are sub-grouped by
 * supported tool type; BO functions are left out of the listing because their
 * 190 entries belong under their parent object.
 */
/** Oracle's console order, so the list reads like the product navigation. */
const SECTION_ORDER = [
  'Authoring · Skills', 'Authoring · Playbooks', 'Authoring · Rules',
  'Authoring · Vocabulary', 'Authoring · CLI',
  'Applications', 'Workflows',
  'Resources · Agents', 'Resources · Supervisor Agents', 'Resources · Tools',
  'Resources · Topics', 'Resources · Business Objects', 'Resources · Deeplinks',
  'Resources · Functions', 'Resources · Document Schema',
  'Connectors', 'Policy Models', 'Approvals',
  'Documentation', 'Findings', 'Derived',
];

function browseGroups() {
  const q = state.browse.q.trim().toLowerCase();
  const match = (x) => !q
    || (x.label || '').toLowerCase().includes(q)
    || (x.code || '').toLowerCase().includes(q)
    || (x.product || '').toLowerCase().includes(q)
    || (x.family || '').toLowerCase().includes(q);

  // Components (panels, actions, workflow steps, BO functions) are reachable by
  // opening their parent and via ⌘K; listing them here made "Applications" read
  // as 69 entries when there are 6 apps.
  const of = (pred) => NODES.filter((x) => !x.component && pred(x) && match(x))
    .sort((a, b) => String(a.label).localeCompare(String(b.label)));

  if (state.browse.by === 'section') {
    // grouped the way Oracle's console groups them
    const bySec = new Map();
    for (const x of of((y) => y.studioSection && y.studioSection !== 'Derived')) {
      if (!bySec.has(x.studioSection)) bySec.set(x.studioSection, []);
      bySec.get(x.studioSection).push(x);
    }
    const order = (n) => {
      const i = SECTION_ORDER.indexOf(n);
      return i === -1 ? 99 : i;
    };
    return [...bySec]
      .sort((a, b) => order(a[0]) - order(b[0]))
      .map(([name, items]) => ({
        name,
        note: name.startsWith('Resources') ? 'resource' : name.toLowerCase(),
        color: layerColor(items[0]?.layer ?? -1),
        items,
        sub: (x) => [x.type, x.family, x.product].filter(Boolean).join(' · '),
      }));
  }

  // The authoring corpus comes first: it is what the repo ships. The sample
  // apps follow as the worked example.
  const anyOf = (pred) => NODES.filter((x) => pred(x) && match(x))
    .sort((a, b) => String(a.label).localeCompare(String(b.label)));
  const PROMPT_ROLES = [
    ['node-spec', 'Workflow node specs'],
    ['builder', 'Artifact builders'],
    ['cli-compat', 'CLI compatibility contracts'],
    ['test-authoring', 'Test authoring'],
    ['debugging', 'Debugging'],
    ['vibe-agent', 'Vibe agents'],
    ['conventions', 'Conventions'],
    ['guardrails', 'Guardrails'],
    ['app-playbook', 'App playbooks'],
    ['handoff', 'Handoff'],
    ['best-practices', 'Best practices'],
    ['ingestion', 'Ingestion'],
    ['index', 'Indexes'],
    ['reference', 'Other references'],
  ];
  const groups = [
    { name: 'Skills', note: 'the entry point', color: layerColor(11),
      items: of((x) => x.type === 'skill' || x.type === 'skillResource'),
      sub: (x) => (x.type === 'skill' ? `${x.ruleCount ?? 0} rules` : x.kind ?? '') },
  ];
  for (const [role, title] of PROMPT_ROLES) {
    groups.push({ name: title, note: 'reference', color: layerColor(10),
      items: of((x) => x.type === 'promptReference' && x.promptRole === role),
      sub: (x) => [`${x.lines ?? 0} lines`, `${x.ruleCount ?? 0} rules`].join(' · ') });
  }
  // rules are components of their section, so they need the unfiltered list
  for (const [modality, title] of [
    ['prohibition', 'Rules · prohibitions'],
    ['obligation', 'Rules · obligations'],
    ['recommendation', 'Rules · recommendations'],
  ]) {
    groups.push({ name: title, note: 'rule', color: layerColor(9),
      items: anyOf((x) => x.type === 'rule' && x.modality === modality),
      sub: (x) => [x.owner, x.section].filter(Boolean).join(' · ') });
  }
  groups.push({ name: 'Workflow node types', note: 'vocabulary', color: layerColor(8),
    items: of((x) => x.type === 'workflowNodeType'),
    sub: (x) => `${x.specified ? 'specified' : 'no spec'} · ${x.instanceCount ?? 0} in samples` });
  groups.push({ name: 'Test kinds', note: 'vocabulary', color: layerColor(8),
    items: of((x) => x.type === 'testKind'), sub: (x) => x.summary ?? '' });
  groups.push({ name: 'Artifact types', note: 'vocabulary', color: layerColor(8),
    items: of((x) => x.type === 'artifactType'), sub: (x) => x.ext ?? '' });
  groups.push({ name: 'CLI commands', note: 'the enforcing surface', color: layerColor(7),
    items: of((x) => x.type === 'cliCommand'), sub: (x) => [x.group, x.verb].filter(Boolean).join(' · ') });

  groups.push(
    { name: 'Agentic applications', note: 'sample · the product', color: layerColor(4),
      items: of((x) => x.type === 'app'), sub: (x) => [x.family, x.pagePattern].filter(Boolean).join(' · ') },
    { name: 'Agent teams', note: 'sample · supervisor + workflow', color: layerColor(3),
      items: of((x) => x.layer === 3), sub: (x) => [x.family, x.product, x.stackRole].filter(Boolean).join(' · ') },
    { name: 'Agents', note: 'sample · compose tools', color: layerColor(2),
      items: of((x) => x.layer === 2), sub: (x) => [x.family, x.product].filter(Boolean).join(' · ') },
  );

  // tools, split by supported type so the taxonomy is visible while browsing
  const toolish = new Set(['tool', 'businessObject', 'deeplink']);
  const byType = new Map();
  for (const x of of((y) => toolish.has(y.type))) {
    const k = x.toolTypeName ?? 'Unclassified';
    if (!byType.has(k)) byType.set(k, []);
    byType.get(k).push(x);
  }
  for (const [k, items] of [...byType].sort((a, b) => b[1].length - a[1].length)) {
    groups.push({
      name: k, note: 'sample · tool', color: layerColor(1), items,
      sub: (x) => [x.type, x.family, x.product].filter(Boolean).join(' · '),
    });
  }

  return groups.filter((g) => g.items.length);
}

function renderBrowse(box) {
  const filter = el('input', {
    class: 'browse-filter', type: 'text', placeholder: 'Filter this list…',
    value: state.browse.q, spellcheck: 'false',
  });
  filter.addEventListener('input', (e) => {
    state.browse.q = e.target.value;
    renderFocusPanel();
    const f = $('.browse-filter');
    if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
  });

  const groups = browseGroups();
  const total = groups.reduce((a, g) => a + g.items.length, 0);

  const localCount = NODES.filter((x) => x.origin === 'local').length;
  const modeBtn = (val, label) => el('button', {
    class: `mini${state.browse.by === val ? ' on' : ''}`,
    onclick: () => { state.browse.by = val; state.browse.open = new Set(); renderFocusPanel(); },
    text: label,
  });

  box.append(el('div', { class: 'card' },
    el('span', { class: 'lbl' }, 'Browse'),
    el('p', { class: 'ctx', style: 'margin:4px 0 8px' },
      `${num(total)} artifact${total === 1 ? '' : 's'} you can open. Pick one to see its wiring, or press ⌘K.`),
    el('div', { style: 'display:flex;gap:5px;margin-bottom:8px' },
      modeBtn('section', 'Studio sections'),
      modeBtn('layer', 'Stack layers')),
    filter,
    localCount
      ? el('p', { class: 'ctx', style: 'margin:8px 0 0;font-size:11px' },
          `Includes ${num(localCount)} artifact${localCount === 1 ? '' : 's'} ingested from your environment.`)
      : null));

  const wrap = el('div', { class: 'card' });
  const CAP = 25;
  for (const g of groups) {
    const open = state.browse.open.has(g.name) || (state.browse.q && g.items.length <= 40);
    const expanded = state.browse.expanded.has(g.name);
    const shown = expanded ? g.items : g.items.slice(0, CAP);

    const list = el('ul', { class: 'browse' }, ...shown.map((x) => el('li', {},
      nodeLink(x.id),
      g.sub(x) ? el('div', { class: 'sub', text: g.sub(x) }) : null)));

    const d = el('details', { class: 'grp2', ...(open ? { open: '' } : {}) },
      el('summary', {},
        el('span', { class: 'dot', style: `background:${g.color}` }),
        el('span', { text: g.name }),
        el('span', { class: 'note', text: g.note }),
        el('span', { class: 'n', text: num(g.items.length) })),
      list,
      g.items.length > CAP && !expanded
        ? el('button', {
            class: 'more',
            onclick: (e) => { e.preventDefault(); state.browse.expanded.add(g.name); renderFocusPanel(); },
            text: `show all ${num(g.items.length)}`,
          })
        : null);

    d.addEventListener('toggle', () => {
      if (d.open) state.browse.open.add(g.name);
      else state.browse.open.delete(g.name);
    });
    wrap.append(d);
  }
  if (!groups.length) wrap.append(el('div', { class: 'empty' }, 'Nothing matches that filter.'));
  box.append(wrap);
}

/** How much of the supported tool surface this corpus actually uses. */
function toolCoverageCard() {
  const types = NODES.filter((x) => x.type === 'toolType');
  if (!types.length) return null;
  const used = types.filter((x) => x.usedHere);
  const card = el('div', { class: 'card' },
    el('span', { class: 'lbl' }, 'Tool coverage'),
    el('p', { class: 'ctx', style: 'margin:4px 0 8px' },
      `${used.length} of ${types.length} supported tool types are used here.`));
  for (const t of [...types].sort((a, b) => (b.artifactCount ?? 0) - (a.artifactCount ?? 0))) {
    card.append(el('div', { class: 'pressure', style: 'margin-bottom:6px' },
      el('div', { class: 'row' },
        el('span', { class: 'name', style: t.usedHere ? null : 'color:var(--fg-dim);font-weight:400' },
          el('a', { class: 'nl', onclick: () => focusNode(t.id) }, t.label)),
        el('span', { class: 'n', text: t.usedHere ? num(t.artifactCount) : 'unused' }))));
  }
  return card;
}

function renderPressure(box) {
  const scoped = slice.ids.length > 0;
  const ids = scoped ? slice.ids : NODES.map((x) => x.id);
  const groups = new Map();
  for (const id of ids) {
    const n = byId.get(id);
    if (!n || n.community === undefined) continue;
    if (!groups.has(n.community)) groups.set(n.community, []);
    groups.get(n.community).push(n);
  }
  const top = [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, 4);
  if (!top.length) return;
  const max = top[0][1].length;

  const card = el('div', { class: 'card' },
    el('span', { class: 'lbl' }, scoped ? 'Community pressure — visible slice' : 'Community pressure — whole corpus'),
    el('p', { class: 'ctx', style: 'margin:0 0 10px' },
      scoped ? 'How the neighbourhood clusters.' : 'The largest clusters in the corpus.'));

  for (const [c, list] of top) {
    const keys = [...list].sort((a, b) => (b.pagerank ?? 0) - (a.pagerank ?? 0)).slice(0, 3).map((x) => x.label);
    const kinds = [...new Set(list.map((x) => x.type))].slice(0, 3).join(' · ');
    card.append(el('div', { class: 'pressure' },
      el('div', { class: 'row' },
        el('span', { class: 'name' },
          el('span', { class: 'dot', style: `display:inline-block;background:${hashColor(c)};margin-right:6px` }),
          `C-${c}`),
        el('span', { class: 'n', text: `${list.length} node${list.length > 1 ? 's' : ''}` })),
      el('div', { class: 'keys', text: kinds }),
      el('div', { class: 'keys', text: `Key: ${keys.join(', ')}` }),
      el('div', { class: 'bar' }, el('i', { style: `width:${(list.length / max) * 100}%` }))));
  }
  box.append(card);
}

// ---------------------------------------------------------------- right panel

const REL_OUT = {
  contains: 'Contains', exposes_agent: 'Agents', rendered_by: 'Rendered by',
  summarized_by: 'Summary agent', subtitle_by: 'Subtitle agent', communicates_via: 'Communications',
  navigates_to: 'Navigates to', invokes_agent: 'Invokes agent', flows_to: 'Flows to',
  converges_to: 'Converges to', on_error_to: 'On error', reads_output_of: 'Reads output of',
  calls_bo_function: 'Calls BO function', uses_business_object: 'Uses business object',
  depends_on_data: 'Data sources', invokes_workflow: 'Invokes workflow', calls: 'Calls sub-workflow',
  uses_tool: 'Uses tool', uses_model: 'Model', governed_by: 'Policy', in_family: 'Family',
  in_product: 'Product', belongs_to_family: 'Family', belongs_to: 'Business object',
  is_artifact_type: 'Artifact type', exposes_rest_resource: 'REST resource', calls_rest: 'REST endpoint',
  reads_app_context: 'Reads app context', routes_app_stage: 'Routes app stage', has_issue: 'Findings',
  backed_by: 'Backed by', references_prompt: 'Prompt references', prescribes_command: 'Prescribes',
  routes_artifact: 'Routes artifacts', targets_family: 'Targets family', delegates_to: 'Delegates to',
  documents_command: 'Documents commands', documents_artifact: 'Documents artifacts',
  see_also: 'See also', documents: 'Documents', operates_on: 'Operates on', in_group: 'Group',
  has_verb: 'Verb', nests: 'Nested pipeline',
};
const REL_IN = {
  contains: 'Part of', exposes_agent: 'Exposed by', rendered_by: 'Renders', flows_to: 'Reached from',
  reads_output_of: 'Output read by', calls_bo_function: 'Called by', depends_on_data: 'Used by',
  invokes_workflow: 'Invoked by', calls: 'Called by', uses_tool: 'Used by', uses_model: 'Used by',
  in_family: 'Members', in_product: 'Members', belongs_to: 'Functions', is_artifact_type: 'Instances',
  calls_rest: 'Called by', reads_app_context: 'Read by', routes_app_stage: 'Routed by',
  has_issue: 'Affected', documents: 'Documented in', operates_on: 'Commands', in_group: 'Commands',
  has_verb: 'Commands', prescribes_command: 'Prescribed by', documents_command: 'Documented in',
  references_prompt: 'Referenced by', see_also: 'Referenced by', navigates_to: 'Reached from',
  backed_by: 'Backs', nests: 'Nested in', converges_to: 'Convergence from',
  on_error_to: 'Handles errors for', belongs_to_family: 'Products', uses_business_object: 'Used by',
  exposes_rest_resource: 'Exposed by', documents_artifact: 'Documented in', routes_artifact: 'Routed by',
  governed_by: 'Governs', delegates_to: 'Delegated from', targets_family: 'Targeted by',
  invokes_agent: 'Invoked by', summarized_by: 'Summarises', subtitle_by: 'Subtitle for',
  communicates_via: 'Communications for',
};

const PROPS = [
  ['code', 'Code'], ['nodeType', 'Node type'], ['workflow', 'Workflow'], ['family', 'Family'],
  ['product', 'Product'], ['status', 'Status'], ['architecture', 'Architecture'],
  ['pagePattern', 'Pattern'], ['agentCount', 'Agents'], ['nodeCount', 'Nodes'],
  ['aiAppsCompatible', 'App-compatible'], ['operationType', 'Operation'],
  ['resourcePath', 'Resource'], ['restResourcePath', 'REST resource'], ['objectSource', 'Source'],
  ['toolType', 'Tool type'], ['namespace', 'Namespace'], ['usageType', 'Usage'],
  ['verb', 'Verb'], ['group', 'Group'], ['modelName', 'Model'], ['lines', 'Lines'],
  ['triggers', 'Triggers'], ['inputNames', 'Inputs'], ['params', 'Parameters'],
];

function renderRight() {
  const box = $('#rbody');
  box.replaceChildren();

  if (state.rtab === 'bridges' || state.rtab === 'hubs') {
    const scope = slice.ids.length ? slice.ids.map((id) => byId.get(id)).filter(Boolean) : NODES;
    const key = state.rtab === 'bridges' ? 'bridgeScore' : 'pagerank';
    const list = [...scope].sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0)).slice(0, 15);
    box.append(
      el('span', { class: 'lbl' }, state.rtab === 'bridges' ? 'Highest bridge score' : 'Highest PageRank'),
      el('p', { class: 'ctx', style: 'margin:6px 0 10px' },
        slice.ids.length ? 'Within the visible slice.' : 'Across the whole corpus.'),
      ...list.map((x, i) => el('div', { class: 'rank-row' },
        el('span', { class: 'num', text: String(i + 1) }),
        el('span', {}, nodeLink(x.id), x.articulation ? ' ' : null, x.articulation ? chip('cut', 'warn') : null),
        el('span', { class: 'val', text: state.rtab === 'bridges' ? (x.bridgeScore ?? 0).toFixed(1) : sci(x.pagerank) }))));
    return;
  }

  const n = state.focus ? byId.get(state.focus) : null;
  if (!n) {
    box.append(el('div', { class: 'empty' }, 'Nothing selected. Choose an artifact from the Browse panel, or press ⌘K.'));
    return;
  }

  if (state.rtab === 'neighbors') {
    const i = idx.get(n.id);
    const groups = new Map();
    const push = (h, node) => { if (!groups.has(h)) groups.set(h, []); groups.get(h).push(node); };
    for (const e of outAdj[i]) {
      push(REL_OUT[e.relation] ?? e.relation,
        el('li', {}, nodeLink(e.target),
          e.context && e.context !== 'success' ? el('span', { class: 'ctx', text: ` — ${e.context}` }) : null));
    }
    for (const e of inAdj[i]) push(REL_IN[e.relation] ?? `${e.relation} (in)`, el('li', {}, nodeLink(e.source)));
    if (!groups.size) { box.append(el('div', { class: 'empty' }, 'No relationships.')); return; }
    for (const [h, items] of groups) {
      box.append(el('div', { class: 'relgrp' },
        el('span', { class: 'lbl' }, `${h} · ${items.length}`),
        el('ul', { class: 'links' }, ...items)));
    }
    return;
  }

  // ---- node tab
  const L = STACK_BY_LAYER.get(n.layer);
  if (L) {
    box.append(el('div', { style: 'margin-bottom:12px' },
      el('span', { class: 'badge', style: `border-color:${L.color};color:${L.color}` }, `${L.name}`),
      n.studioSection && n.studioSection !== 'Derived' ? chip(n.studioSection) : null,
      n.stackRole ? chip(n.stackRole) : null,
      n.appExposed ? chip('app-exposed') : null,
      // the authoring corpus: what kind of statement, what kind of reference
      n.modality ? chip(`${n.modality} · "${n.marker}"`, n.modality === 'prohibition' ? 'hot' : undefined) : null,
      n.promptRole ? chip(n.promptRole) : null,
      n.ruleCount ? chip(`${n.ruleCount} rules`) : null,
      n.type === 'workflowNodeType' && n.specified && !n.usedHere ? chip('specified, unused here', 'hot') : null,
      n.type === 'workflowNodeType' && !n.specified ? chip('no spec', 'hot') : null,
      n.origin === 'local' ? chip('your environment', 'hot') : null));
  }

  box.append(el('span', { class: 'lbl' }, 'Overview'));
  const rows = [];
  for (const [k, label] of PROPS) {
    const v = n[k];
    if (v === undefined || v === null || v === '') continue;
    rows.push(el('dt', { text: label }), el('dd', { text: Array.isArray(v) ? v.join(', ') : String(v) }));
  }
  if (rows.length) box.append(el('dl', { class: 'kv', style: 'margin:6px 0 14px' }, ...rows));
  if (n.summary) box.append(el('p', { class: 'ctx', style: 'margin:0 0 14px' }, n.summary));

  box.append(el('span', { class: 'lbl' }, 'Graph signals'));
  box.append(el('div', { class: 'metric-grid', style: 'margin:6px 0 14px' },
    el('div', { class: 'metric' }, el('div', { class: 'k', text: 'PageRank' }),
      el('div', { class: 'v', text: sci(n.pagerank) }),
      el('div', { class: 's', text: `rank #${n.pagerankRank ?? '—'}` })),
    el('div', { class: 'metric' }, el('div', { class: 'k', text: 'Betweenness' }),
      el('div', { class: 'v', text: sci(n.betweenness) }),
      el('div', { class: 's', text: `bridge ${(n.bridgeScore ?? 0).toFixed(1)}` })),
    el('div', { class: 'metric' }, el('div', { class: 'k', text: 'Blast radius' }),
      el('div', { class: 'v', text: num(n.blastRadius) }),
      el('div', { class: 's', text: 'dependents' })),
    el('div', { class: 'metric' }, el('div', { class: 'k', text: 'Clustering' }),
      el('div', { class: 'v', text: (n.clustering ?? 0).toFixed(2) }),
      el('div', { class: 's', text: `component ${n.componentId ?? '—'}` }))));

  if (n.prompt) { box.append(el('span', { class: 'lbl' }, 'LLM prompt'), el('pre', { text: n.prompt })); }
  if (n.expr) { box.append(el('span', { class: 'lbl' }, 'Routing expression'), el('pre', { text: n.expr })); }
  if (n.src) {
    box.append(el('span', { class: 'lbl' }, `Code${n.sourceCodeLines ? ` · ${n.sourceCodeLines} lines` : ''}`),
      el('pre', { text: n.src }));
  }

  const i2 = idx.get(n.id);
  const counts = new Map();
  for (const e of [...outAdj[i2], ...inAdj[i2]]) counts.set(e.relation, (counts.get(e.relation) ?? 0) + 1);
  if (counts.size) {
    box.append(el('span', { class: 'lbl', style: 'display:block;margin-top:14px' }, 'Connected edge types'));
    const wrap = el('div', { style: 'margin-top:6px' });
    for (const [r, c] of [...counts].sort((a, b) => b[1] - a[1])) {
      wrap.append(el('span', {
        class: `badge clickable ${relVisible(r) ? '' : 'off'}`.trim(),
        title: relVisible(r) ? 'Click to hide from the graph' : 'Click to show in the graph',
        onclick: () => toggleRel(r),
        text: `${r} · ${c}`,
      }));
    }
    box.append(wrap);
  }

  if (n.source_file && n.source_file !== '(derived)') {
    box.append(el('span', { class: 'lbl', style: 'display:block;margin-top:14px' }, 'Source'),
      el('div', { style: 'margin-top:5px;font-size:12px' },
        el('code', { class: 'mono', text: n.source_file }), ' ',
        el('a', { class: 'nl', href: `${G.repoUrl}/${n.source_file}`, target: '_blank', rel: 'noreferrer' }, 'open ↗')));
  }
}

// ---------------------------------------------------------------- legend, status, counts

let legendExpanded = false;

/** Relations on screen first; the other ~30 stay behind an expander so the
 *  legend is a readable strip rather than a 4,000px horizontal scroll. */
function renderLegend() {
  const box = $('#legend');
  box.replaceChildren();
  const sliceCounts = new Map();
  for (const e of slice.edges) sliceCounts.set(e.relation, (sliceCounts.get(e.relation) ?? 0) + 1);

  const mk = (r, total, inSlice) => el('span', {
    class: `badge clickable ${relVisible(r) ? '' : 'off'}`.trim(),
    title: `${r} — ${total} in the corpus${inSlice ? `, ${inSlice} in view` : ', none in view'}. Click to toggle.`,
    onclick: () => toggleRel(r),
    text: inSlice ? `${r} ${inSlice}` : r,
  });

  const inView = [...sliceCounts].sort((a, b) => b[1] - a[1]);
  const rest = [...relCounts].filter(([r]) => !sliceCounts.has(r)).sort((a, b) => b[1] - a[1]);

  for (const [r, c] of inView) box.append(mk(r, relCounts.get(r) ?? c, c));

  if (legendExpanded) {
    for (const [r, total] of rest) box.append(mk(r, total, 0));
  }
  if (rest.length) {
    box.append(el('span', {
      class: 'badge clickable',
      onclick: () => { legendExpanded = !legendExpanded; renderLegend(); },
      text: legendExpanded ? 'show less' : `+${rest.length} not in view`,
    }));
  }
  $('#legend-count').textContent =
    `${inView.length} in view · ${state.hiddenRels.size} hidden of ${relCounts.size}`;
}

function toggleRel(r) {
  if (state.hiddenRels.has(r)) state.hiddenRels.delete(r);
  else state.hiddenRels.add(r);
  refreshGraph();
}

function renderCounts() {
  $('#counts').replaceChildren(
    el('span', { class: 'c' }, el('span', { class: 'dot', style: `background:${cssVar('--t-workflow')}` }),
      el('b', { text: num(N) }), 'artifacts'),
    el('span', { class: 'c' }, el('span', { class: 'dot', style: `background:${cssVar('--teal')}` }),
      el('b', { text: num(EDGES.length) }), 'edges'),
    el('span', { class: 'c' }, el('span', { class: 'dot', style: `background:${cssVar('--violet')}` }),
      el('b', { text: num(COMMUNITIES.size) }), 'communities'));
  $('#build').textContent = G.generatedAt ? `graph ${G.generatedAt.slice(0, 16).replace('T', ' ')}` : '';
}

function renderStatus() {
  const n = state.focus ? byId.get(state.focus) : null;
  $('#status-left').textContent = sim.nodes.length
    ? `${sim.nodes.length} nodes · ${sim.edges.length} edges · ${n ? n.label : ''}`
    : `${num(N)} nodes · ${num(EDGES.length)} edges · nothing focused`;
  const settled = state.layout !== 'force'
    ? 'static layout'
    : (sim.alpha <= 0.02 ? `layout settled (${sim.energy.toFixed(2)})` : 'relaxing…');
  $('#status-right').textContent = `${state.layout} · depth ${state.depth} · ${settled}`;
}

const PANEL_W = { wide: { left: 312, right: 336 }, narrow: { left: 268, right: 300 } };
const COLLAPSED_W = 30;

/** Set the grid tracks inline; a stylesheet rule for this did not take effect. */
function setPanelWidths() {
  const gm = document.querySelector('.graph-main');
  if (!gm) return;
  if (!state.leftCollapsed && !state.rightCollapsed) {
    gm.style.gridTemplateColumns = '';   // hand it back to the stylesheet
    return;
  }
  const base = window.innerWidth <= 1280 ? PANEL_W.narrow : PANEL_W.wide;
  const l = state.leftCollapsed ? COLLAPSED_W : base.left;
  const r = state.rightCollapsed ? COLLAPSED_W : base.right;
  gm.style.gridTemplateColumns = `${l}px minmax(0, 1fr) ${r}px`;
}

function setCollapsed(side, val) {
  if (side === 'left') state.leftCollapsed = val;
  else state.rightCollapsed = val;
  document.body.classList.toggle(`${side}-collapsed`, val);
  setPanelWidths();
  const btn = $(`#toggle-${side}`);
  if (btn) {
    btn.textContent = side === 'left' ? (val ? '›' : '‹') : (val ? '‹' : '›');
    btn.setAttribute('aria-expanded', String(!val));
    btn.title = `${val ? 'Expand' : 'Collapse'} panel (${side === 'left' ? '[' : ']'})`;
  }
  // the grid column changed, so the canvas needs a re-measure
  requestAnimationFrame(() => { paint(); fit(); });
}

function renderCredit() {
  const a = G.author ?? {};
  if (!a.name && !G.attribution) return;
  const box = $('#credit');
  if (!box) return;
  const at = G.attribution;
  box.replaceChildren(...[
    'built by ',
    a.linkedin
      ? el('a', { class: 'nl', href: a.linkedin, target: '_blank', rel: 'noreferrer' }, a.name)
      : el('span', { text: a.name }),
    at?.text ? ' · ' : null,
    at?.text ? el('a', { class: 'nl', href: at.href, target: '_blank', rel: 'noreferrer' }, at.text) : null,
  ].filter(Boolean));
}

const LAYOUT_HINTS = {
  stack: 'Two stacks: the skill package this repo ships on top (skills → references → rules → vocabulary → CLI), Oracle\'s sample apps below it as the worked example.',
  force: 'Force directed. Good for spotting clusters and bridges around the focus.',
  layered: 'Levels follow edge direction from the focus — the one that reads a workflow pipeline left to right.',
  radial: 'One ring per hop, so distance from the focus is literal.',
  concentric: 'Groups by Louvain community, making cluster membership obvious. The default.',
  grid: 'Ranked grid ordered by the current Size metric. Best for comparing magnitudes.',
};

// ---------------------------------------------------------------- focus + refresh

function focusNode(id) {
  state.focus = id;
  if (state.tab !== 'graph') switchTab('graph');
  refreshGraph();
}

function refreshGraph() {
  computeSlice();
  startLayout();
  renderFocusPanel();
  renderRight();
  renderLegend();
  renderStatus();
}

// ---------------------------------------------------------------- command palette

let palette = null;

const TYPE_RANK = {
  app: 12, workflow: 10, skill: 10, businessObject: 8, cliCommand: 7, tool: 6,
  promptReference: 6, deeplink: 5, doc: 4, boFunction: 3, workflowNode: 2,
};

function openPalette() {
  if (palette) return;
  let hits = [];
  let sel = 0;

  const input = el('input', { type: 'text', placeholder: 'Search names, codes, prompts, JS source…', spellcheck: 'false' });
  const list = el('div', { class: 'hits' });
  const box = el('div', { class: 'palette' }, input, list,
    el('div', { class: 'foot' },
      el('span', {}, '↑↓ move'), el('span', {}, '↵ focus'), el('span', {}, 'esc close'),
      el('span', { style: 'margin-left:auto' }, 'searches prompts and code too')));
  const back = el('div', { class: 'palette-back', onclick: (e) => { if (e.target === back) closePalette(); } }, box);

  const highlight = (text, toks) => {
    if (!toks.length) return [text];
    const lower = text.toLowerCase();
    const marks = [];
    for (const t of toks) {
      let i = lower.indexOf(t);
      while (i !== -1) { marks.push([i, i + t.length]); i = lower.indexOf(t, i + t.length); }
    }
    if (!marks.length) return [text];
    marks.sort((a, b) => a[0] - b[0]);
    const out = []; let pos = 0;
    for (const [a, b] of marks) {
      if (a < pos) continue;
      if (a > pos) out.push(text.slice(pos, a));
      out.push(el('em', { text: text.slice(a, b) }));
      pos = b;
    }
    if (pos < text.length) out.push(text.slice(pos));
    return out;
  };

  const run = () => {
    const toks = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const scored = [];
    for (let i = 0; i < N; i++) {
      const n = NODES[i];
      let s = 0;
      if (toks.length) {
        const label = (n.label || '').toLowerCase();
        let ok = true;
        for (const t of toks) {
          if (!hay[i].includes(t)) { ok = false; break; }
          if (label === t) s += 100;
          else if (label.startsWith(t)) s += 40;
          else if (label.includes(t)) s += 18;
          if ((n.code || '').toLowerCase().includes(t)) s += 12;
          s += 1;
        }
        if (!ok) continue;
      } else {
        s = (n.pagerank ?? 0) * 8000;
      }
      scored.push([s + (TYPE_RANK[n.type] ?? 0), i]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    hits = scored.slice(0, 60).map(([, i]) => NODES[i]);
    sel = 0;
    draw();
  };

  const draw = () => {
    list.replaceChildren();
    const toks = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    hits.forEach((n, i) => {
      list.append(el('div', {
        class: 'hit', 'aria-selected': i === sel ? 'true' : 'false',
        onclick: () => { focusNode(n.id); closePalette(); },
      },
        el('span', { class: 'dot', style: `background:${typeColor(n.type)}` }),
        el('span', { class: 't' }, ...highlight(String(n.label), toks)),
        el('span', { class: 'm', text: [n.type, n.workflow ?? n.family].filter(Boolean).join(' · ') })));
    });
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, hits.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (hits[sel]) { focusNode(hits[sel].id); closePalette(); } }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });

  document.body.append(back);
  palette = back;
  input.focus();
  run();
}

function closePalette() {
  if (palette) palette.remove();
  palette = null;
}

// ---------------------------------------------------------------- data lab

const LAB_COLS = [
  ['label', 'Node'], ['studioSection', 'Studio section'], ['layerName', 'Layer'], ['type', 'Kind'], ['family', 'Family'], ['product', 'Product'],
  ['community', 'Comm'], ['pagerankRank', 'PR #'], ['pagerank', 'PageRank'],
  ['bridgeScore', 'Bridge'], ['blastRadius', 'Blast'], ['degree', 'Degree'],
  ['clustering', 'Clust'], ['flags', 'Flags'],
];

function labRows() {
  const { q, layer, type, family, flag } = state.lab;
  const toks = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return NODES.filter((n, i) => {
    if (layer !== '' && String(n.layer) !== layer) return false;
    if (type && n.type !== type) return false;
    if (family && n.family !== family) return false;
    if (flag === 'articulation' && !n.articulation) return false;
    if (flag === 'issues' && !n.issues?.length) return false;
    if (flag === 'stub' && !n._stub) return false;
    if (flag === 'local' && n.origin !== 'local') return false;
    return toks.every((t) => hay[i].includes(t));
  });
}

function renderLab() {
  const { sort, dir } = state.lab;
  const rows = labRows().sort((a, b) => {
    const x = a[sort], y = b[sort];
    if (typeof x === 'number' || typeof y === 'number') {
      return ((y ?? -Infinity) - (x ?? -Infinity)) * (dir === -1 ? 1 : -1);
    }
    return String(x ?? '').localeCompare(String(y ?? '')) * (dir === -1 ? -1 : 1);
  });

  $('#lab-count').textContent = `${num(rows.length)} of ${num(N)}`
    + (rows.length > 1200 ? ' — showing first 1,200' : '');

  $('#lab-grid').replaceChildren(
    el('thead', {}, el('tr', {}, ...LAB_COLS.map(([k, label]) =>
      el('th', {
        class: sort === k ? 'sorted' : '',
        onclick: () => {
          if (state.lab.sort === k) state.lab.dir = -state.lab.dir;
          else { state.lab.sort = k; state.lab.dir = -1; }
          renderLab();
        },
        text: label + (sort === k ? (dir === -1 ? ' ↓' : ' ↑') : ''),
      })))),
    el('tbody', {}, ...rows.slice(0, 1200).map((n) => el('tr', {},
      el('td', { class: 'name' }, nodeLink(n.id), n.origin === 'local' ? chip('yours') : null),
      el('td', { text: n.studioSection ?? '' }),
      el('td', {}, el('span', { class: 'dot', style: `display:inline-block;background:${layerColor(n.layer)};margin-right:5px` }), n.layerName ?? ''),
      el('td', {}, el('span', { class: 'dot', style: `display:inline-block;background:${typeColor(n.type)};margin-right:5px` }), n.type),
      el('td', { text: n.family ?? '' }),
      el('td', { text: n.product ?? '' }),
      el('td', { class: 'num', text: n.community ?? '' }),
      el('td', { class: 'num', text: n.pagerankRank ?? '' }),
      el('td', { class: 'num', text: sci(n.pagerank) }),
      el('td', { class: 'num', text: (n.bridgeScore ?? 0).toFixed(1) }),
      el('td', { class: 'num', text: num(n.blastRadius) }),
      el('td', { class: 'num', text: num(n.degree) }),
      el('td', { class: 'num', text: (n.clustering ?? 0).toFixed(2) }),
      el('td', {}, n.articulation ? chip('cut', 'warn') : null,
        n.issues?.length ? chip('finding', 'warn') : null,
        n._stub ? chip('external') : null)))));
}

function exportCsv() {
  const rows = labRows();
  const cols = LAB_COLS.filter(([k]) => k !== 'flags').map(([k]) => k);
  const head = [...cols, 'articulation', 'issues', 'source_file'];
  const esc = (v) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [head.join(','), ...rows.map((n) => [
    ...cols.map((c) => esc(n[c])),
    esc(!!n.articulation), esc((n.issues ?? []).join('; ')), esc(n.source_file),
  ].join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = el('a', { href: url, download: 'fusion-ai-studio-nodes.csv' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function resolveOne(text) {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const exact = NODES.find((n) => (n.label || '').toLowerCase() === t || (n.code || '').toLowerCase() === t);
  if (exact) return exact;
  const starts = NODES.filter((n) => (n.label || '').toLowerCase().startsWith(t) || (n.code || '').toLowerCase().startsWith(t));
  if (starts.length) return starts.sort((a, b) => a.label.length - b.label.length)[0];
  const inc = NODES.filter((n) => (n.label || '').toLowerCase().includes(t));
  return inc.sort((a, b) => a.label.length - b.label.length)[0] ?? null;
}

function bfsPath(aId, bId, directed) {
  const prev = new Map([[aId, null]]);
  const q = [aId];
  while (q.length) {
    const cur = q.shift();
    if (cur === bId) break;
    const i = idx.get(cur);
    if (i === undefined) continue;
    const steps = [
      ...outAdj[i].map((e) => [e.target, e, '→']),
      ...(directed ? [] : inAdj[i].map((e) => [e.source, e, '←'])),
    ];
    for (const [next, e, d] of steps) {
      if (prev.has(next)) continue;
      prev.set(next, [cur, e, d]);
      q.push(next);
    }
  }
  if (!prev.has(bId)) return null;
  const chain = [];
  let cur = bId;
  while (prev.get(cur)) { const [from, e, d] = prev.get(cur); chain.unshift({ to: cur, e, d }); cur = from; }
  return chain;
}

function buildTools() {
  const pa = el('input', { type: 'text', placeholder: 'From — e.g. Succession Readiness Workspace' });
  const pb = el('input', { type: 'text', placeholder: 'To — e.g. Succession Details Lookup' });
  const pd = el('input', { type: 'checkbox' });
  const pout = el('div');
  const pgo = () => {
    pout.replaceChildren();
    const A = resolveOne(pa.value), B = resolveOne(pb.value);
    if (!A || !B) { pout.append(el('div', { class: 'empty' }, 'Could not resolve both endpoints.')); return; }
    const chain = bfsPath(A.id, B.id, pd.checked);
    if (!chain) {
      pout.append(el('div', { class: 'empty' }, pd.checked
        ? 'No directed path. Untick “follow direction” to allow either way.'
        : 'These two are not connected.'));
      return;
    }
    pout.append(el('p', { class: 'ctx', style: 'margin:4px 0 6px', text: `${chain.length} hop${chain.length === 1 ? '' : 's'}` }));
    pout.append(el('div', { class: 'hop' }, el('span', { class: 'num', text: '0' }), nodeLink(A.id)));
    chain.forEach((h, i) => pout.append(el('div', { class: 'hop' },
      el('span', { class: 'num', text: String(i + 1) }),
      el('span', {},
        el('span', { class: 'via', text: `${h.d} ${h.e.relation}${h.e.context && h.e.context !== 'success' ? ` (${h.e.context})` : ''} ` }),
        nodeLink(h.to)))));
  };
  for (const i of [pa, pb]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') pgo(); });
  $('#tool-path').replaceChildren(
    el('h3', { text: 'Shortest path' }),
    el('p', { class: 'ctx' }, 'How does this app reach that business object?'),
    el('div', { class: 'row' }, pa),
    el('div', { class: 'row' }, pb),
    el('div', { class: 'row' },
      el('label', { style: 'font-size:12px;color:var(--fg-dim);display:flex;gap:5px;align-items:center' }, pd, ' follow direction'),
      el('button', { class: 'go', onclick: pgo, text: 'Find path' })),
    pout);

  const ia = el('input', { type: 'text', placeholder: 'Artifact — e.g. Succession Details Lookup' });
  const idep = el('input', { type: 'range', min: '1', max: '4', value: '2', style: 'accent-color:var(--accent)' });
  const idv = el('span', { class: 'ctx', text: '2' });
  const iout = el('div');
  idep.addEventListener('input', () => { idv.textContent = idep.value; });
  const igo = () => {
    iout.replaceChildren();
    const A = resolveOne(ia.value);
    if (!A) { iout.append(el('div', { class: 'empty' }, 'Could not resolve that artifact.')); return; }
    const maxD = Number(idep.value);
    const seen = new Map([[A.id, 0]]);
    let frontier = [A.id];
    for (let d = 1; d <= maxD; d++) {
      const next = [];
      for (const id of frontier) {
        const i = idx.get(id);
        if (i === undefined) continue;
        for (const e of inAdj[i]) if (!seen.has(e.source)) { seen.set(e.source, d); next.push(e.source); }
      }
      frontier = next;
    }
    seen.delete(A.id);
    iout.append(el('p', { class: 'ctx', style: 'margin:4px 0 6px' },
      `${num(seen.size)} artifact${seen.size === 1 ? '' : 's'} depend on `, nodeLink(A.id),
      ` within ${maxD} hop${maxD === 1 ? '' : 's'}. Full blast radius: ${num(A.blastRadius)}.`));
    const groups = new Map();
    for (const [id, d] of seen) {
      const t = byId.get(id)?.type ?? '?';
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push([id, d]);
    }
    for (const [t, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      iout.append(el('details', { class: 'grp' },
        el('summary', {}, el('span', { class: 'dot', style: `display:inline-block;background:${typeColor(t)};margin-right:6px` }), `${t} (${list.length})`),
        el('ul', { class: 'links' }, ...list.sort((p, q) => p[1] - q[1]).map(([id, d]) =>
          el('li', {}, nodeLink(id), el('span', { class: 'ctx', text: ` · ${d} hop${d === 1 ? '' : 's'}` }))))));
    }
  };
  ia.addEventListener('keydown', (e) => { if (e.key === 'Enter') igo(); });
  $('#tool-impact').replaceChildren(
    el('h3', { text: 'Impact analysis' }),
    el('p', { class: 'ctx' }, 'What needs re-testing if this changes?'),
    el('div', { class: 'row' }, ia),
    el('div', { class: 'row' },
      el('label', { style: 'font-size:12px;color:var(--fg-dim);display:flex;gap:6px;align-items:center' }, 'depth', idep, idv),
      el('button', { class: 'go', onclick: igo, text: 'Analyse' })),
    iout);
}

// ---------------------------------------------------------------- wiring

function switchTab(t) {
  state.tab = t;
  // `[data-tab]` and not a bare `button`: the tab strip also holds the theme
  // switch, and matching those made a theme click call switchTab(undefined),
  // which hid both sections and left a blank page.
  for (const b of document.querySelectorAll('.tabstrip button[data-tab]')) {
    b.setAttribute('aria-selected', b.dataset.tab === t ? 'true' : 'false');
  }
  $('#graph').hidden = t !== 'graph';
  $('#lab').hidden = t !== 'lab';
  if (t === 'graph') { paint(); renderStatus(); } else renderLab();
}

for (const b of document.querySelectorAll('.tabstrip button[data-tab]')) {
  b.addEventListener('click', () => switchTab(b.dataset.tab));
}
for (const b of document.querySelectorAll('.rtabs button')) {
  b.addEventListener('click', () => {
    state.rtab = b.dataset.rtab;
    for (const x of document.querySelectorAll('.rtabs button')) {
      x.setAttribute('aria-selected', x.dataset.rtab === state.rtab ? 'true' : 'false');
    }
    renderRight();
  });
}

$('#color-by').addEventListener('change', (e) => { state.colorBy = e.target.value; paint(); renderFocusPanel(); });
$('#size-by').addEventListener('change', (e) => {
  state.sizeBy = e.target.value;
  if (state.layout === 'grid') startLayout(); else paint();
});
$('#layout').addEventListener('change', (e) => {
  state.layout = e.target.value;
  $('#layout-hint').textContent = LAYOUT_HINTS[state.layout];
  startLayout();
});
$('#depth').addEventListener('input', (e) => {
  state.depth = Number(e.target.value);
  $('#depth-v').textContent = `${state.depth} hop${state.depth > 1 ? 's' : ''}`;
  refreshGraph();
});
$('#fit').addEventListener('click', fit);
$('#clear-focus').addEventListener('click', () => { state.focus = null; refreshGraph(); });
$('#legend-all').addEventListener('click', () => {
  if (state.hiddenRels.size) state.hiddenRels.clear();
  else state.hiddenRels = new Set(CLASSIFICATION_RELS);
  refreshGraph();
});
// ---------------------------------------------------------------- theme

/**
 * Three states, because "follow the system" is a real preference and not the
 * same as picking one. The choice is stored per browser and never leaves the
 * page; `index.html` applies it before the first paint, and this only has to
 * keep the buttons, the stored value and the canvas in step.
 *
 * The canvas is not CSS — it reads `--fg`, `--panel`, `--border` and the type
 * palette through cssVar() at draw time — so a theme change has to redraw it and
 * re-render the panels that inline a colour. Nothing else in the app caches a
 * colour except typeColor, which is dropped here.
 */
const THEME_KEY = 'fusion-explorer-theme';
const THEME_BUTTONS = [...document.querySelectorAll('#theme button')];

function storedTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

function setTheme(mode, { persist = true } = {}) {
  const root = document.documentElement;
  if (mode === 'auto') delete root.dataset.theme;
  else root.dataset.theme = mode;

  if (persist) {
    try {
      if (mode === 'auto') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, mode);
    } catch {
      /* private mode or blocked storage: the switch still works for this visit */
    }
  }

  for (const b of THEME_BUTTONS) {
    b.setAttribute('aria-pressed', b.dataset.setTheme === mode ? 'true' : 'false');
  }

  typeColorCache.clear();
  paint();
  renderFocusPanel();
  renderRight();
  renderLegend();
  if (state.tab === 'lab') renderLab();
}

for (const b of THEME_BUTTONS) {
  b.addEventListener('click', () => setTheme(b.dataset.setTheme));
}
// In auto, a viewer flipping their OS theme mid-session should follow along —
// the CSS does that on its own, but the canvas does not.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (storedTheme() === 'auto') setTheme('auto', { persist: false });
});

$('#search-open').addEventListener('click', openPalette);
$('#toggle-left').addEventListener('click', () => setCollapsed('left', !state.leftCollapsed));
$('#toggle-right').addEventListener('click', () => setCollapsed('right', !state.rightCollapsed));

$('#lab-q').addEventListener('input', (e) => { state.lab.q = e.target.value; renderLab(); });
$('#lab-layer').addEventListener('change', (e) => { state.lab.layer = e.target.value; renderLab(); });
$('#lab-type').addEventListener('change', (e) => { state.lab.type = e.target.value; renderLab(); });
$('#lab-family').addEventListener('change', (e) => { state.lab.family = e.target.value; renderLab(); });
$('#lab-flag').addEventListener('change', (e) => { state.lab.flag = e.target.value; renderLab(); });
$('#lab-csv').addEventListener('click', exportCsv);

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (palette) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
  if (typing) return;
  if (e.key === '/') { e.preventDefault(); openPalette(); }
  else if (e.key === 'g') switchTab('graph');
  else if (e.key === 'd') switchTab('lab');
  else if (e.key === '[') setCollapsed('left', !state.leftCollapsed);
  else if (e.key === ']') setCollapsed('right', !state.rightCollapsed);
  else if (e.key === 'Escape' && state.focus) { state.focus = null; refreshGraph(); }
});

// ---------------------------------------------------------------- boot

const typeCounts = new Map();
for (const n of NODES) typeCounts.set(n.type, (typeCounts.get(n.type) ?? 0) + 1);
for (const [t, c] of [...typeCounts].sort((a, b) => b[1] - a[1])) {
  $('#lab-type').append(el('option', { value: t, text: `${t} (${c})` }));
}
for (const L of STACK) {
  const c = NODES.filter((n) => n.layer === L.layer).length;
  if (c) $('#lab-layer').append(el('option', { value: String(L.layer), text: `${L.name} (${c})` }));
}
for (const f of [...new Set(NODES.map((n) => n.family).filter(Boolean))].sort()) {
  $('#lab-family').append(el('option', { value: f, text: f }));
}

document.querySelector('.stage').append(el('div', { class: 'overlay ov-empty', id: 'stage-empty' },
  'Nothing selected. Pick an app, agent team, agent or tool from the Browse panel on the left — or press ⌘K to search.'));

$('#layout').value = state.layout;
$('#color-by').value = state.colorBy;
$('#layout-hint').textContent = LAYOUT_HINTS[state.layout];
renderCounts();
renderCredit();
buildTools();

// First load starts with nothing selected: the left panel lists what is
// available, so the entry point is a deliberate choice rather than an arbitrary
// seed node.
state.focus = null;
refreshGraph();
renderLab();

// index.html already applied the stored theme to <html>; this only syncs the
// buttons to it, now that there is something on the canvas to redraw.
setTheme(storedTheme(), { persist: false });
