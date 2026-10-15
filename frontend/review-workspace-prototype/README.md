# Review workspace prototype

Throwaway UI exploration for the review-workspace decision ticket. Three structurally different layouts share sample data and in-memory state. No Git access, LLM inference, test execution, persistence, or publication is connected. Diffs imitate editor interactions; this is not a Monaco integration.

From the repository root:

```sh
node frontend/review-workspace-prototype/server.mjs
```

Open http://127.0.0.1:4317/?variant=A. Use the bottom switcher or left/right arrows outside form controls. A: cohort sidebar; B: guided layers; C: change map. Try file/layer progress, line comments, grouping proposals, refresh, coverage simulation, graph scope, and failure scenarios. All data is fictional. Reload resets state except the layout selected in the URL.
