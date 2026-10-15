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
        .filter((n) =>
          options.folder === "."
            ? n.kind === "module" && !!n.path && !n.path.includes("/")
            : n.path?.startsWith(options.folder + "/"),
        )
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
  // Collapse large Java projects at the first branching namespace, then drill down.
  const namespace = options.javaPackage?.startsWith("namespace:")
    ? options.javaPackage.slice("namespace:".length)
    : null;
  const packages = graph.nodes.filter(
    (n) =>
      n.kind === "package" &&
      n.language === "java" &&
      (!namespace ||
        n.label === namespace ||
        n.label.startsWith(namespace + ".")) &&
      selected.has(n.id),
  );
  if (namespace) {
    const packageIds = new Set(packages.map((n) => n.id));
    selected = new Set(
      graph.nodes
        .filter(
          (n) =>
            packageIds.has(n.id) ||
            (!!n.packageId && packageIds.has(n.packageId)),
        )
        .map((n) => n.id),
    );
  }
  if (options.javaPackage && !namespace) {
    const inside = new Set(
      graph.nodes
        .filter((n) => n.packageId === options.javaPackage)
        .map((n) => n.id),
    );
    selected = new Set(inside);
    for (const edge of graph.edges)
      if (inside.has(edge.source) || inside.has(edge.target)) {
        selected.add(edge.source);
        selected.add(edge.target);
      }
  }
  const javaGroups = new Map<string, GraphNode>();
  if (packages.length > 40 && (!options.javaPackage || !!namespace)) {
    const labels = packages.map((n) => n.label.split("."));
    let depth = 0;
    while (
      labels.every(
        (parts) => parts.length > depth && parts[depth] === labels[0][depth],
      )
    )
      depth++;
    const buckets = new Map<string, GraphNode[]>();
    for (const pkg of packages) {
      const prefix = pkg.label
        .split(".")
        .slice(0, depth + 1)
        .join(".");
      const bucket = buckets.get(prefix) ?? [];
      bucket.push(pkg);
      buckets.set(prefix, bucket);
    }
    for (const [prefix, bucket] of buckets) {
      const group: GraphNode =
        bucket.length === 1
          ? bucket[0]
          : {
              id: "namespace:" + prefix,
              label: prefix,
              kind: "folder",
              language: "java",
              changed: bucket.some((n) => n.changed),
            };
      for (const pkg of bucket) javaGroups.set(pkg.id, group);
    }
  }
  const projection = new Map<string, string>(),
    groups = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (options.groupModules && node.kind === "module" && node.path) {
      const parts = node.path.split("/"),
        inside =
          options.folder === "."
            ? !node.path.includes("/")
            : options.folder && node.path.startsWith(options.folder + "/");
      const remaining =
        options.folder === "."
          ? node.path
          : node.path.slice((options.folder?.length ?? 0) + 1);
      const prefix = inside
        ? options.folder + "/" + remaining.split("/")[0]
        : parts.length === 1
          ? "."
          : parts.slice(0, Math.min(2, parts.length - 1)).join("/");
      const directory =
        inside && remaining.includes("/") ? prefix : inside ? "" : prefix;
      if (directory) {
        const id = `folder:${directory}`;
        projection.set(node.id, id);
        const group = groups.get(id);
        if (group) group.changed ||= node.changed;
        else
          groups.set(id, {
            id,
            label: directory === "." ? "Repository root" : directory,
            kind: "folder",
            language: "ts/js",
            changed: node.changed,
          });
        continue;
      }
    }
    const packageId =
      node.kind === "class"
        ? node.packageId
        : node.kind === "package"
          ? node.id
          : undefined;
    const javaGroup =
      packageId && node.packageId !== options.javaPackage
        ? javaGroups.get(packageId)
        : undefined;
    const id = javaGroup
      ? javaGroup.id
      : node.kind === "class" && node.packageId !== options.javaPackage
        ? node.packageId!
        : node.id;
    projection.set(node.id, id);
    if (id !== node.id) {
      const pkg = javaGroup || all.get(id)!;
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
  const members = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.kind === "package") continue;
    const id = projection.get(node.id)!;
    const list = members.get(id) ?? [];
    list.push(node.id);
    members.set(id, list);
  }
  const edgeValues = [...edgeMap.values()];
  return {
    nodes,
    edges: edgeValues.slice(0, 2000),
    totalEdges: edgeValues.length,
    total: matching.length,
    projection,
    members,
  };
}

export function graphRenderPlan<T extends { source: string; target: string }>(
  nodes: { id: string }[],
  edges: T[],
  connections: "auto" | "selected" | "all",
  selected: string | null,
) {
  const dense =
    nodes.length >= 60 || edges.length > Math.max(24, nodes.length * 3);
  const focused =
    connections === "selected" || (connections === "auto" && dense);
  const candidates = focused
    ? edges.filter((e) => e.source === selected || e.target === selected)
    : edges;
  return {
    dense,
    focused,
    grid: dense,
    edges: connections === "all" ? candidates : candidates.slice(0, 160),
    matchingEdges: candidates.length,
  };
}
