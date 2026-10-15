# Changed-module dependency viewer research

Research for [issue #12](https://github.com/OskarDoesSoftware/LeanReview/issues/12), checked 2026-10-14. This note records technical options and limitations. It makes no release-policy or implementation-library decision. The requested MVP view covers changed modules/files and immediate neighbors, rather than class diagrams.

## What a graph can establish

A parser can establish that a source file declares an import. Resolving that import to a repository file is a separate operation. Proving that the imported symbol is actually used, or determining runtime loading, needs more information. These edge kinds must remain distinguishable. TypeScript explicitly makes resolution dependent on runtime/bundler settings; Python supports extensible import machinery. [TypeScript resolution](https://www.typescriptlang.org/docs/handbook/modules/reference.html), [Python import system](https://docs.python.org/3/reference/import.html).

Inference for LeanReview: an arrow can mean `importer -> dependency`, with source location and extractor provenance. A module view should state its node unit. Files, Go packages, Java packages, C# namespaces, and package manifests are different units. A project reference is not evidence that every file in that project depends on every file in the referenced project.

## Extraction options

| Option | Evidence available | Costs and limits |
|---|---|---|
| Trusted, bundled syntax parsers with per-language queries | Imports, exports, declarations, literal dynamic imports, locations | Resolution requires separate rules and manifests; parser support and grammar versions need testing |
| Language compiler/semantic services | Resolved symbols and configuration-aware relationships | More repository context, SDKs, dependency metadata, and platform packaging; incomplete projects produce incomplete results |
| AI analysis of captured files | Proposed relationships and explanatory grouping | Does not establish completeness or semantic correctness; needs authorized provider access and cited source evidence |

Tree-sitter queries match syntax-tree patterns and can detect parse error/missing nodes. They do not supply a universal module resolver. This allows a shared parsing mechanism while retaining language-specific extraction and resolution. Grammar errors should count against coverage. [Tree-sitter queries](https://tree-sitter.github.io/tree-sitter/using-parsers/queries/index.html), [query syntax and errors](https://tree-sitter.github.io/tree-sitter/using-parsers/queries/1-syntax.html).

### TypeScript and JavaScript

The TypeScript compiler API supports source parsing and a custom module-resolution host. LeanReview could supply only captured snapshot files through that host. Compiler resolution accounts for relative paths, configured aliases, package exports/imports, and selected resolution mode. Missing configuration or package metadata prevents reliable resolution. The API wiki is illustrative rather than a version-pinned integration contract. [Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API), [module reference](https://www.typescriptlang.org/docs/handbook/modules/reference.html).

Inference: record static imports, re-exports, CommonJS literal `require`, and literal `import()` separately; retain type-only edges as a distinct kind. A computed `import(name)` is an unresolved dynamic relationship. Bundler aliases outside captured TypeScript/package configuration need explicit resolver support. A missing `node_modules` directory does not mean a package is absent from the application's runtime.

### Go

Go import declarations identify packages by import paths. The standard parser has an imports-only mode. `go list -json` exposes imports and dependency information, but its results depend on the Go environment and package selection. [Go import specification](https://go.dev/ref/spec#Import_declarations), [go/parser](https://pkg.go.dev/go/parser), [go list](https://pkg.go.dev/cmd/go#hdr-List_packages_or_modules).

Inference: syntax extraction can run against captured files without `go list`. Resolving internal packages needs `go.mod`, relevant `go.work` and replacement information, and the tree. Package edges should not become fabricated file-to-file edges. Build tags and platform-specific files make a union of all imports different from a graph for a particular GOOS/GOARCH/build configuration.

### Python

Python AST provides `Import` and `ImportFrom`, relative-import level, aliases, and source positions. Import resolution can involve namespace packages and custom finders/loaders. [AST](https://docs.python.org/3/library/ast.html), [import system](https://docs.python.org/3/reference/import.html).

Inference: captured source can yield declared module dependencies without importing the reviewed code. Resolving a module needs package roots and tree data; execution environment and `sys.path` mutations can defeat static resolution. `importlib` calls and runtime-selected imports remain dynamic. Calling Python's parser requires a trusted interpreter version; a bundled multi-language parser avoids requiring each reviewed language runtime, at the cost of grammar compatibility tests.

### Java

Imports make types or static members available by simple name. Same-package access and fully qualified references need no explicit import, so an import-only graph omits dependencies. Java module `requires` describes a different dependency level. `JavacTask` distinguishes parsing from analysis and code generation. [Java packages/modules specification](https://docs.oracle.com/javase/specs/jls/se25/html/jls-7.html), [JavacTask](https://docs.oracle.com/en/java/javase/25/docs/api/jdk.compiler/com/sun/source/util/JavacTask.html).

Inference: syntax queries can show declared imports and module requirements with honest labels. Complete file relationships need indexed declarations and semantic resolution with classpath/module-path context. Do not invoke Maven/Gradle or annotation processors merely to draw a graph. Parse-only trusted tooling avoids project build execution, but semantic tooling needs a separately audited configuration.

### C#

A `using` directive provides namespace/type-name access and can be global, static, or aliased. It does not uniquely identify a file dependency. Roslyn syntax trees represent source; its semantic model binds symbols in a compilation. [using directive](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/using-directive), [Roslyn syntax](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/work-with-syntax), [semantic model](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/work-with-semantics).

Inference: namespace-use graphs are possible with limited content. File relationships need declarations and symbol binding, including partial types and references. Implicit/global usings and conditional compilation need captured project context. An SDK-backed semantic adapter adds .NET tooling to a TypeScript application; Tree-sitter-style extraction avoids that requirement but cannot promise equivalent semantics. Do not load project analyzers, generators, MSBuild targets, or perform restore/build during analysis.

## API-first snapshots and neighbor completeness

GitHub tree APIs expose object SHA and a truncation indicator; recursive trees have size limits, and documentation directs clients to traverse subtrees when truncated. Azure Items List accepts version descriptors and recursion settings. These provide repository structure without cloning, but listing structure is not parsing source. [GitHub trees](https://docs.github.com/en/rest/git/trees), [Azure Items List](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/items/list?view=azure-devops-rest-7.1).

Derived consequences for LeanReview:

- Outgoing neighbors can be discovered by parsing changed files and resolving their declarations against captured metadata. Target content may be fetched on demand at the same revision.
- Incoming neighbors cannot be established from changed-file contents alone. They require scanning candidate importers or a trustworthy revision-specific index. Provider search results are insufficient unless their revision and coverage are verifiable.
- A complete tree listing does not imply a complete dependency graph. Track listed paths, scanned files/bytes, skipped files, unresolved imports, parser errors, and limits separately.
- Local analysis must read the frozen snapshot rather than the current working tree. Remote analysis must fetch each side's context at its pinned revision, never a moving branch name.
- Deleted files exist only before, added files only after. Build two graphs, then compare edge sets. A missing before-context file is unknown evidence, not proof of an added edge.
- Rename identity can follow normalized change metadata. Do not silently match unrelated modules by similar names.

An API-first full-repository incoming scan may cost many requests and substantial cached private code. A bounded scan can display found incoming neighbors, but must say that additional incoming edges may exist. No clone requirement follows from the graph feature itself.

## Ambiguity, cycles, and unsupported inputs

Inference: retain unresolved specifiers as visible unresolved nodes. Keep external package nodes distinct from missing internal files. Store parse-observed, resolver-confirmed, and AI-proposed edges separately, with source spans and revision identity. AI should return validated graph data, not executable rendering instructions.

Cycles are valid diagram content even where a language disallows a particular cycle. Strongly connected components can identify cycles in the observed graph; incomplete data cannot prove the absence of cycles. Collapse groups only as a display option. This graph supplies evidence to suggested review layers, not a universally correct reading order.

For unsupported languages, show changed nodes and a coverage message. An AI proposal can be shown with explicit provenance if product policy permits; it cannot convert unsupported static coverage into complete coverage. Parser limits and unsupported syntax need the same visibility as unavailable file content.

## Browser rendering options

React Flow accepts structured nodes/edges and custom node components. Automatic layout uses a separate layout solution such as Dagre or ELK; the official guide describes tradeoffs. It suits selection, filtering, and navigation but requires UI and layout implementation. [Node model](https://reactflow.dev/api-reference/types/node), [layout guide](https://reactflow.dev/learn/layouting/layouting).

Mermaid renders text diagrams. Strict mode encodes HTML and disables diagram click behavior; sandbox mode isolates rendering in an iframe. Secure configuration keys prevent diagram directives overriding selected settings. [Mermaid security configuration](https://mermaid.js.org/config/schema-docs/config.html#securitylevel).

Derived safeguards for either renderer: render labels as plain text, generate opaque internal IDs, validate edge endpoints, cap graph size, and route navigation through app-owned snapshot/file IDs. Never execute repository code or render raw repository/AI HTML. Mermaid input can be generated from validated data with escaped labels and app-controlled configuration; reject directives and arbitrary links. Interactive React components can use normal app event handlers without accepting scripts from repository labels. Test malicious paths, quotes, HTML, diagram syntax, huge graphs, and unexpected Unicode.

## Choices still needed

1. Supported MVP languages and versions, and whether limited declared-import graphs meet the requirement for Java/C#.
2. Node unit per language, and whether users need optional package grouping of file nodes.
3. Required outgoing versus incoming coverage and permitted API scan budget.
4. Whether AI proposals appear in a separate overlay or are excluded from the dependency view.
5. Before/after toggle versus a combined graph with added/removed edges.
6. Renderer interaction needs and accessibility expectations.

No prototype or benchmark was run. Packaging, grammar availability/licenses, browser performance, and hostile-input behavior require a small implementation spike before a library/version commitment.
