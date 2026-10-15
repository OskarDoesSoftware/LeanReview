import ts from "typescript-ast";
import { createHash } from "node:crypto";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export type FunctionUnit = {
  id: string;
  name: string;
  line: number;
  complexity: number;
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
};
function isFunction(
  node: ts.Node,
): node is
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}
export function functionUnits(file: string, text: string) {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("tsx")
      ? ts.ScriptKind.TSX
      : file.endsWith("jsx")
        ? ts.ScriptKind.JSX
        : file.endsWith("js")
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS,
  );
  if (
    (source as ts.SourceFile & { parseDiagnostics?: unknown[] })
      .parseDiagnostics?.length
  )
    throw new Error("Source syntax could not be parsed.");
  const units: FunctionUnit[] = [];
  const collect = (node: ts.Node) => {
    if (isFunction(node) && node.body) {
      let complexity = 1;
      const count = (child: ts.Node) => {
        if (child !== node && isFunction(child)) return;
        if (
          ts.isIfStatement(child) ||
          ts.isWhileStatement(child) ||
          ts.isDoStatement(child) ||
          ts.isForStatement(child) ||
          ts.isForInStatement(child) ||
          ts.isForOfStatement(child) ||
          ts.isCatchClause(child) ||
          ts.isConditionalExpression(child) ||
          ts.isCaseClause(child)
        )
          complexity++;
        if (
          ts.isBinaryExpression(child) &&
          [
            ts.SyntaxKind.AmpersandAmpersandToken,
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken,
            ts.SyntaxKind.AmpersandAmpersandEqualsToken,
            ts.SyntaxKind.BarBarEqualsToken,
            ts.SyntaxKind.QuestionQuestionEqualsToken,
          ].includes(child.operatorToken.kind)
        )
          complexity++;
        if (
          (ts.isParameter(child) || ts.isBindingElement(child)) &&
          child.initializer
        )
          complexity++;
        if (
          (ts.isPropertyAccessExpression(child) ||
            ts.isElementAccessExpression(child) ||
            ts.isCallExpression(child)) &&
          child.questionDotToken
        )
          complexity++;
        ts.forEachChild(child, count);
      };
      count(node);
      const name =
        node.name?.getText(source) ??
        (ts.isVariableDeclaration(node.parent)
          ? node.parent.name.getText(source)
          : ts.isConstructorDeclaration(node)
            ? "constructor"
            : `<anonymous at ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}>`);
      units.push({
        id: hash(`${file}:${node.getStart(source)}:${node.end}`).slice(0, 24),
        name,
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        complexity,
        start: node.getStart(source),
        end: node.end,
        bodyStart: node.body.getStart(source),
        bodyEnd: node.body.end,
      });
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const position = (line: number, column: number) => {
    if (
      !Number.isInteger(line) ||
      !Number.isInteger(column) ||
      line < 1 ||
      column < 0
    )
      throw new Error("Invalid statement coordinates.");
    const starts = source.getLineStarts();
    if (line > starts.length) throw new Error("Statement line outside source.");
    const offset = starts[line - 1] + column;
    const end = line < starts.length ? starts[line] : text.length;
    if (offset > end) throw new Error("Statement column outside source.");
    return offset;
  };
  const lineEnd = (line: number) => {
    const start = position(line, 0);
    const starts = source.getLineStarts();
    const end = line < starts.length ? starts[line] : text.length;
    return start + text.slice(start, end).replace(/[\r\n]+$/, "").length;
  };
  return { units, position, lineEnd };
}
