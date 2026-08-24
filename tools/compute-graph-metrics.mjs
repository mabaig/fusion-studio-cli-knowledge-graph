#!/usr/bin/env node
/**
 * compute-graph-metrics.mjs
 *
 * Adds centrality and fragility metrics to graph/fusion-graph.json, in place,
 * as node attributes. Runs after extraction and before the vault / app builders,
 * so both surfaces pick the numbers up for free.
 *
 * Deliberately computed over the *typed* graph rather than over a markdown
 * vault: edges here mean `calls_bo_function`, `reads_output_of`, `flows_to`,
 * so centrality measures architecture. Markdown-proximity edges (same folder,
 * shared tag, similar mtime) would swamp 8.5k real edges with ~1M derived ones
 * and the same algorithms would then be measuring folder layout.
 *
 * Metrics
 *   pagerank     directed, damping 0.85 — architectural importance. High = many
 *                things point at it, especially things that are themselves
 *                pointed at. The honest answer to "what is the real hub".
 *   betweenness  Brandes, undirected, normalised — bridge-ness. High = removing
 *                it disconnects otherwise-separate parts of the corpus.
 *   articulation true when removing the node disconnects its component outright:
 *                a structural single point of failure.
 *   blastRadius  how many nodes can transitively reach it. The exact number of
 *                artifacts affected if this one changes.
 *
 * Usage:
 *   node tools/compute-graph-metrics.mjs [--graph <path>] [--report <path>]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};
const HERE = path.dirname(new URL(import.meta.url).pathname);
const KG_ROOT = path.resolve(HERE, '..');
const GRAPH = path.resolve(arg('--graph', path.join(KG_ROOT, 'graph/fusion-graph.json')));
const REPORT = path.resolve(arg('--report', path.join(KG_ROOT, 'graph/METRICS.md')));

const graph = JSON.parse(fs.readFileSync(GRAPH, 'utf8'));
const nodes = graph.nodes;
const n = nodes.length;
const index = new Map(nodes.map((x, i) => [x.id, i]));

// ---------------------------------------------------------------- CSR adjacency
// Compressed adjacency: one flat Int32Array of neighbours plus per-node offsets.
// Faster and far less garbage than 2,577 separate arrays across ~21M traversals.

function buildCsr(pairs, count) {
  const deg = new Int32Array(count);
  for (const [a] of pairs) deg[a]++;
  const start = new Int32Array(count + 1);
  for (let i = 0; i < count; i++) start[i + 1] = start[i] + deg[i];
  const list = new Int32Array(pairs.length);
  const cursor = start.slice(0, count);
  for (const [a, b] of pairs) list[cursor[a]++] = b;
  return { start, list };
}

/**
 * Classification edges attach many artifacts to one shared label — every
 * workflow to `artifactType:.wf`, every HCM artifact to `family:HCM`, every LLM
 * node to a model config. They are true and useful for faceting, but they create
 * artificial 2-hop shortcuts between otherwise unrelated artifacts, and
 * path-based centrality then measures the taxonomy instead of the architecture.
 * (Left in, `artifactType:.wf` scores 0.39 betweenness — five times the highest
 * real workflow — purely because 100 workflows hang off it.)
 *
 * So: path-based metrics run on the dependency subgraph below. Degree metrics
 * still come from the full typed graph, where they are simply descriptive.
 */
const CLASSIFICATION_RELS = new Set([
  'in_family', 'in_product', 'belongs_to_family', 'is_artifact_type',
  'in_group', 'has_verb', 'routes_artifact', 'operates_on',
  'documents_artifact', 'targets_family', 'uses_model', 'governed_by',
  'reads_app_context', 'routes_app_stage', 'has_issue',
  'is_tool_type', 'uses_tool_type',
  // A workflow node "is a" LLM the same way a tool "is a" Deep Link Tool: a
  // label, not a dependency. Left in, the 1,686 node->type edges would make
  // CODE and LLM the most central things in the corpus purely by being names.
  'is_node_type', 'operates_on_test', 'exercises',
]);
const INCLUDE_ALL = argv.includes('--include-classification');

const outPairs = [];
const inPairs = [];
const undSeen = new Set();
const undPairs = [];
const fullDegIn = new Int32Array(n);
const fullDegOut = new Int32Array(n);
let classificationDropped = 0;

for (const e of graph.edges) {
  const a = index.get(e.source);
  const b = index.get(e.target);
  if (a === undefined || b === undefined || a === b) continue;
  fullDegOut[a]++;
  fullDegIn[b]++;
  if (!INCLUDE_ALL && CLASSIFICATION_RELS.has(e.relation)) { classificationDropped++; continue; }
  outPairs.push([a, b]);
  inPairs.push([b, a]);
  // undirected view is simple: collapse parallel edges and direction
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  const key = lo * n + hi;
  if (!undSeen.has(key)) {
    undSeen.add(key);
    undPairs.push([lo, hi], [hi, lo]);
  }
}

const OUT = buildCsr(outPairs, n);
const IN = buildCsr(inPairs, n);
const UND = buildCsr(undPairs, n);

const simpleUndirectedEdges = undSeen.size;
const dependencyEdges = outPairs.length;
console.log(`[metrics] ${n} nodes · ${graph.edges.length} typed edges`);
console.log(
  INCLUDE_ALL
    ? `[metrics] centrality over ALL edges (--include-classification): ${dependencyEdges} directed, ${simpleUndirectedEdges} simple undirected`
    : `[metrics] centrality over the dependency subgraph: ${dependencyEdges} directed, ${simpleUndirectedEdges} simple undirected (${classificationDropped} classification edges excluded)`,
);

// ---------------------------------------------------------------- PageRank

function pagerank({ damping = 0.85, iterations = 200, tolerance = 1e-9 } = {}) {
  let rank = new Float64Array(n).fill(1 / n);
  let next = new Float64Array(n);
  const outDeg = new Int32Array(n);
  for (let i = 0; i < n; i++) outDeg[i] = OUT.start[i + 1] - OUT.start[i];

  for (let it = 0; it < iterations; it++) {
    // dangling nodes (no out-edges) would leak rank; redistribute it uniformly
    let dangling = 0;
    for (let i = 0; i < n; i++) if (outDeg[i] === 0) dangling += rank[i];
    const base = (1 - damping) / n + (damping * dangling) / n;
    next.fill(base);
    for (let v = 0; v < n; v++) {
      const d = outDeg[v];
      if (d === 0) continue;
      const share = (damping * rank[v]) / d;
      for (let k = OUT.start[v]; k < OUT.start[v + 1]; k++) next[OUT.list[k]] += share;
    }
    let diff = 0;
    for (let i = 0; i < n; i++) diff += Math.abs(next[i] - rank[i]);
    const tmp = rank;
    rank = next;
    next = tmp;
    if (diff < tolerance) {
      console.log(`[metrics] pagerank converged in ${it + 1} iterations (L1 delta ${diff.toExponential(2)})`);
      return rank;
    }
  }
  console.log(`[metrics] pagerank hit the ${iterations}-iteration cap without converging`);
  return rank;
}

// ---------------------------------------------------------------- Betweenness (Brandes)

function betweenness() {
  const cb = new Float64Array(n);
  const sigma = new Float64Array(n);
  const dist = new Int32Array(n);
  const delta = new Float64Array(n);
  const queue = new Int32Array(n);
  const stack = new Int32Array(n);
  // predecessors on shortest paths, one reused array-of-arrays
  const predBuf = Array.from({ length: n }, () => []);

  for (let s = 0; s < n; s++) {
    sigma.fill(0);
    dist.fill(-1);
    delta.fill(0);

    sigma[s] = 1;
    dist[s] = 0;
    let qh = 0, qt = 0, sp = 0;
    queue[qt++] = s;

    while (qh < qt) {
      const v = queue[qh++];
      stack[sp++] = v;
      for (let k = UND.start[v]; k < UND.start[v + 1]; k++) {
        const w = UND.list[k];
        if (dist[w] < 0) {
          dist[w] = dist[v] + 1;
          queue[qt++] = w;
        }
        if (dist[w] === dist[v] + 1) {
          sigma[w] += sigma[v];
          predBuf[w].push(v);
        }
      }
    }
    while (sp > 0) {
      const w = stack[--sp];
      const ps = predBuf[w];
      if (ps.length) {
        const coeff = (1 + delta[w]) / sigma[w];
        for (let i = 0; i < ps.length; i++) delta[ps[i]] += sigma[ps[i]] * coeff;
        ps.length = 0;
      }
      if (w !== s) cb[w] += delta[w];
    }
    if ((s & 511) === 0) process.stdout.write(`\r[metrics] betweenness ${s}/${n}   `);
  }
  process.stdout.write(`\r[metrics] betweenness ${n}/${n}   \n`);

  // each unordered pair is counted from both endpoints
  const scale = 2 / ((n - 1) * (n - 2));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = (cb[i] / 2) * scale;
  return out;
}

// ---------------------------------------------------------------- Articulation points

/** Iterative Hopcroft-Tarjan: recursion would risk the stack at this depth. */
function articulationPoints() {
  const disc = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const parent = new Int32Array(n).fill(-1);
  const isArt = new Uint8Array(n);
  const iter = new Int32Array(n);
  let timer = 0;

  for (let root = 0; root < n; root++) {
    if (disc[root] !== -1) continue;
    let children = 0;
    const stack = [root];
    disc[root] = low[root] = timer++;
    iter[root] = UND.start[root];

    while (stack.length) {
      const v = stack[stack.length - 1];
      if (iter[v] < UND.start[v + 1]) {
        const w = UND.list[iter[v]++];
        if (disc[w] === -1) {
          parent[w] = v;
          disc[w] = low[w] = timer++;
          iter[w] = UND.start[w];
          stack.push(w);
          if (v === root) children++;
        } else if (w !== parent[v]) {
          if (disc[w] < low[v]) low[v] = disc[w];
        }
      } else {
        stack.pop();
        const p = parent[v];
        if (p !== -1) {
          if (low[v] < low[p]) low[p] = low[v];
          // a non-root cut vertex: no back-edge from v's subtree above p
          if (p !== root && low[v] >= disc[p]) isArt[p] = 1;
        }
      }
    }
    if (children > 1) isArt[root] = 1;
  }
  return isArt;
}

// ---------------------------------------------------------------- Blast radius

/** How many distinct nodes can reach `i` by following edge direction. */
function blastRadius() {
  const out = new Int32Array(n);
  const seen = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    let qh = 0, qt = 0, count = 0;
    seen[s] = s;
    queue[qt++] = s;
    while (qh < qt) {
      const v = queue[qh++];
      for (let k = IN.start[v]; k < IN.start[v + 1]; k++) {
        const w = IN.list[k];
        if (seen[w] !== s) {
          seen[w] = s;
          queue[qt++] = w;
          count++;
        }
      }
    }
    out[s] = count;
    if ((s & 511) === 0) process.stdout.write(`\r[metrics] blast radius ${s}/${n}   `);
  }
  process.stdout.write(`\r[metrics] blast radius ${n}/${n}   \n`);
  return out;
}


// ---------------------------------------------------------------- Louvain communities

/**
 * Louvain modularity optimisation on the undirected dependency graph.
 * Deterministic: nodes are visited in index order and ties break toward the
 * lowest community id, so a rebuild of an unchanged corpus yields identical
 * community ids and the vault/app diffs stay readable.
 */
function louvain() {
  // level 0 graph = the simple undirected dependency graph, unit weights
  let adj = Array.from({ length: n }, (_, i) => {
    const out = [];
    for (let k = UND.start[i]; k < UND.start[i + 1]; k++) out.push([UND.list[k], 1]);
    return out;
  });
  let selfLoop = new Float64Array(n);
  let size = new Int32Array(n).fill(1);
  let count = n;
  // membership of each ORIGINAL node, remapped after every aggregation
  let membership = new Int32Array(n).fill(0).map((_, i) => i);
  let level = 0;

  for (;;) {
    const m2 = adj.reduce((acc, list, i) => acc + list.reduce((a, [, w]) => a + w, 0) + 2 * selfLoop[i], 0);
    if (m2 === 0) break;

    const degree = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      let d = 2 * selfLoop[i];
      for (const [, w] of adj[i]) d += w;
      degree[i] = d;
    }

    const comm = new Int32Array(count).map((_, i) => i);
    const commDegree = Float64Array.from(degree);
    let moved = false;

    for (let sweep = 0; sweep < 20; sweep++) {
      let sweepMoved = false;
      for (let v = 0; v < count; v++) {
        const from = comm[v];
        // weights from v into each neighbouring community
        const wTo = new Map();
        for (const [u, w] of adj[v]) {
          if (u === v) continue;
          wTo.set(comm[u], (wTo.get(comm[u]) ?? 0) + w);
        }
        commDegree[from] -= degree[v];
        let best = from;
        let bestGain = (wTo.get(from) ?? 0) - (commDegree[from] * degree[v]) / m2;
        for (const [c, w] of [...wTo].sort((a, b) => a[0] - b[0])) {
          if (c === from) continue;
          const gain = w - (commDegree[c] * degree[v]) / m2;
          if (gain > bestGain + 1e-12) { bestGain = gain; best = c; }
        }
        commDegree[best] += degree[v];
        if (best !== from) { comm[v] = best; sweepMoved = true; moved = true; }
      }
      if (!sweepMoved) break;
    }
    if (!moved) break;

    // renumber communities densely
    const remap = new Map();
    for (let i = 0; i < count; i++) {
      if (!remap.has(comm[i])) remap.set(comm[i], remap.size);
      comm[i] = remap.get(comm[i]);
    }
    const newCount = remap.size;
    if (newCount === count) break;

    // push membership down to original nodes
    for (let i = 0; i < n; i++) membership[i] = comm[membership[i]];

    // aggregate: communities become nodes
    const newSelf = new Float64Array(newCount);
    const newAdjMap = Array.from({ length: newCount }, () => new Map());
    const newSize = new Int32Array(newCount);
    for (let i = 0; i < count; i++) {
      const ci = comm[i];
      newSize[ci] += size[i];
      newSelf[ci] += selfLoop[i];
      for (const [j, w] of adj[i]) {
        const cj = comm[j];
        if (ci === cj) newSelf[ci] += w / 2;
        else newAdjMap[ci].set(cj, (newAdjMap[ci].get(cj) ?? 0) + w);
      }
    }
    adj = newAdjMap.map((mp) => [...mp].sort((a, b) => a[0] - b[0]));
    selfLoop = newSelf;
    size = newSize;
    count = newCount;
    level++;
    if (level > 20) break;
  }

  // final densification, ordered by community size so ids are stable and
  // community 0 is always the largest
  const tally = new Map();
  for (let i = 0; i < n; i++) tally.set(membership[i], (tally.get(membership[i]) ?? 0) + 1);
  const order = [...tally].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([c]) => c);
  const finalId = new Map(order.map((c, i) => [c, i]));
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) out[i] = finalId.get(membership[i]);
  console.log(`[metrics] louvain: ${tally.size} communities over ${level} level(s)`);
  return out;
}

/** Modularity of a partition on the undirected dependency graph. */
function modularity(comm) {
  const m2 = UND.list.length; // each undirected edge appears twice
  if (m2 === 0) return 0;
  const inW = new Map();
  const totW = new Map();
  for (let v = 0; v < n; v++) {
    const deg = UND.start[v + 1] - UND.start[v];
    totW.set(comm[v], (totW.get(comm[v]) ?? 0) + deg);
    for (let k = UND.start[v]; k < UND.start[v + 1]; k++) {
      if (comm[UND.list[k]] === comm[v]) inW.set(comm[v], (inW.get(comm[v]) ?? 0) + 1);
    }
  }
  let q = 0;
  for (const [c, tot] of totW) q += (inW.get(c) ?? 0) / m2 - (tot / m2) ** 2;
  return q;
}

// ---------------------------------------------------------------- Components & clustering

function connectedComponents() {
  const comp = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let next = 0;
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1) continue;
    let qh = 0, qt = 0;
    comp[s] = next;
    queue[qt++] = s;
    while (qh < qt) {
      const v = queue[qh++];
      for (let k = UND.start[v]; k < UND.start[v + 1]; k++) {
        const w = UND.list[k];
        if (comp[w] === -1) { comp[w] = next; queue[qt++] = w; }
      }
    }
    next++;
  }
  // renumber so component 0 is the largest
  const tally = new Map();
  for (let i = 0; i < n; i++) tally.set(comp[i], (tally.get(comp[i]) ?? 0) + 1);
  const order = [...tally].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([c]) => c);
  const remap = new Map(order.map((c, i) => [c, i]));
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) out[i] = remap.get(comp[i]);
  console.log(`[metrics] ${tally.size} connected component(s); largest holds ${Math.max(...tally.values())} nodes`);
  return out;
}

/** Local clustering coefficient: how interconnected a node's neighbours are. */
function clusteringCoefficients() {
  const sets = Array.from({ length: n }, (_, i) => {
    const s = new Set();
    for (let k = UND.start[i]; k < UND.start[i + 1]; k++) s.add(UND.list[k]);
    return s;
  });
  const out = new Float64Array(n);
  for (let v = 0; v < n; v++) {
    const nb = [...sets[v]];
    const d = nb.length;
    if (d < 2) continue;
    let links = 0;
    for (let i = 0; i < d; i++) {
      for (let j = i + 1; j < d; j++) if (sets[nb[i]].has(nb[j])) links++;
    }
    out[v] = (2 * links) / (d * (d - 1));
  }
  return out;
}

// ---------------------------------------------------------------- run

const t0 = Date.now();
const pr = pagerank();
const bt = betweenness();
const art = articulationPoints();
const blast = blastRadius();
const comm = louvain();
const q = modularity(comm);
const comp = connectedComponents();
const clust = clusteringCoefficients();
console.log(`[metrics] modularity Q = ${q.toFixed(4)}`);

const prRanked = [...pr.keys()].sort((a, b) => pr[b] - pr[a]);
const prRank = new Int32Array(n);
prRanked.forEach((i, r) => { prRank[i] = r + 1; });

// bridge score = betweenness percentile, the readable form of "how much of a
// joint is this" (0-100). Ties share a rank.
const btSorted = Float64Array.from(bt).sort();
const percentileOf = (v) => {
  let lo = 0, hi = btSorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (btSorted[mid] < v) lo = mid + 1; else hi = mid; }
  return (lo / (btSorted.length - 1)) * 100;
};

const commSize = new Map();
for (let i = 0; i < n; i++) commSize.set(comm[i], (commSize.get(comm[i]) ?? 0) + 1);

for (let i = 0; i < n; i++) {
  const node = nodes[i];
  node.community = comm[i];
  node.communitySize = commSize.get(comm[i]);
  node.componentId = comp[i];
  node.clustering = Number(clust[i].toPrecision(4));
  node.bridgeScore = Number(percentileOf(bt[i]).toPrecision(4));
  node.pagerank = Number(pr[i].toPrecision(6));
  node.pagerankRank = prRank[i];
  node.betweenness = Number(bt[i].toPrecision(6));
  node.blastRadius = blast[i];
  node.inDegree = fullDegIn[i];
  node.outDegree = fullDegOut[i];
  node.degree = node.inDegree + node.outDegree;
  node.depDegree = (IN.start[i + 1] - IN.start[i]) + (OUT.start[i + 1] - OUT.start[i]);
  if (art[i]) node.articulation = true;
  else delete node.articulation;
}

graph._meta = { ...(graph._meta ?? {}), metrics: {
  centralityComputedOver: INCLUDE_ALL ? 'all typed edges' : 'dependency subgraph (classification edges excluded)',
  dependencyEdges,
  classificationEdgesExcluded: INCLUDE_ALL ? 0 : classificationDropped,
  degreeComputedOver: 'all typed edges',
  pagerankDamping: 0.85,
  betweenness: 'Brandes, undirected, normalised',
  articulationPoints: Number([...art].reduce((a, b) => a + b, 0)),
  communities: commSize.size,
  modularity: Number(q.toPrecision(6)),
  components: new Set(comp).size,
} };

fs.writeFileSync(GRAPH, JSON.stringify(graph, null, 1));
console.log(`[metrics] wrote ${GRAPH} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------- report

const ARTIFACTS = new Set(['app', 'workflow', 'workflowNode', 'businessObject', 'boFunction', 'tool', 'deeplink', 'skill', 'promptReference', 'cliCommand']);
const fmt = (v) => (typeof v === 'number' && v < 0.01 && v > 0 ? v.toExponential(2) : String(v));

function table(list, cols) {
  return [
    `| ${cols.map((c) => c[0]).join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...list.map((x) => `| ${cols.map((c) => fmt(c[1](x))).join(' | ')} |`),
  ].join('\n');
}

const top = (key, count, filter = () => true) =>
  nodes.filter(filter).sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0)).slice(0, count);

const NAME = [['Node', (x) => x.label], ['Type', (x) => x.type], ['Where', (x) => x.workflow ?? x.family ?? x.product ?? '—']];

const report = `# Graph metrics

Centrality and fragility over the **typed** graph: ${n} nodes, ${graph.edges.length} typed
edges (${simpleUndirectedEdges} simple undirected). Regenerate with
\`node tools/compute-graph-metrics.mjs\`.

Every node in \`graph/fusion-graph.json\` carries \`pagerank\`, \`pagerankRank\`,
\`betweenness\`, \`blastRadius\`, \`inDegree\`, \`outDegree\`, \`degree\` and, where it applies,
\`articulation: true\`. The vault exposes them as note properties; the Graph Explorer can
sort by them.

## Architectural hubs — PageRank

What the corpus actually points at. Unlike raw degree, a node scores highly here only when
the things pointing at it are themselves important.

${table(top('pagerank', 15), [...NAME, ['PageRank', (x) => x.pagerank], ['In', (x) => x.inDegree], ['Out', (x) => x.outDegree]])}

### Restricted to concrete artifacts

Taxonomy nodes (families, artifact types, model configs) dominate the list above by
construction — everything links to them. This is the same ranking with those removed.

${table(top('pagerank', 15, (x) => ARTIFACTS.has(x.type)), [...NAME, ['PageRank', (x) => x.pagerank], ['Blast radius', (x) => x.blastRadius]])}

## Bridges — betweenness centrality

High betweenness means shortest paths across the corpus funnel through this node. These are
the joints: change one and the effect travels furthest.

${table(top('betweenness', 15), [...NAME, ['Betweenness', (x) => x.betweenness], ['Degree', (x) => x.degree]])}

## Structural single points of failure — articulation points

Removing one of these disconnects its component outright. ${nodes.filter((x) => x.articulation).length} of ${n} nodes qualify.

${table(top('betweenness', 25, (x) => x.articulation), [...NAME, ['Betweenness', (x) => x.betweenness], ['Blast radius', (x) => x.blastRadius], ['Degree', (x) => x.degree]])}

## Blast radius — how far a change reaches

Number of nodes that can transitively reach this one, i.e. how much depends on it.

${table(top('blastRadius', 20, (x) => ARTIFACTS.has(x.type)), [...NAME, ['Blast radius', (x) => x.blastRadius], ['PageRank rank', (x) => `#${x.pagerankRank}`]])}

## Business objects by blast radius

The data layer, ordered by how much of the corpus depends on each source.

${table(top('blastRadius', 20, (x) => x.type === 'businessObject'), [['Business object', (x) => x.label], ['Product', (x) => x.product ?? '—'], ['Blast radius', (x) => x.blastRadius], ['Functions', (x) => x.outDegree]])}
`;

fs.writeFileSync(REPORT, report);
console.log(`[metrics] report -> ${REPORT}`);

console.log('\nTop 5 by PageRank (concrete artifacts):');
for (const x of top('pagerank', 5, (x) => ARTIFACTS.has(x.type))) {
  console.log(`  ${x.pagerank.toExponential(2)}  ${x.type.padEnd(15)} ${x.label}`);
}
console.log(`\nArticulation points: ${nodes.filter((x) => x.articulation).length}`);
console.log('Top 5 by betweenness:');
for (const x of top('betweenness', 5)) {
  console.log(`  ${x.betweenness.toFixed(4)}  ${x.type.padEnd(15)} ${x.label}`);
}
