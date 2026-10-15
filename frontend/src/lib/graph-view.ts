import type {
  ModuleGraph,
  GraphNode,
} from "../../../packages/contracts/src/graph";
export function graphView(
  graph: ModuleGraph,
  options: {
    scope: "review" | "repository";
    query: string;
    showExternal: boolean;
    showTypeOnly: boolean;
    expanded: string[];
    javaPackage: string | null;
    collapseCycles: boolean;
    limit: number;
    groupModules?: boolean;
    folder?: string | null;
  },
) {
  const all = new Map(graph.nodes.map((n) => [n.id, n]));
  let selected = new Set(graph.nodes.filter((n) => n.changed).map((n) => n.id));
  if (options.scope === "repository") selected = new Set(all.keys());
  else
    for (const edge of graph.edges)
      if (selected.has(edge.source) && all.get(edge.source)?.changed)
        selected.add(edge.target);
  if (options.folder) {
    selected = new Set(
      graph.nodes
        .filter((n) => n.path?.startsWith(options.folder + "/"))
        .map((n) => n.id),
    );
    const inside = new Set(selected);
    for (const edge of graph.edges)
      if (inside.has(edge.source)) selected.add(edge.target);
  }
  for (const id of options.expanded) {
    selected.add(id);
    for (const edge of graph.edges)
      if (edge.source === id || edge.target === id) {
        selected.add(edge.source);
        selected.add(edge.target);
      }
  }
  const projection = new Map<string, string>(),
    groups = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (options.groupModules && node.kind === "module" && node.path) {
      const parts = node.path.split("/"),
        inside = options.folder && node.path.startsWith(options.folder + "/");
      const prefix = inside
        ? options.folder +
          "/" +
          node.path.slice(options.folder!.length + 1).split("/")[0]
        : parts.slice(0, Math.min(2, parts.length - 1)).join("/");
      const directory =
        inside && node.path.slice(options.folder!.length + 1).includes("/")
          ? prefix
          : inside
            ? ""
            : prefix;
      if (directory) {
        const id = `folder:${directory}`;
        projection.set(node.id, id);
        const group = groups.get(id);
        if (group) group.changed ||= node.changed;
        else
          groups.set(id, {
            id,
            label: directory,
            kind: "folder",
            language: "ts/js",
            changed: node.changed,
          });
        continue;
      }
    }
    const id =
      node.kind === "class" && node.packageId !== options.javaPackage
        ? node.packageId!
        : node.id;
    projection.set(node.id, id);
    if (id !== node.id) {
      const pkg = all.get(id)!;
      groups.set(id, pkg);
    } else if (node.kind !== "package" || node.id !== options.javaPackage)
      groups.set(id, node);
  }
  if (options.collapseCycles)
    for (const [index, cycle] of graph.cycles.entries()) {
      const ids = [...new Set(cycle.map((id) => projection.get(id)!))];
      if (ids.length < 2) continue;
      const id = `cycle:${index}`;
      groups.set(id, {
        id,
        label: `Cycle ${index + 1} · ${ids.length} modules`,
        kind: "package",
        language: "ts/js",
        changed: cycle.some((n) => all.get(n)?.changed),
      });
      for (const [node, target] of projection)
        if (ids.includes(target)) projection.set(node, id);
    }
  const selectedGroups = new Set(
    [...selected].map((id) => projection.get(id)!),
  );
  const query = options.query.toLowerCase();
  const matchedGroups = new Set(
    graph.nodes
      .filter((n) => `${n.label} ${n.path ?? ""}`.toLowerCase().includes(query))
      .map((n) => projection.get(n.id)),
  );
  const matching = [...groups.values()]
    .filter(
      (n) =>
        selectedGroups.has(n.id) &&
        (options.showExternal ||
          !["external", "unresolved"].includes(n.kind)) &&
        (!query ||
          matchedGroups.has(n.id) ||
          `${n.label} ${n.path ?? ""}`.toLowerCase().includes(query)),
    )
    .sort(
      (a, b) =>
        Number(b.changed) - Number(a.changed) || a.label.localeCompare(b.label),
    );
  const nodes = matching.slice(0, options.limit),
    visible = new Set(nodes.map((n) => n.id));
  const edgeMap = new Map<
    string,
    {
      id: string;
      source: string;
      target: string;
      label: string;
      unresolved: boolean;
      typeOnly: boolean;
      originalIds: string[];
    }
  >();
  for (const edge of graph.edges) {
    if (!options.showTypeOnly && edge.typeOnly) continue;
    const source = projection.get(edge.source)!,
      target = projection.get(edge.target)!;
    if (source === target || !visible.has(source) || !visible.has(target))
      continue;
    const key = `${source}:${target}:${edge.status}:${edge.typeOnly}`;
    const group = edgeMap.get(key);
    if (group) {
      group.originalIds.push(edge.id);
      group.label = `${group.originalIds.length} relationships${edge.typeOnly ? " · type" : ""}`;
    } else
      edgeMap.set(key, {
        id: key,
        source,
        target,
        label: `${edge.kind}${edge.typeOnly ? " · type" : ""}`,
        unresolved: edge.status === "unresolved",
        typeOnly: edge.typeOnly,
        originalIds: [edge.id],
      });
  }
  const edgeValues = [...edgeMap.values()];
  return {
    nodes,
    edges: edgeValues.slice(0, 2000),
    totalEdges: edgeValues.length,
    total: matching.length,
    projection,
  };
}
