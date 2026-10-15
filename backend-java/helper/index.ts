import {
  typescriptDependencies,
  typescriptResolver,
} from "../../backend/src/graph/typescript";
import { javaClasses } from "../../backend/src/graph/java";
import { functionUnits } from "../../backend/src/coverage/typescript";
import ts from "typescript-ast";
import path from "node:path";

// One request per owned process. No repository path or filesystem host is accepted.
const limit = 256 * 1024 * 1024;
let size = 0;
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > limit) process.exit(2);
  chunks.push(chunk);
}
let id: string | null = null;
try {
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    request.version !== 1 ||
    typeof request.id !== "string" ||
    request.id.length > 100
  )
    throw new Error("Invalid analysis helper request.");
  id = request.id;
  const { operation, input } = request;
  let result: unknown;
  if (operation === "configuration") {
    const value = ts.parseConfigFileTextToJson(input.file, input.text).config;
    let target: string | null = null;
    if (typeof value?.extends === "string" && value.extends.startsWith(".")) {
      target = path.posix.normalize(
        path.posix.join(path.posix.dirname(input.file), value.extends),
      );
      if (!target.endsWith(".json")) target += ".json";
    }
    result = { target };
  } else if (operation === "extractBatch") {
    const results = [];
    for (const item of input.files) {
      try {
        const value = item.file.endsWith(".java")
          ? { classes: await javaClasses(item.text) }
          : { dependencies: typescriptDependencies(item.file, item.text) };
        results.push({ file: item.file, ...value });
      } catch {
        results.push({
          file: item.file,
          error: item.file.endsWith(".java")
            ? "Java parse failure or unsupported grammar syntax"
            : "TypeScript/JavaScript parse failure",
        });
      }
    }
    result = results;
  } else if (operation === "extract") {
    if (typeof input.file !== "string" || typeof input.text !== "string")
      throw new Error();
    result = input.file.endsWith(".java")
      ? { classes: await javaClasses(input.text) }
      : { dependencies: typescriptDependencies(input.file, input.text) };
  } else if (operation === "complexityBatch") {
    result = input.files.map((item: { file: string; text: string }) => {
      try {
        return {
          file: item.file,
          units: functionUnits(item.file, item.text).units,
        };
      } catch {
        return {
          file: item.file,
          error: "Unsupported or invalid source syntax.",
        };
      }
    });
  } else if (operation === "complexity") {
    if (typeof input.file !== "string" || typeof input.text !== "string")
      throw new Error();
    result = { units: functionUnits(input.file, input.text).units };
  } else if (operation === "resolve") {
    const files = new Map<string, string>(Object.entries(input.files));
    const warnings: string[] = [];
    const resolve = typescriptResolver(
      files,
      new Set<string>(input.listed),
      warnings,
    );
    const resolutions = input.requests.map(
      (item: { file: string; specifier: string; dynamic?: boolean }) => {
        if (item.dynamic) return { target: null, internal: false };
        const target = resolve(item.file, item.specifier) ?? null;
        return { target, internal: resolve.isInternal(item.specifier) };
      },
    );
    result = { resolutions, warnings };
  } else throw new Error("Unsupported analysis helper operation.");
  const output = JSON.stringify({ version: 1, id, result });
  if (Buffer.byteLength(output) > limit) throw new Error();
  process.stdout.write(output + "\n");
} catch {
  // Parser exceptions may contain captured source. Only protocol errors leave this process.
  process.stdout.write(
    JSON.stringify({
      version: 1,
      id,
      error: "Analysis helper could not process captured input.",
    }) + "\n",
  );
  process.exitCode = 1;
}
