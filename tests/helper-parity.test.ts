import { expect, it } from "vitest";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  typescriptDependencies,
  typescriptResolver,
} from "../backend-java/helper/src/dependencies";
import { javaClasses } from "../backend-java/helper/src/java";
import { functionUnits } from "../backend-java/helper/src/complexity";
import fixtures from "./fixtures/backend-compatibility/parsers.json";
import { z } from "zod";
import * as contracts from "../packages/contracts/src/index";
import * as coverage from "../packages/contracts/src/coverage";
import * as graph from "../packages/contracts/src/graph";
import schemas from "./fixtures/backend-compatibility/schemas.json";

it("preserves the shared request schemas used by the Java compatibility gate", () => {
  const expected = structuredClone(schemas);
  // The approved Codex provider was added after the original baseline.
  expected.providerSchema.properties.provider.enum.push("codex");
  const actual = Object.fromEntries(
    Object.entries({ ...contracts, ...coverage, ...graph }).flatMap(
      ([key, value]) =>
        value instanceof z.ZodType
          ? [[key, z.toJSONSchema(value, { io: "input" })]]
          : [],
    ),
  );
  expect(actual).toEqual(expected);
});

it("retains every frozen database, source artifact, and migration expectation", async () => {
  const root = "tests/fixtures/backend-compatibility";
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, "manifest.json"), "utf8"),
  );
  for (const file of manifest.files)
    expect(
      createHash("sha256")
        .update(await fs.readFile(path.join(root, file.path)))
        .digest("hex"),
      file.path,
    ).toBe(file.sha256);
});

it("keeps relocated parser output identical to the frozen baseline", async () => {
  const example = fixtures.typescript;
  expect(typescriptDependencies(example.file, example.text)).toEqual(
    example.dependencies,
  );
  const files = new Map([
    [example.file, example.text],
    ["src/value.ts", "export const value = 1; export type Value = number;"],
    ["src/lazy.ts", "export {};"],
    [
      "tsconfig.json",
      '{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["src/*"]}}}',
    ],
  ]);
  const warnings: string[] = [];
  const resolve = typescriptResolver(files, new Set(files.keys()), warnings);
  expect(
    example.resolved.map(({ specifier }) => ({
      specifier,
      target: resolve(example.file, specifier) ?? null,
    })),
  ).toEqual(example.resolved);
  expect(warnings).toEqual(example.warnings);
  expect(await javaClasses(fixtures.java.text)).toEqual(fixtures.java.classes);
  expect(
    functionUnits(fixtures.complexity.file, fixtures.complexity.text).units,
  ).toEqual(fixtures.complexity.units);
});
