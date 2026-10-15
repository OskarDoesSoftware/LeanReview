import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { NativeSelect } from "./ui/native-select";
import { Badge } from "./ui/badge";
import { ReviewDialog } from "./review-dialog";
import { DialogTitle } from "./ui/dialog";
import { useState, useEffect, useCallback, useRef } from "react";
import { Play, Upload, Settings2, Square, Download } from "lucide-react";
import type { Review } from "../../../packages/contracts/src/index";
import type {
  CoverageView,
  TestConfig,
  TestPreview,
  CoverageProvenance,
} from "../../../packages/contracts/src/coverage";
import { api } from "../lib/api";
import { Button } from "./ui/button";
const windows = () => navigator.userAgent.includes("Windows");
function defaults(format: "istanbul" | "jacoco"): TestConfig {
  return {
    format,
    cwd: ".",
    reportPath:
      format === "istanbul"
        ? "coverage/coverage-final.json"
        : "target/site/jacoco/jacoco.xml",
    timeoutSeconds: 600,
    threshold: 8,
    steps: [
      {
        executable:
          format === "istanbul"
            ? windows()
              ? "npm.cmd"
              : "npm"
            : windows()
              ? "mvn.cmd"
              : "mvn",
        args:
          format === "istanbul"
            ? ["run", "test", "--", "--coverage"]
            : ["verify", "jacoco:report"],
        shell: windows(),
      },
    ],
  };
}
function download(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
export function CoveragePanel({
  review,
  fileId,
  active,
}: {
  review: Review;
  fileId?: string;
  active: boolean;
}) {
  const [format, setFormat] = useState<"istanbul" | "jacoco">(
    review.snapshot.files.find((f) => f.id === fileId)?.path.endsWith(".java")
      ? "jacoco"
      : "istanbul",
  );
  const [view, setView] = useState<CoverageView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [config, setConfig] = useState<TestConfig>(defaults(format));
  const [steps, setSteps] = useState(JSON.stringify(config.steps, null, 2));
  const [preview, setPreview] = useState<TestPreview | null>(null);
  const [report, setReport] = useState<File | null>(null);
  const [provenance, setProvenance] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const base = `/sessions/${review.snapshot.sessionId}/coverage`;
  const requestVersion = useRef(0);
  const reload = useCallback(async () => {
    const version = ++requestVersion.current;
    const result = await api<CoverageView>(
      `${base}?snapshot=${review.snapshot.id}&format=${format}`,
    );
    if (version === requestVersion.current) setView(result);
    return result;
  }, [base, review.snapshot.id, format]);
  useEffect(() => {
    const language = review.snapshot.files
      .find((f) => f.id === fileId)
      ?.path.endsWith(".java")
      ? "jacoco"
      : "istanbul";
    setFormat(language);
  }, [fileId]);
  useEffect(() => {
    let live = true;
    setView(null);
    setPreview(null);
    void reload()
      .then((result) => {
        if (live) {
          const current = result.config ?? defaults(format);
          setConfig(current);
          setSteps(JSON.stringify(current.steps, null, 2));
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      live = false;
      ++requestVersion.current;
    };
  }, [reload]);
  useEffect(() => {
    if (view?.run?.status !== "running") return;
    const timer = setInterval(
      () => void reload().catch((e) => setError(e.message)),
      1000,
    );
    return () => clearInterval(timer);
  }, [view?.run?.status, reload]);
  const action = async (work: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Coverage action failed.");
    } finally {
      setBusy(false);
    }
  };
  const file = view?.metrics.files.find((f) => f.fileId === fileId);
  const functions = file?.functions ?? [];
  const measured = functions.filter((f) => f.crap !== null);
  const highest = measured.length
    ? Math.max(...measured.map((f) => f.crap!))
    : null;
  return (
    <div className="details-content coverage-panel">
      <div className="flex items-center justify-between gap-2">
        <h2>CRAP meter</h2>
        <Badge variant="secondary" className="badge">
          Measured · no AI estimates
        </Badge>
      </div>
      <label className="small mt-3">
        Coverage format
        <NativeSelect
          aria-label="Coverage format"
          value={format}
          onChange={(e) => setFormat(e.target.value as typeof format)}
        >
          <option value="istanbul">TS/JS · Istanbul JSON</option>
          <option value="jacoco">Java · JaCoCo XML</option>
        </NativeSelect>
      </label>
      {error && (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="crap-value">
        {highest === null ? "Unavailable" : highest.toFixed(2)}
      </div>
      <p className="small muted">
        Highest measured function/method in this file. CRAP is unbounded.
      </p>
      <div className="coverage-counts">
        <span>{measured.length} measured</span>
        <span>{functions.length - measured.length} unavailable</span>
        <span>
          {measured.filter((f) => f.crap! > config.threshold).length} above{" "}
          {config.threshold}
        </span>
      </div>
      <p className="small muted">
        {file?.convention ??
          (format === "istanbul"
            ? "Classic complexity + statement coverage"
            : "JaCoCo complexity + instruction coverage")}
      </p>
      {file?.reason && <p className="omission">{file.reason}</p>}
      {view?.metrics.warnings.map((warning, index) => (
        <p key={index} className="omission">
          {warning}
        </p>
      ))}
      {functions.map((metric) => (
        <div className="function-metric" key={metric.id}>
          <strong>{metric.name}</strong>
          <span className="small muted">Line {metric.line || "unknown"}</span>
          <div className="metric-values">
            <span>
              Complexity <b>{metric.complexity ?? "N/A"}</b>
            </span>
            <span>
              Coverage{" "}
              <b>
                {metric.coverage === null
                  ? "N/A"
                  : `${(metric.coverage * 100).toFixed(1)}%`}
              </b>
            </span>
            <span>
              CRAP{" "}
              <b>{metric.crap === null ? "N/A" : metric.crap.toFixed(2)}</b>
            </span>
          </div>
          {metric.reason && <p className="small muted">{metric.reason}</p>}
        </div>
      ))}
      {!view && <p className="small muted">Loading measured functions…</p>}
      <div className="coverage-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={!active || busy}
          onClick={() => setImporting(true)}
        >
          <Upload size={13} />
          Import report
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!active || busy}
          onClick={() => setEditing(true)}
        >
          <Settings2 size={13} />
          Configure tests
        </Button>
        <Button
          size="sm"
          disabled={!active || busy || view?.run?.status === "running"}
          onClick={() =>
            void action(async () => {
              if (!view?.config) {
                setEditing(true);
                return;
              }
              setPreview(
                await api(base + "/preview", {
                  snapshotId: review.snapshot.id,
                  format,
                }),
              );
            })
          }
        >
          <Play size={13} />
          Run tests & coverage
        </Button>
      </div>
      {view?.run && (
        <section className="test-run">
          <div className="flex justify-between items-center">
            <h3>Test run · {view.run.status}</h3>
            {view.run.status === "running" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void action(async () => {
                    await api(base + "/cancel", {
                      snapshotId: review.snapshot.id,
                      runId: view.run!.id,
                    });
                    await reload();
                  })
                }
              >
                <Square size={12} />
                Cancel
              </Button>
            )}
          </div>
          {view.run.error && (
            <p className="text-destructive">{view.run.error}</p>
          )}
          <details>
            <summary>Command output</summary>
            <pre>{view.run.log || "Waiting for output…"}</pre>
          </details>
        </section>
      )}
      {view?.metrics.reportHash && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void action(async () => {
              const artifact = await api<{
                report: string;
                provenance: CoverageProvenance | null;
              }>(
                base +
                  `/artifact?snapshot=${review.snapshot.id}&format=${format}`,
              );
              download(
                format === "istanbul" ? "coverage-final.json" : "jacoco.xml",
                artifact.report,
              );
              if (artifact.provenance)
                download(
                  "coverage.leanreview.json",
                  JSON.stringify(artifact.provenance, null, 2),
                );
            })
          }
        >
          <Download size={13} />
          Export report & provenance
        </Button>
      )}
      <p className="small muted mt-4">
        Source provenance{" "}
        {view?.metrics.aligned ? "matches this snapshot" : "not verified"}. No
        before/after CRAP delta without two aligned reports. Warning thresholds
        are advisory.
      </p>
      {importing && (
        <ReviewDialog
          labelledBy="coverage-import-title"
          onClose={() => setImporting(false)}
        >
          <DialogTitle id="coverage-import-title">
            Import coverage report
          </DialogTitle>
          <p>
            Choose{" "}
            {format === "istanbul"
              ? "original-source-mapped Istanbul JSON"
              : "JaCoCo XML"}{" "}
            and, when available, its LeanReview provenance sidecar.
          </p>
          <label>
            Coverage report
            <Input
              aria-label="Coverage report file"
              type="file"
              accept={format === "istanbul" ? ".json" : ".xml"}
              onChange={(e) => setReport(e.target.files?.[0] ?? null)}
            />
          </label>
          <label>
            Source provenance · optional
            <Input
              aria-label="Coverage provenance file"
              type="file"
              accept=".json"
              onChange={(e) => setProvenance(e.target.files?.[0] ?? null)}
            />
          </label>
          <p className="small muted">
            Without matching report/source fingerprints, CRAP remains
            unavailable. Test runs inside LeanReview generate a sidecar
            automatically. No code is sent to an LLM.
          </p>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setImporting(false)}>
              Cancel
            </Button>
            <Button
              disabled={!report || busy}
              onClick={() =>
                void action(async () => {
                  if (
                    report!.size > 20 * 1024 * 1024 ||
                    (provenance && provenance.size > 2 * 1024 * 1024)
                  )
                    throw new Error("Report/sidecar exceeds import limit.");
                  await api(
                    base + "/import",
                    {
                      snapshotId: review.snapshot.id,
                      format,
                      report: await report!.text(),
                      provenance: provenance
                        ? JSON.parse(await provenance.text())
                        : undefined,
                      threshold: config.threshold,
                    },
                    "POST",
                    "application/vnd.leanreview.coverage+json",
                  );
                  setImporting(false);
                  await reload();
                })
              }
            >
              Import measured data
            </Button>
          </div>
        </ReviewDialog>
      )}
      {editing && (
        <ReviewDialog
          labelledBy="coverage-config-title"
          onClose={() => setEditing(false)}
        >
          <DialogTitle id="coverage-config-title">
            Configure tests & coverage
          </DialogTitle>
          <p className="small muted">
            Saved for this repository and report format. Nothing runs when
            saving.
          </p>
          <label>
            Working directory · relative to repository
            <Input
              aria-label="Test working directory"
              value={config.cwd}
              onChange={(e) => setConfig({ ...config, cwd: e.target.value })}
            />
          </label>
          <label>
            Report path · relative to repository
            <Input
              aria-label="Coverage report path"
              value={config.reportPath}
              onChange={(e) =>
                setConfig({ ...config, reportPath: e.target.value })
              }
            />
          </label>
          <div className="two-fields">
            <label>
              Timeout · seconds
              <Input
                type="number"
                value={config.timeoutSeconds}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    timeoutSeconds: Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              Advisory threshold
              <Input
                type="number"
                value={config.threshold}
                onChange={(e) =>
                  setConfig({ ...config, threshold: Number(e.target.value) })
                }
              />
            </label>
          </div>
          <label>
            Command steps · JSON array
            <Textarea
              aria-label="Test command steps"
              rows={8}
              value={steps}
              onChange={(e) => setSteps(e.target.value)}
            />
          </label>
          <p className="small muted">
            Each step has executable, args, and shell. Enable shell only for
            your explicitly configured wrapper/command. Windows npm.cmd,
            mvnw.cmd or gradlew.bat require a shell. For Gradle use your wrapper
            with test and jacocoTestReport; Java tooling must already be
            installed.
          </p>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const saved = await api<TestConfig>(base + "/config", {
                    snapshotId: review.snapshot.id,
                    config: { ...config, steps: JSON.parse(steps) },
                  });
                  setConfig(saved);
                  setEditing(false);
                  await reload();
                })
              }
            >
              Save test configuration
            </Button>
          </div>
        </ReviewDialog>
      )}
      {preview && (
        <ReviewDialog
          labelledBy="test-preview-title"
          onClose={() => setPreview(null)}
        >
          <DialogTitle id="test-preview-title">
            Run tests and measure coverage?
          </DialogTitle>
          <p>
            This executes trusted repository code on your machine. Commands may
            write build artifacts, run project plugins, and download
            dependencies.
          </p>
          <p className="small">
            Working directory: <code>{preview.workingDirectory}</code>
            <br />
            Report: <code>{preview.config.reportPath}</code>
            <br />
            Matched source files: {preview.sourceCount} · Timeout:{" "}
            {preview.config.timeoutSeconds}s
          </p>
          {preview.config.steps.map((step, index) => (
            <div key={index}>
              <strong>
                Step {index + 1}
                {step.shell ? " · shell enabled" : ""}
              </strong>
              <pre>
                {JSON.stringify([step.executable, ...step.args], null, 2)}
              </pre>
            </div>
          ))}
          <p className="small muted">
            Provider credentials are not passed into the test environment. This
            is trusted execution, not a sandbox. Previous measurements survive
            failed runs.
          </p>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setPreview(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await api(base + "/run", {
                    snapshotId: review.snapshot.id,
                    previewId: preview.id,
                    confirmed: true,
                  });
                  setPreview(null);
                  await reload();
                })
              }
            >
              Confirm & run tests
            </Button>
          </div>
        </ReviewDialog>
      )}
    </div>
  );
}
