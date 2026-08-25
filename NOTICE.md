# Notices and attribution

## Independence

This is an independent project. It is **not affiliated with, sponsored by, or
endorsed by Oracle**. "Oracle", "Oracle Fusion" and "Oracle Fusion AI Agent
Studio" are trademarks of Oracle and/or its affiliates, used here only to
identify the corpus this project describes.

## Derived data

This project reads the public repository
[oracle/fusion-ai-studio](https://github.com/oracle/fusion-ai-studio) (branch `release-26C`)
and derives a knowledge graph from it. The published site and the generated
`data.js` / `graph/fusion-graph.json` therefore **contain excerpts of Oracle
content**: artifact names, codes and descriptions, LLM prompt text, routing
expressions, JavaScript from `CODE` nodes, business-object descriptions and REST
resource paths.

That upstream repository is licensed under the **Universal Permissive License
v1.0 (UPL-1.0)**:

```
Copyright (c) 2022 Oracle and/or its affiliates.
The Universal Permissive License (UPL), Version 1.0
```

Each individual artifact also carries its own inline notice:

```
Copyright © 2026, Oracle and/or its affiliates.
Licensed under the Universal Permissive License (UPL), Version 1.0
as shown at https://oss.oracle.com/licenses/upl
```

UPL-1.0 grants permission to "copy, create derivative works of, display,
perform, and distribute" the software **and data**, on the condition that the
copyright notice and a license notice travel with any copy or substantial
portion. This file, plus the attribution rendered in the application footer
("Data derived from oracle/fusion-ai-studio · UPL-1.0"), satisfies that
condition. Keep both in place when you host or redistribute the site.

The full upstream licence text is reproduced in
[`LICENSE-UPL-oracle.txt`](LICENSE-UPL-oracle.txt).

## This project's own code

The extractor, metric computation, vault builder, site builder and the explorer
UI in `tools/` and `app/` are original work by Baig Mohammed and are licensed
under the terms in [`LICENSE`](LICENSE).

## Third-party tooling

- **Graphify** ([safishamsi/graphify](https://github.com/safishamsi/graphify)) — used
  locally for clustering, the vis.js graph, the D3 tree, the call-flow export and the
  query CLI. Installed into a local virtualenv; not redistributed here.
- **Obsidian** ([obsidian.md](https://obsidian.md)) — reads the generated vault. Not
  redistributed; the vault is plain Markdown.

Neither is bundled into the published site. The explorer has **no runtime
dependencies at all** — no CDN scripts, no external fonts, no network calls.

## Not included

- No credentials, tokens, connection strings or environment values. The build
  reads only the exported upstream tree, never `env.properties` or any local
  configuration, and the payload is scanned for secret-shaped strings before
  release.
- No customer or personal data. The corpus is Oracle's published sample
  artifacts.
