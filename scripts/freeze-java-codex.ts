import { writeFile } from "node:fs/promises";
import { codexOutput } from "../backend/src/llm/codex-output";
const examples = [];
for (const count of [1, 2, 49]) {
  const input = {
    files: Array.from({ length: count }, (_, index) => ({
      id: `file-${index}`,
    })),
  };
  const value = {
    fileAssignments: Object.fromEntries(
      input.files.map((file, index) => [
        file.id,
        {
          cohortName: `Feature ${index % 3}`,
          cohortExplanation: "Related changes",
          layerName: `Step ${index % 2}`,
          layerExplanation: "Read this part",
          readingOrder: count - index - 1,
        },
      ]),
    ),
    findings: [],
  };
  const output = codexOutput(input);
  examples.push({
    input,
    value,
    schema: output.schema,
    parsed: output.parse(value),
  });
}
await writeFile(
  "tests/fixtures/java-codex-output.json",
  JSON.stringify(examples, null, 2) + "\n",
);
