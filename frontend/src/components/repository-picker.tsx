import React from "react";
import { api } from "../lib/api";
import { ReviewDialog } from "./review-dialog";
import { DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import type {
  Comparison,
  Review,
  SessionSummary,
} from "../../../packages/contracts/src";

type Repository = {
  id: number;
  full_name: string;
  private: boolean;
  owner: { login: string };
};
type Pull = {
  needsMyReview?: boolean;
  number: number;
  title: string;
  user: { login: string };
  requested_reviewers: { login: string }[];
};
type Connection = {
  connected: boolean;
  signingIn: boolean;
  login?: string;
  userCode?: string;
  verificationUrl: string;
  error?: string;
};

export function RepositoryPicker({
  sessions,
  onClose,
  onLocal,
  onRemote,
}: {
  sessions: SessionSummary[];
  onClose: () => void;
  onLocal: (root: string, comparison: Comparison) => Promise<unknown>;
  onRemote: (review: Review) => Promise<unknown>;
}) {
  const [connection, setConnection] = React.useState<Connection>();
  const [repositories, setRepositories] = React.useState<Repository[]>([]);
  const [repository, setRepository] = React.useState<Repository>();
  const [pulls, setPulls] = React.useState<Pull[]>([]);
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState("all");
  const [tab, setTab] = React.useState("local");
  const [local, setLocal] = React.useState("");
  const [mode, setMode] = React.useState<Comparison["mode"]>("all");
  const [base, setBase] = React.useState("main");
  const [changedCount, setChangedCount] = React.useState<number>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  React.useEffect(() => {
    let live = true;
    const update = async () => {
      try {
        const status = await api<Connection>("/github/status");
        if (live) setConnection(status);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void update();
    const timer = setInterval(() => void update(), 2500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  React.useEffect(() => {
    if (!connection?.connected) return;
    let live = true;
    void api<Repository[]>("/github/repositories")
      .then((repos) => {
        if (live) setRepositories(repos);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [connection?.connected]);
  React.useEffect(() => {
    let live = true;
    setChangedCount(undefined);
    if (!local || (repository && tab !== "local")) return;
    const timer = setTimeout(() => {
      void api<{ count: number }>("/repositories/local-count", {
        root: local,
        comparison: { mode, base },
      })
        .then((r) => {
          if (live) setChangedCount(r.count);
        })
        .catch(() => {});
    }, 600);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [local, mode, base, repository?.id, tab]);
  const choose = (repo: Repository) =>
    void run(async () => {
      const context = await api<{ tab?: string; localPath?: string } | null>(
        `/github/repositories/${repo.id}/context`,
      );
      const list = await api<Pull[]>(`/github/repositories/${repo.id}/pulls`);
      setRepository(repo);
      setPulls(list);
      setTab(context?.tab ?? "pulls");
      setLocal(context?.localPath ?? "");
    });
  const changeTab = (value: string) => {
    setTab(value);
    if (repository)
      void run(() =>
        api(`/github/repositories/${repository.id}/context`, { tab: value }),
      );
  };
  return (
    <ReviewDialog labelledBy="repository-picker-title" onClose={onClose}>
      <DialogTitle id="repository-picker-title">Choose repository</DialogTitle>
      {error && <p role="alert">{error}</p>}
      {!repository ? (
        <>
          <label>
            Search repositories
            <Input value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <h3>Recent local repositories</h3>
          <div className="repository-results">
            {[
              ...new Set(
                sessions
                  .filter((s) => !s.root.startsWith("github.com/"))
                  .map((s) => s.root),
              ),
            ]
              .filter((root) =>
                root.toLowerCase().includes(query.toLowerCase()),
              )
              .map((root) => (
                <button
                  key={root}
                  onClick={() => {
                    setLocal(root);
                    setTab("local");
                  }}
                >
                  {root}
                  <small>Local Git</small>
                </button>
              ))}
          </div>
          <label>
            Local repository path
            <Input
              value={local}
              onChange={(e) => setLocal(e.target.value)}
              placeholder="Choose a folder or enter its path"
            />
          </label>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await api<{ root?: string }>(
                  "/repositories/browse",
                  {},
                );
                if (result.root) setLocal(result.root);
              })
            }
          >
            Browse folders
          </Button>
          <h3>GitHub.com</h3>
          {connection?.connected ? (
            <>
              <p className="small muted">Connected as {connection.login}</p>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setConnection(await api("/github/disconnect", {}));
                    setRepositories([]);
                  })
                }
              >
                Disconnect GitHub
              </Button>
              <div className="repository-results">
                {repositories
                  .filter((r) =>
                    r.full_name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((r) => (
                    <button
                      disabled={busy}
                      key={r.id}
                      onClick={() => choose(r)}
                    >
                      {r.full_name}
                      <small>
                        GitHub.com · {r.owner.login} ·{" "}
                        {r.private ? "Private" : "Public"}
                      </small>
                    </button>
                  ))}
              </div>
            </>
          ) : (
            <>
              <p className="small muted">
                Connect through GitHub CLI to select repositories and pull
                requests without cloning.
              </p>
              {connection?.signingIn ? (
                <div role="status">
                  <p>
                    Enter code{" "}
                    <strong>
                      {connection.userCode || "Preparing sign-in…"}
                    </strong>{" "}
                    on GitHub.
                  </p>
                  <a
                    href="https://github.com/login/device"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Continue GitHub sign-in in browser
                  </a>
                  <Button
                    variant="outline"
                    onClick={() =>
                      void run(async () =>
                        setConnection(await api("/github/cancel-login", {})),
                      )
                    }
                  >
                    Cancel GitHub sign-in
                  </Button>
                </div>
              ) : (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      setConnection(await api("/github/login", {})),
                    )
                  }
                >
                  Sign in with GitHub CLI
                </Button>
              )}
              {connection?.error && (
                <p className="small muted">{connection.error}</p>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={() => setRepository(undefined)}>
            Back to repositories
          </Button>
          <h3>{repository.full_name}</h3>
          <p className="small muted">GitHub.com · {repository.owner.login}</p>
          <div className="flex gap-2">
            <Button
              variant={tab === "pulls" ? "default" : "outline"}
              onClick={() => changeTab("pulls")}
            >
              Pull requests
            </Button>
            <Button
              variant={tab === "local" ? "default" : "outline"}
              onClick={() => changeTab("local")}
            >
              Local changes
            </Button>
          </div>
          {tab === "pulls" ? (
            <>
              <label>
                Filter pull requests
                <NativeSelect
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">All open</option>
                  <option value="review">Needs my review</option>
                  <option value="mine">Mine</option>
                </NativeSelect>
              </label>
              <div className="repository-results">
                {pulls
                  .filter(
                    (p) =>
                      filter === "all" ||
                      (filter === "mine"
                        ? p.user.login === connection?.login
                        : p.needsMyReview ||
                          p.requested_reviewers.some(
                            (u) => u.login === connection?.login,
                          )),
                  )
                  .map((p) => (
                    <button
                      key={p.number}
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const review = await api<Review>(
                            `/github/repositories/${repository.id}/pulls/${p.number}/open`,
                            {},
                          );
                          await onRemote(review);
                          onClose();
                        })
                      }
                    >
                      #{p.number} {p.title}
                      <small>{p.user.login}</small>
                    </button>
                  ))}
                {!pulls.length && <p>No open pull requests.</p>}
              </div>
            </>
          ) : (
            <>
              <p className="small muted">
                Link a local folder to review working changes for this
                repository.
              </p>
              <label>
                Local repository path
                <Input
                  value={local}
                  onChange={(e) => setLocal(e.target.value)}
                />
              </label>
              <Button
                variant="outline"
                disabled={!local || busy}
                onClick={() =>
                  void run(() =>
                    api(`/github/repositories/${repository.id}/context`, {
                      tab: "local",
                      localPath: local,
                    }),
                  )
                }
              >
                Remember folder link
              </Button>
            </>
          )}
        </>
      )}
      {(!repository || tab === "local") && (
        <>
          {changedCount !== undefined && (
            <p className="small muted">{changedCount} changed files</p>
          )}
          <label>
            Local comparison
            <NativeSelect
              value={mode}
              onChange={(e) => setMode(e.target.value as Comparison["mode"])}
            >
              <option value="all">All uncommitted</option>
              <option value="staged">Staged</option>
              <option value="unstaged">Unstaged</option>
              <option value="branch">Branch</option>
            </NativeSelect>
          </label>
          {mode === "branch" && (
            <label>
              Base branch
              <Input value={base} onChange={(e) => setBase(e.target.value)} />
            </label>
          )}
          <Button
            disabled={busy || !local}
            onClick={() =>
              void run(async () => {
                if (repository)
                  await api(`/github/repositories/${repository.id}/context`, {
                    tab: "local",
                    localPath: local,
                  });
                await onLocal(local, { mode, base });
                onClose();
              })
            }
          >
            Open local changes
          </Button>
        </>
      )}
      {busy && <p role="status">Loading repository data…</p>}
    </ReviewDialog>
  );
}
