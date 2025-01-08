import * as ts from "typescript";
export declare function transpileTypescript(codeString: string, sourceUrl?: string | undefined, globalProxyNames?: string[], globalNonProxyNames?: string[], debug?: boolean, sourceMap?: boolean): Promise<string>;
export declare function flipOperator(kind: ts.SyntaxKind): ts.SyntaxKind;
//# sourceMappingURL=Transpiler.d.ts.map