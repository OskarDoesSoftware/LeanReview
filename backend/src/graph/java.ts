import Parser from "web-tree-sitter";
import { createRequire } from "node:module";
import type { Dependency } from "./typescript";
const require = createRequire(import.meta.url);
let language: Promise<Parser.Language> | undefined;
export type JavaClass = {
  name: string;
  packageName: string;
  line: number;
  references: Dependency[];
};
export async function javaClasses(text: string): Promise<JavaClass[]> {
  language ??= (async () => {
    await Parser.init();
    return Parser.Language.load(
      require.resolve("tree-sitter-wasms/out/tree-sitter-java.wasm"),
    );
  })();
  const loaded = await language;
  const parser = new Parser();
  parser.setLanguage(loaded);
  parser.setTimeoutMicros(1000000);
  const tree = parser.parse(text);
  try {
    if (tree.rootNode.hasError())
      throw new Error("Java parse failure or unsupported grammar syntax");
    const packageName =
      tree.rootNode.namedChildren
        .find((n) => n.type === "package_declaration")
        ?.namedChildren.find(
          (n) => n.type === "identifier" || n.type === "scoped_identifier",
        )?.text ?? "";
    const imports = tree.rootNode.namedChildren
      .filter((n) => n.type === "import_declaration")
      .map((node) => ({
        specifier: node.text
          .replace(/^import\s+(?:static\s+)?/, "")
          .replace(/;$/, "")
          .trim(),
        line: node.startPosition.row + 1,
        kind: "import" as const,
        typeOnly: false,
      }));
    const classes: JavaClass[] = [];
    const walk = (node: Parser.SyntaxNode, parent?: JavaClass) => {
      let owner = parent;
      if (
        [
          "class_declaration",
          "interface_declaration",
          "enum_declaration",
          "record_declaration",
          "annotation_type_declaration",
        ].includes(node.type)
      ) {
        const simple = node.childForFieldName("name")?.text;
        if (!simple) return;
        owner = {
          name: parent
            ? `${parent.name}.${simple}`
            : packageName
              ? `${packageName}.${simple}`
              : simple,
          packageName,
          line: node.startPosition.row + 1,
          references: [...imports],
        };
        classes.push(owner);
      }
      if (owner) {
        let generic = false;
        if (node.type === "type_identifier")
          for (
            let ancestor: Parser.SyntaxNode | null = node.parent;
            ancestor;
            ancestor = ancestor.parent
          ) {
            const parameters = ancestor.namedChildren.find(
              (child) => child.type === "type_parameters",
            );
            if (
              parameters?.namedChildren.some(
                (parameter) =>
                  parameter.type === "type_parameter" &&
                  parameter.namedChildren[0]?.text === node.text,
              )
            ) {
              generic = true;
              break;
            }
          }
        if (
          !generic &&
          ["type_identifier", "scoped_type_identifier"].includes(node.type) &&
          !["scoped_type_identifier"].includes(node.parent?.type ?? "")
        )
          owner.references.push({
            specifier: node.text.replace(/<.*>/g, ""),
            line: node.startPosition.row + 1,
            kind: "type-reference",
            typeOnly: false,
          });
        if (
          node.type === "field_access" &&
          /^[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)*\.[A-Z][\w$]*$/.test(node.text)
        )
          owner.references.push({
            specifier: node.text,
            line: node.startPosition.row + 1,
            kind: "type-reference",
            typeOnly: false,
          });
      }
      for (const child of node.namedChildren) walk(child, owner);
    };
    walk(tree.rootNode);
    return classes;
  } finally {
    tree.delete();
    parser.delete();
  }
}
