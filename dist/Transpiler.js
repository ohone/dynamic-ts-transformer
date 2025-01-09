import { createTypeChecker } from "./TypeChecker.js";
import * as ts from "typescript";
export async function originalTranspileTypescript(codeString, sourceUrl, globalProxyNames = [], globalNonProxyNames = [], debug = false, sourceMap = true) {
    const typeChecker = await createTypeChecker(codeString, globalProxyNames, [...globalNonProxyNames, "JSON"], debug);
    const { outputText } = ts.transpileModule(`//\n//\n` + codeString, {
        compilerOptions: {
            module: ts.ModuleKind.ES2022,
            target: ts.ScriptTarget.ES2023,
            inlineSourceMap: sourceMap,
            inlineSources: sourceMap,
            sourceMap: sourceMap,
            removeComments: false,
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
function getRootExpression(node) {
    // Keep unwrapping until we find the leftmost expression
    if (ts.isCallExpression(node) ||
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) {
        while (ts.isCallExpression(node) ||
            ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node)) {
            node = node.expression;
        }
        return node;
    }
    if (ts.isBinaryExpression(node)) {
        return getRootExpression(node.left);
    }
    return node;
}
function createTransformer(typeChecker, debug) {
    return (context) => {
        const { factory } = context;
        function visitNode(node, onFunctionVisited) {
            if (ts.isExpression(node)) {
                const newExpression = visitExpression(node, factory, (node) => visitNode(node, onFunctionVisited), typeChecker, onFunctionVisited, context);
                if (newExpression !== node) {
                    return newExpression;
                }
            }
            // Handle Variable Declarations (e.g. const a = myProxy.foo.bar;)
            if (ts.isVariableDeclaration(node) && node.initializer) {
                const newInit = visitExpression(node.initializer, factory, (node) => visitNode(node, onFunctionVisited), typeChecker, onFunctionVisited, context);
                if (newInit !== node.initializer) {
                    return factory.updateVariableDeclaration(node, node.name, node.exclamationToken, node.type, newInit);
                }
            }
            // Handle for-of loops
            if (ts.isForOfStatement(node)) {
                // Check if the expression is async mock
                if (isAsyncMock(typeChecker, node.expression)) {
                    // If we can rely on `for await` loops:
                    // Convert `for (const x of myProxy)` to `for await (const x of myProxy)`
                    // This requires changing the for-of flags.
                    return factory.updateForOfStatement(node, node.awaitModifier ||
                        factory.createToken(ts.SyntaxKind.AwaitKeyword), node.initializer, node.expression, node.statement);
                    // If not possible, you might rewrite the loop entirely:
                    // const temp = await myProxy;
                    // for (const item of temp) {...}
                    // In that case you'd need to introduce a new variable declaration before the loop
                    // and replace the loop expression with that variable.
                }
            }
            // Make functions async if transformed
            if (ts.isFunctionDeclaration(node)) {
                if (!functionAlreadyAsync(node)) {
                    const newBody = node.body
                        ? visitNode(node.body, onFunctionVisited)
                        : undefined;
                    if (newBody !== node.body) {
                        const newModifiers = node.modifiers
                            ? [
                                ...node.modifiers,
                                factory.createModifier(ts.SyntaxKind.AsyncKeyword),
                            ]
                            : [factory.createModifier(ts.SyntaxKind.AsyncKeyword)];
                        const newFunction = factory.updateFunctionDeclaration(node, newModifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, newBody);
                        onFunctionVisited(newFunction);
                        return newFunction;
                    }
                    return node;
                }
            }
            // Make functions async if transformed
            if (ts.isArrowFunction(node)) {
                if (!functionAlreadyAsync(node)) {
                    const newBody = visitNode(node.body, onFunctionVisited);
                    if (newBody !== node.body) {
                        const newModifiers = node.modifiers
                            ? [
                                ...node.modifiers,
                                factory.createModifier(ts.SyntaxKind.AsyncKeyword),
                            ]
                            : [factory.createModifier(ts.SyntaxKind.AsyncKeyword)];
                        const newFunction = factory.updateArrowFunction(node, newModifiers, node.typeParameters, node.parameters, node.type, node.equalsGreaterThanToken, newBody);
                        onFunctionVisited(newFunction);
                        return newFunction;
                    }
                    return node;
                }
            }
            // Make functions async if transformed
            if (ts.isFunctionExpression(node)) {
                if (!functionAlreadyAsync(node)) {
                    const newBody = visitNode(node.body, onFunctionVisited);
                    if (newBody !== node.body) {
                        const newModifiers = node.modifiers
                            ? [
                                ...node.modifiers,
                                factory.createModifier(ts.SyntaxKind.AsyncKeyword),
                            ]
                            : [factory.createModifier(ts.SyntaxKind.AsyncKeyword)];
                        const newFunction = factory.updateFunctionExpression(node, newModifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, newBody);
                        onFunctionVisited(newFunction);
                        return newFunction;
                    }
                    return node;
                }
            }
            return ts.visitEachChild(node, (ctx) => visitNode(ctx, onFunctionVisited), context);
        }
        /**
         * Recursively transforms expressions if they involve `AsyncMock` proxy accesses.
         *
         * Cases:
         * - Property access: myProxy.foo → await myProxy.foo
         * - Chained property access: myProxy.foo.bar → await (await myProxy.foo).bar
         * - Calls: myProxy.foo() → await (await myProxy.foo)()
         * - Chained calls: myProxy.x.y()(z) → await ((await (await (await myProxy.x).y)())(z))
         */
        return (sourceFile) => {
            const visitedFunctions = [];
            const onFunctionVisited = (node) => {
                visitedFunctions.push(node);
            };
            return ts.visitNode(sourceFile, (node) => visitNode(node, onFunctionVisited));
        };
    };
}
function visitAsyncMockExpression(node, factory, visitNode, typeChecker, onFunctionVisited, context) {
    if (ts.isCallExpression(node)) {
        return transformCallExpression(node, factory, visitNode, typeChecker, onFunctionVisited, (exp) => visitAsyncMockExpression(exp, factory, visitNode, typeChecker, onFunctionVisited, context), context);
    }
    if (ts.isElementAccessExpression(node)) {
        return transformElementAccessExpression(node, factory, (exp) => visitAsyncMockExpression(exp, factory, visitNode, typeChecker, onFunctionVisited, context), visitNode, typeChecker, onFunctionVisited, context);
    }
    if (ts.isPropertyAccessExpression(node)) {
        return transformPropertyAccessExpression(node, factory, (exp) => visitAsyncMockExpression(exp, factory, visitNode, typeChecker, onFunctionVisited, context));
    }
    if (ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isPropertyAccessExpression(node.left) ||
            ts.isElementAccessExpression(node.left))) {
        const left = node.left;
        const right = node.right;
        // Check if the left-hand side is accessing an AsyncMock
        // The final property name:
        const propertyName = ts.isPropertyAccessExpression(node.left)
            ? node.left.name.text
            : node.left.argumentExpression.getText();
        // Transform the right-hand side in case it involves proxies:
        const transformedRight = visitAsyncMockExpression(right, factory, visitNode, typeChecker, onFunctionVisited, context);
        // Now we must get the object on which to call setProp.
        // For `myProxy.foo.bar = value`, `parentExpr` = `myProxy.foo`.
        const parentExpr = left.expression;
        // Transform that parent to be fully awaited:
        // For `myProxy.foo.bar`, transform `myProxy.foo` into `await myProxy.foo`.
        const transformedParent = visitAsyncMockExpression(parentExpr, factory, visitNode, typeChecker, onFunctionVisited, context);
        // Now we create: await (transformedParent.setProp("propertyName", transformedRight))
        const setPropCall = factory.createCallExpression(factory.createPropertyAccessExpression(transformedParent, factory.createIdentifier("__setProp")), undefined, [factory.createStringLiteral(propertyName), transformedRight]);
        return factory.createAwaitExpression(setPropCall);
    }
    return ts.visitEachChild(node, visitNode, context);
}
function visitUnknownAsyncMockExpression(node, factory, visitNode, visitExpression, typeChecker, onFunctionVisited, context, bindExpression = false) {
    if (ts.isCallExpression(node)) {
        const transformedArgs = node.arguments.map((arg) => visitExpression(arg));
        if (ts.isIdentifier(node.expression)) {
            return factory.createParenthesizedExpression(factory.createAwaitExpression(factory.updateCallExpression(node, node.expression, node.typeArguments, transformedArgs)));
        }
        const transformedCallee = visitUnknownAsyncMockExpression(node.expression, factory, visitNode, visitExpression, typeChecker, onFunctionVisited, context, true // bind expression result, we know it's a function
        );
        // If transformed callee is different, it means we have something like (await ...).
        // For calling a remote function: myProxy.foo() → await (await myProxy.foo)()
        // If we ended up with an awaited property access, that gives us the function. We must now
        // await the call as well.
        //
        // So: call = transformedCallee(...expr.arguments)
        // Actually, we must wrap the call: await (transformedCallee(...))
        const nonProxyCall = factory.updateCallExpression(node, transformedCallee, node.typeArguments, transformedArgs);
        const proxyCall = factory.createCallExpression(ts.factory.createParenthesizedExpression(factory.createAwaitExpression(transformedCallee)), node.typeArguments, transformedArgs);
        const ternary = createProxyTernary(transformedCallee, proxyCall, nonProxyCall, factory);
        return ternary;
    }
    if (ts.isPropertyAccessExpression(node)) {
        const transformedLeft = visitUnknownAsyncMockExpression(node.expression, factory, visitNode, visitExpression, typeChecker, onFunctionVisited, context);
        const propertyAccessExpression = factory.createPropertyAccessExpression(transformedLeft, node.name.text);
        if (!bindExpression) {
            return factory.createParenthesizedExpression(factory.createAwaitExpression(propertyAccessExpression));
        }
        const awaitedPropertyAccessExpression = factory.createParenthesizedExpression(factory.createAwaitExpression(propertyAccessExpression));
        const ternary = createProxyTernary(awaitedPropertyAccessExpression, awaitedPropertyAccessExpression, factory.createCallExpression(factory.createPropertyAccessExpression(propertyAccessExpression, "bind"), undefined, [transformedLeft]), factory);
        return ternary;
    }
    if (ts.isElementAccessExpression(node)) {
        return factory.createAwaitExpression(node);
    }
    if (ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isPropertyAccessExpression(node.left) ||
            ts.isElementAccessExpression(node.left))) {
        const left = node.left;
        const right = node.right;
        // Transform the right-hand side in case it involves proxies:
        const transformedRight = visitUnknownAsyncMockExpression(right, factory, visitNode, visitExpression, typeChecker, onFunctionVisited, context);
        // Now we must get the object on which to call setProp.
        // For `myProxy.foo.bar = value`, `parentExpr` = `myProxy.foo`.
        const parentExpr = left.expression;
        // Transform that parent to be fully awaited:
        // For `myProxy.foo.bar`, transform `myProxy.foo` into `await myProxy.foo`.
        const transformedParent = visitUnknownAsyncMockExpression(parentExpr, factory, visitNode, visitExpression, typeChecker, onFunctionVisited, context);
        let setPropCall = undefined;
        // The final property name:
        if (ts.isPropertyAccessExpression(node.left)) {
            const propertyName = node.left.name.text;
            setPropCall = factory.createCallExpression(factory.createPropertyAccessExpression(transformedParent, factory.createIdentifier("__setProp")), undefined, [factory.createStringLiteral(propertyName), transformedRight]);
        }
        else {
            const propertyName = node.left.argumentExpression;
            setPropCall = factory.createCallExpression(factory.createPropertyAccessExpression(transformedParent, factory.createIdentifier("__setProp")), undefined, [propertyName, transformedRight]);
        }
        return createProxyTernary(transformedParent, setPropCall, factory.createBinaryExpression(left, node.operatorToken, transformedRight), factory);
    }
    // check if its a comparison expression
    if (ts.isBinaryExpression(node) && node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
        return transformComparisonExpression(node, factory, visitExpression);
    }
    if (ts.isArrowFunction(node)) {
        const hasAsync = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
        const newModifiers = !hasAsync
            ? node.modifiers
                ? [
                    ...node.modifiers,
                    factory.createModifier(ts.SyntaxKind.AsyncKeyword),
                ]
                : [factory.createModifier(ts.SyntaxKind.AsyncKeyword)]
            : node.modifiers;
        if (ts.isBlock(node.body)) {
            const transformedStatements = node.body.statements.map((stmt) => visitNode(stmt));
            const newBlock = ts.factory.createBlock(transformedStatements, true);
            return factory.updateArrowFunction(node, newModifiers, node.typeParameters, node.parameters, node.type, node.equalsGreaterThanToken, newBlock);
        }
        else {
            const updatedBody = visitNode(node.body);
            return factory.updateArrowFunction(node, newModifiers, node.typeParameters, node.parameters, node.type, node.equalsGreaterThanToken, updatedBody);
        }
    }
    return node;
}
function visitExpression(node, factory, visitNode, typeChecker, onFunctionVisited, context) {
    const asyncMockStatus = getAsyncMockStatus(typeChecker, node);
    if (asyncMockStatus === AsyncMockStatus.AsyncMock) {
        return visitAsyncMockExpression(node, factory, visitNode, typeChecker, onFunctionVisited, context);
    }
    if (asyncMockStatus === AsyncMockStatus.NonAsyncMock) {
        return node;
    }
    return visitUnknownAsyncMockExpression(node, factory, visitNode, (node) => visitExpression(node, factory, visitNode, typeChecker, onFunctionVisited, context), typeChecker, onFunctionVisited, context);
}
function transformCallExpression(node, factory, visitNode, typeChecker, onFunctionVisited, visitChildren, context) {
    const transformedCallee = visitChildren(node.expression);
    const wrappedCallee = ts.factory.createParenthesizedExpression(transformedCallee);
    const transformedArgs = node.arguments.map((arg) => visitExpression(arg, factory, visitNode, typeChecker, onFunctionVisited, context));
    return factory.createAwaitExpression(factory.createCallExpression(ts.factory.createParenthesizedExpression(ts.factory.createAwaitExpression(wrappedCallee)), node.typeArguments, transformedArgs));
}
function transformPropertyAccessExpression(node, factory, visitChildren) {
    const transformedExpression = visitChildren(node.expression);
    return factory.createAwaitExpression(factory.createPropertyAccessExpression(transformedExpression, node.name.text));
}
function transformElementAccessExpression(node, factory, visitChildren, visitNode, typeChecker, onFunctionVisited, context) {
    const transformedExpression = visitChildren(node.expression);
    const transformedArgument = visitExpression(node.argumentExpression, factory, visitNode, typeChecker, onFunctionVisited, context);
    return factory.createAwaitExpression(factory.createElementAccessExpression(transformedExpression, transformedArgument));
}
function createCompareCall(factory, target, value, operatorKind) {
    return factory.createAwaitExpression(factory.createCallExpression(factory.createPropertyAccessExpression(target, "__compare"), undefined, [
        factory.createObjectLiteralExpression([
            factory.createPropertyAssignment("value", value),
            // Here is where we also store the numeric operatorKind
            factory.createPropertyAssignment("operatorKind", factory.createNumericLiteral(operatorKind)),
        ]),
    ]));
}
function transformComparisonExpression(node, factory, visitExpression) {
    const kind = node.operatorToken.kind;
    const flippedOperator = flipOperator(kind);
    const transformedLeft = visitExpression(node.left);
    const leftIsProxy = createProxyCheck(transformedLeft);
    const transformedRight = visitExpression(node.right);
    const rightIsProxy = createProxyCheck(transformedRight);
    // Left side compare: uses the unflipped operator
    const leftCompareCall = createCompareCall(factory, transformedLeft, transformedRight, kind);
    // Right side compare: flips the operator if needed
    const rightCompareCall = createCompareCall(factory, transformedRight, transformedLeft, flippedOperator);
    // If neither is proxy, remain as a raw binary
    const originalBinary = factory.createBinaryExpression(transformedLeft, node.operatorToken, transformedRight);
    return factory.createParenthesizedExpression(factory.createConditionalExpression(leftIsProxy, factory.createToken(ts.SyntaxKind.QuestionToken), leftCompareCall, factory.createToken(ts.SyntaxKind.ColonToken), factory.createConditionalExpression(rightIsProxy, factory.createToken(ts.SyntaxKind.QuestionToken), rightCompareCall, factory.createToken(ts.SyntaxKind.ColonToken), originalBinary)));
}
var AsyncMockStatus;
(function (AsyncMockStatus) {
    AsyncMockStatus[AsyncMockStatus["AsyncMock"] = 0] = "AsyncMock";
    AsyncMockStatus[AsyncMockStatus["NonAsyncMock"] = 1] = "NonAsyncMock";
    AsyncMockStatus[AsyncMockStatus["Unknown"] = 2] = "Unknown";
})(AsyncMockStatus || (AsyncMockStatus = {}));
export function flipOperator(kind) {
    switch (kind) {
        case ts.SyntaxKind.GreaterThanToken:
            // x > a => a <= x
            return ts.SyntaxKind.LessThanToken;
        case ts.SyntaxKind.GreaterThanEqualsToken:
            // x >= a => a < x
            return ts.SyntaxKind.LessThanEqualsToken;
        case ts.SyntaxKind.LessThanToken:
            // x < a => a >= x
            return ts.SyntaxKind.GreaterThanToken;
        case ts.SyntaxKind.LessThanEqualsToken:
            // x <= a => a > x
            return ts.SyntaxKind.GreaterThanEqualsToken;
        // Equality and inequality operators are symmetric (flipping them doesn't change the meaning):
        case ts.SyntaxKind.EqualsEqualsEqualsToken:
            return ts.SyntaxKind.EqualsEqualsEqualsToken;
        case ts.SyntaxKind.EqualsEqualsToken:
            return ts.SyntaxKind.EqualsEqualsToken;
        case ts.SyntaxKind.ExclamationEqualsEqualsToken:
            return ts.SyntaxKind.ExclamationEqualsEqualsToken;
        case ts.SyntaxKind.ExclamationEqualsToken:
            return ts.SyntaxKind.ExclamationEqualsToken;
        // If we get something else, just return it unchanged.
        default:
            return kind;
    }
}
function getAsyncMockStatus(typeChecker, node) {
    const leftMost = getRootExpression(node);
    const nodeType = typeChecker.getTypeAtLocation(leftMost);
    const isAsyncMock = typeIsOrExtendsAsyncMock(nodeType);
    if (isAsyncMock) {
        return AsyncMockStatus.AsyncMock;
    }
    const isNonProxy = typeIsOrExtendsNonProxy(nodeType);
    if (isNonProxy) {
        return AsyncMockStatus.NonAsyncMock;
    }
    else {
        return AsyncMockStatus.Unknown;
    }
}
function functionAlreadyAsync(node) {
    return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}
function typeIsOrExtendsAsyncMock(type) {
    // If we gave `AsyncMock` a unique brand:
    // Check for presence of __isAsyncMock property
    const props = type.getProperties();
    return props.some((sym) => sym.getName() === "__isAsyncMock");
}
function typeIsOrExtendsNonProxy(type) {
    const props = type.getProperties();
    return props.some((sym) => sym.getName() === "__notAsyncMock");
}
function createProxyTernary(maybeProxyExpression, proxyCall, nonProxyCall, factory) {
    const isProxyCheck = createProxyCheck(maybeProxyExpression);
    const ternary = factory.createConditionalExpression(isProxyCheck, ts.factory.createToken(ts.SyntaxKind.QuestionToken), proxyCall, ts.factory.createToken(ts.SyntaxKind.ColonToken), nonProxyCall);
    const awaitExpression = factory.createAwaitExpression(ternary);
    const parenthesizedAwaitExpression = factory.createParenthesizedExpression(awaitExpression);
    return parenthesizedAwaitExpression;
}
function createProxyCheck(expr) {
    return ts.factory.createPropertyAccessChain(expr, ts.factory.createToken(ts.SyntaxKind.QuestionDotToken), "isProxy");
}
function isAsyncMock(typeChecker, node) {
    // Direct identifier: Check the type of the identifier.
    const nodeType = typeChecker.getTypeAtLocation(node);
    return typeIsOrExtendsAsyncMock(nodeType);
}
//# sourceMappingURL=Transpiler.js.map