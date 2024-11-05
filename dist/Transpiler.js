import ts from "typescript";
import { getTypeDefinitions } from "./type-definitions.js";
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
    const sourceFile = ts.createSourceFile("input.ts", sourceCode, ts.ScriptTarget.Latest, true);
    return {
        getSourceFile: (fileName, languageVersion) => {
            if (fileName === "input.ts") {
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
            if (fileName === "input.ts") {
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
            if (fileName === "input.ts") {
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
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const printNode = (node, debug) => debug &&
    console.log(printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile()));
function createTransformer(typeChecker, debug) {
    return (context) => {
        const visit = (node) => {
            printNode(node, debug);
            // Handle property access and call expressions
            if (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node)) {
                let leftmostExp = node;
                while (ts.isPropertyAccessExpression(leftmostExp.expression) ||
                    ts.isCallExpression(leftmostExp.expression)) {
                    leftmostExp = leftmostExp.expression;
                }
                const baseType = typeChecker.getTypeAtLocation(leftmostExp.expression);
                if (isAsyncMockType(baseType)) {
                    if (ts.isCallExpression(node)) {
                        const visitedExpression = ts.visitNode(node.expression, visit);
                        printNode(visitedExpression, debug);
                        const callExpression = ts.factory.createCallExpression(visitedExpression, node.typeArguments, node.arguments);
                        printNode(callExpression, debug);
                        const parenthesizedExpression = ts.factory.createParenthesizedExpression(callExpression);
                        printNode(parenthesizedExpression, debug);
                        const result = ts.factory.createAwaitExpression(parenthesizedExpression);
                        printNode(result, debug);
                        return result;
                    }
                    else {
                        // Only transform property access if we're accessing a property of an AsyncMock result
                        const parent = node.parent;
                        if (!ts.isCallExpression(parent)) {
                            // If this property isn't being called directly, transform it to a call
                            const transformedExpression = ts.visitNode(node.expression, visit);
                            printNode(transformedExpression, debug);
                            const propertyAccess = ts.factory.createPropertyAccessExpression(transformedExpression, node.name);
                            printNode(propertyAccess, debug);
                            const functionCall = ts.factory.createCallExpression(propertyAccess, undefined, []);
                            printNode(functionCall, debug);
                            const awaitExp = ts.factory.createAwaitExpression(functionCall
                            //ts.factory.createParenthesizedExpression(functionCall)
                            );
                            printNode(awaitExp, debug);
                            return awaitExp;
                        }
                    }
                }
            }
            // Handle variable declarations
            if (ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                console.log("Binary expression");
                let leftmostExp = node.left;
                while (ts.isPropertyAccessExpression(leftmostExp) ||
                    ts.isCallExpression(leftmostExp)) {
                    leftmostExp = leftmostExp.expression;
                }
                const baseType = typeChecker.getTypeAtLocation(leftmostExp);
                if (isAsyncMockType(baseType)) {
                    const transformedLeftSide = ts.visitNode(node.left, visit);
                    const transformedRightSide = ts.visitNode(node.right, visit);
                    console.log("Transformed left side");
                    printNode(transformedLeftSide, debug);
                    console.log("Transformed right side");
                    printNode(transformedRightSide, debug);
                    const innerLeftSide = transformedLeftSide
                        .expression;
                    console.log("Inner left side");
                    printNode(innerLeftSide, debug);
                    const methodCall = innerLeftSide
                        .expression;
                    console.log("Method call");
                    printNode(methodCall, debug);
                    const newCallExpr = ts.factory.createCallExpression(methodCall, methodCall.typeArguments, [createObjectLiteral(transformedRightSide)]);
                    console.log("New call expression");
                    printNode(newCallExpr, debug);
                    const result = ts.factory.createAwaitExpression(newCallExpr);
                    printNode(result, debug);
                    return result;
                }
            }
            return ts.visitEachChild(node, visit, context);
        };
        function isAsyncMockType(type) {
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
                    return isAsyncMockType(typeArguments[0]);
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
                    return isAsyncMockType(returnType);
                }
            }
            // Check if it's a property of AsyncMock
            const parentType = type.parent;
            if (parentType?.symbol?.name === "AsyncMock") {
                return true;
            }
            return false;
        }
        return (sourceFile) => ts.visitNode(sourceFile, visit);
    };
}
function createProgram(compilerHost) {
    // Create a program to trigger lib loading
    const program = ts.createProgram({
        rootNames: ["input.ts"],
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
function createObjectLiteral(rightSideExpr) {
    return ts.factory.createObjectLiteralExpression([
        // Create the 'type' property
        ts.factory.createPropertyAssignment(ts.factory.createStringLiteral('type'), ts.factory.createStringLiteral('assignment')),
        // Create the 'value' property with the expression
        ts.factory.createPropertyAssignment(ts.factory.createStringLiteral('value'), rightSideExpr)
    ], true); // true for multiline formatting
}
//# sourceMappingURL=Transpiler.js.map