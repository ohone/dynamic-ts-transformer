import { createTypeChecker } from "./TypeChecker.js";
import { printNode } from "./Printer.js";
import * as ts from "typescript";

export async function transpileTypescript(
  codeString: string,
  sourceUrl?: string | undefined,
  globalProxyNames: string[] = [],
  globalNonProxyNames: string[] = [],
  debug: boolean = false,
  sourceMap: boolean = true
) {
  const typeChecker = await createTypeChecker(
    codeString,
    globalProxyNames,
    [...globalNonProxyNames, "JSON"],
    debug
  );
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
  return (
    outputText.split("\n").slice(2).join("\n") + "\n//# sourceURL=" + sourceUrl
  );
}
function getRootExpression(node: ts.Expression): ts.Expression {
  // Keep unwrapping until we find the leftmost expression
  if (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    while (
      ts.isCallExpression(node) ||
      ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    node = node.expression;
  }
  return node;
  }
  if (ts.isBinaryExpression(node)) {
    return getRootExpression(node.left);
  }
  return node;
}

function createProxyTernary(
  maybeProxyExpression: ts.Expression,
  proxyCall: ts.Expression,
  nonProxyCall: ts.Expression,
  factory: ts.NodeFactory
) {
  const isProxyCheck = createProxyCheck(maybeProxyExpression);
  const ternary = factory.createConditionalExpression(
    isProxyCheck,
    ts.factory.createToken(ts.SyntaxKind.QuestionToken),
    proxyCall,
    ts.factory.createToken(ts.SyntaxKind.ColonToken),
    nonProxyCall
  );
  const awaitExpression = factory.createAwaitExpression(ternary);
  const parenthesizedAwaitExpression =
    factory.createParenthesizedExpression(awaitExpression);
  return parenthesizedAwaitExpression;
}

function createTransformer(
  typeChecker: ts.TypeChecker,
  debug: boolean
): ts.TransformerFactory<ts.SourceFile> {
  return (context: ts.TransformationContext) => {
    const { factory } = context;

    function visitNode(
      node: ts.Node,
      onFunctionVisited: (node: ts.Node) => void
    ): ts.Node {
      if (ts.isExpression(node)) {
        const newExpression = visitExpression(
          node,
          factory,
          (node) => visitNode(node, onFunctionVisited),
          typeChecker,
          onFunctionVisited,
          context
        );
        if (newExpression !== node) {
          return newExpression;
        }
      }
      // Handle Variable Declarations (e.g. const a = myProxy.foo.bar;)
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const newInit = visitExpression(
          node.initializer,
          factory,
          (node) => visitNode(node, onFunctionVisited),
          typeChecker,
          onFunctionVisited,
          context
        );
        if (newInit !== node.initializer) {
          return factory.updateVariableDeclaration(
            node,
            node.name,
            node.exclamationToken,
            node.type,
            newInit
          );
        }
      }

      // Handle for-of loops
      if (ts.isForOfStatement(node)) {
        // Check if the expression is async mock
        if (isAsyncMock(typeChecker, node.expression)) {
          // If we can rely on `for await` loops:
          // Convert `for (const x of myProxy)` to `for await (const x of myProxy)`
          // This requires changing the for-of flags.
          return factory.updateForOfStatement(
            node,
            node.awaitModifier ||
              factory.createToken(ts.SyntaxKind.AwaitKeyword),
            node.initializer,
            node.expression,
            node.statement
          );

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
            ? (visitNode(node.body, onFunctionVisited) as ts.Block)
            : undefined;
          if (newBody !== node.body) {
            const newModifiers = node.modifiers
              ? [
                  ...node.modifiers,
                  factory.createModifier(ts.SyntaxKind.AsyncKeyword),
                ]
              : [factory.createModifier(ts.SyntaxKind.AsyncKeyword)];
            const newFunction = factory.updateFunctionDeclaration(
              node,
              newModifiers,
              node.asteriskToken,
              node.name,
              node.typeParameters,
              node.parameters,
              node.type,
              newBody
            );
            onFunctionVisited(newFunction);
            return newFunction;
          }
          return node;
        }
      }
      // Make functions async if transformed
      if (ts.isArrowFunction(node)) {
        if (!functionAlreadyAsync(node)) {
          const newBody = visitNode(
            node.body,
            onFunctionVisited
          ) as ts.ConciseBody;
          if (newBody !== node.body) {
            const newModifiers = node.modifiers
              ? [
                  ...node.modifiers,
                  factory.createModifier(ts.SyntaxKind.AsyncKeyword),
                ]
              : [factory.createModifier(ts.SyntaxKind.AsyncKeyword)];
            const newFunction = factory.updateArrowFunction(
              node,
              newModifiers,
              node.typeParameters,
              node.parameters,
              node.type,
              node.equalsGreaterThanToken,
              newBody
            );
            onFunctionVisited(newFunction);
            return newFunction;
          }
          return node;
        }
      }
      // Make functions async if transformed
      if (ts.isFunctionExpression(node)) {
        if (!functionAlreadyAsync(node)) {
          const newBody = visitNode(node.body, onFunctionVisited) as ts.Block;
          if (newBody !== node.body) {
            const newModifiers = node.modifiers
              ? [
                  ...node.modifiers,
                  factory.createModifier(ts.SyntaxKind.AsyncKeyword),
                ]
              : [factory.createModifier(ts.SyntaxKind.AsyncKeyword)];
            const newFunction = factory.updateFunctionExpression(
              node,
              newModifiers,
              node.asteriskToken,
              node.name,
              node.typeParameters,
              node.parameters,
              node.type,
              newBody
            );
            onFunctionVisited(newFunction);
            return newFunction;
          }
          return node;
        }
      }

      return ts.visitEachChild(
        node,
        (ctx) => visitNode(ctx, onFunctionVisited),
        context
      );
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

    return (sourceFile: ts.SourceFile) => {
      const visitedFunctions: ts.Node[] = [];
      const onFunctionVisited = (node: ts.Node) => {
        visitedFunctions.push(node);
      };
      return ts.visitNode(sourceFile, (node) =>
        visitNode(node, onFunctionVisited)
      ) as ts.SourceFile;
    };
  };
}

function visitAsyncMockExpression(
  node: ts.Expression,
  factory: ts.NodeFactory,
  visitNode: (node: ts.Node) => ts.Node,
  typeChecker: ts.TypeChecker,
  onFunctionVisited: (node: ts.Node) => void,
  context: ts.TransformationContext
): ts.Expression {
  if (ts.isCallExpression(node)) {
    return transformCallExpression(
      node,
      factory,
      visitNode,
      typeChecker,
      onFunctionVisited,
      (exp) =>
        visitAsyncMockExpression(
          exp,
          factory,
          visitNode,
          typeChecker,
          onFunctionVisited,
          context
        ),
      context
    );
  }

  if (ts.isElementAccessExpression(node)) {
    return transformElementAccessExpression(
      node,
      factory,
      (exp) =>
        visitAsyncMockExpression(
          exp,
          factory,
          visitNode,
          typeChecker,
          onFunctionVisited,
          context
        ),
      visitNode,
      typeChecker,
      onFunctionVisited,
      context
    );
  }

  if (ts.isPropertyAccessExpression(node)) {
    return transformPropertyAccessExpression(node, factory, (exp) =>
      visitAsyncMockExpression(
        exp,
        factory,
        visitNode,
        typeChecker,
        onFunctionVisited,
        context
      )
    );
  }

  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    (ts.isPropertyAccessExpression(node.left) ||
      ts.isElementAccessExpression(node.left))
  ) {
    const left = node.left;
    const right = node.right;

    // Check if the left-hand side is accessing an AsyncMock
    // The final property name:
    const propertyName = ts.isPropertyAccessExpression(node.left)
      ? node.left.name.text
      : node.left.argumentExpression.getText();

    // Transform the right-hand side in case it involves proxies:
    const transformedRight = visitAsyncMockExpression(
      right,
      factory,
      visitNode,
      typeChecker,
      onFunctionVisited,
      context
    );

    // Now we must get the object on which to call setProp.
    // For `myProxy.foo.bar = value`, `parentExpr` = `myProxy.foo`.
    const parentExpr = left.expression;

    // Transform that parent to be fully awaited:
    // For `myProxy.foo.bar`, transform `myProxy.foo` into `await myProxy.foo`.
    const transformedParent = visitAsyncMockExpression(
      parentExpr,
      factory,
      visitNode,
      typeChecker,
      onFunctionVisited,
      context
    );

    // Now we create: await (transformedParent.setProp("propertyName", transformedRight))
    const setPropCall = factory.createCallExpression(
      factory.createPropertyAccessExpression(
        transformedParent,
        factory.createIdentifier("__setProp")
      ),
      undefined,
      [factory.createStringLiteral(propertyName), transformedRight]
    );

    return factory.createAwaitExpression(setPropCall);
  }

  return ts.visitEachChild(node, visitNode, context);
}

function visitUnknownAsyncMockExpression(
  node: ts.Expression,
  factory: ts.NodeFactory,
  visitNode: (node: ts.Node) => ts.Node,
  typeChecker: ts.TypeChecker,
  onFunctionVisited: (node: ts.Node) => void,
  context: ts.TransformationContext,
  bindExpression: boolean = false
): ts.Expression {
  if (ts.isCallExpression(node)) {
    const transformedArgs = node.arguments.map(
      (arg) =>
        visitExpression(
          arg,
          factory,
          visitNode,
          typeChecker,
          onFunctionVisited,
          context
        ) as ts.Expression
    );

    if (ts.isIdentifier(node.expression)) {
      return factory.createParenthesizedExpression(
        factory.createAwaitExpression(
          factory.updateCallExpression(
            node,
            node.expression,
            node.typeArguments,
            transformedArgs
          )
        )
      );
    }
    const transformedCallee = visitUnknownAsyncMockExpression(
      node.expression,
      factory,
      visitNode,
      typeChecker,
      onFunctionVisited,
      context,
      true // bind expression result, we know it's a function
    );

    // If transformed callee is different, it means we have something like (await ...).
    // For calling a remote function: myProxy.foo() → await (await myProxy.foo)()
    // If we ended up with an awaited property access, that gives us the function. We must now
    // await the call as well.
    //
    // So: call = transformedCallee(...expr.arguments)
    // Actually, we must wrap the call: await (transformedCallee(...))
    const nonProxyCall = factory.updateCallExpression(
      node,
      transformedCallee,
      node.typeArguments,
      transformedArgs
    );

    const proxyCall = factory.createCallExpression(
      ts.factory.createParenthesizedExpression(
        factory.createAwaitExpression(transformedCallee)
      ),
      node.typeArguments,
      transformedArgs
    );

    const ternary = createProxyTernary(
      transformedCallee,
      proxyCall,
      nonProxyCall,
      factory
    );
    return ternary;
  }

  if (ts.isPropertyAccessExpression(node)) {
    const transformedLeft = visitUnknownAsyncMockExpression(
      node.expression,
      factory,
      visitNode,
      typeChecker,
      onFunctionVisited,
      context
    );

    const propertyAccessExpression = factory.createPropertyAccessExpression(
      transformedLeft,
      node.name.text
    );

    return bindExpression
      ? factory.createCallExpression(
          factory.createPropertyAccessExpression(
            propertyAccessExpression,
            "bind"
          ),
          undefined,
          [transformedLeft]
        )
      : factory.createParenthesizedExpression(
          factory.createAwaitExpression(propertyAccessExpression)
        );
  }

  if (ts.isElementAccessExpression(node)) {
    return factory.createAwaitExpression(node);
  }

  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    (ts.isPropertyAccessExpression(node.left) ||
      ts.isElementAccessExpression(node.left))
  ) {
    const left = node.left;
    const right = node.right;

    // Check if the left-hand side is accessing an AsyncMock
    // The final property name:
    const propertyName = ts.isPropertyAccessExpression(node.left)
      ? node.left.name.text
      : node.left.argumentExpression.getText();

    // Transform the right-hand side in case it involves proxies:
    const transformedRight = visitUnknownAsyncMockExpression(
      right,
      factory,
      visitNode,
      typeChecker,
      onFunctionVisited,
      context
    );

    // Now we must get the object on which to call setProp.
    // For `myProxy.foo.bar = value`, `parentExpr` = `myProxy.foo`.
    const parentExpr = left.expression;

    // Transform that parent to be fully awaited:
    // For `myProxy.foo.bar`, transform `myProxy.foo` into `await myProxy.foo`.
    const transformedParent = visitUnknownAsyncMockExpression(
      parentExpr,
      factory,
      visitNode,
      typeChecker,
      onFunctionVisited,
      context
    );

    // Now we create: await (transformedParent.setProp("propertyName", transformedRight))
    const setPropCall = factory.createCallExpression(
      factory.createPropertyAccessExpression(
        transformedParent,
        factory.createIdentifier("__setProp")
      ),
      undefined,
      [factory.createStringLiteral(propertyName), transformedRight]
    );

    return factory.createAwaitExpression(setPropCall);
  }

  // Handle other Binary Expressions (operators involving proxies)
  // e.g. myProxy.x + 10, myProxy.y && someVar, myProxy.x > 5
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind !== ts.SyntaxKind.EqualsToken
  ) {
    // Transform left and right if needed
    const left = visitUnknownAsyncMockExpression(
      node.left,
      factory,
      visitNode,
      typeChecker,
      onFunctionVisited,
      context
    ) as ts.Expression;
    const right = visitUnknownAsyncMockExpression(
      node.right,
      factory,
      visitNode,
      typeChecker,
      onFunctionVisited,
      context
    ) as ts.Expression;

    // If either side changed (indicating async involvement), we return the updated expression.
    if (left !== node.left || right !== node.right) {
      return factory.updateBinaryExpression(
        node,
        left,
        node.operatorToken,
        right
      );
    }
  }

  if (ts.isArrowFunction(node)) {
    const hasAsync = node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword);
    const newModifiers = !hasAsync 
      ? (node.modifiers
          ? [...node.modifiers, factory.createModifier(ts.SyntaxKind.AsyncKeyword)]
          : [factory.createModifier(ts.SyntaxKind.AsyncKeyword)])
      : node.modifiers;

    if (ts.isBlock(node.body)) {
      const transformedStatements = node.body.statements.map((stmt) =>
        visitNode(stmt) as ts.Statement
      );
      const newBlock = ts.factory.createBlock(transformedStatements, true);
      return factory.updateArrowFunction(
        node,
        newModifiers,
        node.typeParameters,
        node.parameters,
        node.type,
        node.equalsGreaterThanToken,
        newBlock
      );
    } else {
      const updatedBody = visitNode(node.body) as ts.ConciseBody;

      return factory.updateArrowFunction(
        node,
        newModifiers,
        node.typeParameters,
        node.parameters,
        node.type,
        node.equalsGreaterThanToken,
        updatedBody
      );
    }
  }
  return node;
}

function visitExpression(
  node: ts.Expression,
  factory: ts.NodeFactory,
  visitNode: (node: ts.Node) => ts.Node,
  typeChecker: ts.TypeChecker,
  onFunctionVisited: (node: ts.Node) => void,
  context: ts.TransformationContext
): ts.Expression {
  const asyncMockStatus = getAsyncMockStatus(typeChecker, node);
  if (asyncMockStatus === AsyncMockStatus.AsyncMock) {
    return visitAsyncMockExpression(
      node,
      factory,
      visitNode,
      typeChecker,
      onFunctionVisited,
      context
    );
  }

  if (asyncMockStatus === AsyncMockStatus.NonAsyncMock) {
    return node;
  }

  return visitUnknownAsyncMockExpression(
    node,
    factory,
    visitNode,
    typeChecker,
    onFunctionVisited,
    context
  );
}

function transformCallExpression(
  node: ts.CallExpression,
  factory: ts.NodeFactory,
  visitNode: (node: ts.Node) => ts.Node,
  typeChecker: ts.TypeChecker,
  onFunctionVisited: (node: ts.Node) => void,
  visitChildren: (node: ts.Expression) => ts.Expression,
  context: ts.TransformationContext
): ts.Expression {
  const transformedCallee = visitChildren(node.expression);
  const wrappedCallee =
    ts.factory.createParenthesizedExpression(transformedCallee);
  const transformedArgs = node.arguments.map(
    (arg) =>
      visitExpression(
        arg,
        factory,
        visitNode,
        typeChecker,
        onFunctionVisited,
        context
      ) as ts.Expression
  );

  return factory.createAwaitExpression(
    factory.createCallExpression(
      ts.factory.createParenthesizedExpression(
        ts.factory.createAwaitExpression(wrappedCallee)
      ),
      node.typeArguments,
      transformedArgs
    )
  );
}

function transformPropertyAccessExpression(
  node: ts.PropertyAccessExpression,
  factory: ts.NodeFactory,
  visitChildren: (node: ts.Expression) => ts.Expression
): ts.Expression {
  const transformedExpression = visitChildren(node.expression);
  return factory.createAwaitExpression(
    factory.createPropertyAccessExpression(
      transformedExpression,
      node.name.text
    )
  );
}

function transformElementAccessExpression(
  node: ts.ElementAccessExpression,
  factory: ts.NodeFactory,
  visitChildren: (node: ts.Expression) => ts.Expression,
  visitNode: (node: ts.Node) => ts.Node,
  typeChecker: ts.TypeChecker,
  onFunctionVisited: (node: ts.Node) => void,
  context: ts.TransformationContext
): ts.Expression {
  const transformedExpression = visitChildren(node.expression);

  const transformedArgument = visitExpression(
    node.argumentExpression,
    factory,
    visitNode,
    typeChecker,
    onFunctionVisited,
    context
  );

  return factory.createAwaitExpression(
    factory.createElementAccessExpression(
      transformedExpression,
      transformedArgument
    )
  );
}

enum AsyncMockStatus {
  AsyncMock,
  NonAsyncMock,
  Unknown,
}

function getAsyncMockStatus(
  typeChecker: ts.TypeChecker,
  node: ts.Expression
): AsyncMockStatus {
  const leftMost = getRootExpression(node);
  const nodeType = typeChecker.getTypeAtLocation(leftMost);
  const isAsyncMock = typeIsOrExtendsAsyncMock(nodeType);
  if (isAsyncMock) {
    return AsyncMockStatus.AsyncMock;
  }
  const isNonProxy = typeIsOrExtendsNonProxy(nodeType);
  if (isNonProxy) {
    return AsyncMockStatus.NonAsyncMock;
  } else {
    return AsyncMockStatus.Unknown;
  }
}

function functionAlreadyAsync(
  node: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression
) {
  return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

function typeIsOrExtendsAsyncMock(
  type: ts.Type,
): boolean {
  // If we gave `AsyncMock` a unique brand:
  // Check for presence of __isAsyncMock property
  const props = type.getProperties();
  return props.some((sym) => sym.getName() === "__isAsyncMock");
}

function typeIsOrExtendsNonProxy(
  type: ts.Type,
): boolean {
  const props = type.getProperties();
  return props.some((sym) => sym.getName() === "__notAsyncMock");
}

function createProxyCheck(expr: ts.Expression): ts.PropertyAccessChain {
  return ts.factory.createPropertyAccessChain(
    expr,
    ts.factory.createToken(ts.SyntaxKind.QuestionDotToken),
    "isProxy"
  );
}

function isAsyncMock(typeChecker: ts.TypeChecker, node: ts.Node): boolean {
  // Direct identifier: Check the type of the identifier.
  const nodeType = typeChecker.getTypeAtLocation(node);
  return typeIsOrExtendsAsyncMock(nodeType);
}
