#!/usr/bin/env bash
# Rebuild every artifact in this folder from oracle/fusion-ai-studio.
#
#   ./run.sh                       # rebuild from the source already in .source/
#   ./run.sh --sync                # fetch the latest upstream branch first
#   ./run.sh --sync --branch main   # sync a different branch
#   ./run.sh --repo /path/to/repo  # build from a checkout you point at
#   ./run.sh --skip-graphify       # graph + metrics + vault + app only
#
# Exports downloaded from a live environment are picked up automatically: drop
# them in local/ (see local/README.md).
#
# Read-only with respect to your clone and the rest of the workspace. --sync
# exports the upstream tree into .source/ with `git archive`; it never checks
# out, resets, or otherwise touches your working tree.

set -euo pipefail

KG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$KG_ROOT"

CLONE="${FUSION_CLONE:-$KG_ROOT/../../fusion-ai-repo/fusion-ai-studio}"
SOURCE="$KG_ROOT/.source/fusion-ai-studio"
REPO=""
BRANCH=""
SYNC=0
SKIP_GRAPHIFY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sync) SYNC=1; shift ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --clone) CLONE="$2"; shift 2 ;;
    --skip-graphify) SKIP_GRAPHIFY=1; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

VENV="$KG_ROOT/.venv-graphify"
GRAPHIFY="$VENV/bin/graphify"
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------- sync

if [[ $SYNC -eq 1 ]]; then
  step "Syncing from upstream"
  if [[ ! -d "$CLONE/.git" ]]; then
    echo "error: no git clone at $CLONE (pass --clone <path>)" >&2
    exit 1
  fi
  git -C "$CLONE" fetch origin --prune
  if [[ -z "$BRANCH" ]]; then
    # follow whatever upstream calls default; release-26C as of 2026-08
    BRANCH="$(git -C "$CLONE" remote show origin | sed -n 's/.*HEAD branch: //p')"
    [[ -z "$BRANCH" ]] && BRANCH="release-26C"
  fi
  echo "branch: origin/$BRANCH"
  git -C "$CLONE" log -1 --format='  %h  %ad  %s' --date=short "origin/$BRANCH"
  mkdir -p "$SOURCE"
  find "$SOURCE" -mindepth 1 -delete
  # `git archive` writes a clean tree without checking anything out, so the
  # user's working copy and current branch are left exactly as they were
  git -C "$CLONE" archive "origin/$BRANCH" | tar -x -C "$SOURCE"
  echo "exported $(find "$SOURCE" -type f | wc -l | tr -d ' ') files to .source/"
fi

[[ -z "$REPO" ]] && REPO="$SOURCE"
REPO="$(cd "$REPO" && pwd)"

step "Source"
echo "$REPO"
if [[ ! -d "$REPO/aiapps" && ! -d "$REPO/release-26C" ]]; then
  echo "error: $REPO has no aiapps/ or release-26C/ — not a fusion-ai-studio tree" >&2
  echo "       try: ./run.sh --sync" >&2
  exit 1
fi
for e in app wf bo tool dl md; do
  printf '  %-4s %s\n' ".$e" "$(find "$REPO" -name "*.$e" -not -path '*/.git/*' | wc -l | tr -d ' ')"
done

# ---------------------------------------------------------------- CLI commands

step "Capturing aistudio CLI command list"
# Located rather than assumed: release-26C moved the bundled skill from
# aistudio/bin/aistudio to .agents/skills.
CLI="$(find "$REPO" -name 'aistudio.js' -path '*scripts*' | head -1)"
mkdir -p "$KG_ROOT/data"
if [[ -n "$CLI" ]]; then
  echo "$(realpath --relative-to="$REPO" "$CLI" 2>/dev/null || echo "$CLI")"
  # run from a scratch cwd so a stray command cannot write into the source tree
  SCRATCH="$(mktemp -d)"
  if ( cd "$SCRATCH" && node "$CLI" --help ) > "$KG_ROOT/data/cli-help.txt" 2>/dev/null; then
    echo "$(grep -cE '^  [a-z][a-z0-9-]*$' "$KG_ROOT/data/cli-help.txt") commands"
  else
    echo "warning: could not run the bundled CLI; keeping the previous capture" >&2
  fi
  rm -rf "$SCRATCH"
else
  echo "warning: no aistudio.js found under $REPO" >&2
fi

# ---------------------------------------------------------------- build

step "Ingesting local exports"
# normalises anything in local/ (or ../CustomAgentArtifacts) into .source/local
node tools/ingest-local.mjs --clean

step "Extracting the knowledge graph"
node tools/extract-fusion-graph.mjs --repo "$REPO"

step "Computing graph metrics"
node tools/compute-graph-metrics.mjs

if [[ $SKIP_GRAPHIFY -eq 0 && -x "$GRAPHIFY" ]]; then
  step "Graphify: clustering, report, visualisations"
  mkdir -p graphify-out
  cp graph/fusion-graph.json graphify-out/graph.json
  # graphify's loader collapses a few parallel edges, so its copy is a view.
  # graph/fusion-graph.json stays the source of truth.
  "$GRAPHIFY" cluster-only . --no-label
  "$GRAPHIFY" tree --graph graphify-out/graph.json --output graphify-out/GRAPH_TREE.html --label "Fusion AI Studio"
  "$GRAPHIFY" export callflow-html
  "$GRAPHIFY" benchmark graphify-out/graph.json | tail -n 10
elif [[ $SKIP_GRAPHIFY -eq 0 ]]; then
  step "Graphify not installed — skipping"
  echo "install with:  python3 -m venv .venv-graphify && .venv-graphify/bin/pip install graphifyy"
fi

step "Building the Obsidian vault"
node tools/build-obsidian-vault.mjs

step "Building Fusion Agent Stack Explorer"
node tools/build-search-app.mjs --bundle --site

step "Done"
cat <<EOF
Explore:
  Fusion Agent Stack Explorer  open $KG_ROOT/app/index.html
  Obsidian      Obsidian -> Open folder as vault -> $KG_ROOT/vault
  Metrics       $KG_ROOT/graph/METRICS.md
  Graphify viz  open $KG_ROOT/graphify-out/graph.html
  Call flow     open $KG_ROOT/graphify-out/fusion-knowledge-graph-callflow.html

Query from the shell:
  $VENV/bin/graphify query "which workflows read purchasing data"
  $VENV/bin/graphify path "Succession Readiness Workspace" "Succession Details Lookup"
  $VENV/bin/graphify explain "Intent Router"
EOF
