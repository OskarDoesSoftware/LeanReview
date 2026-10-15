import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ModuleGraphViewer } from "../../frontend/src/components/module-graph";
import { CoveragePanel } from "../../frontend/src/components/coverage-panel";
import { api } from "../../frontend/src/lib/api";
import type { Review } from "../../packages/contracts/src/index";
import "../../frontend/src/style.css";

// Acceptance harness for the retained components while the primary UI parks these features.
function Analysis({ review }: { review: Review }) {
  const [graph, setGraph] = useState(false);
  return (
    <main>
      <h1>Java analysis acceptance</h1>
      <button onClick={() => setGraph(true)}>Repository graph</button>
      <CoveragePanel
        review={review}
        fileId={
          review.snapshot.files.find((file) => file.path === "first.ts")?.id
        }
        active
      />
      {graph && (
        <ModuleGraphViewer
          review={review}
          initialScope="repository"
          onClose={() => setGraph(false)}
          onNavigate={() => {}}
        />
      )}
    </main>
  );
}
const session = new URL(location.href).searchParams.get("session");
const review = await api<Review>(`/sessions/${session}`);
createRoot(document.getElementById("root")!).render(
  <Analysis review={review} />,
);
