# Cross-platform backend, SQLite, and credentials

Research for [issue #2](https://github.com/OskarDoesSoftware/LeanReview/issues/2), checked 14 October 2026. This note compares implementation options. It does not choose the backend or release policy.

## Findings

Both candidates can run a localhost REST backend and serve the browser UI on Windows, macOS, and Linux. Browser portability does not prove backend packaging or credential-store availability on every target. Go supplies HTTP handlers and servers in `net/http`. Hono runs on Node through `@hono/node-server`, which wraps Node HTTP and supports static-file serving. [Go HTTP](https://pkg.go.dev/net/http), [Hono Node guide](https://hono.dev/docs/getting-started/nodejs).

| Concern | Go | Hono + Node |
| --- | --- | --- |
| HTTP server | Standard-library server and routing building blocks | Hono routes through its Node adapter |
| Development startup | Go toolchain builds/runs backend; browser frontend has its own build tooling | Node and package manager install/run backend; TypeScript frontend and backend can share tooling |
| SQLite option without separate native addon | `modernc.org/sqlite` is a cgo-free driver | Built-in `node:sqlite`, subject to the pinned Node version's stability/API |
| Other SQLite option | C-based drivers imply separate compiler/linking considerations | `better-sqlite3` supplies a native addon and prebuilt binaries for major targets |
| Credential storage example | `zalando/go-keyring` | `@napi-rs/keyring`, a native Node binding |
| Embedded browser assets | `embed` includes files in the built program | Node SEA supports embedded assets |
| Eventual executable | Go build emits platform-targeted executable | Node SEA includes runtime and bundled application; native addons require special handling |

Table sources are detailed below. Shared TypeScript tooling is an architectural implication, not a benchmark or proof of lower maintenance cost.

## SQLite

`modernc.org/sqlite` is an in-process SQLite driver without cgo. Its documented targets include Windows, Linux, and macOS on amd64 and arm64. It warns that its `modernc.org/libc` dependency version must match the driver's own dependency. Avoid assuming that selecting a pure-Go driver removes dependency maintenance. [Driver documentation](https://pkg.go.dev/modernc.org/sqlite).

Node added `node:sqlite` in 22.5.0. The current v26 documentation marks it release candidate, with the change recorded in 25.7.0. The Node 24 documentation must be checked separately before choosing that runtime; latest-current documentation is not the contract for an LTS installation. The module supplies SQLite inside Node, avoiding a separate SQLite addon package. [Current SQLite API](https://nodejs.org/api/sqlite.html), [Node 24 SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html).

`better-sqlite3` exposes synchronous queries and requires a supported Node version. Its maintainers provide prebuilt binaries for major platforms and architectures. Exact release coverage still needs verification against the selected runtime and CPU matrix; unavailable prebuilts can create native-build prerequisites. [Maintainer README](https://github.com/WiseLibs/better-sqlite3).

SQLite WAL permits readers alongside a writer, but still allows only one writer at a time. WAL does not work over network filesystems and introduces WAL/shared-memory files. These constraints apply to either backend. A local database location, transaction boundaries, busy handling, migration recovery, and backup behavior therefore need explicit implementation requirements. Those are implications of SQLite's documented behavior, not a driver selection. [SQLite WAL](https://sqlite.org/wal.html).

## Secure credential storage

`go-keyring` offers set/get/delete across Windows, macOS, and Linux. Its macOS adapter calls `/usr/bin/security`; Linux uses the Secret Service D-Bus interface and expects a login collection. Its purpose includes avoiding C bindings for statically linked binaries. The Windows backend uses Credential Manager. [Maintainer documentation](https://github.com/zalando/go-keyring).

For Node, `@napi-rs/keyring` is a native binding with get/set/delete APIs. Its Linux default tries Secret Service and can silently fall back to kernel keyutils. Kernel credentials do not survive reboot. Its options can require Secret Service and report an unavailable store rather than falling back. Persistent credential storage cannot rely on the default Linux behavior without checking which store was selected. [Binding documentation](https://github.com/Brooooooklyn/keyring-node).

The often-mentioned `atom/node-keytar` repository was archived in December 2022. Its existing documentation describes Windows Credential Vault, macOS Keychain, and Linux libsecret, but archive status makes it unsuitable as an assumed maintained dependency. A current binding's release coverage must be investigated directly. [Archived upstream](https://github.com/atom/node-keytar).

Secret Service is a desktop-session service that can involve locked collections and prompts. Linux support must include an actual available and unlocked store, rather than assume every Linux machine has one. [Secret Service specification](https://specifications.freedesktop.org/secret-service/latest/).

The requirement forbidding plaintext tokens in SQLite/configuration remains binding. A missing store should produce an explicit credential-storage failure or a separately chosen session-only mode. This is a requirement implication, not a decision to introduce such a fallback. SQLite can hold account metadata and credential references without containing tokens.

## Development and release delivery

Go distributes installation instructions for Windows, macOS, and Linux. `go build` produces an executable and supports target OS/architecture selection through Go's build environment. `embed` can compile the frontend build into it. With a cgo-free SQLite driver, the database does not itself require a separately distributed native addon. OS credential services and any Git CLI usage remain external prerequisites. [Go installation](https://go.dev/doc/install), [Go build](https://pkg.go.dev/cmd/go), [Go embed](https://pkg.go.dev/embed).

A normal Hono development setup installs dependencies and runs/builds the application through package scripts. That distribution requires a Node runtime unless release packaging includes one. Node SEA can distribute to a machine without Node installed and embed browser assets. The current docs mark SEA active development. Native `.node` addons cannot load directly from embedded virtual files; they must reach the real filesystem before loading. A credential binding or `better-sqlite3` therefore requires a packaging exercise even if JavaScript bundles successfully. [Hono startup](https://hono.dev/docs/getting-started/nodejs), [Node SEA](https://nodejs.org/api/single-executable-applications.html).

A single download is not necessarily a process that never extracts files, has no prerequisites, or works on every CPU. Neither source establishes those stronger promises. Go avoids the Node runtime packaging step; Node supports executable delivery but adds runtime/addon integration work. Both still need platform-specific release verification.

## Open decisions and validation evidence

No implementation or packaging prototype was performed in this research. Documentation establishes available options, not a successful LeanReview build.

Before implementation, settle the backend, runtime/toolchain versions, SQLite driver, supported CPU architectures, Linux credential service prerequisite, behavior when the store is locked/missing, and initial installation method. Keep eventual executable delivery separate from development startup.

A useful release proof should run localhost REST, serve built UI assets, migrate/write/reopen SQLite, and store/read/delete a dummy credential on each supported OS and CPU. Include restart persistence and locked/missing Linux store cases. Verify that packaged native addons load and that logs, SQLite, and configuration contain no dummy token. These checks establish the specific claims an MVP installer will make.
