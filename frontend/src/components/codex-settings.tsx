import React from "react";
import type { CodexStatus } from "../../../packages/contracts/src/codex";
import { api } from "../lib/api";
import { Button } from "./ui/button";
import { NativeSelect } from "./ui/native-select";

export function CodexSettings({
  model,
  onModel,
}: {
  model: string;
  onModel: (model: string) => void;
}) {
  const [status, setStatus] = React.useState<CodexStatus | null>(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [authUrl, setAuthUrl] = React.useState("");
  const generation = React.useRef(0);
  const refresh = React.useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await api<CodexStatus>("/codex/status");
      if (current !== generation.current) return;
      setStatus(next);
      setError("");
      if (next.connected || !next.loginPending) setAuthUrl("");
    } catch (error) {
      if (current === generation.current)
        setError(
          error instanceof Error
            ? error.message
            : "Could not connect to Codex.",
        );
    }
  }, []);
  React.useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  React.useEffect(() => {
    if (!status?.loginPending || busy) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [status?.loginPending, busy, refresh]);
  React.useEffect(() => {
    if (model || !status?.connected) return;
    const choice =
      status.models.find((entry) => entry.isDefault) ?? status.models[0];
    if (choice) onModel(choice.model);
  }, [model, onModel, status]);

  async function act(action: "login" | "logout" | "cancel-login") {
    generation.current++;
    setBusy(true);
    setError("");
    try {
      if (action === "login") {
        const result = await api<{ authUrl: string }>("/codex/login", {});
        setAuthUrl(result.authUrl);
        window.open(result.authUrl, "_blank", "noopener,noreferrer");
      } else {
        await api(`/codex/${action}`, {});
        setAuthUrl("");
      }
      await refresh();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Codex sign-in failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="ChatGPT subscription connection" className="space-y-3">
      <p className="small muted">
        Uses your ChatGPT plan's Codex allowance. No API key or automatic API
        fallback. Codex manages this app's sign-in separately from your other
        Codex sessions.
      </p>
      <p role="status">
        {status?.connected
          ? `Connected${status.email ? ` as ${status.email}` : ""}${status.plan ? ` · ${status.plan}` : ""}`
          : status?.loginPending
            ? "Waiting for ChatGPT sign-in in your browser…"
            : status
              ? "Not signed in"
              : error
                ? "Codex unavailable"
                : "Connecting to Codex…"}
      </p>
      {(error || status?.loginError) && (
        <p role="alert">{error || status?.loginError}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {!status?.connected && !status?.loginPending && (
          <Button disabled={busy} onClick={() => void act("login")}>
            Sign in with ChatGPT
          </Button>
        )}
        {status?.loginPending && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void act("cancel-login")}
          >
            Cancel sign-in
          </Button>
        )}
        {status?.connected && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void act("logout")}
          >
            Sign out of LeanReview
          </Button>
        )}
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh connection and usage
        </Button>
      </div>
      {authUrl && (
        <p>
          <a href={authUrl} target="_blank" rel="noopener noreferrer">
            Continue sign-in in your browser
          </a>
        </p>
      )}
      <label>
        Model
        <NativeSelect
          value={model}
          disabled={!status?.connected || busy}
          onChange={(event) => onModel(event.target.value)}
        >
          <option value="">Choose a Codex model</option>
          {model && !status?.models.some((entry) => entry.model === model) && (
            <option value={model}>
              {model} · reconnect to verify availability
            </option>
          )}
          {status?.models.map((entry) => (
            <option key={entry.model} value={entry.model}>
              {entry.displayName}
            </option>
          ))}
        </NativeSelect>
      </label>
      {status?.connected && (
        <div aria-label="Subscription usage" className="small muted">
          <p>Codex allowance is shared with your other Codex sessions.</p>
          {status.usageError && <p>{status.usageError}</p>}
          {!status.usageError &&
            !status.limits.some(
              (limit) => limit.primary || limit.secondary,
            ) && <p>Usage details are unavailable.</p>}
          {status.limits.map((limit, index) => (
            <div key={limit.limitId ?? index}>
              <strong>{limit.limitName ?? limit.limitId ?? "Codex"}</strong>
              {[limit.primary, limit.secondary].map(
                (window, index) =>
                  window && (
                    <p key={index}>
                      {Math.max(0, Math.min(100, 100 - window.usedPercent))}%
                      remaining
                      {window.windowDurationMins
                        ? ` · ${window.windowDurationMins >= 1440 ? `${window.windowDurationMins / 1440} day` : `${window.windowDurationMins} minute`} window`
                        : ""}
                      {window.resetsAt
                        ? ` · resets ${new Date(window.resetsAt * 1000).toLocaleString()}`
                        : ""}
                    </p>
                  ),
              )}
              {limit.rateLimitReachedType && (
                <p>Allowance exhausted. Wait for the reset before retrying.</p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
