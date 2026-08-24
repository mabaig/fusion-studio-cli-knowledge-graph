# Fusion AI Studio Knowledge Graph

A queryable, navigable, visual map of the [oracle/fusion-ai-studio](https://github.com/oracle/fusion-ai-studio)
`release-26C` corpus — built with [Graphify](https://github.com/safishamsi/graphify) and
[Obsidian](https://obsidian.md), plus **Fusion AI Studio Explorer**, a purpose-built explorer.

What that repo actually ships is a **skill package**: three skills, 62 prompt references,
1,676 rules those references state, the vocabulary those rules govern, and a 290-command CLI
that enforces it. `aiapps/` sits alongside as Oracle's *worked example* of that contract — six
apps, 113 workflows, 75 business objects. This graph is organised that way round: the
authoring corpus is the subject, the sample apps are the evidence.

Everything here is generated and reproducible. Your clone, the source tree and the rest of
the workspace are read-only inputs; nothing outside this folder is written to.

```
./run.sh --sync      # fetch the latest upstream branch, then rebuild everything
./run.sh             # rebuild from the source already in .source/
```

---

## What you get

| Artifact | Open with | What it's for |
| --- | --- | --- |
| `app/index.html` | any browser | **Fusion AI Studio Explorer** — focus any artifact, walk its neighbourhood in six layouts, read its centrality signals; plus a Data Lab with a sortable table, CSV export, path finder and impact analysis |
| `app/fusion-ai-studio-explorer.html` | any browser | the same app as one self-contained file, for sharing |
| `vault/` | Obsidian → *Open folder as vault* | 4,848 linked notes — one per rule, section, spec, workflow node and artifact — with Mermaid flow diagrams, metric properties and Obsidian's native graph view |
| `graph/METRICS.md` | editor | hubs, bridges, cut vertices and blast radius, ranked |
| `graph/fusion-graph.json` | anything | the canonical graph — 5,076 nodes, 14,026 edges |
| `graphify-out/graph.html` | any browser | Graphify's vis.js graph, coloured by community |
| `graphify-out/GRAPH_TREE.html` | any browser | Graphify's collapsible D3 hierarchy |
| `graphify-out/fusion-knowledge-graph-callflow.html` | any browser | Graphify's Mermaid call-flow sections |
| `graphify-out/GRAPH_REPORT.md` | editor | community breakdown and surprising connections |

## The questions this answers

1. **"Which rule governs this?"** — every normative statement in the skill package is a node.
   Ask what governs an `LLM` node and you get the 69 rules that do, each anchored to the file
   and line that states it.
2. **"What does the skill package forbid?"** — 919 prohibitions, 490 obligations and 267
   recommendations, separated by the marker that signals them (`MUST`, `NEVER`, `do not`,
   `always`, `required`, `should`, `prefer`).
3. **"Which skill, reference or CLI command covers X?"** — 3 skills, 62 references (tagged by
   what each is *for*: node spec, artifact builder, CLI-compat contract, test authoring,
   debugging, guardrails …) and 290 `aistudio` commands, cross-linked to the artifact types
   they operate on.
4. **"What can Agent Studio do that these samples never show?"** — 8 workflow node types ship
   an authoring spec that no sample workflow exercises: `EXTERNAL_REST`, `HUMAN`,
   `RAG_DOCUMENT_TOOL`, `REFERENCE`, `REFERENCEABLEBLOCK`, `VECTOR_DB_READER`,
   `VECTOR_DB_WRITER`, `WAIT`. One type runs the other way: `ADD` appears 5× in the samples
   with no spec at all.
5. **"How is this tested?"** — testing is the CLI's largest subsystem (51 commands across 8
   test kinds) and has three authoring references of its own, but no file extension. Each kind
   is a node its reference specifies, its commands operate on, and its artifact type hangs off.
6. **"How does this app actually get its data?"** — app → panel → agent workflow → workflow
   node → BO function → REST resource is a real edge chain. Follow it, or ask for the path.
7. **"What breaks if I change this business object?"** — Impact mode reverse-traverses and
   groups every dependent; `blastRadius` gives the exact count.
8. **"Where is that prompt / that bit of JS?"** — every LLM prompt, routing expression and
   `CODE` node body is indexed as searchable text.
9. **"What is actually load-bearing here?"** — PageRank, betweenness, Louvain communities,
   articulation points and blast radius, computed over the typed dependency graph.

---

## Three tools, three layers

They are often confused because all three draw a force-directed graph. They are not
alternatives:

| | What it is | Role here |
| --- | --- | --- |
| **Graphify** | A program that *produces* a graph — parsers → `graph.json`, plus a query CLI | The extraction and query engine |
| **Obsidian** | A program that *displays* markdown. Extracts nothing | The human reading surface |
| **OKF** | Not a program — Google Cloud's [Open Knowledge *Format*](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing) spec: markdown + YAML frontmatter | A portable contract; the vault is close to conformant already |

Generic vault-graph tools derive edges from markdown *proximity* — shared tags, same folder,
similar mtime. That is the wrong instrument for this corpus: the vault is batch-generated, so
every note shares one mtime, 1,676 rule notes share one tag, and 1,443 workflow-node notes
share another. Those heuristics would bury 14,026 real typed edges under ~10^7 derived ones,
and centrality would then measure folder layout. Hence: metrics run on the typed graph.

---

## Two stacks

Every node carries a `layer`. There are two stacks, drawn one above the other — the explorer
draws it as one band per layer, the skill package on top, in the **Agent Studio stack** layout.

**The authoring corpus — what the repo ships**

| Layer | Count | What sits here |
| --- | --- | --- |
| **Skills** — the entry point | 3 | `SKILL.md`, what a coding agent loads first |
| **Playbooks & references** | 735 | the 62 prompt references, the 43 repo docs, and their 630 `##` sections |
| **Rules & conventions** | 1,676 | every normative statement those documents make |
| **Specs & vocabulary** | 68 | artifact types, workflow node types, test kinds, tool types |
| **CLI surface** | 311 | 290 commands, their groups and verbs, and the bundled `aistudio.js` |

**The sample corpus — Oracle's worked example**

| Layer | Count | What sits here |
| --- | --- | --- |
| **Business outcomes** — the result | 31 | `product`, `family` (the closest artifact in the repo; there is no explicit outcome object) |
| **Agentic applications** — the product | 69 | `app`, panels, sub-panels, actions |
| **Agent teams** — supervisor + workflow | 31 | workflows an app exposes as an agent, or that invoke sub-workflows |
| **Agents** — compose tools | 83 | every other workflow |
| **Tools** — used by agents | 382 | `tool`, `businessObject`, `boFunction`, `deeplink`, REST resources |
| **Agent internals** — workflow steps | 1,686 | `workflowNode` — the inside of an agent, not a layer of the stack |

`corpusRole` says which half a node is in independently of its band: **2,696 authoring**,
**2,134 sample**, 202 derived taxonomy, 22 ingested from a live environment, 22 platform-seeded.

### The spine that joins them

The edge that makes this one graph rather than two is `is_node_type`: all 1,686 sample
workflow nodes point at the node type they instantiate, and each of those types points back at
the `workflow-node-prompts/*.md` spec that defines it. So:

```
skill --ships--> workflow-node-prompts/llm.md --specifies--> LLM node (LLM)
                                                                  ^
                                       282 sample nodes ----------+  is_node_type
```

That mapping is **declared, not guessed**: each node spec states its backend type on a
`` Backend `type`: `LLM` `` line, and the sample side reads the `type` field on the `.wf` node.
Where the two disagree is the interesting part — a type with a spec and no instances is a
capability the samples never demonstrate; a type with instances and no spec is an authoring gap.

### What counts as a rule

A line counts as a rule when it carries a modality marker — `MUST`, `NEVER`, `do not`,
`always`, `required`, `should`, `prefer` — outside a fenced code block. That is a deliberately
mechanical test, and it has two honest limits: a constraint written without a marker
("`caseExpression` is authored as an input with `type: \"string\"`") is not captured, and an
adjectival "required" occasionally reads as an obligation when it is not. Treat 1,676 as a
floor, and the `marker` property as the evidence for each call. Identical sentences repeated
within one document collapse into one rule with a `repeats` count.

The team/agent split on the sample side is **derived from edges, not from a field** — the `.wf`
format does not record it. A workflow is a team when an app exposes it as an agent
(`exposes_agent`, `rendered_by`, `summarized_by`, …) or when it invokes sub-workflows
(`calls`, `invokes_workflow`), i.e. it supervises other agents.

Business outcomes are the honest weak point: the repo has no outcome artifact, so `product`
and `family` stand in for it. Treat that band as "business area", not as a measured outcome.

---

## Ingesting your own apps and workflows

The graph is not limited to Oracle's samples — export from a live environment and
`./run.sh` folds your artifacts in beside them.

### Steps

1. **Download from the console.**
   - *Applications* → your app → download → `MY_APP.json`
   - *Workflows* → your workflow → download → `my_workflow.zip`
2. **Drop them in `local/`.** Any mix of `.json`, `.zip` or loose `src/` trees.
3. **`./run.sh`** — ingestion runs first, then everything rebuilds.

That's it. To ingest without a full rebuild: `node tools/ingest-local.mjs`.

### What the ingester handles for you

The two export shapes are genuinely different, which is why a plain copy does not
work:

| Export | Shape | Problem it would cause |
| --- | --- | --- |
| App `.json` | `specification` is a **JSON string** | The extractor reads `specification.applicationMetadata`; against a string that is `undefined`, so the app contributes nothing — silently |
| Workflow `.zip` | `src/` tree, `specification` is an object | Needs unzipping; also carries `.agent`, `.bo` and `.tool` files alongside the `.wf` |

`tools/ingest-local.mjs` therefore unzips archives, classifies each file **by its
keys rather than its extension** (`workflowCode` → workflow, `agentCode` → agent,
`objectCode` → business object, and so on), parses any stringified
specification, and writes `src/<kind>/<code>.<ext>` into `.source/local/`.

Ingested artifacts are tagged `origin: local`, show a **your environment** badge,
and can be isolated in the Data Lab via *Only → from my environment*. `local/` is
gitignored, so your artifacts are never committed or published.

### Worked example

A `BAIG_SALES_ORDER_WORKSPACE.json` plus a `bg_sales_order_workflow.zip` yielded
six artifacts — 1 app, 1 workflow, 1 agent, 1 business object, 2 tools — and
changed three things about the graph:

- **A new artifact type.** The zip contained a `.agent` file, which the Oracle
  sample corpus has none of. Agents are now a first-class node type.
- **Two new step types.** `AGENT` (hands off to a reusable agent) and `EMAIL`,
  neither of which appears in the sample corpus.
- **Tool coverage moved from 4 of 9 to 5 of 9** — that `EMAIL` step is the only
  use of the Email Tool anywhere in the graph.

It also surfaced three dangling references, correctly: the app exposes
`BAIG_SO_ORDER_360`, `BAIG_SO_FULFILLMENT` and `BAIG_SO_COMMUNICATIONS`, whose
workflows were not in the export. They appear as *referenced but not present*
rather than being silently dropped — export those workflows too and they resolve.

## How Oracle categorises artifacts

Every node carries **two** classifications, because they answer different
questions:

- `layerName` — the conceptual stack: skills → references → rules → vocabulary → CLI, then
  outcomes → apps → agent teams → agents → tools. What an artifact *is*.
- `studioSection` — where the console puts it. Where you would *click* to find it.

The browse panel toggles between them; **Studio sections** is the default since it
mirrors the product.

The authoring corpus has no console home, so it gets its own set: **Authoring · Skills**,
**Authoring · Playbooks**, **Authoring · Rules**, **Authoring · Vocabulary**,
**Authoring · CLI**. These sort first in the browse panel.

| Console location | Artifact |
| --- | --- |
| Applications | `.app` |
| Workflows | `.wf` |
| Resources · Agents | `.agent` where `type = WORKER` |
| Resources · Supervisor Agents | `.agent` where `type = SUPERVISOR` |
| Resources · Tools | `.tool` |
| Resources · Topics | `.topic` |
| Resources · Business Objects | `.bo` |
| Resources · Deeplinks | `.dl` |
| Resources · Functions | `.function` |
| Resources · Document Schema | `.documentSchema` |
| Connectors | `.connectorDefinition`, `.connectorInstance` |
| Policy Models | `.policy`, `.policyTemplate` |
| Approvals | `.approval` |

Note the refinement this brought: the sample corpus has no `.agent` files, so
agent-vs-agent-team there is *derived from edges* (app-exposed or invokes
sub-workflows). When a real `.agent` file is present, its own `type` field decides
— no heuristic needed.

## Why a custom extractor

Graphify's AST extractors cover 20-odd languages plus Markdown and PDF, but AI Studio's
artifacts are none of those — `.app`, `.wf`, `.bo`, `.tool` and `.dl` are Oracle-specific JSON
whose meaning lives in fields like `metadata.businessObjectCode`, `outcomes`, and
`{{$context.$nodes.X.$output}}` template expressions.

`tools/extract-fusion-graph.mjs` reads those natively and **emits Graphify's own `graph.json`
schema**, so the domain is modelled properly and Graphify's query surface still works:

```bash
G=.venv-graphify/bin/graphify

$G query   "which workflows read purchasing data"
$G path    "Succession Readiness Workspace" "Succession Details Lookup"
$G explain "Intent Router"
$G affected "HCM GHR Worker Search" --depth 3
$G god-nodes --top 15
$G benchmark graphify-out/graph.json
```

## What's in the graph

**Nodes (5,076)** — the authoring corpus first, then the sample corpus it demonstrates.

| Count | Type | Source |
| --- | --- | --- |
| 1,676 | `rule` | every normative statement in a `SKILL.md` or prompt reference, with its modality and marker |
| 630 | `docSection` | the `##`/`###`/`####` heading tree of every authoring document |
| 290 | `cliCommand` | `aistudio --help`, grouped by purpose and verb |
| 62 | `promptReference` | `.agents/skills/**/references/**/*.md`, tagged with what each is for |
| 43 | `doc` | READMEs and how-to guides |
| 26 | `workflowNodeType` | declared by a node spec, observed in a `.wf`, or both |
| 14 | `artifactType` | the skill routing table |
| 10 | `commandGroup` | derived from command names |
| 9 | `toolType` | the nine supported tool types |
| 8 | `commandVerb` | do-/get-/list-/run-/validate- |
| 8 | `testKind` | workflow / conversation / app / function tests, judge, sweep, masking, debugger |
| 3 | `skill` | `SKILL.md` files |
| 3 | `skillResource` | non-markdown files a skill ships: the CLI script, agent configs |
| 1,686 | `workflowNode` | every node of every `.wf` pipeline, incl. nested LOOP/WHILE |
| 193 | `boFunction` | the REST-backed functions each `.bo` exposes |
| 113 | `workflow` | `.wf` files (plus any referenced-only) |
| 109 | `restResource` | distinct Fusion REST resource paths |
| 75 | `businessObject` | `.bo` files |
| 32 | `appAction` | app actions and their navigation targets |
| 26 | `product` | derived taxonomy |
| 23 | `appPanel` | agent containers |
| 8 | `appSubPanel` | additional panels |
| 7 | `appContextKey` | `$app.$Ora*` keys nodes read |
| 6 | `app` | `.app` agentic apps (plus referenced-only) |
| 5 | `family` | HCM, SCM, FIN, PRC |
| 4 | `tool` | `.tool` files |
| 2 | `modelConfiguration` | model configs referenced by workflows |
| 2 | `appStage` | InitDisplay / Query / … |
| 1 | `agent` | `.agent` files |
| 1 | `deeplink` | `.dl` files |
| 1 | `issue` | extraction findings |

**Edges (14,026)** — the load-bearing ones:

| Relation | Count | Meaning |
| --- | --- | --- |
| `contains` | 2,253 | workflow → node, app → panel, document → section |
| `flows_to` | 1,814 | control flow, labelled with the outcome that takes that branch |
| `is_node_type` | 1,686 | **the spine** — a sample workflow node → the node type it instantiates |
| `states` | 1,676 | a section or document → a rule it states |
| `reads_output_of` | 1,185 | **data flow**, parsed from `{{$context.$nodes.X.$output}}` |
| `governs` | 591 | a rule → the node type, artifact type, command or test kind it constrains |
| `documents_command` | 454 | a reference or doc → an `aistudio` command it mentions |
| `nests` | 360 | section → sub-section |
| `calls_bo_function` | 296 | a `BO_FUNCTION` node → the exact function it invokes |
| `converges_to` / `on_error_to` | 277 / 122 | branch convergence and error handlers |
| `depends_on_data` | 174 | workflow → business object, rolled up |
| `calls_rest` | 182 | BO function → REST endpoint |
| `reads_app_context` | 144 | node → `$app.$OraMessageHint` and friends |
| `ships` | 65 | skill → the references and files it bundles |
| `operates_on_test` | 51 | CLI command → the test kind it drives |
| `has_issue` | 48 | see Findings |
| `invokes_workflow` | 39 | sub-workflow calls |
| `specifies` | 30 | a reference → the node type or test kind it defines |
| `exposes_agent` | 24 | app → backing agent workflow |
| `paired_with` | 6 | `X-builder.md` ↔ `X-cli-compat.md`, two halves of one contract |
| `exercises` | 5 | test kind → the artifact type it tests |

## Metrics

`tools/compute-graph-metrics.mjs` writes these onto every node, and both the explorer and the
vault read them. Full rankings in `graph/METRICS.md`.

| Metric | Meaning |
| --- | --- |
| `pagerank`, `pagerankRank` | architectural importance — high when the things pointing at it are themselves well connected |
| `betweenness`, `bridgeScore` | bridge-ness (Brandes, undirected); `bridgeScore` is the percentile |
| `articulation` | removing it disconnects its component: **588 of 5,076** nodes qualify |
| `blastRadius` | exact count of artifacts that can transitively reach it |
| `community`, `communitySize` | Louvain communities — **230** of them, modularity **0.910099** |
| `componentId` | connected component (172 of them) |
| `clustering` | local clustering coefficient |
| `degree`, `inDegree`, `outDegree` | over all typed edges |

**Centrality runs on the dependency subgraph** (10,180 directed edges),
with 3,846 classification edges excluded. Those edges — `in_family`,
`is_artifact_type`, `is_node_type`, `uses_model` — attach many artifacts to one shared label
and create artificial 2-hop shortcuts. Left in, `artifactType:.wf` scored 0.39 betweenness,
five times the highest real workflow, purely because every workflow hangs off it; and the
1,686 `is_node_type` edges put `CODE`, `BO_FUNCTION` and `LLM` in the top three bridges of the
entire corpus purely by being names. A workflow node "is a" `LLM` the same way a tool "is a"
Deep Link Tool: a label, not a dependency.

`governs` (rule → node type) is deliberately *kept in*: it is the relation the whole authoring
half turns on, and excluding it would leave the skill package looking inert. The cost is that
`LLM node (LLM)` and `Workflow debugger session` rank high on raw PageRank simply for being
much-governed. That is a real signal, but if you want the corpus without it, the
*Restricted to concrete artifacts* table in `graph/METRICS.md` drops all vocabulary nodes. Degree metrics still
count all typed edges, where they are simply descriptive. `--include-classification`
computes the other way if you want to compare.

A note on reading PageRank: agentic **apps score low** (5 of them sit near the bottom).
That is correct, not a bug — apps are entry points with no inbound dependencies, so rank
flows away from them. Judge apps by blast radius and bridge score instead.

## Findings surfaced along the way

Extraction is strict: an unresolvable reference becomes a **finding**, not a silently dropped
edge. See `vault/Maps/Findings.md`, or filter the Data Lab to *has findings*.

- **48 unwired branches** — `SWITCH`/`CONDITION` outcomes with no target, so the branch
  dead-ends. Most are app-stage names on an `$OraMessageHint` router (`Query`, `initDisplay2`,
  `InitActions`, `AdditionalContent`, `Summary`), which reads as stages not yet implemented.
  A few look like leftovers: `dummy`, `New outcome 1`, bare `true`/`false`/`success`.
- **0 duplicate node entries** — the same node code listed twice in one `pipelineNodes`
  array. Harmless at runtime, worth knowing when diffing.
- **22 artifacts referenced but absent** — `ORA_USER_SESSION_TOOL`, `ORA_ASSIGNED_JOURNEY_TASK_LINK`, `ORA_PRC_SSP_GETATTACHMENT`, `get_document_for_processing`, `ORA_SCM_COSTMANAGE_INVENTORYVALUATIONCOMPARISONADVISOR`, ….
  Mostly platform-seeded. One exception worth a look: a reference to
  `SUCCESSION_OVERVIEW_ADVISOR` without the `XX_` prefix every other reference uses.

---

## Fusion AI Studio Explorer

Open `app/index.html`. `⌘K` searches everything — names, codes, prompts, JS source.

**Theme** — the switch in the tab strip has three states: **Auto** follows your system setting,
**Light** and **Dark** force one. The choice is remembered in that browser and applied before
the first paint, so forcing light on a dark system does not flash. The canvas is not CSS — it
reads the palette at draw time — so switching redraws it and the panels along with the page.

**Graph tab**

- **Focus panel (left)** — PageRank rank, degree, community, bridge score, then a plain-language
  read of what those numbers mean for this node, and which neighbour to open next.
  *Community pressure* shows how the visible slice clusters.
- **Canvas (centre)** — six layouts. **Concentric by community** is the default: nodes group
  into their Louvain community, so cluster membership is the first thing you see.
  **Agent Studio stack** is the one that explains the corpus as a whole: a band per layer,
  captioned, with node colour following the layer — warm reds and golds for the five authoring
  bands on top, cooler blues and greens for the sample corpus below.
  **Layered** is the one to reach for on a single workflow: levels
  follow edge direction, so a pipeline reads left to right instead of curling into a ball.
  Force, radial, concentric-by-community and ranked-grid cover the rest. Edges are labelled
  with the real relation and branch outcome; dashed = data flow, solid violet = control flow.
  Cut vertices get a red rim. Hover any node for a readout; drag to pan, scroll to zoom,
  click to re-focus.
- **Right panel** — *Node* (properties, signals, prompt/code, source link), *Neighbors*
  (grouped by relation), *Bridges* and *Hubs* (ranked within the visible slice).
- **Edge legend (bottom)** — every relation with corpus and visible counts; click to toggle.
  Classification edges start hidden; *All on* reveals them.

The **browse panel** (shown when nothing is focused) leads with the skill package: Skills,
then the references grouped by role — workflow node specs, artifact builders, CLI-compat
contracts, test authoring, debugging, vibe agents, conventions, guardrails, app playbooks —
then the rules split by modality, then the vocabulary and the CLI. The sample apps, agents and
tools follow. Toggle to **Studio sections** to browse by where Oracle's console puts things.

**Data Lab tab** — the whole corpus as a sortable table with every metric, filters for
**layer**, kind, family, articulation points and findings, CSV export, plus the path finder
and impact analysis.

Keys: `⌘K` search · `g` graph · `d` data lab · `↑↓/↵` in the palette.

## Obsidian vault

Obsidian → *Open folder as vault* → `vault/`. Start at `Home.md`.

- `Maps/` — one Map-of-Content per dimension. For the skill package: **Skills and Prompts**
  (references grouped by what each is for), **Rules** (by modality, by document, by what they
  govern, plus the 60 most-governing prohibitions), **Node Types** (spec vs. sample usage, and
  both mismatch lists), **Testing** (each kind and the commands that drive it), CLI Commands.
  For the sample corpus: Apps, Workflows, Data Flow, Business Objects, Tools and Deeplinks,
  Tool Types. Cross-cutting: **Architecture Stack**, **Hubs and Bottlenecks**, Taxonomy, Findings.
- Every workflow note carries a **Mermaid diagram** of its control and data flow, coloured by
  node role; every app note an app → panel → agent → business-object diagram.
- Node notes embed their LLM prompt, routing expression and JS source, so `⌘⇧F` searches real
  content, not just names.
- Frontmatter exposes `pagerank`, `bridgeScore`, `blastRadius`, `community`, `family`,
  `nodeType` and more to the Properties panel and Dataview:
  `TABLE pagerank, blastRadius FROM #type/workflow SORT pagerank DESC`
- Facet tags: `#type/…`, `#family/…`, `#node/LLM`, `#verb/mutate`, `#community/C-5`,
  `#finding/cut-vertex`. For the skill package: `#rule/prohibition` for everything the skills
  forbid, `#prompt/node-spec` for the node specs, `#corpus/authoring` vs `#corpus/sample` to
  separate the contract from the worked example, `#spec/unused-in-samples` for capabilities
  documented but never demonstrated.
- Rule notes carry the full statement in a callout coloured by modality, and every skill,
  reference and section note lists the rules it states, prohibitions first.

Structural `START`/`END`/`ADD` nodes appear in the diagrams but get no note of their own,
so the vault holds fewer notes than the graph holds nodes.

The vault is regenerated wholesale, so **don't hand-edit it**. Your `.obsidian/` settings are
preserved across rebuilds; note bodies are not.

---

## Layout

```
fusion-knowledge-graph/
├── run.sh                        sync + rebuild everything
├── tools/
│   ├── ingest-local.mjs          your Fusion exports (.json / .zip) -> .source/local
│   ├── extract-fusion-graph.mjs  skills + references + rules + vocabulary + CLI,
│   │                             and .app/.wf/.bo/.tool/.dl/.agent -> graph.json
│   ├── compute-graph-metrics.mjs pagerank, betweenness, louvain, components, blast radius
│   ├── build-obsidian-vault.mjs  graph.json -> Obsidian vault
│   └── build-search-app.mjs      graph.json -> app/data.js (+ --bundle)
├── graph/fusion-graph.json       canonical graph (source of truth)
├── graph/METRICS.md              ranked hubs, bridges, cut vertices, blast radius
├── graphify-out/                 graphify's clustered view, visualisations, report
├── vault/                        the Obsidian vault
├── app/                          Fusion AI Studio Explorer (index.html + app.js + app.css + data.js)
├── data/cli-help.txt             captured `aistudio --help`
├── local/                        drop your own exports here (gitignored)
├── .source/fusion-ai-studio/     upstream tree exported by --sync (gitignored)
├── .source/local/                normalised copies of your exports (gitignored)
└── .venv-graphify/               isolated graphify install, not global
```

`graph/fusion-graph.json` is authoritative. `graphify-out/graph.json` is Graphify's *view* of
it — its loader collapses a few parallel edges that differ only by relation.

## Staying current

`./run.sh --sync` fetches and rebuilds. It uses `git archive` to export the upstream tree into
`.source/`, so **your clone is never checked out, reset or modified** — it stays on whatever
branch and commit you left it on.

Upstream restructured in August 2026 and the tooling follows it by discovery, not by
hardcoded paths:

- the default branch is now **`release-26C`**, not `main` (`main-legacy` holds the old history)
- the `release-26C/` path prefix was dropped; everything moved to the repo root
- skills are now checked in at **`.agents/skills/`** as real files; the bundled
  `aistudio/bin/aistudio` copy and the skill zips are gone
- a new **`aiapps/prc/purchasing`** pillar appeared (10 artifacts)
- the CLI grew to 290 commands, adding test-data masking and conversation-test support

---

## Publishing it for everyone

Yes — as a **static site on GitHub Pages**. Not a "GitHub App": that's an installable
integration/bot, a different thing entirely. The explorer is plain HTML/CSS/JS with **no
runtime dependencies** — no CDN, no external fonts, no network calls — so it hosts anywhere
that serves files.

Two clearances that actually gate this, both checked:

| Gate | Status |
| --- | --- |
| **Licence** | Upstream is **UPL-1.0**, which explicitly permits copying, deriving from and distributing the software *and data*, provided the copyright notice travels along. `NOTICE.md`, `LICENSE-UPL-oracle.txt` and the attribution in the app footer satisfy that. |
| **Secrets** | The payload is scanned for password/token/key/private-key/email shapes before release — clean. The build reads only the exported upstream tree, never `env.properties`. |
| **Size** | `data.js` is 4.1 MB raw, **0.4 MB gzipped** (Pages gzips automatically). Pages caps are 100 MB/file and 1 GB/site. |

### Option A — Actions build, self-updating (recommended)

`.github/workflows/publish.yml` clones `oracle/fusion-ai-studio` itself, rebuilds the graph
and metrics, refuses to deploy if a secret-shaped string appears in the payload, and
publishes. It runs on push to `main`, weekly on Monday, or on demand — so the site tracks
upstream releases without anyone running the pipeline by hand. The derived graph is never
committed.

```bash
gh repo create fusion-studio-cli-knowledge-graph --public --source . --push
# then: Settings -> Pages -> Source = "GitHub Actions"
```

### Option B — commit the built site

Simplest, no CI. `./run.sh` writes `docs/`, which Pages can serve directly:

```bash
node tools/build-search-app.mjs --site      # writes docs/
git add docs && git commit -m "publish explorer" && git push
# then: Settings -> Pages -> Source = "Deploy from a branch", branch main, folder /docs
```

Your URL will be `https://<user>.github.io/<repo>/`. Both options give the same page.

### Option C — hand someone a file

`app/fusion-ai-studio-explorer.html` is the whole thing in one self-contained 7.2 MB file. Email
it, drop it in Slack, open it from a USB stick — it works offline with no server.

### What gets published, and what doesn't

Published: the explorer (`index.html`, `app.css`, `app.js`, `data.js`) plus the licence
notices. Not published: the Obsidian vault, `graphify-out/`, `.source/` and the venv — all
gitignored or excluded, all reproducible with `./run.sh --sync`.

The data is public Oracle sample content, so there is nothing confidential in it. Re-check
that claim yourself before pointing this at an internal corpus: the same pipeline over
private artifacts would publish private prompts and code.

## Setup

Recorded for reproducibility; already done here:

```bash
python3 -m venv .venv-graphify
.venv-graphify/bin/pip install graphifyy
```

Graphify is installed into a **local venv on purpose** — no global `pip install`, no
`graphify install`, no `graphify claude install`. That last one writes a graphify section into
your `CLAUDE.md` and registers a global `PreToolUse` hook; run it deliberately if you want the
`/graphify` slash command:

```bash
.venv-graphify/bin/graphify install --platform claude
```

Node 18+ is the only other requirement. The builders have no npm dependencies.

## Extending it

To add an artifact type or edge kind, work in `tools/extract-fusion-graph.mjs`:

1. Collect the files in the scan block near the top.
2. Add an entry to `ID`.
3. Emit with `addNode` / `addEdge`, and give the node type an entry in `FILE_TYPE` — that
   decides whether Graphify's dedup may label-merge it across files. Anything whose identity
   is its code belongs in the `code` bucket.
4. Give it a band in `STATIC_LAYER` and a home in `STUDIO_SECTION`.
5. Add the type to `FOLDER` in the vault builder, `KEEP` in the app builder and `STACK` /
   `browseGroups` in `app/app.js`, plus a label in `REL_LABEL` / `REL_OUT` for any new relation.
6. If the relation attaches many artifacts to one shared label, add it to
   `CLASSIFICATION_RELS` in **both** the metrics tool and `app/app.js`, or centrality will
   start measuring the taxonomy.

Two constraints worth knowing before you add anything to the authoring corpus. Labels must be
unique *within a file* for any type in the `document` bucket — Graphify's dedup merges
same-labelled nodes and `run.sh` fails hard when the merged graph comes back smaller than the
one it was handed. And the same-sentence-twice case is real: repeated rules are collapsed with
a `repeats` count rather than emitted twice.

The extractor is deliberately strict: unresolvable references become findings, and each run
prints counts by type, so a regression shows up as a number that moved.
