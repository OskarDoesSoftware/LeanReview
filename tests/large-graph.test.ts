import { expect, it } from "vitest";
import { largeJavaGraph, largeOptions } from "./fixtures/large-graph";
import { graphView, graphRenderPlan } from "../frontend/src/lib/graph-view";

it("summarizes a 600-package Java project into readable namespace groups", () => {
  const view = graphView(largeJavaGraph(), largeOptions);
  expect(view.nodes.length).toBeLessThanOrEqual(12);
  expect(view.total).toBe(10);
  expect(view.edges.length).toBeLessThanOrEqual(100);
});
it("drills into namespaces and retains class evidence and search targets", () => {
  const graph = largeJavaGraph();
  const overview = graphView(graph, largeOptions);
  const group = overview.nodes.find((n) => n.label.endsWith("area3"))!;
  expect(overview.members.get(group.id)).toHaveLength(60);
  const inside = graphView(graph, { ...largeOptions, javaPackage: group.id });
  expect(inside.total).toBe(60);
  expect(inside.nodes.every((n) => n.label.startsWith(group.label))).toBe(true);
  const pkg = inside.nodes[0];
  const classes = graphView(graph, { ...largeOptions, javaPackage: pkg.id });
  expect(
    classes.nodes.some((n) => n.kind === "class" && n.packageId === pkg.id),
  ).toBe(true);
  const search = graphView(graph, { ...largeOptions, query: "feature245" });
  expect(search.nodes.map((n) => n.label)).toContain(
    "com.example.product.area4",
  );
  expect(
    overview.edges.reduce((sum, e) => sum + e.originalIds.length, 0),
  ).toBeGreaterThan(1000);
});

it("bounds dense rendering without feeding thousands of edges into layout", () => {
  const graph = largeJavaGraph();
  const flat = graphView(graph, {
    ...largeOptions,
    javaPackage: "namespace:com.example.product.area3",
  });
  const plan = graphRenderPlan(flat.nodes, flat.edges, "auto", null);
  expect(plan.grid).toBe(true);
  expect(plan.edges).toHaveLength(0);
  const focused = graphRenderPlan(
    flat.nodes,
    flat.edges,
    "auto",
    flat.nodes[0].id,
  );
  expect(focused.edges.length).toBeGreaterThan(0);
  expect(focused.edges.length).toBeLessThanOrEqual(160);
  expect(
    focused.edges.every(
      (e) => e.source === flat.nodes[0].id || e.target === flat.nodes[0].id,
    ),
  ).toBe(true);
});
