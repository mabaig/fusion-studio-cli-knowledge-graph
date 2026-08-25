#!/usr/bin/env node
/**
 * extract-fusion-graph.mjs
 *
 * Deterministic knowledge-graph extractor for the Oracle Fusion AI Studio repo
 * (https://github.com/oracle/fusion-ai-studio).
 *
 * Graphify's own AST extractors understand .js/.py/.md but not Oracle's artifact
 * formats (.app/.wf/.bo/.tool/.dl are AI Studio JSON documents). This extractor
 * fills that gap and emits Graphify's graph.json schema, so every graphify
 * command (query / path / explain / god-nodes / tree / cluster-only /
 * export callflow-html) works on the result, and so the vault + search-app
 * builders have a single source of truth.
 *
 * Read-only: never writes inside the source repo.
 *
 * Usage:
 *   node tools/extract-fusion-graph.mjs [--repo <path>] [--out <graph.json>]
 *
 * Writes the canonical graph to graph/fusion-graph.json. run.sh copies it into
 * graphify-out/ for graphify to cluster; graphify's fuzzy dedup may collapse a
 * few same-labelled nodes there, so the canonical copy stays authoritative.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const HERE = path.dirname(new URL(import.meta.url).pathname);
const KG_ROOT = path.resolve(HERE, '..');
const REPO = path.resolve(arg('--repo', path.join(KG_ROOT, '.source/fusion-ai-studio')));
const OUT = path.resolve(arg('--out', path.join(KG_ROOT, 'graph/fusion-graph.json')));
const CLI_HELP = path.resolve(arg('--cli-help', path.join(KG_ROOT, 'data/cli-help.txt')));

if (!fs.existsSync(REPO)) {
  console.error(`[extract] repo not found: ${REPO}\n         run ./run.sh --sync, or pass --repo <path-to-fusion-ai-studio>`);
  process.exit(1);
}

// ---------------------------------------------------------------- graph model

const nodes = new Map(); // id -> node
const edgeKeys = new Set();
const edges = [];
const warnings = [];

/**
 * Artifacts come from two places: the upstream corpus and anything ingested
 * from a live environment into .source/local. Paths stay readable by resolving
 * each file against whichever root contains it.
 */
const LOCAL_ROOT = path.join(KG_ROOT, '.source/local');
const ROOTS = [
  { dir: REPO, origin: 'upstream', prefix: '' },
  ...(fs.existsSync(LOCAL_ROOT) ? [{ dir: LOCAL_ROOT, origin: 'local', prefix: 'local/' }] : []),
];

const rel = (p) => {
  for (const r of ROOTS) {
    if (p.startsWith(r.dir)) return r.prefix + path.relative(r.dir, p);
  }
  return path.relative(REPO, p);
};
const originOf = (p) => (p.startsWith(LOCAL_ROOT) ? 'local' : 'upstream');

function addNode(id, attrs) {
  if (!id) return id;
  const existing = nodes.get(id);
  if (existing) {
    // first writer wins for label/summary; fill in blanks only
    for (const [k, v] of Object.entries(attrs)) {
      if (existing[k] === undefined || existing[k] === null || existing[k] === '') existing[k] = v;
    }
    // a real definition arriving after a forward reference promotes the stub
    if (!attrs._stub) delete existing._stub;
    return id;
  }
  nodes.set(id, { id, file_type: 'code', _origin: 'fusion-ast', ...attrs });
  return id;
}

/** Placeholder for a code referenced but never defined in the corpus. */
function addStub(id, attrs) {
  return addNode(id, { _stub: true, ...attrs });
}

function addEdge(source, target, relation, extra = {}) {
  if (!source || !target || source === target) return;
  // \u0000 rather than a literal NUL: identical at runtime, but a raw NUL makes
  // git treat this whole file as binary, so it never shows a diff on review.
  const key = `${source}\u0000${target}\u0000${relation}\u0000${extra.context ?? ''}`;
  if (edgeKeys.has(key)) return;
  edgeKeys.add(key);
  edges.push({
    source,
    target,
    relation,
    confidence: 'EXTRACTED',
    weight: 1.0,
    _origin: 'fusion-ast',
    ...extra,
  });
}

// ---------------------------------------------------------------- fs helpers

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    warnings.push(`unparsable JSON: ${rel(file)} (${err.message})`);
    return null;
  }
}

const trim = (s, n = 400) =>
  typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : undefined;

// ---------------------------------------------------------------- id scheme

const ID = {
  app: (code) => `app:${code}`,
  wf: (code) => `wf:${code}`,
  wfnode: (wfCode, nodeCode) => `node:${wfCode}/${nodeCode}`,
  bo: (code) => `bo:${code}`,
  bofn: (boCode, fn) => `bofn:${boCode}#${fn}`,
  tool: (code) => `tool:${code}`,
  dl: (code) => `dl:${code}`,
  family: (f) => `family:${f}`,
  product: (p) => `product:${p}`,
  model: (m) => `model:${m}`,
  policy: (p) => `policy:${p}`,
  rest: (p) => `rest:${p}`,
  skill: (n) => `skill:${n}`,
  prompt: (n) => `prompt:${n}`,
  cmd: (n) => `cmd:${n}`,
  doc: (p) => `doc:${p}`,
  panel: (appCode, name) => `panel:${appCode}/${name}`,
  action: (appCode, code) => `action:${appCode}/${code}`,
  artifactType: (ext) => `artifactType:${ext}`,
  stage: (hint) => `appstage:${hint}`,
  // authoring corpus
  section: (owner, heading) => `section:${owner}#${heading}`,
  rule: (owner, i) => `rule:${owner}#${i}`,
  nodeType: (t) => `nodeType:${t}`,
  testKind: (k) => `testKind:${k}`,
  resource: (p) => `resource:${p}`,
};

// ---------------------------------------------------------------- taxonomy nodes

function ensureFamily(family, product, sourceFile) {
  if (family) {
    addNode(ID.family(family), { label: family, type: 'family', file_type: 'concept' });
  }
  if (product) {
    addNode(ID.product(product), { label: product, type: 'product', file_type: 'concept' });
    if (family) addEdge(ID.product(product), ID.family(family), 'belongs_to_family', { source_file: sourceFile });
  }
}

// ---------------------------------------------------------------- expressions

/** Every `{{$context.$nodes.CODE.$output...}}` reference inside a blob. */
function referencedNodeCodes(blob) {
  const out = new Set();
  const re = /\$context\.\$nodes\.([A-Za-z0-9_]+)\./g;
  let m;
  while ((m = re.exec(blob)) !== null) out.add(m[1]);
  return out;
}

/** Every `{{$context.$app.$OraX}}` app-stage/context key inside a blob. */
function referencedAppKeys(blob) {
  const out = new Set();
  const re = /\$context\.\$app\.\$([A-Za-z0-9_]+)/g;
  let m;
  while ((m = re.exec(blob)) !== null) out.add(m[1]);
  return out;
}

/** Literal app-stage hints compared against in SWITCH/CONDITION expressions. */
const APP_STAGES = [
  'InitDisplay',
  'InitActions',
  'InitCommunications',
  'FillParameters',
  'SendCommunication',
  'Query',
];

// ---------------------------------------------------------------- workflows

const workflowFiles = [];
const appFiles = [];
const boFiles = [];
const toolFiles = [];
const dlFiles = [];
const docFiles = [];

// Layout is discovered, not assumed: release-26C dropped the `release-26C/`
// path prefix and moved the bundled skill from aistudio/bin/aistudio to
// .agents/skills, so hardcoded paths would silently produce an empty graph.
let cliScript = null;
const agentFiles = [];

for (const root of ROOTS) {
  for (const f of walk(root.dir)) {
    if (path.basename(f) === 'aistudio.js') cliScript = rel(f);
    const ext = path.extname(f);
    if (ext === '.wf') workflowFiles.push(f);
    else if (ext === '.app') appFiles.push(f);
    else if (ext === '.bo') boFiles.push(f);
    else if (ext === '.tool') toolFiles.push(f);
    else if (ext === '.dl') dlFiles.push(f);
    else if (ext === '.agent') agentFiles.push(f);
    else if (ext === '.md') docFiles.push(f);
  }
}
if (ROOTS.length > 1) {
  console.log(`[extract] roots: ${ROOTS.map((r) => `${r.origin} (${path.basename(r.dir)})`).join(', ')}`);
}

// --- pass 1: business objects (so workflow BO refs resolve to real nodes)

for (const file of boFiles) {
  const bo = readJson(file);
  if (!bo) continue;
  const code = bo.objectCode || path.basename(file, '.bo').toUpperCase();
  const id = addNode(ID.bo(code), {
    label: bo.name || code,
    type: 'businessObject',
    code,
    summary: trim(bo.description),
    family: bo.family,
    product: bo.product,
    objectSource: bo.objectSource,
    restResourcePath: bo.restResourcePath,
    seeded: !!bo.seededFlag,
    origin: originOf(file),
    source_file: rel(file),
  });
  ensureFamily(bo.family, bo.product, rel(file));
  if (bo.family) addEdge(id, ID.family(bo.family), 'in_family', { source_file: rel(file) });
  if (bo.product) addEdge(id, ID.product(bo.product), 'in_product', { source_file: rel(file) });

  if (bo.restResourcePath) {
    const rid = addNode(ID.rest(bo.restResourcePath), {
      label: bo.restResourcePath,
      type: 'restResource',
      file_type: 'concept',
    });
    addEdge(id, rid, 'exposes_rest_resource', { source_file: rel(file) });
  }

  for (const t of bo.objectProperties?.tools ?? []) {
    if (!t?.name) continue;
    const fid = addNode(ID.bofn(code, t.name), {
      label: `${t.name}()`,
      type: 'boFunction',
      code: t.name,
      summary: trim(t.description),
      operationType: t.operationType,
      resourceType: t.resourceType,
      resourcePath: t.resourcePath,
      params: (t.parameterDefinitions ?? []).map((p) => p.name),
      businessObject: code,
      _callable: true,
      source_file: rel(file),
    });
    addEdge(id, fid, 'contains', { context: 'bo function', source_file: rel(file) });
    if (t.resourcePath) {
      const base = String(t.resourcePath).split('?')[0];
      const rid = addNode(ID.rest(base), { label: base, type: 'restResource', file_type: 'concept' });
      addEdge(fid, rid, 'calls_rest', { context: t.operationType || 'GET', source_file: rel(file) });
    }
  }
}

// --- pass 2: deeplinks + tools

for (const file of dlFiles) {
  const dl = readJson(file);
  if (!dl) continue;
  const code = dl.deepLinkCode || path.basename(file, '.dl').toUpperCase();
  addNode(ID.dl(code), {
    label: dl.name || code,
    type: 'deeplink',
    code,
    summary: trim(dl.description),
    family: dl.family,
    product: dl.product,
    destinationUrl: dl.destinationUrl,
    usageType: dl.usageType,
    origin: originOf(file),
    source_file: rel(file),
  });
  ensureFamily(dl.family, dl.product, rel(file));
  if (dl.family) addEdge(ID.dl(code), ID.family(dl.family), 'in_family', { source_file: rel(file) });
  if (dl.product) addEdge(ID.dl(code), ID.product(dl.product), 'in_product', { source_file: rel(file) });
}

for (const file of toolFiles) {
  const t = readJson(file);
  if (!t) continue;
  const code = t.toolCode || path.basename(file, '.tool').toUpperCase();
  const id = addNode(ID.tool(code), {
    label: t.name || code,
    type: 'tool',
    code,
    toolType: t.type,
    subType: t.subType || undefined,
    namespace: t.namespace,
    status: t.status,
    summary: trim(t.description),
    family: t.family,
    product: t.product,
    origin: originOf(file),
    source_file: rel(file),
  });
  ensureFamily(t.family, t.product, rel(file));
  if (t.family) addEdge(id, ID.family(t.family), 'in_family', { source_file: rel(file) });
  if (t.product) addEdge(id, ID.product(t.product), 'in_product', { source_file: rel(file) });

  const base = t.specification?.baseObjectCode;
  if (base) {
    // baseObjectCode points at a deeplink, BO, or document schema depending on tool type
    const target =
      nodes.has(ID.dl(base)) ? ID.dl(base)
      : nodes.has(ID.bo(base)) ? ID.bo(base)
      : addStub(ID.dl(base), { label: base, type: 'deeplink', code: base });
    addEdge(id, target, 'backed_by', { context: t.type, source_file: rel(file) });
  }
}

// --- pass 2.5: pre-register every workflow and app code.
// Workflows reference each other (WORKFLOW nodes) and apps reference workflows,
// in arbitrary file order. Registering identities first means a forward
// reference resolves to the real artifact instead of minting a stub with the
// raw code as its label.

for (const file of workflowFiles) {
  const wf = readJson(file);
  if (!wf) continue;
  addNode(ID.wf(wf.workflowCode || path.basename(file, '.wf').toUpperCase()), {
    label: wf.name || wf.workflowCode,
    type: 'workflow',
    code: wf.workflowCode,
    source_file: rel(file),
  });
}
for (const file of appFiles) {
  const app = readJson(file);
  if (!app) continue;
  addNode(ID.app(app.code || path.basename(file, '.app').toUpperCase()), {
    label: app.name || app.code,
    type: 'app',
    code: app.code,
    source_file: rel(file),
  });
}

// --- pass 3: workflows (nodes, control flow, data flow, cross-artifact refs)

/**
 * Every node code reachable in a workflow, including nested LOOP/WHILE
 * pipelines, keyed the same way ingestPipeline keys them. Needed up-front so a
 * data-flow reference can be told apart from an unresolvable one.
 */
function collectCodes(pipeline, prefix = '', out = new Set()) {
  for (const n of pipeline?.pipelineNodes ?? []) {
    const code = prefix + (n.code || n.id);
    out.add(code);
    if (n.metadata?.dataPipeline) collectCodes(n.metadata.dataPipeline, `${code}::`, out);
  }
  return out;
}

/** Findings that are properties of the source artifacts, not of extraction. */
const ISSUES = {
  unwired: 'issue:unwired-branch',
  unresolved: 'issue:unresolved-data-reference',
  orphan: 'issue:unreachable-node',
  duplicate: 'issue:duplicate-node-entry',
};

function flagIssue(nodeId, kind, detail, file) {
  const iid = addNode(ISSUES[kind], {
    label:
      kind === 'unwired' ? 'Unwired branch'
      : kind === 'unresolved' ? 'Unresolved data reference'
      : kind === 'duplicate' ? 'Duplicate node entry'
      : 'Unreachable node',
    type: 'issue',
    file_type: 'concept',
    summary:
      kind === 'unwired' ? 'A SWITCH/CONDITION outcome with no target node — the branch dead-ends.'
      : kind === 'unresolved' ? 'A {{$context.$nodes.X}} reference to a node code that does not exist in the workflow.'
      : kind === 'duplicate' ? 'The same node code appears more than once in one pipelineNodes array.'
      : 'A node with no inbound control-flow edge and which is not the pipeline root.',
  });
  addEdge(nodeId, iid, 'has_issue', { context: detail, source_file: file });
  const n = nodes.get(nodeId);
  if (n) (n.issues ??= []).push(`${kind}: ${detail}`);
}

/** Walk one dataPipeline, recursing into LOOP/WHILE sub-pipelines. */
function ingestPipeline({ wfCode, wfId, pipeline, file, prefix = '', parentNodeId = null, knownCodes }) {
  const pnodes = pipeline?.pipelineNodes ?? [];
  const byId = new Map(pnodes.map((n) => [n.id, n]));
  const codeOf = (n) => n.code || n.id;

  // Some artifacts list the same node twice in pipelineNodes. Ingest is
  // idempotent, so the graph is correct either way, but the duplication is
  // worth surfacing rather than silently absorbing.
  const seenCodes = new Set();
  const duplicated = new Set();
  for (const n of pnodes) {
    const c = codeOf(n);
    if (seenCodes.has(c)) duplicated.add(c);
    seenCodes.add(c);
  }
  const distinctCount = seenCodes.size;

  for (const n of pnodes) {
    const nodeCode = prefix + codeOf(n);
    const nid = ID.wfnode(wfCode, nodeCode);
    const md = n.metadata ?? {};
    const blob = JSON.stringify(n.inputs ?? []) + JSON.stringify(md.sourceCode ?? '');

    // A nested LOOP/WHILE pipeline has its own Start/End, so a bare
    // metadata.name collides with the outer pipeline's inside one file.
    // Qualify nested labels by their owning node.
    const ownerCode = prefix ? prefix.replace(/::$/, '').split('::').pop() : null;
    const label = ownerCode ? `${md.name || nodeCode} (in ${ownerCode})` : md.name || nodeCode;

    addNode(nid, {
      label,
      type: 'workflowNode',
      nodeType: n.type,
      code: nodeCode,
      workflow: wfCode,
      summary: trim(md.description),
      returnType: md.returnType,
      inputNames: (n.inputs ?? []).map((i) => i.name),
      hasPrompt: (n.inputs ?? []).some((i) => i.name === 'prompt'),
      promptExcerpt: trim((n.inputs ?? []).find((i) => i.name === 'prompt')?.value, 1200),
      caseExpression: trim((n.inputs ?? []).find((i) => i.name === 'caseExpression')?.value, 400),
      sourceCodeExcerpt: md.sourceCode ? trim(md.sourceCode, 1200) : undefined,
      sourceCodeLines: md.sourceCode ? String(md.sourceCode).split('\n').length : undefined,
      nested: !!prefix,
      _callable: true,
      source_file: rel(file),
    });

    addEdge(wfId, nid, 'contains', { context: `node:${n.type}`, source_file: rel(file) });
    if (parentNodeId) addEdge(parentNodeId, nid, 'nests', { context: 'sub-pipeline', source_file: rel(file) });

    // ---- control flow: outcomes map -> next node
    for (const [outcome, targetRaw] of Object.entries(n.outcomes ?? {})) {
      const target = byId.get(targetRaw);
      if (!target) {
        // an outcome with an empty or unknown target is a dead-end branch in
        // the artifact itself, not a gap in extraction
        flagIssue(nid, 'unwired', `outcome "${outcome}"`, rel(file));
        continue;
      }
      addEdge(nid, ID.wfnode(wfCode, prefix + codeOf(target)), 'flows_to', {
        context: outcome,
        source_file: rel(file),
      });
    }
    if (n.convergenceTargetId) {
      const t = byId.get(n.convergenceTargetId);
      if (t) {
        addEdge(nid, ID.wfnode(wfCode, prefix + codeOf(t)), 'converges_to', {
          context: 'convergence',
          source_file: rel(file),
        });
      }
    }
    if (md.errorNodeId) {
      const t = byId.get(md.errorNodeId);
      if (t) {
        addEdge(nid, ID.wfnode(wfCode, prefix + codeOf(t)), 'on_error_to', {
          context: 'error handler',
          source_file: rel(file),
        });
      }
    }

    // ---- data flow: {{$context.$nodes.OTHER.$output}}
    // References are workflow-global (not pipeline-local), so resolve against
    // every code in the workflow: bare first, then within this sub-pipeline.
    for (const upstream of referencedNodeCodes(blob)) {
      const resolved =
        knownCodes.has(prefix + upstream) ? prefix + upstream
        : knownCodes.has(upstream) ? upstream
        : null;
      if (!resolved) {
        flagIssue(nid, 'unresolved', `$nodes.${upstream}`, rel(file));
        continue;
      }
      addEdge(nid, ID.wfnode(wfCode, resolved), 'reads_output_of', {
        context: 'data flow',
        source_file: rel(file),
      });
    }

    // ---- app context keys the node consumes
    for (const key of referencedAppKeys(blob)) {
      const sid = addNode(`appcontext:${key}`, {
        label: `$app.$${key}`,
        type: 'appContextKey',
        file_type: 'concept',
      });
      addEdge(nid, sid, 'reads_app_context', { source_file: rel(file) });
    }

    // ---- app-stage literals routed on
    for (const stage of APP_STAGES) {
      if (blob.includes(`'${stage}'`) || blob.includes(`"${stage}"`) || blob.includes(`= ${stage}`)) {
        const sid = addNode(ID.stage(stage), { label: stage, type: 'appStage', file_type: 'concept' });
        addEdge(nid, sid, 'routes_app_stage', { source_file: rel(file) });
      }
    }

    // ---- typed cross-artifact references
    switch (n.type) {
      case 'BO_FUNCTION':
      case 'DOCUMENT_PROCESSOR': {
        const boCode = md.businessObjectCode;
        const fn = md.functionName;
        if (boCode) {
          const boId = nodes.has(ID.bo(boCode))
            ? ID.bo(boCode)
            : addStub(ID.bo(boCode), { label: boCode, type: 'businessObject', code: boCode });
          if (fn) {
            const fid = nodes.has(ID.bofn(boCode, fn))
              ? ID.bofn(boCode, fn)
              : addStub(ID.bofn(boCode, fn), {
                  label: `${fn}()`,
                  type: 'boFunction',
                  code: fn,
                  businessObject: boCode,
                  _callable: true,
                });
            addEdge(fid, boId, 'belongs_to', {});
            addEdge(nid, fid, 'calls_bo_function', { context: fn, source_file: rel(file) });
          } else {
            addEdge(nid, boId, 'uses_business_object', { source_file: rel(file) });
          }
          addEdge(wfId, boId, 'depends_on_data', { context: 'via BO node', source_file: rel(file) });
        }
        break;
      }
      case 'WORKFLOW': {
        const sub = md.workflowCode;
        if (sub) {
          const sid = nodes.has(ID.wf(sub))
            ? ID.wf(sub)
            : addStub(ID.wf(sub), { label: sub, type: 'workflow', code: sub });
          addEdge(nid, sid, 'invokes_workflow', { source_file: rel(file) });
          addEdge(wfId, sid, 'calls', { context: 'sub-workflow', source_file: rel(file) });
        }
        break;
      }
      case 'TOOL': {
        const tc = md.toolCode;
        if (tc) {
          const tid = nodes.has(ID.tool(tc))
            ? ID.tool(tc)
            : addStub(ID.tool(tc), { label: tc, type: 'tool', code: tc, seeded: true });
          addEdge(nid, tid, 'uses_tool', { source_file: rel(file) });
          addEdge(wfId, tid, 'uses_tool', { source_file: rel(file) });
        }
        break;
      }
      case 'AGENT': {
        // a workflow step that hands off to a reusable agent resource
        const ac = md.agentCode;
        if (ac) {
          const aid = nodes.has(`agent:${ac}`)
            ? `agent:${ac}`
            : addStub(`agent:${ac}`, { label: ac, type: 'agent', code: ac });
          addEdge(nid, aid, 'invokes_agent_resource', { source_file: rel(file) });
          addEdge(wfId, aid, 'uses_agent', { source_file: rel(file) });
        }
        break;
      }
      case 'LLM': {
        // modelConfiguration is a code string on most nodes but an inline
        // config object on nodes that override model properties
        const mc = typeof md.modelConfiguration === 'object' && md.modelConfiguration
          ? md.modelConfiguration.code
          : md.modelConfiguration;
        if (mc) {
          const inline = typeof md.modelConfiguration === 'object' ? md.modelConfiguration : null;
          const mid = addNode(ID.model(mc), {
            label: mc,
            type: 'modelConfiguration',
            file_type: 'concept',
            modelName: inline?.modelName,
            provider: inline?.provider,
            model: inline?.model,
          });
          addEdge(nid, mid, 'uses_model', { context: 'node override', source_file: rel(file) });
        }
        break;
      }
      default:
        break;
    }

    if (duplicated.has(codeOf(n)) && !prefix) {
      flagIssue(nid, 'duplicate', `listed ${pnodes.filter((x) => codeOf(x) === codeOf(n)).length}x in pipelineNodes`, rel(file));
    }

    // ---- nested pipelines (LOOP / WHILE)
    if (md.dataPipeline) {
      ingestPipeline({
        wfCode,
        wfId,
        pipeline: md.dataPipeline,
        file,
        prefix: `${nodeCode}::`,
        parentNodeId: nid,
        knownCodes,
      });
    }
  }
}

for (const file of workflowFiles) {
  const wf = readJson(file);
  if (!wf) continue;
  const code = wf.workflowCode || path.basename(file, '.wf').toUpperCase();
  const spec = wf.specification ?? {};
  const wfId = addNode(ID.wf(code), {
    label: wf.name || code,
    type: 'workflow',
    code,
    summary: trim(wf.description),
    family: wf.family,
    product: wf.product,
    status: wf.status,
    architecture: wf.architecture,
    accessModifier: wf.accessModifier,
    aiAppsCompatible: !!wf.aiAppsCompatibleFlag,
    humanApproval: !!spec.humanApprovalFlag,
    seeded: !!wf.seededFlag,
    triggers: (spec.triggers ?? []).map((t) => t.type),
    nodeCount: new Set(
      (spec.dataPipeline?.pipelineNodes ?? []).map((n) => n.code || n.id),
    ).size,
    rawNodeEntries: (spec.dataPipeline?.pipelineNodes ?? []).length,
    timeSavings: spec.timeSavings,
    costSavings: spec.costSavings,
    origin: originOf(file),
    source_file: rel(file),
  });

  ensureFamily(wf.family, wf.product, rel(file));
  if (wf.family) addEdge(wfId, ID.family(wf.family), 'in_family', { source_file: rel(file) });
  if (wf.product) addEdge(wfId, ID.product(wf.product), 'in_product', { source_file: rel(file) });

  const defModel = spec.defaultModelConfiguration;
  if (defModel) {
    const mid = addNode(ID.model(defModel), { label: defModel, type: 'modelConfiguration', file_type: 'concept' });
    addEdge(wfId, mid, 'uses_model', { context: 'workflow default', source_file: rel(file) });
  }
  for (const pid of spec.policyIds ?? []) {
    const p = addNode(ID.policy(String(pid)), { label: `Policy ${pid}`, type: 'policy', file_type: 'concept' });
    addEdge(wfId, p, 'governed_by', { source_file: rel(file) });
  }

  addEdge(wfId, ID.artifactType('.wf'), 'is_artifact_type', {});

  if (spec.dataPipeline) {
    ingestPipeline({
      wfCode: code,
      wfId,
      pipeline: spec.dataPipeline,
      file,
      knownCodes: collectCodes(spec.dataPipeline),
    });
  }
}

// --- pass 3.5: reusable agents (.agent). Oracle lists these under
// Resources -> Agents and Resources -> Supervisor Agents; the `type` field is
// what separates the two, so no heuristic is needed when the file exists.

for (const file of agentFiles) {
  const a = readJson(file);
  if (!a) continue;
  const code = a.agentCode || path.basename(file, '.agent').toUpperCase();
  const id = addNode(`agent:${code}`, {
    label: a.name || code,
    type: 'agent',
    code,
    summary: trim(a.description),
    family: a.family,
    product: a.product,
    status: a.status,
    agentKind: a.type,
    namespace: a.namespace,
    reusable: !!a.reusableFlag,
    seeded: !!a.seededFlag,
    maxInteractions: a.maxInteractions,
    promptExcerpt: trim(a.prompt, 1200),
    summarizationMode: a.specification?.summarizationMode,
    origin: originOf(file),
    source_file: rel(file),
  });
  ensureFamily(a.family, a.product, rel(file));
  if (a.family) addEdge(id, ID.family(a.family), 'in_family', { source_file: rel(file) });
  if (a.product) addEdge(id, ID.product(a.product), 'in_product', { source_file: rel(file) });
  addEdge(id, ID.artifactType('.agent'), 'is_artifact_type', {});

  for (const m of a.agentToolMappings ?? []) {
    const t = m?.tool;
    if (!t?.toolCode) continue;
    const tid = nodes.has(ID.tool(t.toolCode))
      ? ID.tool(t.toolCode)
      : addStub(ID.tool(t.toolCode), {
          label: t.name || t.toolCode, type: 'tool', code: t.toolCode,
          toolType: t.type, summary: trim(t.description),
          family: t.family, product: t.product, seeded: !!t.seededFlag,
        });
    addEdge(id, tid, 'uses_tool', { context: t.type, source_file: rel(file) });
  }
  for (const m of a.agentTopicMappings ?? []) {
    const code2 = m?.topic?.topicCode;
    if (!code2) continue;
    const tid = addStub(`topic:${code2}`, { label: m.topic.name || code2, type: 'topic', code: code2 });
    addEdge(id, tid, 'uses_topic', { source_file: rel(file) });
  }
}

// --- pass 4: apps (agents, panels, actions, navigation)

for (const file of appFiles) {
  const app = readJson(file);
  if (!app) continue;
  const code = app.code || path.basename(file, '.app').toUpperCase();
  const am = app.specification?.applicationMetadata ?? {};
  const appId = addNode(ID.app(code), {
    label: app.name || am.title || code,
    type: 'app',
    code,
    summary: trim(app.internalDescription || am.subTitle),
    title: am.title,
    pagePattern: am.pagePattern,
    status: app.status,
    enableFileUpload: !!am.enableFileUpload,
    agentCount: Object.keys(am.agents ?? {}).length,
    origin: originOf(file),
    source_file: rel(file),
  });
  addEdge(appId, ID.artifactType('.app'), 'is_artifact_type', {});

  const resolveWf = (wfCode) =>
    nodes.has(ID.wf(wfCode)) ? ID.wf(wfCode) : addStub(ID.wf(wfCode), { label: wfCode, type: 'workflow', code: wfCode });

  // agents -> backing workflows
  const agentSlotToWf = new Map();
  for (const [slot, a] of Object.entries(am.agents ?? {})) {
    if (!a?.agent) continue;
    agentSlotToWf.set(slot, a.agent);
    const wid = resolveWf(a.agent);
    addEdge(appId, wid, 'exposes_agent', {
      context: a.name || a.agent,
      source_file: rel(file),
    });
    // propagate family/product to the app for faceted search
    const w = nodes.get(wid);
    if (w?.family) {
      addEdge(appId, ID.family(w.family), 'in_family', { source_file: rel(file) });
      addNode(appId, { family: w.family });
    }
    if (w?.product) addEdge(appId, ID.product(w.product), 'in_product', { source_file: rel(file) });
  }

  // containers -> panels -> agents
  for (const c of am.pageConfig?.agentContainers ?? []) {
    const pid = addNode(ID.panel(code, c.title || c.id), {
      label: c.title || c.id,
      type: 'appPanel',
      app: code,
      file_type: 'concept',
      source_file: rel(file),
    });
    addEdge(appId, pid, 'contains', { context: 'panel', source_file: rel(file) });
    for (const slot of c.agents ?? []) {
      const wfCode = agentSlotToWf.get(slot);
      if (wfCode) addEdge(pid, resolveWf(wfCode), 'rendered_by', { source_file: rel(file) });
    }
    for (const ap of c.additionalPanels ?? []) {
      const sid = addNode(ID.panel(code, `${c.title || c.id}/${ap.name}`), {
        label: ap.heading || ap.name,
        type: 'appSubPanel',
        app: code,
        file_type: 'concept',
        source_file: rel(file),
      });
      addEdge(pid, sid, 'contains', { context: 'sub-panel', source_file: rel(file) });
      if (ap.agent) addEdge(sid, resolveWf(ap.agent), 'rendered_by', { source_file: rel(file) });
    }
  }

  if (am.summary?.agentCode) {
    addEdge(appId, resolveWf(am.summary.agentCode), 'summarized_by', { source_file: rel(file) });
  }
  if (am.subtitleAgentCode) {
    addEdge(appId, resolveWf(am.subtitleAgentCode), 'subtitle_by', { source_file: rel(file) });
  }
  for (const comm of am.communications ?? []) {
    if (comm?.agentCode) addEdge(appId, resolveWf(comm.agentCode), 'communicates_via', { source_file: rel(file) });
  }

  // actions -> navigation between apps / agent commands
  for (const act of am.actions ?? []) {
    const aid = addNode(ID.action(code, act.code || act.id), {
      label: act.displayName || act.code,
      type: 'appAction',
      app: code,
      code: act.code,
      summary: trim(act.description),
      file_type: 'concept',
      source_file: rel(file),
    });
    addEdge(appId, aid, 'contains', { context: 'action', source_file: rel(file) });
    for (const ev of act.events?.onInvoke ?? []) {
      if (ev.type === 'navigateToAgenticApp' && ev.params?.appCode) {
        const t = nodes.has(ID.app(ev.params.appCode))
          ? ID.app(ev.params.appCode)
          : addStub(ID.app(ev.params.appCode), { label: ev.params.appCode, type: 'app', code: ev.params.appCode });
        addEdge(aid, t, 'navigates_to', { source_file: rel(file) });
        addEdge(appId, t, 'navigates_to', { context: act.code, source_file: rel(file) });
      }
      if (ev.params?.agentCode) {
        addEdge(aid, resolveWf(ev.params.agentCode), 'invokes_agent', {
          context: ev.type,
          source_file: rel(file),
        });
      }
    }
  }
}

// ---------------------------------------------------------------- artifact types (from the skill's routing table)

const ARTIFACT_TYPES = [
  ['.wf', 'Workflow'],
  ['.app', 'Agentic App'],
  ['.bo', 'Business Object'],
  ['.tool', 'Tool'],
  ['.dl', 'Deeplink'],
  ['.topic', 'Topic'],
  ['.agent', 'Agent'],
  ['.connectorDefinition', 'Connector Definition'],
  ['.connectorInstance', 'Connector Instance'],
  ['.approval', 'Approval Process'],
  ['.policy', 'Policy Store'],
  ['.policyTemplate', 'Policy Template'],
  ['.documentSchema', 'Document Schema'],
  ['.function', 'Function Template'],
  ['.agent', 'Agent'],
];
for (const [ext, name] of ARTIFACT_TYPES) {
  addNode(ID.artifactType(ext), { label: `${name} (${ext})`, type: 'artifactType', ext, file_type: 'concept' });
}
addEdge(ID.bo(''), '', ''); // no-op guard
for (const file of boFiles) {
  const bo = readJson(file);
  if (bo?.objectCode) addEdge(ID.bo(bo.objectCode), ID.artifactType('.bo'), 'is_artifact_type', {});
}
for (const file of toolFiles) {
  const t = readJson(file);
  if (t?.toolCode) addEdge(ID.tool(t.toolCode), ID.artifactType('.tool'), 'is_artifact_type', {});
}
for (const file of dlFiles) {
  const d = readJson(file);
  if (d?.deepLinkCode) addEdge(ID.dl(d.deepLinkCode), ID.artifactType('.dl'), 'is_artifact_type', {});
}

// ---------------------------------------------------------------- skills & prompt references

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const skillFiles = docFiles.filter((f) => path.basename(f) === 'SKILL.md');

/**
 * A "prompt reference" is any .md living under a skill's references/ tree.
 * Two different apps-skills each ship a references/workflow.md, so keys are
 * namespaced by the owning skill and resolution is scoped to the referrer.
 */
const skillDirOf = (f) => {
  let d = path.dirname(f);
  while (d !== REPO && d !== path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'SKILL.md'))) return d;
    d = path.dirname(d);
  }
  return null;
};

const promptFiles = docFiles.filter((f) => f.includes(`${path.sep}references${path.sep}`));

/** key -> node id, plus a basename index scoped per skill dir for fuzzy resolution */
const promptKey = new Map(); // absolute file -> key
const byExactKey = new Map(); // key -> id
const bySkillAndBase = new Map(); // `${skillDir}::${basename}` -> id

for (const file of promptFiles) {
  const sd = skillDirOf(file);
  const fromRefs = path.relative(path.join(sd ?? path.dirname(file), 'references'), file);
  // base skill nests prompts under references/prompts/; apps-skills use references/
  const key = fromRefs.startsWith('prompts' + path.sep)
    ? path.relative(path.join(sd, 'references/prompts'), file)
    : `${path.basename(sd ?? '')}/references/${path.basename(file)}`;
  promptKey.set(file, key);
  const id = ID.prompt(key);
  byExactKey.set(key, id);
  bySkillAndBase.set(`${sd}::${path.basename(file)}`, id);
}

/** Resolve a `foo.md` mention inside `fromFile` to a registered prompt node. */
function resolvePrompt(raw, fromFile) {
  const sd = skillDirOf(fromFile);
  return (
    byExactKey.get(raw) ??
    bySkillAndBase.get(`${sd}::${path.basename(raw)}`) ??
    byExactKey.get(`workflow-node-prompts/${raw}`) ??
    byExactKey.get(path.basename(raw)) ??
    null
  );
}

// CLI commands (from a captured `aistudio --help`)
const commandNames = new Set();
if (fs.existsSync(CLI_HELP)) {
  const help = fs.readFileSync(CLI_HELP, 'utf8');
  const lines = help.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {2}([a-z][a-z0-9-]*)\s*$/.exec(lines[i]);
    if (!m) continue;
    const name = m[1];
    const desc = (lines[i + 1] || '').trim();
    commandNames.add(name);
    const verb =
      name.startsWith('do-') ? 'mutate'
      : name.startsWith('get-') ? 'read'
      : name.startsWith('list-') ? 'list'
      : name.startsWith('run-') ? 'execute'
      : name.startsWith('validate-') ? 'validate'
      : name.startsWith('search-') ? 'search'
      : name.startsWith('compare-') ? 'compare'
      : name.startsWith('mark-') ? 'mutate'
      : name.startsWith('propose-') ? 'read'
      : 'other';
    const group =
      /workflow-test|app-test|judge|sweep|optimization/.test(name) ? 'testing & optimization'
      : /debug|pinned|override|nodes-executed/.test(name) ? 'debugger'
      : /node/.test(name) ? 'workflow nodes'
      : /workflow/.test(name) ? 'workflow authoring'
      : /app/.test(name) ? 'app authoring'
      : /bo\b|business-object/.test(name) ? 'business objects'
      : /tool|deeplink|connector/.test(name) ? 'tools & connectors'
      : /policy|approval|function|document-schema|topic|agent|signal/.test(name) ? 'other artifacts'
      : /auth|login|logout|whoami|configure/.test(name) ? 'auth'
      : 'project';
    addNode(ID.cmd(name), {
      label: `aistudio ${name}`,
      type: 'cliCommand',
      code: name,
      summary: desc,
      verb,
      group,
      file_type: 'concept',
      source_file: cliScript ?? '(cli)',
    });
    addEdge(ID.cmd(name), addNode(`cmdgroup:${group}`, { label: group, type: 'commandGroup', file_type: 'concept' }), 'in_group', {});
    addEdge(ID.cmd(name), addNode(`verb:${verb}`, { label: verb, type: 'commandVerb', file_type: 'concept' }), 'has_verb', {});
    for (const [ext, pretty] of ARTIFACT_TYPES) {
      const slug = pretty.toLowerCase().replace(/\s+/g, '-');
      const bare = ext.slice(1).toLowerCase();
      if (name.includes(slug) || name.includes(bare) || (bare === 'bo' && /(^|-)bo(-|$)/.test(name))) {
        addEdge(ID.cmd(name), ID.artifactType(ext), 'operates_on', {});
      }
    }
  }
} else {
  warnings.push(`no CLI help capture at ${CLI_HELP} — CLI commands omitted (run ./run.sh to capture)`);
}

// ================================================================ the authoring corpus
//
// What this repo actually ships is the skill package under .agents/skills:
// skills, the prompt references they route to, the rules those references
// state, the vocabulary those rules govern (artifact types, workflow node
// types, test kinds) and the CLI that enforces it. `aiapps/` sits alongside as
// a sample corpus that demonstrates the rules — evidence, not subject.
//
// Everything below models the authoring half as first-class nodes so it can be
// queried the same way the runtime artifacts already can:
//
//   skill --references_prompt--> promptReference --contains--> docSection
//         --states--> rule --governs--> workflowNodeType <--is_node_type-- workflowNode
//
// `corpusRole` (assigned in assignLayers) marks which half every node is in.

/** What a prompt reference is for. Derived from where it sits and what it is named. */
function classifyPrompt(file, key) {
  const base = path.basename(file, '.md');
  if (key.startsWith('workflow-node-prompts/')) return base === 'index' ? 'index' : 'node-spec';
  if (base === 'index') return 'index';
  if (base.endsWith('-cli-compat')) return 'cli-compat';
  if (base.endsWith('-builder')) return 'builder';
  if (base.includes('test-authoring')) return 'test-authoring';
  if (base.includes('debug')) return 'debugging';
  if (base.includes('vibe')) return 'vibe-agent';
  if (base === 'artifact-conventions') return 'conventions';
  if (base === 'app-best-practices') return 'best-practices';
  if (base === 'app-ingestion') return 'ingestion';
  if (base === 'guardrails') return 'guardrails';
  if (base === 'aistudio-handoff') return 'handoff';
  if (base === 'workflow') return 'app-playbook';
  return 'reference';
}

/**
 * Rule modality, most specific first. Prohibitions are tested before
 * obligations so "must not" reads as a prohibition rather than a MUST.
 */
const RULE_MARKERS = [
  [/\b(?:MUST NOT|SHALL NOT|must not|shall not)\b/, 'prohibition', 'must not'],
  [/\b(?:SHOULD NOT|should not)\b/, 'prohibition', 'should not'],
  [/\bNEVER\b/, 'prohibition', 'NEVER'],
  [/\b[Nn]ever\b/, 'prohibition', 'never'],
  [/\b(?:DO NOT|Do not|do not|Don't|don't|DON'T)\b/, 'prohibition', 'do not'],
  [/\b(?:Prohibited|prohibited|forbidden|Forbidden|Invalid:|invalid:)\b/, 'prohibition', 'prohibited'],
  [/\bMUST\b/, 'obligation', 'MUST'],
  [/\b(?:ALWAYS|Always|always)\b/, 'obligation', 'always'],
  [/\b(?:REQUIRED|Required|required)\b/, 'obligation', 'required'],
  [/\b[Mm]ust\b/, 'obligation', 'must'],
  [/\b(?:SHOULD|Should|should)\b/, 'recommendation', 'should'],
  [/\b(?:PREFER|Prefer|prefer(?:red)?)\b/, 'recommendation', 'prefer'],
];

function classifyRule(text) {
  for (const [re, modality, marker] of RULE_MARKERS) {
    if (re.test(text)) return { modality, marker };
  }
  return null;
}

/**
 * Read a markdown file as structure + normative content.
 *
 * Fenced code is skipped: a `// never mutate this` comment inside a JavaScript
 * example is a rule of the example, not of the corpus. Table rows are kept but
 * flattened, because several references state their rules in tables.
 */
function readMarkdown(text) {
  const lines = text.split('\n');
  const headings = [];
  const rules = [];
  let fence = null;
  const stack = [];
  let current = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const f = /^\s*(```|~~~)/.exec(raw);
    if (f) {
      if (fence && raw.trim().startsWith(fence)) fence = null;
      else if (!fence) fence = f[1];
      continue;
    }
    if (fence) continue;

    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(raw);
    if (h) {
      const level = h[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const idx = headings.length;
      headings.push({
        level,
        title: h[2].replace(/[`*_]/g, '').trim(),
        line: i + 1,
        parent: stack.length ? stack[stack.length - 1].idx : -1,
      });
      stack.push({ level, idx });
      current = idx;
      continue;
    }

    let t = raw.trim();
    if (!t || t.startsWith('<!--') || t.startsWith('---')) continue;
    let form = 'prose';
    if (/^\|/.test(t)) {
      if (/^\|[\s:|-]+\|?$/.test(t)) continue; // table rule row
      form = 'table';
      t = t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).filter(Boolean).join(' · ');
    } else if (/^(?:[-*+]|\d+[.)])\s+/.test(t)) {
      form = 'bullet';
      t = t.replace(/^(?:[-*+]|\d+[.)])\s+/, '').trim();
    }
    if (t.length < 16 || t.length > 400) continue;
    const m = classifyRule(t);
    if (!m) continue;
    rules.push({ text: t, ...m, heading: current, line: i + 1, form });
  }
  return { headings, rules };
}

/** Bare `LLM` / `` `CODE` `` style tokens a rule names, for governance edges. */
const nodeTypeMentions = (text, known) => {
  const out = new Set();
  for (const m of text.matchAll(/`?\b([A-Z][A-Z0-9_]{2,})\b`?/g)) if (known.has(m[1])) out.add(m[1]);
  return out;
};
/** Only backticked, exactly-matching command tokens — substring matching makes
 *  `run-workflow-test` swallow every rule that mentions `run-workflow-tests`. */
const commandMentions = (text) => {
  const out = new Set();
  for (const m of text.matchAll(/`([a-z][a-z0-9-]+)`/g)) if (commandNames.has(m[1])) out.add(m[1]);
  return out;
};

// ---------------------------------------------------------------- workflow node types

/**
 * The workflow node vocabulary. Two independent sources, deliberately kept
 * apart so the difference is visible:
 *   - declared: `Backend `type`: `LLM`` in a workflow-node-prompts/*.md spec;
 *   - observed: the `type` on a node in a sample .wf.
 * A type with a spec and no instances is a supported capability the samples do
 * not exercise; a type with instances and no spec is an authoring gap.
 */
const nodeSpecFiles = promptFiles.filter((f) => classifyPrompt(f, promptKey.get(f)) === 'node-spec');

for (const file of nodeSpecFiles) {
  const text = fs.readFileSync(file, 'utf8');
  const key = promptKey.get(file);
  const decl = /Backend `type`:\s*(.+)/.exec(text);
  const declared = decl ? [...decl[1].matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]) : [];
  if (!declared.length) {
    warnings.push(`node spec without a declared backend type: ${rel(file)}`);
    continue;
  }
  const title = (text.match(/^#{1,4}\s+(.+)$/m)?.[1] ?? path.basename(file, '.md')).trim();
  for (const t of declared) {
    const id = addNode(ID.nodeType(t), {
      label: `${title} node (${t})`,
      type: 'workflowNodeType',
      code: t,
      summary: `Workflow node type specified by ${key}.`,
      specified: true,
      specFile: key,
      file_type: 'concept',
      source_file: rel(file),
    });
    addEdge(ID.prompt(key), id, 'specifies', { source_file: rel(file) });
  }
}

/**
 * Types the Workflow Builder inserts as scaffolding rather than as a capability.
 * ADD is the stub dropped on an unfilled branch - every instance is named
 * "Add (False Branch)" / "Add (True Branch)", carries no inputs and passes
 * straight through to the next node. It has no authoring spec because there is
 * nothing to author, so reporting it as a documentation gap is wrong.
 */
const PLACEHOLDER_NODE_TYPES = new Set(['ADD']);

// every type the sample corpus actually instantiates, spec or no spec
for (const n of [...nodes.values()]) {
  if (n.type !== 'workflowNode' || !n.nodeType) continue;
  const placeholder = PLACEHOLDER_NODE_TYPES.has(n.nodeType);
  const id = addNode(ID.nodeType(n.nodeType), {
    label: `${n.nodeType} node`,
    type: 'workflowNodeType',
    code: n.nodeType,
    summary: placeholder
      ? 'Builder scaffolding: the empty stub dropped on an unfilled branch, not an authoring capability.'
      : 'Workflow node type observed in the sample corpus with no bundled spec.',
    specified: false,
    placeholder,
    file_type: 'concept',
  });
  addEdge(n.id, id, 'is_node_type', {});
}

const KNOWN_NODE_TYPES = new Set(
  [...nodes.values()].filter((n) => n.type === 'workflowNodeType').map((n) => n.code),
);

// ---------------------------------------------------------------- test & evaluation kinds

/**
 * Testing is the largest single subsystem of the CLI (45 of 290 commands) and
 * has three authoring references of its own, but it has no artifact file
 * extension, so it would otherwise be invisible in the graph. Each kind is a
 * node that its authoring reference specifies, its commands operate on, and the
 * artifact type it exercises hangs off.
 */
const TEST_KINDS = [
  ['workflow-test', 'Workflow test', '.wf',
    'Deterministic per-workflow test: recorded inputs, a run, and a comparison against the last run.',
    /workflow-test(?!-judge)|workflow-tests|record-workflow-test|apply-workflow-test/],
  ['workflow-conversation-test', 'Workflow conversation test', '.wf',
    'Multi-turn conversation test over a workflow.',
    /workflow-conversation-test/],
  ['app-test', 'App test', '.app',
    'Panel-level test of an agentic app, with recorded and masked data.',
    /app-test|app-tests/],
  ['function-test-case', 'Function test case', '.function',
    'Test case for a function template.',
    /function-test/],
  ['judge', 'LLM judge evaluation', null,
    'Model-graded evaluation attached to a test run.',
    /judge/],
  ['optimization-sweep', 'Optimization sweep', null,
    'Parameter sweep across test runs, with a generated comparison report.',
    /sweep|optimization/],
  ['test-data-masking', 'Test data masking', null,
    'Masking profile applied to recorded test data before it is committed.',
    /masking|mask-test-data/],
  ['debug-session', 'Workflow debugger session', '.wf',
    'Node-level debug run with pinned inputs and per-node overrides.',
    /debug|nodes-executed|pinned|override/],
];

for (const [key, name, ext, note] of TEST_KINDS) {
  addNode(ID.testKind(key), {
    label: name,
    type: 'testKind',
    code: key,
    summary: note,
    file_type: 'concept',
  });
  if (ext) addEdge(ID.testKind(key), ID.artifactType(ext), 'exercises', {});
}
for (const name of commandNames) {
  for (const [key, , , , re] of TEST_KINDS) {
    if (re.test(name)) addEdge(ID.cmd(name), ID.testKind(key), 'operates_on_test', {});
  }
}

// --- prompt reference nodes

for (const file of promptFiles) {
  const key = promptKey.get(file);
  const text = fs.readFileSync(file, 'utf8');
  const role = classifyPrompt(file, key);
  addNode(ID.prompt(key), {
    label: key,
    type: 'promptReference',
    code: key,
    promptRole: role,
    skill: path.basename(skillDirOf(file) ?? ''),
    summary: trim(text.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '', 300),
    lines: text.split('\n').length,
    bytes: Buffer.byteLength(text),
    file_type: 'doc',
    source_file: rel(file),
  });
}

/**
 * Nine artifact types ship a `X-builder.md` (how to author it) beside an
 * `X-cli-compat.md` (what the CLI will accept). They are two halves of one
 * contract, so the pair is an edge rather than two unrelated notes.
 */
for (const file of promptFiles) {
  const key = promptKey.get(file);
  if (!key.endsWith('-builder.md')) continue;
  const compat = key.replace(/-builder\.md$/, '-cli-compat.md');
  if (byExactKey.has(compat)) {
    addEdge(ID.prompt(key), ID.prompt(compat), 'paired_with', { context: 'builder/cli-compat' });
  }
}

for (const file of promptFiles) {
  const pid = ID.prompt(promptKey.get(file));
  const text = fs.readFileSync(file, 'utf8');
  for (const cmd of commandNames) {
    if (text.includes(cmd)) addEdge(pid, ID.cmd(cmd), 'documents_command', { source_file: rel(file) });
  }
  for (const [ext] of ARTIFACT_TYPES) {
    if (text.includes('`' + ext + '`')) addEdge(pid, ID.artifactType(ext), 'documents_artifact', { source_file: rel(file) });
  }
  for (const m of text.matchAll(/`([a-z0-9-]+(?:\/[a-z0-9-]+)?\.md)`/g)) {
    const target = resolvePrompt(m[1], file);
    if (target && target !== pid) addEdge(pid, target, 'see_also', { source_file: rel(file) });
    else if (!target) warnings.push(`unresolved prompt reference \`${m[1]}\` in ${rel(file)}`);
  }
}

// --- skill nodes

for (const file of skillFiles) {
  const text = fs.readFileSync(file, 'utf8');
  const fm = frontmatter(text);
  const name = fm.name || path.basename(path.dirname(file));
  const sid = addNode(ID.skill(name), {
    label: name,
    type: 'skill',
    code: name,
    summary: trim(fm.description, 600),
    file_type: 'doc',
    lines: text.split('\n').length,
    source_file: rel(file),
  });

  for (const m of text.matchAll(/`([a-z0-9-]+(?:\/[a-z0-9-]+)?\.md)`/g)) {
    const target = resolvePrompt(m[1], file);
    if (target) addEdge(sid, target, 'references_prompt', { source_file: rel(file) });
    else warnings.push(`unresolved prompt reference \`${m[1]}\` in ${rel(file)}`);
  }
  for (const [ext] of ARTIFACT_TYPES) {
    if (text.includes('`' + ext + '`')) addEdge(sid, ID.artifactType(ext), 'routes_artifact', { source_file: rel(file) });
  }
  for (const cmd of commandNames) {
    if (text.includes(cmd)) addEdge(sid, ID.cmd(cmd), 'prescribes_command', { source_file: rel(file) });
  }
  if (name !== 'aistudio' && /aistudio skill/i.test(text)) {
    addEdge(sid, ID.skill('aistudio'), 'delegates_to', { source_file: rel(file) });
  }
  // an apps-skill that names a family/product it targets
  for (const [, fam] of [['', 'HCM'], ['', 'SCM'], ['', 'FIN']]) {
    if (nodes.has(ID.family(fam)) && new RegExp(`\\b${fam}\\b`).test(text)) {
      addEdge(sid, ID.family(fam), 'targets_family', { source_file: rel(file) });
    }
  }

  // a skill owns every reference under it, whichever one names it
  for (const pf of promptFiles) {
    if (skillDirOf(pf) === path.dirname(file)) {
      addEdge(sid, ID.prompt(promptKey.get(pf)), 'ships', { context: 'reference' });
    }
  }
}

// --- non-markdown files a skill ships (the CLI itself, agent configs, samples)

const SKILL_RESOURCE_KIND = {
  '.js': 'CLI script',
  '.mjs': 'script',
  '.yaml': 'agent configuration',
  '.yml': 'agent configuration',
  '.json': 'data',
  '.sh': 'script',
};
for (const file of skillFiles) {
  const skillDir = path.dirname(file);
  const name = frontmatter(fs.readFileSync(file, 'utf8')).name || path.basename(skillDir);
  for (const f of walk(skillDir)) {
    const ext = path.extname(f);
    const kind = SKILL_RESOURCE_KIND[ext];
    if (!kind) continue;
    const r = rel(f);
    const rid = addNode(ID.resource(r), {
      // two skills each ship an agents/openai.yaml, so the skill name is part
      // of the label or the vault ends up with one note for both
      label: `${name}/${path.relative(skillDir, f)}`,
      type: 'skillResource',
      code: path.basename(f),
      skill: name,
      kind,
      summary: `${kind} shipped by the ${name} skill.`,
      lines: fs.readFileSync(f, 'utf8').split('\n').length,
      file_type: 'code',
      source_file: r,
    });
    addEdge(ID.skill(name), rid, 'ships', { context: kind });
    // the bundled CLI is what every command node comes from
    if (path.basename(f) === 'aistudio.js') {
      for (const [id, n] of nodes) if (n.type === 'commandGroup') addEdge(rid, id, 'provides', {});
    }
  }
}

// --- sections and rules, over every authoring document

/**
 * Index one markdown file: its heading tree becomes docSection nodes, and every
 * normative statement under a heading becomes a rule node hanging off it. Rules
 * are then wired to the vocabulary they govern, which is what turns the skill
 * package from a pile of prose into something the graph can answer questions
 * about: "which rule governs an LLM node", "what does workflow-vibe forbid".
 */
function indexAuthoringDoc(ownerId, ownerKey, file, text) {
  const { headings, rules } = readMarkdown(text);
  const seen = new Map();
  const secId = new Map();
  headings.forEach((h, i) => {
    if (h.level < 2 || h.level > 4) return;
    // Two `#### Structure` headings in one file are different sections. The
    // disambiguator has to reach the label as well as the id: graphify merges
    // same-labelled nodes within a file, so a bare repeated title would be
    // silently collapsed back into one.
    const n = (seen.get(h.title) ?? 0) + 1;
    seen.set(h.title, n);
    const title = n === 1 ? h.title : `${h.title} (${n})`;
    const id = ID.section(ownerKey, title);
    addNode(id, {
      label: title,
      heading: h.title,
      type: 'docSection',
      parent: ownerKey,
      level: h.level,
      file_type: 'document',
      source_file: rel(file),
      source_location: `L${h.line}`,
    });
    secId.set(i, id);
    const parent = h.parent >= 0 ? secId.get(h.parent) : null;
    addEdge(parent ?? ownerId, id, parent ? 'nests' : 'contains', { context: 'section' });
  });

  let seq = 0;
  // The same sentence stated twice in one document is one rule, not two — the
  // references repeat their key prohibitions across sections deliberately.
  // Collapsing them here also keeps labels unique per file, which graphify's
  // dedup pass requires.
  const byText = new Map();
  for (const r of rules) {
    const key = r.text.toLowerCase().replace(/\s+/g, ' ');
    const first = byText.get(key);
    if (first) {
      const n = nodes.get(first);
      if (n) {
        n.repeats = (n.repeats ?? 1) + 1;
        n.repeatedAt = [...(n.repeatedAt ?? []), r.line];
      }
      continue;
    }
    const rid = ID.rule(ownerKey, ++seq);
    byText.set(key, rid);
    const section = r.heading >= 0 ? headings[r.heading] : null;
    addNode(rid, {
      label: trim(r.text, 120),
      type: 'rule',
      modality: r.modality,
      marker: r.marker,
      form: r.form,
      body: r.text,
      summary: trim(r.text, 300),
      owner: ownerKey,
      section: section?.title,
      file_type: 'document',
      source_file: rel(file),
      source_location: `L${r.line}`,
    });
    addEdge(secId.get(r.heading) ?? ownerId, rid, 'states', {});

    for (const t of nodeTypeMentions(r.text, KNOWN_NODE_TYPES)) {
      addEdge(rid, ID.nodeType(t), 'governs', {});
    }
    for (const cmd of commandMentions(r.text)) addEdge(rid, ID.cmd(cmd), 'governs', {});
    for (const [ext] of ARTIFACT_TYPES) {
      if (r.text.includes('`' + ext + '`')) addEdge(rid, ID.artifactType(ext), 'governs', {});
    }
    for (const [key, , , , re] of TEST_KINDS) {
      if (re.test(r.text.toLowerCase())) addEdge(rid, ID.testKind(key), 'governs', {});
    }
  }
  return { sections: secId.size, rules: seq };
}

const authoringIndex = { sections: 0, rules: 0 };
for (const file of skillFiles) {
  const text = fs.readFileSync(file, 'utf8');
  const name = frontmatter(text).name || path.basename(path.dirname(file));
  const r = indexAuthoringDoc(ID.skill(name), `skill/${name}`, file, text);
  nodes.get(ID.skill(name)).ruleCount = r.rules;
  authoringIndex.sections += r.sections;
  authoringIndex.rules += r.rules;
}
for (const file of promptFiles) {
  const key = promptKey.get(file);
  const r = indexAuthoringDoc(ID.prompt(key), `prompt/${key}`, file, fs.readFileSync(file, 'utf8'));
  nodes.get(ID.prompt(key)).ruleCount = r.rules;
  authoringIndex.sections += r.sections;
  authoringIndex.rules += r.rules;
}

// a test-authoring reference specifies the kind it is about
for (const file of promptFiles) {
  const key = promptKey.get(file);
  if (classifyPrompt(file, key) !== 'test-authoring') continue;
  const base = path.basename(file, '.md');
  const kind =
    base.startsWith('workflow-conversation') ? 'workflow-conversation-test'
    : base.startsWith('app-') ? 'app-test'
    : 'workflow-test';
  addEdge(ID.prompt(key), ID.testKind(kind), 'specifies', { source_file: rel(file) });
}
for (const file of promptFiles) {
  const key = promptKey.get(file);
  if (classifyPrompt(file, key) !== 'debugging') continue;
  addEdge(ID.prompt(key), ID.testKind('debug-session'), 'specifies', { source_file: rel(file) });
}

// --- usage counts, so "specified but never used here" is a first-class answer

for (const n of nodes.values()) {
  if (n.type !== 'workflowNodeType') continue;
  n.instanceCount = edges.filter((e) => e.target === n.id && e.relation === 'is_node_type').length;
  n.ruleCount = edges.filter((e) => e.target === n.id && e.relation === 'governs').length;
  n.usedHere = n.instanceCount > 0;
  if (n.placeholder) n.summary = `Builder scaffolding, used ${n.instanceCount}× in the sample corpus. Not an authoring capability, so it has no spec by design.`;
  else if (!n.specified) n.summary = `Workflow node type used ${n.instanceCount}× in the sample corpus with no bundled spec.`;
  else if (!n.usedHere) n.summary = `${n.summary} Supported and specified, but not exercised by any sample app.`;
}
// A section states its rules directly, so an edge count is right for it. A skill
// or reference does not: almost every rule sits under some heading, so the
// `states` edge leaves the section rather than the document, and counting edges
// reported 0 rules for all three skills when they state 25, 43 and 40.
// indexAuthoringDoc returns the real per-document total; use that.
for (const n of nodes.values()) {
  if (n.type === 'docSection') {
    n.ruleCount = edges.filter((e) => e.source === n.id && e.relation === 'states').length;
  }
}

// ---------------------------------------------------------------- docs (READMEs, how-tos)

for (const file of docFiles) {
  if (path.basename(file) === 'SKILL.md') continue;
  if (promptFiles.includes(file)) continue;
  const r = rel(file);
  const text = fs.readFileSync(file, 'utf8');
  const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(file)).trim();
  const did = addNode(ID.doc(r), {
    label: title,
    type: 'doc',
    summary: trim(text.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '', 300),
    lines: text.split('\n').length,
    file_type: 'doc',
    source_file: r,
  });

  // A README documents the top-level artifacts sitting beside it. Deliberately
  // excludes workflowNode/boFunction children — they inherit their parent's
  // source_file, so including them would add thousands of low-signal edges.
  const DOCUMENTABLE = new Set(['app', 'workflow', 'businessObject', 'tool', 'deeplink']);
  const dir = path.dirname(file);
  for (const [id, n] of nodes) {
    if (!n.source_file || !DOCUMENTABLE.has(n.type)) continue;
    if (path.dirname(path.join(REPO, n.source_file)) === dir && id !== did) {
      addEdge(did, id, 'documents', { source_file: r });
    }
  }
  for (const cmd of commandNames) {
    if (text.includes(cmd)) addEdge(did, ID.cmd(cmd), 'documents_command', { source_file: r });
  }
}



// ---------------------------------------------------------------- supported tool types

/**
 * The tool types Fusion AI Agent Studio supports (documented as of release 26A).
 * All nine are registered whether or not this corpus uses them, so the graph can
 * answer "what capability exists but is unused here" as well as "what is used".
 */
const TOOL_TYPES = [
  ['calculator', 'Calculator Tool', 'Performs mathematical operations on the fly.'],
  ['email', 'Email Tool', 'Composes and sends email to human recipients as part of a workflow.'],
  ['businessObject', 'Business Object Tool', 'Reads or updates Fusion business objects via the Fusion OpenAPI spec.'],
  ['userQuery', 'User Query Tool', "Queries data in the end user's session context for personalised answers."],
  ['ragDocument', 'Document Retrieval Tool (RAG)', 'Grounds answers in unstructured documents and policy assets.'],
  ['multiFile', 'Multi-file Processor Tool', 'Reads and processes chat attachments and files uploaded at runtime.'],
  ['mcp', 'MCP Tool', 'Talks to external MCP-compliant servers with structured requests and responses.'],
  ['externalRest', 'External REST API Tool', 'Calls any public REST API.'],
  ['deepLink', 'Deep Link Tool', 'Sends the user to a specific Fusion page, pre-populated with context.'],
];

const ID_TOOLTYPE = (k) => `toolType:${k}`;

for (const [key, name, note] of TOOL_TYPES) {
  addNode(ID_TOOLTYPE(key), {
    label: name,
    type: 'toolType',
    code: key,
    summary: note,
    supportedSince: '26A',
    file_type: 'concept',
  });
}

/**
 * Which of the nine a `.tool` artifact is. The `type` field is authoritative
 * when set; otherwise the populated `specification` slot names the kind
 * (businessObjectMetadata / externalRestMetadata / mcpConfig / ragDocumentMetadata).
 */
function classifyToolArtifact(t) {
  const spec = t.specification ?? {};
  const declared = String(t.type ?? '').toUpperCase();
  const nonEmpty = (v) => v && (typeof v !== 'object' || Object.keys(v).length > 0);

  if (declared === 'DEEP_LINK') return ['deepLink', 'declared'];
  if (declared === 'USER_SESSION' || declared === 'USER_QUERY') return ['userQuery', 'declared'];
  if (declared === 'EMAIL') return ['email', 'declared'];
  if (declared === 'CALCULATOR') return ['calculator', 'declared'];
  if (declared === 'MCP' || nonEmpty(spec.mcpConfig)) return ['mcp', 'declared'];
  if (declared.includes('REST') || nonEmpty(spec.externalRestMetadata)) return ['externalRest', 'declared'];
  if (declared.includes('RAG') || nonEmpty(spec.ragDocumentMetadata) || nonEmpty(spec.kmConnectorConfig)) return ['ragDocument', 'declared'];
  if (declared.includes('DOCUMENT') || declared.includes('FILE')) return ['multiFile', 'declared'];
  if (declared.includes('BUS_OBJECT') || declared.includes('BUSINESS') || nonEmpty(spec.businessObjectMetadata)) return ['businessObject', 'declared'];
  return [null, null];
}

/** Seeded platform tools are referenced by code only, so the kind is inferred. */
function classifyToolCode(code) {
  const c = String(code ?? '').toUpperCase();
  if (/SESSION|USER_QUERY|LOGGEDIN/.test(c)) return ['userQuery', 'inferred from code'];
  if (/DEEP_?LINK|_LINK$/.test(c)) return ['deepLink', 'inferred from code'];
  if (/CALCULAT/.test(c)) return ['calculator', 'inferred from code'];
  if (/EMAIL|NOTIFY/.test(c)) return ['email', 'inferred from code'];
  if (/ATTACHMENT|DOCUMENT|FILE/.test(c)) return ['multiFile', 'inferred from code'];
  if (/MCP/.test(c)) return ['mcp', 'inferred from code'];
  return [null, null];
}

function tagToolType(nodeId, key, how) {
  if (!key) return;
  const n = nodes.get(nodeId);
  if (n) {
    n.toolTypeKey = key;
    n.toolTypeName = TOOL_TYPES.find(([k]) => k === key)?.[1];
    n.toolTypeSource = how;
  }
  addEdge(nodeId, ID_TOOLTYPE(key), 'is_tool_type', { context: how });
}

// classify everything sitting on the Tools layer
for (const n of [...nodes.values()]) {
  if (n.type === 'businessObject') {
    tagToolType(n.id, 'businessObject', `declared · objectSource ${n.objectSource ?? '?'}`);
  } else if (n.type === 'boFunction') {
    tagToolType(n.id, 'businessObject', 'declared · BO function');
  } else if (n.type === 'deeplink') {
    tagToolType(n.id, 'deepLink', 'declared');
  } else if (n.type === 'tool') {
    const file = n.source_file ? path.join(REPO, n.source_file) : null;
    let key = null, how = null;
    if (file && fs.existsSync(file) && file.endsWith('.tool')) {
      const t = readJson(file);
      if (t) [key, how] = classifyToolArtifact(t);
    }
    if (!key) [key, how] = classifyToolCode(n.code ?? n.label);
    tagToolType(n.id, key, how);
    if (!key) warnings.push(`unclassified tool: ${n.code ?? n.label}`);
  }
}

// Some steps are a tool surface in their own right rather than a reference to a
// .tool artifact, so they are joined to the type they exercise.
const STEP_TOOL_TYPE = { DOCUMENT_PROCESSOR: 'multiFile', EMAIL: 'email' };
for (const n of [...nodes.values()]) {
  if (n.type !== 'workflowNode') continue;
  const key = STEP_TOOL_TYPE[n.nodeType];
  if (key) addEdge(n.id, ID_TOOLTYPE(key), 'uses_tool_type', { context: `${n.nodeType} step` });
}

// usage counts, so an unused-but-supported type is visible as exactly that
const toolTypeUsage = {};
for (const [key, name] of TOOL_TYPES) {
  const id = ID_TOOLTYPE(key);
  const used = edges.filter((e) => e.target === id).length;
  const n = nodes.get(id);
  if (n) {
    n.artifactCount = used;
    n.usedHere = used > 0;
  }
  toolTypeUsage[name] = used;
}

// ---------------------------------------------------------------- the AI Agent Studio stack

/**
 * Oracle AI Agent Studio's conceptual hierarchy:
 *
 *   Business outcomes      the result
 *   Agentic applications   the product
 *   Agent teams            supervisor + workflow   (human-in-the-loop)
 *   Agents                 compose tools
 *   Tools                  used by agents
 *
 * Every node gets a layer so the UI can lay the corpus out as that stack
 * instead of as an undifferentiated blob. Two rules are derived from edges
 * rather than from a node's type, because the artifact format does not
 * distinguish them:
 *   - a workflow is an AGENT TEAM when an app exposes it as an agent or when it
 *     invokes sub-workflows (i.e. it supervises other agents);
 *   - every other workflow is an AGENT.
 * Workflow nodes are the internals of an agent, not a layer of the stack, so
 * they sit below Tools and are labelled as such.
 */
const LAYERS = {
  // the authoring corpus — what this repo ships
  11: 'Skills',
  10: 'Playbooks & references',
  9: 'Rules & conventions',
  8: 'Specs & vocabulary',
  7: 'CLI surface',
  // the sample corpus — what it ships as a demonstration
  5: 'Business outcomes',
  4: 'Agentic applications',
  3: 'Agent teams',
  2: 'Agents',
  1: 'Tools',
  0: 'Agent internals',
  '-1': 'Findings',
};

/** Which half of the corpus a band belongs to. */
const LAYER_HALF = {
  11: 'authoring', 10: 'authoring', 9: 'authoring', 8: 'authoring', 7: 'authoring',
  5: 'sample', 4: 'sample', 3: 'sample', 2: 'sample', 1: 'sample', 0: 'sample',
  '-1': 'findings',
};

const STATIC_LAYER = {
  // authoring: entry point, then the prose, then what the prose says, then the
  // vocabulary it says it about, then the surface that enforces it
  skill: 11,
  promptReference: 10, doc: 10, docSection: 10,
  rule: 9,
  artifactType: 8, workflowNodeType: 8, testKind: 8, toolType: 8,
  policy: 8, modelConfiguration: 8, appStage: 8, appContextKey: 8,
  cliCommand: 7, commandGroup: 7, commandVerb: 7, skillResource: 7,
  // sample corpus
  product: 5, family: 5,
  app: 4, appPanel: 4, appSubPanel: 4, appAction: 4,
  tool: 1, businessObject: 1, boFunction: 1, deeplink: 1, restResource: 1,
  workflowNode: 0,
  issue: -1,
};

/**
 * Where Oracle's own console puts each artifact. This is a different axis from
 * the conceptual stack above: the stack says what an artifact *is*, this says
 * where you would click to find it. `Resources` is a tabbed page, so its
 * members keep the tab name.
 */
const STUDIO_SECTION = {
  app: 'Applications', appPanel: 'Applications', appSubPanel: 'Applications', appAction: 'Applications',
  workflow: 'Workflows', workflowNode: 'Workflows',
  tool: 'Resources · Tools', toolType: 'Resources · Tools',
  topic: 'Resources · Topics',
  businessObject: 'Resources · Business Objects', boFunction: 'Resources · Business Objects',
  deeplink: 'Resources · Deeplinks',
  function: 'Resources · Functions',
  documentSchema: 'Resources · Document Schema',
  policy: 'Policy Models',
  approval: 'Approvals',
  connectorDefinition: 'Connectors', connectorInstance: 'Connectors',
  skill: 'Authoring · Skills', promptReference: 'Authoring · Playbooks',
  docSection: 'Authoring · Playbooks', rule: 'Authoring · Rules',
  cliCommand: 'Authoring · CLI', commandGroup: 'Authoring · CLI',
  commandVerb: 'Authoring · CLI', skillResource: 'Authoring · CLI',
  artifactType: 'Authoring · Vocabulary', workflowNodeType: 'Authoring · Vocabulary',
  testKind: 'Authoring · Vocabulary',
  doc: 'Documentation',
  family: 'Derived', product: 'Derived',
  modelConfiguration: 'Derived', appStage: 'Derived', appContextKey: 'Derived',
  restResource: 'Derived', issue: 'Findings',
};

const COMPONENT_TYPES = new Set([
  'appPanel', 'appSubPanel', 'appAction', 'workflowNode', 'boFunction', 'docSection',
  // a rule is reached by opening the section that states it
  'rule',
]);

const SUPERVISES = new Set(['calls', 'invokes_workflow']);
const APP_EXPOSES = new Set([
  'exposes_agent', 'rendered_by', 'summarized_by', 'subtitle_by',
  'invokes_agent', 'communicates_via',
]);

/**
 * Which corpus a node comes from. The distinction the repo itself makes:
 * `.agents/skills` is the product, `aiapps/` is a worked example of it, and
 * anything ingested from a live environment is the user's own.
 *
 *   authoring  the skill package and the repo's own documentation
 *   sample     Oracle's demonstration apps, workflows and business objects
 *   ingested   artifacts exported from a live environment into local/
 *   platform   referenced by the corpus but seeded by the platform, not shipped
 *   derived    taxonomy this extractor computed, owned by no file
 */
function corpusRoleOf(n) {
  if (n._stub) return 'platform';
  const f = n.source_file;
  if (!f) return 'derived';
  if (f.startsWith('local/')) return 'ingested';
  if (f.startsWith('.agents/')) return 'authoring';
  if (f.startsWith('aiapps/')) return 'sample';
  if (f.endsWith('.md')) return 'authoring';
  return 'derived';
}

function assignLayers() {
  const appExposed = new Set();
  const supervises = new Set();
  for (const e of edges) {
    if (APP_EXPOSES.has(e.relation)) appExposed.add(e.target);
    if (SUPERVISES.has(e.relation)) supervises.add(e.source);
  }
  const counts = {};
  for (const n of nodes.values()) {
    let layer;
    if (n.type === 'agent') {
      // Oracle separates Agents from Supervisor Agents by the type field, so
      // no heuristic is needed when a .agent file is present.
      const sup = String(n.agentKind ?? '').toUpperCase() === 'SUPERVISOR';
      layer = sup ? 3 : 2;
      n.stackRole = sup ? 'supervisor agent' : 'agent';
      n.studioSection = sup ? 'Resources · Supervisor Agents' : 'Resources · Agents';
    } else if (n.type === 'workflow') {
      const isTeam = appExposed.has(n.id) || supervises.has(n.id);
      layer = isTeam ? 3 : 2;
      n.stackRole = isTeam
        ? (supervises.has(n.id) ? 'supervisor' : 'workflow')
        : 'agent';
      if (appExposed.has(n.id)) n.appExposed = true;
    } else {
      layer = STATIC_LAYER[n.type] ?? -1;
    }
    n.layer = layer;
    n.layerName = LAYERS[layer];
    n.corpusHalf = LAYER_HALF[layer] ?? 'sample';
    n.corpusRole = corpusRoleOf(n);
    // Parts of a larger artifact: a panel, action, workflow step or BO function
    // is reached by opening its parent, not by browsing a top-level list.
    if (COMPONENT_TYPES.has(n.type)) n.component = true;
    if (!n.studioSection) n.studioSection = STUDIO_SECTION[n.type] ?? 'Derived';
    counts[n.layerName] = (counts[n.layerName] ?? 0) + 1;
  }
  return counts;
}

const layerCounts = assignLayers();

// ---------------------------------------------------------------- finalize

// clean the no-op guard artifacts
for (const [id, n] of [...nodes]) if (!n.label) nodes.delete(id);

// Concept nodes (families, products, REST paths, artifact types...) are derived
// rather than read from a file, but graphify requires source_file on every node.
// Attribute each to the first artifact that introduced it.
const introducedBy = new Map();
for (const e of edges) {
  if (!e.source_file) continue;
  if (!introducedBy.has(e.target)) introducedBy.set(e.target, e.source_file);
  if (!introducedBy.has(e.source)) introducedBy.set(e.source, e.source_file);
}
/**
 * graphify's dedup pass merges same-labelled nodes across files for `concept`
 * (the type meant to unify) and for `doc`, but never for `code` (identity is
 * the ID) or for `document` (heading-derived, file-anchored). Type each node
 * by what actually anchors its identity, or distinct entities with similar
 * labels — `aistudio do-fetch-workflow` vs `do-fetch-tool`, two REST paths
 * differing by one segment — get silently collapsed.
 */
const FILE_TYPE = {
  // identity is the code/ID, never the display label
  app: 'code', workflow: 'code', workflowNode: 'code', businessObject: 'code',
  boFunction: 'code', tool: 'code', deeplink: 'code', cliCommand: 'code',
  restResource: 'code', appPanel: 'code', appSubPanel: 'code', appAction: 'code',
  skillResource: 'code',
  // heading- and line-derived: file-anchored, must not merge across files.
  // Two references can state the same rule in the same words and still be two
  // rules, each answerable to its own file.
  docSection: 'document', rule: 'document',
  // prose
  doc: 'doc', promptReference: 'doc', skill: 'doc',
  // taxonomy: unifying across files is the point
  family: 'concept', product: 'concept', artifactType: 'concept',
  workflowNodeType: 'concept', testKind: 'concept',
  appStage: 'concept', appContextKey: 'concept', commandGroup: 'concept',
  commandVerb: 'concept', modelConfiguration: 'concept', policy: 'concept',
  issue: 'concept',
};
for (const n of nodes.values()) {
  const ft = FILE_TYPE[n.type];
  if (ft) n.file_type = ft;
  if (!n.source_file) {
    n.source_file = introducedBy.get(n.id) ?? '(derived)';
    n._derived = true;
  }
  if (!n.source_location) n.source_location = 'L1';
}
for (const e of edges) {
  if (!e.source_file) {
    e.source_file =
      nodes.get(e.source)?.source_file ?? nodes.get(e.target)?.source_file ?? '(derived)';
  }
  if (!e.source_location) e.source_location = 'L1';
}
const valid = new Set(nodes.keys());
const finalEdges = edges.filter((e) => valid.has(e.source) && valid.has(e.target));

const dropped = edges.length - finalEdges.length;
if (dropped > 0) warnings.push(`${dropped} edge(s) dropped (dangling endpoint)`);

const graph = {
  directed: true,
  nodes: [...nodes.values()],
  edges: finalEdges,
  hyperedges: [],
  input_tokens: 0,
  output_tokens: 0,
  _meta: {
    generator: 'extract-fusion-graph.mjs',
    repo: REPO,
    generatedFromCommit: (() => {
      try {
        return fs.readFileSync(path.join(REPO, '.git/HEAD'), 'utf8').trim();
      } catch {
        return null;
      }
    })(),
    layers: layerCounts,
    authoring: {
      skills: [...nodes.values()].filter((n) => n.type === 'skill').length,
      promptReferences: [...nodes.values()].filter((n) => n.type === 'promptReference').length,
      sections: [...nodes.values()].filter((n) => n.type === 'docSection').length,
      rules: [...nodes.values()].filter((n) => n.type === 'rule').length,
      workflowNodeTypes: [...nodes.values()].filter((n) => n.type === 'workflowNodeType').length,
      testKinds: [...nodes.values()].filter((n) => n.type === 'testKind').length,
    },
    corpusRoles: (() => {
      const o = {};
      for (const n of nodes.values()) o[n.corpusRole] = (o[n.corpusRole] ?? 0) + 1;
      return o;
    })(),
    toolTypes: toolTypeUsage,
    studioSections: (() => {
      const o = {};
      for (const n of nodes.values()) o[n.studioSection] = (o[n.studioSection] ?? 0) + 1;
      return o;
    })(),
    counts: {
      apps: appFiles.length,
      workflows: workflowFiles.length,
      businessObjects: boFiles.length,
      tools: toolFiles.length,
      deeplinks: dlFiles.length,
      docs: docFiles.length,
      cliCommands: commandNames.size,
    },
  },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(graph, null, 1));

// ---------------------------------------------------------------- report

const byType = {};
for (const n of graph.nodes) byType[n.type ?? '?'] = (byType[n.type ?? '?'] ?? 0) + 1;
const byRel = {};
for (const e of graph.edges) byRel[e.relation] = (byRel[e.relation] ?? 0) + 1;

console.log(`[extract] repo   ${REPO}`);
console.log(`[extract] wrote  ${OUT}`);
console.log(`[extract] ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
const usedTypes = Object.entries(toolTypeUsage).filter(([, v]) => v > 0);
console.log(`\nSupported tool types: ${usedTypes.length} of ${TOOL_TYPES.length} used in this corpus`);
for (const [name, count] of Object.entries(toolTypeUsage)) {
  console.log(`  ${String(count).padStart(5)}  ${name}${count ? '' : '   (supported, unused here)'}`);
}
console.log('\nStack layers:');
console.log('  the authoring corpus — what the repo ships');
for (const k of ['Skills', 'Playbooks & references', 'Rules & conventions', 'Specs & vocabulary', 'CLI surface']) {
  if (layerCounts[k]) console.log(`  ${String(layerCounts[k]).padStart(5)}  ${k}`);
}
console.log('  the sample corpus — what it ships as a demonstration');
for (const k of ['Business outcomes', 'Agentic applications', 'Agent teams', 'Agents', 'Tools', 'Agent internals', 'Findings']) {
  if (layerCounts[k]) console.log(`  ${String(layerCounts[k]).padStart(5)}  ${k}`);
}
const halves = {};
for (const n of nodes.values()) halves[n.corpusRole] = (halves[n.corpusRole] ?? 0) + 1;
console.log('\nNodes by corpus role:');
for (const [k, v] of Object.entries(halves).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(5)}  ${k}`);
}
const sections = {};
for (const n of nodes.values()) sections[n.studioSection] = (sections[n.studioSection] ?? 0) + 1;
console.log('\nAI Agent Studio sections (where Oracle puts them):');
for (const [k, v] of Object.entries(sections).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(5)}  ${k}`);
}
const localCount = [...nodes.values()].filter((n) => n.origin === 'local').length;
if (localCount) console.log(`\nIngested from a live environment: ${localCount} artifact(s)`);
console.log('\nNodes by type:');
for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(5)}  ${k}`);
}
console.log('\nEdges by relation:');
for (const [k, v] of Object.entries(byRel).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(5)}  ${k}`);
}
const stubs = graph.nodes.filter((n) => n._stub);
if (stubs.length) {
  console.log(`\n${stubs.length} referenced-but-not-in-repo node(s) (seeded/platform artifacts):`);
  for (const s of stubs.slice(0, 15)) console.log(`  ${s.type.padEnd(16)} ${s.label}`);
  if (stubs.length > 15) console.log(`  ... and ${stubs.length - 15} more`);
}
if (warnings.length) {
  console.log('\nWarnings:');
  for (const w of warnings.slice(0, 20)) console.log(`  - ${w}`);
}
