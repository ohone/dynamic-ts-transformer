import ts from "typescript";

const getPrinter = (() => {
    let printer: ts.Printer | undefined = undefined;
    return () =>
      (printer ??= ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }));
  })();
  
  export const printNode = (node: ts.Node, debug: boolean) =>
    debug &&
    console.log(
      getPrinter().printNode(ts.EmitHint.Unspecified, node, node.getSourceFile())
    );