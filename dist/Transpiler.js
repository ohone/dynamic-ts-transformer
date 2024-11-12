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
async function createTypeChecker(sourceCode, globalObjectNames, debug) {
    const compilerHost = await createInMemoryCompilerHost(sourceCode, globalObjectNames, debug);
    const program = createProgram(compilerHost);
    return program.getTypeChecker();
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
                        printNode(node, debug);
                        return transformCallExpression(node, visit, typeChecker, debug);
                    }
                    else {
                        return transformPropertyAccess(node, visit, debug);
                    }
                }
            }
            // Check for assignment
            if (isAssignmentExpression(node)) {
                const leftmostExp = findLeftmostExpression(node.left);
                const baseType = typeChecker.getTypeAtLocation(leftmostExp);
                if (isAsyncMockType(baseType, typeChecker)) {
                    return transformAssignment(node, visit, debug);
                }
            }
            // Check for equality/non-equality/greater/less/greater-equal/less-equal
            if (isBinaryExpression(node)) {
                const leftmostExp = findLeftmostExpression(node.left);
                const baseType = typeChecker.getTypeAtLocation(leftmostExp);
                if (isAsyncMockType(baseType, typeChecker)) {
                    return transformComparison(node, visit, debug);
                }
            }
            if (nodeIsFunctionLike(node)) {
                return visitFunctionLike(node, visit, typeChecker, context, debug);
            }
            return ts.visitEachChild(node, visit, context);
        };
        return (sourceFile) => ts.visitNode(sourceFile, visit);
    };
}
function visitFunctionLike(node, visit, typeChecker, context, debug) {
    const factory = context.factory;
    // Mark the function as async if not already
    let modifiers = ts.getModifiers(node) || [];
    const hasAsyncModifier = modifiers.some((mod) => mod.kind === ts.SyntaxKind.AsyncKeyword);
    if (!hasAsyncModifier) {
        modifiers = factory.createNodeArray([
            ...modifiers,
            factory.createModifier(ts.SyntaxKind.AsyncKeyword),
        ]);
    }
    const parameters = transformParameters(node, typeChecker, debug);
    // Update the function with new modifiers and body
    if (ts.isFunctionDeclaration(node)) {
        const intermediateDeclaration = factory.updateFunctionDeclaration(node, modifiers, node.asteriskToken, node.name, node.typeParameters, parameters, node.type, node.body);
        const newBody = transformFunctionBody(intermediateDeclaration, visit, typeChecker, context, debug);
        return factory.updateFunctionDeclaration(node, modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, newBody);
    }
    else if (ts.isFunctionExpression(node)) {
        const intermediateExpression = factory.updateFunctionExpression(node, modifiers, node.asteriskToken, node.name, node.typeParameters, parameters, node.type, node.body);
        const newBody = transformFunctionBody(intermediateExpression, visit, typeChecker, context, debug);
        if (!newBody) {
            return node;
        }
        return factory.updateFunctionExpression(node, modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, newBody);
    }
    else if (ts.isArrowFunction(node)) {
        const intermediateExpression = factory.updateArrowFunction(node, modifiers, node.typeParameters, parameters, node.type, node.equalsGreaterThanToken, node.body);
        const newBody = transformFunctionBody(intermediateExpression, visit, typeChecker, context, debug);
        if (!newBody) {
            return node;
        }
        return factory.updateArrowFunction(node, modifiers, node.typeParameters, node.parameters, node.type, node.equalsGreaterThanToken, newBody);
    }
    else if (ts.isMethodDeclaration(node)) {
        const intermediateExpression = factory.updateMethodDeclaration(node, modifiers, node.asteriskToken, node.name, node.questionToken, node.typeParameters, parameters, node.type, node.body);
        const newBody = transformFunctionBody(intermediateExpression, visit, typeChecker, context, debug);
        if (!newBody) {
            return node;
        }
        return factory.updateMethodDeclaration(node, modifiers, node.asteriskToken, node.name, node.questionToken, node.typeParameters, node.parameters, node.type, newBody);
    }
    else {
        // Other function-like declarations can be added here
        return node;
    }
}
function transformNode(parentNode, visit, typeChecker, context, debug) {
    console.log("Transforming node");
    printNode(parentNode, debug);
    // Recursively visit nodes within the function body
    return ts.visitEachChild(parentNode, (node) => {
        // Check for property access expressions
        // Check for call expressions
        if (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node)) {
            const leftmostExp = findLeftmostExpression(node.expression);
            const baseType = typeChecker.getTypeAtLocation(leftmostExp);
            if (isAsyncMockType(baseType, typeChecker)) {
                if (ts.isCallExpression(node)) {
                    return transformCallExpression(node, visit, typeChecker, debug);
                }
                else {
                    return transformPropertyAccess(node, visit, debug);
                }
            }
            if (couldBeAsyncMockType(baseType, typeChecker)) {
                if (ts.isCallExpression(node)) {
                    return transformCallExpressionWithRuntimeCheck(node, visit, typeChecker, debug);
                }
                else {
                    return transformPropertyAccessWithRuntimeCheck(node, visit, debug);
                }
            }
        }
        // Check for assignments
        if (isAssignmentExpression(node)) {
            const leftmostExp = findLeftmostExpression(node.left);
            const baseType = typeChecker.getTypeAtLocation(leftmostExp);
            if (isAsyncMockType(baseType, typeChecker)) {
                return transformAssignment(node, visit, debug);
            }
            if (couldBeAsyncMockType(baseType, typeChecker)) {
                return transformAssignmentWithRuntimeCheck(node, visit, debug);
            }
        }
        if (isBinaryExpression(node)) {
            const leftmostExp = findLeftmostExpression(node.left);
            const baseType = typeChecker.getTypeAtLocation(leftmostExp);
            if (isAsyncMockType(baseType, typeChecker) || couldBeAsyncMockType(baseType, typeChecker)) {
                return transformComparison(node, visit, debug);
            }
        }
        if (nodeIsFunctionLike(node)) {
            return visitFunctionLike(node, visit, typeChecker, context, debug);
        }
        // Continue visiting other nodes
        return transformNode(node, visit, typeChecker, context, debug);
    }, undefined);
}
// type checking functions
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
function couldBeAsyncMockType(type, typeChecker) {
    if (!type)
        return false;
    // If the type is 'any' or 'unknown', it could be an AsyncMock
    if (type.flags & ts.TypeFlags.Any || type.flags & ts.TypeFlags.Unknown) {
        return true;
    }
    // If the type is a union, check if any constituent type is AsyncMock
    if (type.isUnion()) {
        return type.types.some((t) => isAsyncMockType(t, typeChecker) || couldBeAsyncMockType(t, typeChecker));
    }
    return false;
}
function isAssignmentExpression(node) {
    return (ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken);
}
function isBinaryExpression(node) {
    return (ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
            node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken ||
            node.operatorToken.kind === ts.SyntaxKind.GreaterThanToken ||
            node.operatorToken.kind === ts.SyntaxKind.LessThanToken ||
            node.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken ||
            node.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken));
}
function nodeIsFunctionLike(node) {
    return (ts.isArrowFunction(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node));
}
// transformation functions
function transformArgument(arg, visit, typeChecker, debug) {
    // Recursively transform the argument
    return ts.visitNode(arg, (node) => {
        if (ts.isPropertyAccessExpression(node)) {
            const leftmostExp = findLeftmostExpression(node);
            const baseType = typeChecker.getTypeAtLocation(leftmostExp);
            if (isAsyncMockType(baseType, typeChecker)) {
                return transformPropertyAccess(node, visit, debug);
            }
            if (couldBeAsyncMockType(baseType, typeChecker)) {
                return transformPropertyAccessWithRuntimeCheck(node, visit, debug);
            }
        }
        else if (ts.isCallExpression(node)) {
            const leftmostExp = findLeftmostExpression(node.expression);
            const baseType = typeChecker.getTypeAtLocation(leftmostExp);
            if (isAsyncMockType(baseType, typeChecker)) {
                return transformCallExpression(node, visit, typeChecker, debug);
            }
            if (couldBeAsyncMockType(baseType, typeChecker)) {
                return transformCallExpressionWithRuntimeCheck(node, visit, typeChecker, debug);
            }
        }
        return ts.visitEachChild(node, (child) => transformArgument(child, visit, typeChecker, debug), undefined);
    });
}
function transformCallExpressionWithRuntimeCheck(node, visit, typeChecker, debug) {
    console.log("Call expression");
    printNode(node, debug);
    const factory = ts.factory;
    // Transform the callee expression
    const transformedExpression = ts.visitNode(node.expression, visit);
    // Transform each argument, handling AsyncMock parameters
    const transformedArguments = node.arguments.map((arg) => {
        return transformArgument(arg, visit, typeChecker, debug);
    });
    const callExpression = factory.createCallExpression(transformedExpression, undefined, transformedArguments);
    // Create the AsyncMock path: await a.method(...transformedArguments)
    const asyncCall = factory.createAwaitExpression(callExpression);
    // Create the regular path: a.method(...transformedArguments)
    const regularCall = factory.createCallExpression(transformedExpression, undefined, transformedArguments);
    // Create the runtime check: a.isProxy ? await a.method(...args) : a.method(...args)
    const leftmostExp = findLeftmostExpression(node.expression);
    const condition = factory.createPropertyAccessExpression(leftmostExp, "isProxy");
    return factory.createParenthesizedExpression(factory.createConditionalExpression(condition, undefined, asyncCall, undefined, regularCall));
}
function createMaybeProxyTypeLiteral(factory) {
    return factory.createUnionTypeNode([
        // Reference to AsyncMock type
        factory.createTypeReferenceNode(factory.createIdentifier("AsyncMock"), undefined),
        // Any type
        factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
    ]);
}
function transformParameters(node, typeChecker, debug) {
    const factory = ts.factory;
    const parameters = [...node.parameters];
    const transformedParameters = parameters.map((param) => {
        const paramType = typeChecker.getTypeAtLocation(param);
        if (couldBeAsyncMockType(paramType, typeChecker)) {
            return factory.updateParameterDeclaration(param, undefined, undefined, param.name, param.questionToken, createMaybeProxyTypeLiteral(factory), param.initializer);
        }
        return param;
    });
    return transformedParameters;
}
function transformAssignmentWithRuntimeCheck(node, visit, debug) {
    const factory = ts.factory;
    // Transform the left and right sides
    const transformedLeftSide = ts.visitNode(node.left, visit);
    const transformedRightSide = ts.visitNode(node.right, visit);
    // For AsyncMock: await a.prop(value)
    const asyncCall = factory.createAwaitExpression(factory.createCallExpression(transformedLeftSide, undefined, [
        transformedRightSide,
    ]));
    // For regular object: a.prop = value
    const regularAssignment = factory.createBinaryExpression(transformedLeftSide, ts.SyntaxKind.EqualsToken, transformedRightSide);
    // Create the runtime check: a.isProxy ? await a.prop(value) : a.prop = value
    const leftmostExp = findLeftmostExpression(node.left);
    const condition = factory.createPropertyAccessExpression(leftmostExp, "isProxy");
    return factory.createParenthesizedExpression(factory.createConditionalExpression(condition, undefined, asyncCall, undefined, regularAssignment));
}
function transformPropertyAccessWithRuntimeCheck(node, visit, debug) {
    console.log("Property access");
    printNode(node, debug);
    const factory = ts.factory;
    // Transform the expression part (e.g., 'b' in 'b.parent')
    const transformedExpression = ts.visitNode(node.expression, visit);
    const propertyName = node.name;
    // Create the AsyncMock path: await b.parent()
    const asyncCall = factory.createAwaitExpression(factory.createCallExpression(factory.createPropertyAccessExpression(transformedExpression, propertyName), undefined, []));
    // Create the regular path: b.parent
    const regularAccess = factory.createPropertyAccessExpression(transformedExpression, propertyName);
    // Create the runtime check: b.isProxy ? await b.parent() : b.parent
    const condition = factory.createPropertyAccessExpression(transformedExpression, "isProxy");
    return factory.createParenthesizedExpression(factory.createConditionalExpression(condition, undefined, asyncCall, undefined, regularAccess));
}
function transformFunctionBody(funcNode, visit, typeChecker, context, debug) {
    const factory = context.factory;
    if (!funcNode.body) {
        return funcNode.body;
    }
    // Normalize the body to a block
    let functionBody;
    if (ts.isBlock(funcNode.body)) {
        functionBody = funcNode.body;
    }
    else {
        functionBody = factory.createBlock([factory.createReturnStatement(funcNode.body)], true);
    }
    // Transform the function body
    const newStatements = functionBody.statements.map((statement) => transformNode(statement, visit, typeChecker, context, debug));
    return factory.createBlock(newStatements, true);
}
function transformCallExpression(node, visit, typeChecker, debug) {
    console.warn("visiting call expression");
    printNode(node, debug);
    const visitedExpression = ts.visitNode(node.expression, visit);
    // Transform each argument and await it if it's a property access on an AsyncMock
    const transformedArguments = node.arguments.map((arg) => {
        const visited = ts.visitNode(arg, visit);
        // If the argument is a property access that wasn't transformed (because it was in an argument position),
        // we need to transform it now
        if (ts.isPropertyAccessExpression(arg)) {
            const leftmostExp = findLeftmostExpression(arg);
            const baseType = typeChecker.getTypeAtLocation(leftmostExp);
            if (isAsyncMockType(baseType, typeChecker)) {
                return transformPropertyAccess(arg, visit, debug) || visited;
            }
        }
        return visited;
    });
    const callExpression = ts.factory.createCallExpression(visitedExpression, node.typeArguments, transformedArguments);
    return ts.factory.createAwaitExpression(callExpression);
}
function transformPropertyAccess(node, visit, debug) {
    console.warn("visiting property access");
    printNode(node, debug);
    const parent = node.parent;
    if (ts.isCallExpression(parent) && parent.expression === node) {
        const result = ts.visitEachChild(node, visit, undefined);
        console.warn("skipping transformation, parent is call expression");
        printNode(parent, debug);
        console.warn("visited expression");
        printNode(node.expression, debug);
        console.warn("returning result");
        printNode(result, debug);
        return result;
    }
    const transformedExpression = ts.visitNode(node.expression, visit);
    console.warn("transformed expression");
    printNode(transformedExpression, debug);
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
    const newCallExpr = ts.factory.createCallExpression(methodCall, methodCall.typeArguments, [
        createObjectLiteral(transformedRightSide, [
            { type: "type", value: "assignment" },
        ]),
    ]);
    return ts.factory.createAwaitExpression(newCallExpr);
}
function transformComparison(node, visit, debug) {
    const transformedLeftSide = ts.visitNode(node.left, visit);
    const transformedRightSide = ts.visitNode(node.right, visit);
    // TODO: handle when one is a proxy and the other is not
    if (transformedLeftSide === node.left && transformedRightSide === node.right) {
        return node;
    }
    const innerLeftSide = transformedLeftSide.expression;
    try {
        const methodCall = innerLeftSide
            .expression;
        const newCallExpr = ts.factory.createCallExpression(methodCall, methodCall.typeArguments, [
            createObjectLiteral(transformedRightSide, [
                { type: "type", value: "comparison" },
                { type: "operator", value: node.operatorToken.kind.toString() },
            ]),
        ]);
        return ts.factory.createAwaitExpression(newCallExpr);
    }
    catch (e) {
        throw e;
    }
}
function findLeftmostExpression(node) {
    let leftmostExp = node;
    while (ts.isPropertyAccessExpression(leftmostExp) ||
        ts.isCallExpression(leftmostExp)) {
        leftmostExp = leftmostExp.expression;
    }
    return leftmostExp;
}
function createObjectLiteral(rightSideExpr, extraProps) {
    return ts.factory.createObjectLiteralExpression([
        ...extraProps.map((prop) => ts.factory.createPropertyAssignment(ts.factory.createStringLiteral(prop.type), ts.factory.createStringLiteral(prop.value))),
        // Create the 'value' property with the expression
        ts.factory.createPropertyAssignment(ts.factory.createStringLiteral("value"), rightSideExpr),
    ], true); // true for multiline formatting
}
//# sourceMappingURL=Transpiler.js.map