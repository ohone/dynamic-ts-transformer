import ts from "typescript";
import { getTypeDefinitions } from "./type-definitions.js";
const rootFileName = "input.ts";
const runtimeTypes = {
    "node_modules/my-runtime-types.d.ts": getTypeDefinitions,
};
export async function transpileTypescript(codeString, sourceUrl, globalMockNames = [], debug = false) {
    const typeChecker = await createTypeChecker(codeString, globalMockNames, debug);
    const { outputText } = ts.transpileModule(`//\n//\n` + codeString, {
        compilerOptions: {
            module: ts.ModuleKind.ES2022,
            target: ts.ScriptTarget.ES2023,
            inlineSourceMap: true, //Disabled for now, as the maps were mangled, happy to use JS debugging for now
            inlineSources: true,
            sourceMap: true,
        },
        fileName: sourceUrl,
        transformers: {
            before: [createTransformer(typeChecker, debug)],
        },
    });
    // WHY ??
    // the map files are off by 2, so we added two comment lines before transpiling
    // we then trim those lines before gen of dynamic function, so that we correct the off by 2
    return (outputText.split("\n").slice(2).join("\n") + "\n//# sourceURL=" + sourceUrl);
}
async function createInMemoryCompilerHost(sourceCode, globalMockNames, debug = false) {
    const sourceFile = ts.createSourceFile(rootFileName, sourceCode, ts.ScriptTarget.Latest, true);
    return {
        getSourceFile: (fileName, languageVersion) => {
            if (fileName === rootFileName) {
                return sourceFile;
            }
            if (runtimeTypes[fileName] !== undefined) {
                debug && console.log("Loading lib file:", fileName);
                return ts.createSourceFile(fileName, runtimeTypes[fileName](globalMockNames, debug), languageVersion);
            }
            debug && console.warn("[getFileSource]File does not exist:", fileName);
            return undefined;
        },
        writeFile: () => { },
        getDefaultLibFileName: () => "lib.d.ts",
        useCaseSensitiveFileNames: () => false,
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => "",
        getNewLine: () => "\n",
        getDirectories: () => [],
        fileExists: (fileName) => {
            if (fileName === rootFileName) {
                return true;
            }
            if (runtimeTypes[fileName] !== undefined) {
                debug && console.log("Checking for lib file:", fileName);
                return true;
            }
            debug && console.warn("[fileExists]File does not exist:", fileName);
            return false;
        },
        readFile: (fileName) => {
            if (fileName === rootFileName) {
                return sourceCode;
            }
            if (runtimeTypes[fileName] !== undefined) {
                debug && console.log("Reading lib file:", fileName);
                return runtimeTypes[fileName](globalMockNames, debug);
            }
            debug && console.warn("[readFile]File does not exist:", fileName);
            return undefined;
        },
    };
}
const getPrinter = (() => {
    let printer = undefined;
    return () => (printer ??= ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }));
})();
const printNode = (node, debug) => debug &&
    console.log(getPrinter().printNode(ts.EmitHint.Unspecified, node, node.getSourceFile()));
function createTransformer(typeChecker, debug) {
    return (context) => {
        const visit = (node) => {
            printNode(node, debug);
            // Check for property access or call expression
            if (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node)) {
                const leftmostExp = findLeftmostExpression(node);
                const baseType = typeChecker.getTypeAtLocation(leftmostExp);
                if (isAsyncMockType(baseType, typeChecker)) {
                    if (ts.isCallExpression(node)) {
                        console.warn("Call expression");
                        printNode(node, debug);
                        const result = transformCallExpression(node, visit, typeChecker, debug);
                        console.warn("Transformed to");
                        printNode(result, debug);
                        return result;
                    }
                    else {
                        console.warn("Property access");
                        printNode(node, debug);
                        const transformed = transformPropertyAccess(node, visit, debug);
                        if (transformed) {
                            console.warn("Transformed to");
                            printNode(transformed, debug);
                            return transformed;
                        }
                        else {
                            console.warn("No transformation");
                        }
                    }
                }
            }
            // Check for assignment
            if (ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                const leftmostExp = findLeftmostExpression(node.left);
                const baseType = typeChecker.getTypeAtLocation(leftmostExp);
                if (isAsyncMockType(baseType, typeChecker)) {
                    return transformAssignment(node, visit, debug);
                }
            }
            return ts.visitEachChild(node, visit, context);
        };
        return (sourceFile) => ts.visitNode(sourceFile, visit);
    };
}
// Helper functions
function findLeftmostExpression(node) {
    let leftmostExp = node;
    while (ts.isPropertyAccessExpression(leftmostExp) ||
        ts.isCallExpression(leftmostExp)) {
        leftmostExp = leftmostExp.expression;
    }
    return leftmostExp;
}
function transformCallExpression(node, visit, typeChecker, debug) {
    console.log("Call expression");
    printNode(node, debug);
    const visitedExpression = ts.visitNode(node.expression, visit);
    // Transform each argument and await it if it's a property access on an AsyncMock
    const transformedArguments = node.arguments.map(arg => {
        console.log("Argument");
        printNode(arg, debug);
        const visited = ts.visitNode(arg, visit);
        console.log("Visited argument");
        printNode(visited, debug);
        // If the argument is a property access that wasn't transformed (because it was in an argument position),
        // we need to transform it now
        if (ts.isPropertyAccessExpression(arg)) {
            console.log("Property access");
            const leftmostExp = findLeftmostExpression(arg);
            const baseType = typeChecker.getTypeAtLocation(leftmostExp);
            if (isAsyncMockType(baseType, typeChecker)) {
                return transformPropertyAccess(arg, visit, debug) || visited;
            }
        }
        return visited;
    });
    const callExpression = ts.factory.createCallExpression(visitedExpression, node.typeArguments, transformedArguments);
    return ts.factory.createAwaitExpression(ts.factory.createParenthesizedExpression(callExpression));
}
function transformPropertyAccess(node, visit, debug) {
    console.log("Property access");
    const parent = node.parent;
    if (ts.isCallExpression(parent) && parent.expression === node) {
        return undefined;
    }
    const transformedExpression = ts.visitNode(node.expression, visit);
    const propertyAccess = ts.factory.createPropertyAccessExpression(transformedExpression, node.name);
    const functionCall = ts.factory.createCallExpression(propertyAccess, undefined, []);
    return ts.factory.createAwaitExpression(functionCall);
}
function transformAssignment(node, visit, debug) {
    const transformedLeftSide = ts.visitNode(node.left, visit);
    const transformedRightSide = ts.visitNode(node.right, visit);
    const innerLeftSide = transformedLeftSide.expression;
    const methodCall = innerLeftSide
        .expression;
    const newCallExpr = ts.factory.createCallExpression(methodCall, methodCall.typeArguments, [createObjectLiteral(transformedRightSide)]);
    return ts.factory.createAwaitExpression(newCallExpr);
}
function isAsyncMockType(type, typeChecker) {
    if (!type)
        return false;
    // Check for error types
    if (type.flags & ts.TypeFlags.Any || type.flags & ts.TypeFlags.Unknown) {
        return false;
    }
    // Check if it's a Promise<AsyncMock>
    if (type.symbol?.name === "Promise") {
        const typeArguments = type.aliasTypeArguments || type.typeArguments;
        if (typeArguments && typeArguments.length > 0) {
            return isAsyncMockType(typeArguments[0], typeChecker);
        }
    }
    // Direct AsyncMock check
    if (type.symbol?.name === "AsyncMock") {
        return true;
    }
    // Check if it's a call expression type - using proper bitwise comparison
    if ((type.flags & ts.TypeFlags.Object) !== 0) {
        // changed from === true
        const objType = type;
        const callSignatures = objType.getCallSignatures();
        if (callSignatures.length > 0) {
            const returnType = typeChecker.getReturnTypeOfSignature(callSignatures[0]);
            return isAsyncMockType(returnType, typeChecker);
        }
    }
    // Check if it's a property of AsyncMock
    const parentType = type.parent;
    if (parentType?.symbol?.name === "AsyncMock") {
        return true;
    }
    return false;
}
function createProgram(compilerHost) {
    // Create a program to trigger lib loading
    const program = ts.createProgram({
        rootNames: [rootFileName],
        options: {
            types: ["my-runtime-types"],
            target: ts.ScriptTarget.ESNext,
        },
        host: compilerHost,
    });
    return program;
}
async function createTypeChecker(sourceCode, globalObjectNames, debug) {
    const compilerHost = await createInMemoryCompilerHost(sourceCode, globalObjectNames, debug);
    const program = createProgram(compilerHost);
    return program.getTypeChecker();
}
function functionIsAsync(node) {
    return !!node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.AsyncKeyword);
}
function transformContainingFunction(node) {
    return node;
}
function nodeIsFunctionLike(node) {
    return (ts.isArrowFunction(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node));
}
function createObjectLiteral(rightSideExpr) {
    return ts.factory.createObjectLiteralExpression([
        // Create the 'type' property
        ts.factory.createPropertyAssignment(ts.factory.createStringLiteral("type"), ts.factory.createStringLiteral("assignment")),
        // Create the 'value' property with the expression
        ts.factory.createPropertyAssignment(ts.factory.createStringLiteral("value"), rightSideExpr),
    ], true); // true for multiline formatting
}
//# sourceMappingURL=Transpiler.js.map