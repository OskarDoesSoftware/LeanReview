import { z } from "zod";
import {
  analysisSchema,
  type Analysis,
} from "../../../packages/contracts/src/index";
import { outputSchema } from "./providers";

// A required property per input file makes assignment total and single-valued.
// The model chooses grouping, while application code owns file membership.
export function codexOutput(input: unknown) {
  const { files } = z
    .object({ files: z.array(z.object({ id: z.string().min(1) })).min(1) })
    .parse(input);
  const ids = files.map((file) => file.id);
  if (new Set(ids).size !== ids.length)
    throw new Error("Analysis input contains duplicate file IDs.");
  const assignment = z
    .object({
      cohortName: z.string().min(1).max(100),
      cohortExplanation: z.string().max(2000),
      layerName: z.string().min(1).max(100),
      layerExplanation: z.string().max(2000),
      readingOrder: z
        .number()
        .int()
        .min(0)
        .max(ids.length - 1),
    })
    .strict();
  const result = z
    .object({
      fileAssignments: z
        .object(Object.fromEntries(ids.map((id) => [id, assignment])))
        .strict(),
      findings: z.array(
        analysisSchema.shape.findings.element
          .extend({ fileId: z.enum(ids) })
          .strict(),
      ),
    })
    .strict();
  return {
    schema: outputSchema(result),
    instructions:
      "Return fileAssignments with exactly one required entry for every supplied file ID. Each entry chooses cohortName, cohortExplanation, layerName, layerExplanation, and a readingOrder rank starting at zero. Reuse the exact cohort and layer names for files that belong together. Rank files in the suggested dependency-informed reading order. Findings may reference only supplied IDs.",
    parse(value: unknown): Analysis {
      const parsed = result.parse(value);
      const cohorts: Analysis["cohorts"] = [];
      // Ignore JSON property order; equal ranks retain stable input order.
      const ordered = [...ids].sort(
        (left, right) =>
          parsed.fileAssignments[left].readingOrder -
          parsed.fileAssignments[right].readingOrder,
      );
      for (const id of ordered) {
        const item = parsed.fileAssignments[id];
        let cohort = cohorts.find((entry) => entry.name === item.cohortName);
        if (!cohort) {
          cohort = {
            name: item.cohortName,
            explanation: item.cohortExplanation,
            layers: [],
          };
          cohorts.push(cohort);
        }
        let layer = cohort.layers.find(
          (entry) => entry.name === item.layerName,
        );
        if (!layer) {
          layer = {
            name: item.layerName,
            explanation: item.layerExplanation,
            fileIds: [],
          };
          cohort.layers.push(layer);
        }
        layer.fileIds.push(id);
      }
      return analysisSchema.parse({ cohorts, findings: parsed.findings });
    },
  };
}
