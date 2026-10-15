import path from "node:path";
import type { Snapshot, Content } from "../../../packages/contracts/src/index";
import type { GraphOptions } from "../../../packages/contracts/src/graph";
import { hash } from "../git/local";
import { GitBlobReader } from "../git/blob-reader";

/** Provider-neutral pinned source boundary. Remote adapters can supply the same inventory/read API. */
export interface GraphSource {
  revision: string;
  complete: boolean;
  paths: string[];
  read(path: string, signal?: AbortSignal): Promise<string>;
  close?(): Promise<void>;
}
export function localGraphSource(
  snapshot: Snapshot,
  side: GraphOptions["side"],
): GraphSource {
  const inventory = snapshot.graphContext?.[side];
  const blobs = new Map(
    inventory?.entries.map((entry) => [entry.path, entry]) ?? [],
  );
  const overlay = new Map<string, Content>();
  for (const file of snapshot.files) {
    const name = side === "before" ? file.oldPath : file.path;
    if (side === "after" && file.oldPath !== file.path)
      blobs.delete(file.oldPath);
    overlay.set(name, file[side]);
    if (file[side].kind === "absent") blobs.delete(name);
  }
  const paths = [...new Set([...blobs.keys(), ...overlay.keys()])]
    .filter((name) => overlay.get(name)?.kind !== "absent")
    .sort();
  let reader: GitBlobReader | undefined;
  return {
    revision: hash(
      JSON.stringify([
        inventory ?? "context-unavailable",
        snapshot.files.map((f) => [f.id, f.fingerprint]),
        side,
      ]),
    ),
    complete: inventory?.complete ?? false,
    paths,
    async read(name, signal) {
      if (
        path.posix.isAbsolute(name) ||
        name.split(/[\\/]/).some((p) => p === ".." || p === ".git")
      )
        throw new Error("Invalid pinned source path.");
      const captured = overlay.get(name);
      if (captured) {
        if (captured.kind !== "text")
          throw new Error(captured.reason ?? `Source ${captured.kind}`);
        return captured.text;
      }
      const entry = blobs.get(name);
      if (
        !entry ||
        !/^100(644|755)$/.test(entry.mode) ||
        !/^[a-f0-9]{40,64}$/.test(entry.oid)
      )
        throw new Error("Pinned blob unavailable or non-regular file.");
      reader ??= new GitBlobReader(snapshot.root, signal);
      const bytes = await reader.read(entry.oid);
      if (bytes.includes(0)) throw new Error("Binary source unavailable.");
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    },
    async close() {
      await reader?.close();
    },
  };
}
