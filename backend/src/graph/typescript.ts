import ts from "typescript-ast";
import path from "node:path";
import type { GraphEdge } from "../../../packages/contracts/src/graph";
export type Dependency = {
  specifier: string;
  line: number;
  kind: GraphEdge["kind"];
  typeOnly: boolean;
  dynamic?: boolean;
};
export function typescriptDependencies(
  file: string,
  text: string,
): Dependency[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  if (
    (source as ts.SourceFile & { parseDiagnostics?: unknown[] })
      .parseDiagnostics?.length
  )
    throw new Error("TypeScript/JavaScript parse failure");
  const deps: Dependency[] = [];
  function add(
    node: ts.Node,
    value: ts.Node | undefined,
    kind: Dependency["kind"],
    typeOnly = false,
  ) {
    const literal =
      value &&
      (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value));
    deps.push({
      specifier: literal ? value.text : "<computed dependency>",
      line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      kind,
      typeOnly,
      dynamic: !literal,
    });
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node))
      add(
        node,
        node.moduleSpecifier,
        "import",
        !!node.importClause?.isTypeOnly ||
          !!(
            node.importClause?.namedBindings &&
            ts.isNamedImports(node.importClause.namedBindings) &&
            !node.importClause.name &&
            node.importClause.namedBindings.elements.length &&
            node.importClause.namedBindings.elements.every((e) => e.isTypeOnly)
          ),
      );
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier)
      add(
        node,
        node.moduleSpecifier,
        "re-export",
        node.isTypeOnly ||
          !!(
            node.exportClause &&
            ts.isNamedExports(node.exportClause) &&
            node.exportClause.elements.length &&
            node.exportClause.elements.every((element) => element.isTypeOnly)
          ),
      );
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      add(node, node.moduleReference.expression, "require", node.isTypeOnly);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      add(node, node.argument.literal, "import", true);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    )
      add(
        node,
        node.arguments[0],
        node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? "dynamic"
          : "require",
      );
    ts.forEachChild(node, visit);
  };
  visit(source);
  return deps;
}
export function typescriptResolver(
  files: Map<string, string>,
  listed: Set<string>,
  warnings: string[],
) {
  const workspaces = new Map<string, { directory: string; manifest: any }>(),
    internalRequests = new Set<string>();
  for (const [file, text] of files)
    if (file.endsWith("package.json"))
      try {
        const manifest = JSON.parse(text);
        if (typeof manifest.name === "string") {
          if (workspaces.has(manifest.name)) {
            warnings.push(`Ambiguous workspace package: ${manifest.name}`);
            workspaces.delete(manifest.name);
          } else
            workspaces.set(manifest.name, {
              directory: path.posix.dirname(file),
              manifest,
            });
        }
      } catch {
        warnings.push(`Invalid package manifest: ${file}`);
      }
  const root = path.resolve("/leanreview-graph");
  const absolute = (file: string) => path.resolve(root, file);
  const names = new Map([...listed].map((name) => [absolute(name), name]));
  const directories = new Set<string>();
  for (const name of names.keys()) {
    let parent = path.dirname(name);
    while (parent.startsWith(root)) {
      directories.add(parent);
      if (parent === root) break;
      parent = path.dirname(parent);
    }
  }
  const host: ts.ModuleResolutionHost = {
    fileExists: (name) => names.has(path.resolve(name)),
    readFile: (name) => files.get(names.get(path.resolve(name)) ?? ""),
    directoryExists: (name) => directories.has(path.resolve(name)),
    getCurrentDirectory: () => root,
    realpath: (name) => name,
  };
  const configurations = new Map<string, ts.CompilerOptions>();
  function config(
    name: string,
    seen = new Set<string>(),
  ): Record<string, unknown> {
    if (seen.has(name) || seen.size > 12) {
      warnings.push(`Cyclic/too deep TS config: ${name}`);
      return {};
    }
    seen.add(name);
    const text = files.get(name);
    if (!text) return {};
    const parsed = ts.parseConfigFileTextToJson(name, text);
    if (parsed.error) {
      warnings.push(`Invalid TS configuration: ${name}`);
      return {};
    }
    const value = parsed.config ?? {};
    let inherited: Record<string, unknown> = {};
    if (value.extends) {
      if (typeof value.extends !== "string" || !value.extends.startsWith("."))
        warnings.push(`Unsupported package/array config extends: ${name}`);
      else {
        let target = path.posix.normalize(
          path.posix.join(path.posix.dirname(name), value.extends),
        );
        if (!target.endsWith(".json")) target += ".json";
        if (!files.has(target))
          warnings.push(`Missing captured TS config: ${target}`);
        else inherited = config(target, seen);
      }
    }
    const own = value.compilerOptions ?? {};
    const merged = { ...inherited, ...own };
    // Resolve relative option origins before inheritance; never load JS configuration.
    for (const key of ["baseUrl", "rootDir"])
      if (typeof own[key] === "string")
        merged[key] = absolute(
          path.posix.join(path.posix.dirname(name), own[key]),
        );
    if (own.paths && !own.baseUrl)
      merged.baseUrl = absolute(path.posix.dirname(name));
    return merged;
  }
  const resolve = (file: string, specifier: string) => {
    let dir = path.posix.dirname(file),
      selected = "";
    while (true) {
      const candidate = ["tsconfig.json", "jsconfig.json"]
        .map((n) => path.posix.join(dir, n))
        .find((n) => files.has(n));
      if (candidate) {
        selected = candidate;
        break;
      }
      if (dir === ".") break;
      dir = path.posix.dirname(dir);
    }
    let options = configurations.get(selected);
    if (!options) {
      const converted = ts.convertCompilerOptionsFromJson(
        config(selected),
        root,
      );
      if (converted.errors.length)
        warnings.push(`Unsupported compiler options: ${selected}`);
      options = {
        moduleResolution: ts.ModuleResolutionKind.Node10,
        allowJs: true,
        ...converted.options,
      };
      configurations.set(selected, options);
    }
    const result = ts.resolveModuleName(
      specifier,
      absolute(file),
      options,
      host,
    ).resolvedModule;
    const name = result
      ? names.get(path.resolve(result.resolvedFileName))
      : undefined;
    if (name && !name.split("/").includes("node_modules")) return name;
    for (const pattern of Object.keys(options.paths ?? {})) {
      const [prefix, suffix] = pattern.split("*");
      if (
        pattern === specifier ||
        (suffix !== undefined &&
          specifier.startsWith(prefix) &&
          specifier.endsWith(suffix))
      )
        internalRequests.add(specifier);
    }
    const workspace = [...workspaces].find(
      ([name]) => specifier === name || specifier.startsWith(name + "/"),
    );
    if (workspace) {
      internalRequests.add(specifier);
      const [packageName, { directory, manifest }] = workspace,
        subpath = specifier.slice(packageName.length);
      const pick = (value: any): string | undefined =>
        typeof value === "string"
          ? value
          : value && typeof value === "object"
            ? pick(value.types ?? value.import ?? value.default)
            : undefined;
      let target: string | undefined;
      if (manifest.exports) {
        target = pick(
          subpath
            ? manifest.exports["." + subpath]
            : (manifest.exports["."] ?? manifest.exports),
        );
      } else
        target = subpath
          ? "." + subpath
          : (manifest.types ??
            manifest.typings ??
            manifest.module ??
            manifest.main ??
            "./index");
      if (
        typeof target === "string" &&
        !path.posix.isAbsolute(target) &&
        !target.split("/").includes("..")
      ) {
        const virtual = absolute(path.posix.join(directory, target));
        const resolved = ts.resolveModuleName(
          virtual,
          absolute(file),
          options,
          host,
        ).resolvedModule;
        const match = resolved
          ? names.get(path.resolve(resolved.resolvedFileName))
          : undefined;
        if (match) return match;
      }
    }
    return undefined;
  };
  return Object.assign(resolve, {
    isInternal: (specifier: string) => internalRequests.has(specifier),
  });
}
