import ts from "typescript";
import { createTypeChecker } from "./TypeChecker.js";
import { printNode } from "./Printer.js";
export async function transpileTypescript(codeString, sourceUrl, globalProxyNames = [], globalNonProxyNames = [], debug = false, sourceMap = true) {
    const typeChecker = await createTypeChecker(codeString, globalProxyNames, [...globalNonProxyNames, "JSON"], debug);
    const { outputText } = ts.transpileModule(`//\n//\n` + codeString, {
        compilerOptions: {
            module: ts.ModuleKind.ES2022,
            target: ts.ScriptTarget.ES2023,
            inlineSourceMap: sourceMap,
            inlineSources: sourceMap,
            sourceMap: sourceMap,
            removeComments: false
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
function createTransformer(typeChecker, debug) {
    return (context) => {
        const { factory } = context;
        function createProxyTernary(maybeProxyExpression, proxyCall, nonProxyCall) {
            const isProxyCheck = createProxyCheck(maybeProxyExpression);
            const ternary = factory.createConditionalExpression(isProxyCheck, ts.factory.createToken(ts.SyntaxKind.QuestionToken), proxyCall, ts.factory.createToken(ts.SyntaxKind.ColonToken), nonProxyCall);
            const awaitExpression = factory.createAwaitExpression(ternary);
            const parenthesizedAwaitExpression = factory.createParenthesizedExpression(awaitExpression);
            return parenthesizedAwaitExpression;
        }
        function visitExpression(node) {
            if (ts.isCallExpression(node)) {
                const transformedCallee = visitExpression(node.expression);
                const wrappedCallee = ts.factory.createParenthesizedExpression(transformedCallee);
                const transformedArgs = node.arguments.map((arg) => visitNode(arg));
                // If transformed callee is different, it means we have something like (await ...).
                // For calling a remote function: myProxy.foo() → await (await myProxy.foo)()
                // If we ended up with an awaited property access, that gives us the function. We must now
                // await the call as well.
                //
                // So: call = transformedCallee(...expr.arguments)
                // Actually, we must wrap the call: await (transformedCallee(...))
                const nonProxyCall = factory.updateCallExpression(node, transformedCallee, node.typeArguments, transformedArgs);
                const proxyCall = factory.createCallExpression(ts.factory.createParenthesizedExpression(ts.factory.createAwaitExpression(wrappedCallee)), node.typeArguments, transformedArgs);
                const ternary = createProxyTernary(wrappedCallee, proxyCall, nonProxyCall);
                return ternary;
            }
            if (ts.isPropertyAccessExpression(node)) {
                const transformedLeft = visitExpression(node.expression);
                const proxyCall = factory.createAwaitExpression(factory.createElementAccessExpression(transformedLeft, ts.factory.createStringLiteral(node.name.text)));
                const nonProxyCall = factory.createPropertyAccessExpression(transformedLeft, node.name.text);
                const ternary = createProxyTernary(transformedLeft, proxyCall, nonProxyCall);
                return ternary;
            }
            if (ts.isElementAccessExpression(node)) {
                const transformedLeft = visitExpression(node.expression);
                const proxyCall = factory.createAwaitExpression(factory.createElementAccessExpression(transformedLeft, node.argumentExpression));
                const nonProxyCall = factory.createElementAccessExpression(transformedLeft, node.argumentExpression);
                const ternary = createProxyTernary(transformedLeft, proxyCall, nonProxyCall);
                return ternary;
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
                const transformedRight = visitExpression(right);
                // Now we must get the object on which to call setProp.
                // For `myProxy.foo.bar = value`, `parentExpr` = `myProxy.foo`.
                const parentExpr = left.expression;
                // Transform that parent to be fully awaited:
                // For `myProxy.foo.bar`, transform `myProxy.foo` into `await myProxy.foo`.
                const transformedParent = visitExpression(parentExpr);
                // Now we create: await (transformedParent.setProp("propertyName", transformedRight))
                const setPropCall = factory.createCallExpression(factory.createPropertyAccessExpression(transformedParent, factory.createIdentifier("__setProp")), undefined, [factory.createStringLiteral(propertyName), transformedRight]);
                return factory.createAwaitExpression(setPropCall);
            }
            // Handle other Binary Expressions (operators involving proxies)
            // e.g. myProxy.x + 10, myProxy.y && someVar, myProxy.x > 5
            if (ts.isBinaryExpression(node) &&
                node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
                // Transform left and right if needed
                const left = visitNode(node.left);
                const right = visitNode(node.right);
                // If either side changed (indicating async involvement), we return the updated expression.
                if (left !== node.left || right !== node.right) {
                    return factory.updateBinaryExpression(node, left, node.operatorToken, right);
                }
            }
            printNode(node, true);
            return node;
        }
        function visitNode(node) {
            if (ts.isExpression(node)) {
                const newExpression = visitExpression(node);
                if (newExpression !== node) {
                    return newExpression;
                }
            }
            // Handle Variable Declarations (e.g. const a = myProxy.foo.bar;)
            if (ts.isVariableDeclaration(node) && node.initializer) {
                const newInit = visitExpression(node.initializer);
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
            return ts.visitEachChild(node, visitNode, context);
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
            return ts.visitNode(sourceFile, visitNode);
        };
    };
}
function isAsyncMock(typeChecker, node) {
    // Direct identifier: Check the type of the identifier.
    const nodeType = typeChecker.getTypeAtLocation(node);
    return typeIsOrExtendsAsyncMock(nodeType, typeChecker);
}
function typeIsOrExtendsAsyncMock(type, checker) {
    // If we gave `AsyncMock` a unique brand:
    // Check for presence of __isAsyncMock property
    const props = type.getProperties();
    return props.some((sym) => sym.getName() === "__isAsyncMock");
}
function createProxyCheck(expr) {
    return ts.factory.createPropertyAccessChain(expr, ts.factory.createToken(ts.SyntaxKind.QuestionDotToken), "isProxy");
}
//# sourceMappingURL=Transpiler.js.map