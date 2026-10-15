# Module dependency viewer

Open a local review, then choose **Review dependencies** or **Repository graph**. Both open the same workspace with separate scope tabs. Scan pinned sources explicitly; opening a review or asking for AI grouping does not run a graph scan, build, plugin, or repository script.

The review graph starts with changed modules and their direct outgoing dependencies. The repository graph shows the scanned repository context. Arrows point from the dependent/importer to its dependency. Select a node in the diagram or accessible list to inspect source locations, relationship kind, resolution status, and resolver provenance. Expand scanned neighbors to include known incoming and outgoing relationships. Changed nodes can open their review diff. Scanned source nodes can display their immutable captured text.

TS/JS folders are grouped by default. Double-click a folder in the diagram or list to explore its children. The Open folder button remains available for keyboard access; Back to folder overview returns to the summary. External/unresolved nodes start hidden and remain available through their checkbox and source evidence. Dependencies between collapsed folders/packages are visible by default. Individual files appear when their folder is opened, including root-level modules inside Repository root. Selected module remains an optional connection filter. Labels use readable headings and a minimum automatic-fit zoom of 85%. Readable zoom restores 100%; Fit overview deliberately permits a smaller whole-graph overview. This avoids automatically shrinking a large diagram until its labels cannot be read.

Running scans show phase, file count, current path, and elapsed time. Completed runs retain their elapsed duration. Pinned Git content is read through one binary-safe `git cat-file --batch-command` process per scan, with object identity checks, size checks before requesting contents, a read timeout, cancellation, and explicit process cleanup. Git must support that batch command. No source read falls back to working files.

## Languages and resolution

TS/JS nodes represent source modules. Extraction covers imports, re-exports, import types, import-equals, literal dynamic imports, and syntactic require calls. Computed calls remain unresolved. TypeScript 6.0.3 resolves against the captured file inventory, local tsconfig/jsconfig inheritance, path aliases, and supported workspace package entry points/exports. No repository JavaScript configuration is evaluated. Package-based/array config inheritance, arbitrary resolver plugins, complex conditional/wildcard exports, and runtime loader behavior may remain unresolved. A syntactic require call is not proof that the identifier is the Node loader. External-package nodes record declarations rather than guessed library files.

Java defaults to packages. Select a package and choose Drill into classes to inspect its declarations; Back to packages collapses them. The bundled Tree-sitter Java 0.20.2 grammar uses web-tree-sitter 0.20.8. Resolution considers declared classes, explicit/wildcard imports, same-package references, nested types, and fully qualified type references. Generic parameters are not guessed to be repository classes. Duplicate or ambiguous identities remain unresolved.

This is bounded Java source analysis without a compiler/classpath, generated code, annotation processors, reflection, or full lexical/name binding. Unsupported syntax becomes a parser failure. Platform imports can be declared external; unknown library and wildcard relationships remain visible. Java references are not labeled as erased TS type-only edges.

Type-only filtering applies to observed TS/JS type-only edges. External/unresolved nodes have their own visibility control. No AI-suggested graph edges are generated. Cycles are detected from resolved relationships, reported, and can be collapsed into groups. The source evidence remains available separately from the grouped diagram. Labels are plain text, and source navigation uses application-owned node/file IDs.

## Pinned before and after views

New snapshots record Git blob identities for both source inventories. Branch comparisons use the merge base and selected HEAD; staged/unstaged comparisons capture the index inventory; working changes use the snapshot's captured content. Renames use Git's captured identity and side-specific paths. Subsequent index, working-file, or HEAD changes do not change a saved graph.

Choose Before or After to inspect each side independently. These are not inferred edge additions/removals: incomplete context is never evidence that a dependency disappeared. Older snapshots without inventories can scan captured changed files but are explicitly partial. Refresh to capture full context. A Git blob that has become unavailable is an omission, not a fallback to current working text.

Completed graphs, scan lifecycle, extraction metadata, and source hashes are stored locally. Larger graph/source artifacts use the hash-verified cache. Reopening uses the stored result; explicit rescans can reuse captured source. Failed/canceled runs preserve the previous result. Restart marks abandoned scans interrupted. Version-2 databases receive a consistent `leanreview.pre-v3.<timestamp>.sqlite` backup before migration.

## Limits and coverage

Default source scan limits are 10,000 files and 20 MiB. Users may raise them to 50,000 files and 100 MiB and explicitly rescan. Other bounds are 2 MiB per source file, 500 configuration files/2 MiB configuration text, 100,000 inventory entries, a one-second Java parse budget per file, and 200,000 relationships. Git command timeout/output limits also apply. Tracked build/vendor directories named `node_modules`, `.git`, `target`, `dist`, `build`, `coverage`, or `vendor` are excluded from extraction. Unsupported languages remain available for ordinary diff review.

The viewer reports listed paths, eligible/scanned/skipped source files, parser failures, unresolved relationships, source bytes, and omission reasons. A successful or complete source scan does not establish semantic completeness. Incoming references cover scanned sources only. A scan reaching a cap is partial. Limits bound extraction independently of AI budgets.

React Flow 12.12.0 renders at most 200 nodes and 2,000 relationships at a time, with filtering and neighbor expansion giving access to the cached graph. The visible caps do not delete evidence; relationship totals and paginated source evidence retain access to omitted drawing edges. ELK 0.12.0 layouts run in a dedicated bundled worker with an eight-second limit and a grid fallback. The accessible node list offers the same selection and navigation actions. All rendering assets and the Java grammar are local after dependency installation.

## Verification

`npm test` exercises adapters, aliases/inheritance/workspaces, Java type references and generic scope, cycles, capped/partial scans, cancellation/restart, immutable Git/index context, rename navigation, and cache persistence. `npm run test:browser` runs fixture-backed graph scans, requires successful ELK worker layout, opens Java classes and pinned source, switches before/after and review/repository scopes, verifies capped scans and safe labels, and navigates to a changed file. Browser fixtures use port 4320, separate from the normal application port.

Current execution evidence is Windows x64. Cross-platform release acceptance and API-first GitHub/Azure DevOps source adapters remain separate work. The graph scanner accepts a pinned inventory/read interface so future adapters can supply remote content without managed clones.

### Scan performance regression

On the development Windows machine, a 20-file/810-byte pinned fixture took 13,262 ms with two Git processes per file. The batch reader took 293 ms for the same scan. A separate probe measured 11,226 ms for old source reads versus 16 ms for parsing/resolution from memory. Replaying the reported 43-file/295,530-byte snapshot took 711 ms for extraction and 799 ms including isolated cache/SQLite persistence, with identical dependency evidence. These are local measurements, not platform-wide performance guarantees.

`npm run benchmark:graph` recreates/reuses the isolated 20-file fixture and checks a two-second scan budget. The regular tests use Git's structured trace to verify one batch process for a multi-file cold scan, and cover empty/binary/oversized/missing objects plus cancellation. Browser verification uses a 46-source-file fixture and checks grouping, folder drill-down, minimum readable zoom, label size, focused edges, Java navigation, and safe labels.

## Large projects

Java overviews with more than 40 packages group at the first branching namespace. Double-click a namespace or choose Open namespace to explore its packages; package drill-down shows its classes and direct scanned neighbors. Back to packages returns to the overview. Search matches full package/class labels within the current scope.

Connections defaults to Automatic. Small graphs show all connections. Views with at least 60 nodes or more than max(24, three times the node count) relationships use a grid and show connections for the selected module. Automatic rendering draws at most 160 relationships; the count beside the controls reports how many are drawn out of the available relationships. Choose All connections explicitly for a dense overview. Large layouts bypass ELK, and offscreen diagram elements are not rendered. Source evidence remains available in the inspector.

These limits apply to visualization. Source scanning retains its file/byte caps and partial-scan reporting. A faster graph view does not establish faster Java parsing or classpath-complete resolution.
