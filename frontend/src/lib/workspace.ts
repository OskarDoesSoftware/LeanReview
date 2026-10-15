import type { ReviewNavigation } from "./review-navigation";
import type { SessionSummary } from "../../../packages/contracts/src/index";

const key = "leanreview.workspace";
type Workspace = { sessionId: string; snapshotId: string; fileId: string };

export function rememberWorkspace(workspace: Workspace) {
  try {
    localStorage.setItem(key, JSON.stringify(workspace));
  } catch {
    // The database still retains saved reviews if browser storage is unavailable.
  }
}

export async function restoreWorkspace(
  sessions: SessionSummary[],
  navigation: ReviewNavigation,
) {
  let saved: Workspace | null = null;
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (
      value &&
      [value.sessionId, value.snapshotId, value.fileId].every(
        (v) => typeof v === "string",
      )
    )
      saved = value;
  } catch {
    // Ignore corrupt or unavailable browser preferences.
  }
  const session =
    sessions.find((s) => s.id === saved?.sessionId) ?? sessions[0];
  if (!session) return;
  const cursor = saved?.sessionId === session.id ? saved : null;
  let restored = false;
  try {
    restored = await navigation.navigate(session.id, cursor?.snapshotId);
  } catch (error) {
    if (!cursor?.snapshotId) throw error;
    restored = await navigation.navigate(session.id);
  }
  if (restored && cursor) navigation.selectFile(cursor.fileId);
}
