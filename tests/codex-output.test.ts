import { describe, expect, it } from "vitest";
import { codexOutput } from "../backend/src/llm/codex-output";

const files = Array.from({ length: 49 }, (_, index) => ({
  id: `file-${index}`,
}));
const value = () => ({
  fileAssignments: Object.fromEntries(
    files.map((file, index) => [
      file.id,
      {
        cohortName: `Feature ${index % 3}`,
        cohortExplanation: "Related changes",
        layerName: `Step ${index % 2}`,
        layerExplanation: "Read this part",
        readingOrder: files.length - index - 1,
      },
    ]),
  ),
  findings: [],
});

describe("Codex file assignments", () => {
  it("preserves exactly one membership for all 49 files across related cohorts and layers", () => {
    const result = codexOutput({ files }).parse(value());
    const ids = result.cohorts.flatMap((cohort) =>
      cohort.layers.flatMap((layer) => layer.fileIds),
    );
    expect(ids).toHaveLength(49);
    expect(new Set(ids)).toEqual(new Set(files.map((file) => file.id)));
    expect(result.cohorts).toHaveLength(3);
    expect(result.cohorts[0].layers[0].fileIds[0]).toBe("file-48");
    expect(
      result.cohorts.every((cohort) =>
        cohort.layers.every((layer) => layer.fileIds.length > 0),
      ),
    ).toBe(true);
  });

  it("requires every input ID and rejects invented assignments and findings", () => {
    const output = codexOutput({ files });
    const omitted = value();
    delete omitted.fileAssignments["file-0"];
    expect(() => output.parse(omitted)).toThrow();
    const invented = value();
    invented.fileAssignments["invented"] = invented.fileAssignments["file-0"];
    expect(() => output.parse(invented)).toThrow();
    expect(() =>
      output.parse({
        ...value(),
        findings: [
          {
            fileId: "invented",
            line: null,
            kind: "bug",
            message: "Unknown file",
          },
        ],
      }),
    ).toThrow();
  });

  it("does not depend on JSON property order when producing the suggested reading order", () => {
    const original = value();
    const reversed = {
      ...original,
      fileAssignments: Object.fromEntries(
        Object.entries(original.fileAssignments).reverse(),
      ),
    };
    expect(codexOutput({ files }).parse(original)).toEqual(
      codexOutput({ files }).parse(reversed),
    );
  });
});
