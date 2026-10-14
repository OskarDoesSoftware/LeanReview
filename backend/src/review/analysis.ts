import {
  analysisSchema,
  type Analysis,
  type Manifest,
  type ProviderConfig,
  type Snapshot,
} from "../../../packages/contracts/src/index";
import { hash } from "../git/local";
export const configKey = (config: ProviderConfig) =>
  hash(JSON.stringify(config));
const excluded = (path: string) =>
  /(^|\/)(node_modules|vendor|dist|build|coverage)(\/|$)|\.(lock|min\.js|map)$|package-lock\.json$/.test(
    path,
  );
export function prepare(snapshot: Snapshot, config: ProviderConfig) {
  let bytes = 0;
  const items = snapshot.files.map((file) => {
    const body = {
      id: file.id,
      path: file.path,
      status: file.status,
      diff: file.patch,
      before: file.before.kind,
      after: file.after.kind,
    };
    const size = Buffer.byteLength(file.patch);
    const reason = excluded(file.path)
      ? "Generated/vendor file excluded"
      : !file.patch
        ? "No text diff"
        : size > 128 * 1024
          ? "Per-file context limit"
          : bytes + size > 2 * 1024 * 1024
            ? "Total context limit"
            : undefined;
    if (!reason) bytes += size;
    return {
      body: {
        ...body,
        diff: reason ? "" : file.patch,
        omitted: reason ?? null,
      },
      manifest: { id: file.id, path: file.path, included: !reason, reason },
    };
  });
  const inputBudget = Math.floor(
    Math.min(
      config.contextWindow * 0.75,
      config.contextWindow - config.maxOutput,
    ) - 1024,
  );
  if (inputBudget < 256)
    throw new Error(
      "Context window is too small for the configured output reservation.",
    );
  // Deliberately conservative UTF-8 byte upper bound; not an exact model tokenizer.
  const estimatedTokens = Buffer.byteLength(
    JSON.stringify(items.map((x) => x.body)),
  );
  const manifest: Manifest = {
    id: hash(
      JSON.stringify([
        snapshot.id,
        config,
        snapshot.files.map((f) => f.fingerprint),
      ]),
    ),
    snapshotId: snapshot.id,
    config,
    files: items.map((x) => x.manifest),
    estimatedTokens,
    inputBudget,
  };
  const batches: (typeof items)[] = [];
  let batch: typeof items = [],
    used = 0;
  for (const item of items) {
    let itemSize = Buffer.byteLength(JSON.stringify(item.body));
    if (itemSize > inputBudget) {
      item.body.diff = "";
      item.body.omitted = "Model input budget";
      item.manifest.included = false;
      item.manifest.reason = "Model input budget";
      itemSize = Buffer.byteLength(JSON.stringify(item.body));
    }
    if (itemSize > inputBudget)
      throw new Error("File metadata exceeds model input budget.");
    if (batch.length && (batch.length >= 20 || used + itemSize > inputBudget)) {
      batches.push(batch);
      batch = [];
      used = 0;
    }
    batch.push(item);
    used += itemSize;
  }
  if (batch.length) batches.push(batch);
  return {
    manifest,
    batches: batches.map((b) => ({ files: b.map((x) => x.body) })),
  };
}
export function validateAnalysis(
  value: unknown,
  snapshot: Pick<Snapshot, "files">,
): Analysis {
  const analysis = analysisSchema.parse(value);
  const ids = new Set(snapshot.files.map((f) => f.id));
  const seen = new Set<string>();
  for (const cohort of analysis.cohorts)
    for (const layer of cohort.layers) {
      if (!layer.fileIds.length)
        throw new Error("Analysis contains an empty layer.");
      for (const id of layer.fileIds) {
        if (!ids.has(id) || seen.has(id))
          throw new Error("Analysis contains an invented or duplicated file.");
        seen.add(id);
      }
    }
  if (seen.size !== ids.size)
    throw new Error("Analysis omitted a changed file.");
  for (const finding of analysis.findings) {
    const file = snapshot.files.find((f) => f.id === finding.fileId);
    if (!file) throw new Error("Finding references an invented file.");
    if (
      finding.line !== null &&
      (file.after.kind !== "text" ||
        finding.line > file.after.text.split("\n").length)
    )
      throw new Error("Finding line is outside the captured file.");
  }
  return analysis;
}
