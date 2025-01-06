import ts from "typescript";
const getPrinter = (() => {
    let printer = undefined;
    return () => (printer ??= ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }));
})();
export const printNode = (node, debug) => debug &&
    console.log(getPrinter().printNode(ts.EmitHint.Unspecified, node, node.getSourceFile()));
//# sourceMappingURL=Printer.js.map