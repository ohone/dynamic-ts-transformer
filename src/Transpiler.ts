import ts from "typescript";
import { createTypeChecker } from "./TypeChecker";
import { printNode } from "./Printer";

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

function createTransformer(
  typeChecker: ts.TypeChecker,
  debug: boolean
): ts.TransformerFactory<ts.SourceFile> {
  // FIFO queue of functions that have been transformed
  const transformedFunctions: ts.Node[] = [];
  const onTransformed: (node: ts.Node) => void = (node) => {
    transformedFunctions.push(node);
  };

  return (context) => {
    return (sourceFile: ts.SourceFile) => {
      const firstPass = visitNode(
        sourceFile,
        typeChecker,
        context,
        onTransformed,
        debug
      ) as ts.SourceFile;
      const secondPass = awaitTransformedAsyncFunctions(
        transformedFunctions,
        firstPass,
        typeChecker,
        context
      );
      return secondPass as ts.SourceFile;
    };
  };
}

function awaitTransformedAsyncFunctions(
  transformedFunctions: ts.Node[],
  node: ts.Node,
  typeChecker: ts.TypeChecker,
  context: ts.TransformationContext
) {
  const secondPassVisit: ts.Visitor = (node: ts.Node): ts.Node => {
    if (ts.isCallExpression(node)) {
      const signature = typeChecker.getResolvedSignature(node);
      if (signature) {
        const declaration = signature.declaration;
        if (declaration && transformedFunctions.includes(declaration)) {
          return ts.factory.createAwaitExpression(
            ts.visitEachChild(node, secondPassVisit, context)
          );
        }
      }
    }
    return ts.visitEachChild(node, secondPassVisit, context);
  };

  return ts.visitNode(node, secondPassVisit);
}

function visitFunctionDeclaration(
  node: ts.FunctionDeclaration,
  visit: ts.Visitor,
  modifiers: readonly ts.Modifier[],
  parameters: ts.ParameterDeclaration[],
  typeChecker: ts.TypeChecker,
  context: ts.TransformationContext,
  onTransformedFunction: (node: ts.Node) => void,
  debug: boolean
) {
  const factory = context.factory;
  const intermediateDeclaration = factory.updateFunctionDeclaration(
    node,
    modifiers,
    node.asteriskToken,
    node.name,
    node.typeParameters,
    parameters,
    node.type,
    node.body
  );
  const newBody = visitFunctionLikeBody(
    intermediateDeclaration,
    visit,
    typeChecker,
    context,
    onTransformedFunction,
    debug
  );
  const res = factory.updateFunctionDeclaration(
    node,
    modifiers,
    node.asteriskToken,
    node.name,
    node.typeParameters,
    node.parameters,
    node.type,
    newBody
  );

  return res;
}

function visitFunctionExpression(
  node: ts.FunctionExpression,
  visit: ts.Visitor,
  modifiers: readonly ts.Modifier[],
  parameters: ts.ParameterDeclaration[],
  typeChecker: ts.TypeChecker,
  context: ts.TransformationContext,
  onTransformedFunction: (node: ts.Node) => void,
  debug: boolean
) {
  const factory = context.factory;
  const intermediateExpression = factory.updateFunctionExpression(
    node,
    modifiers,
    node.asteriskToken,
    node.name,
    node.typeParameters,
    parameters,
    node.type,
    node.body
  );
  const newBody = visitFunctionLikeBody(
    intermediateExpression,
    visit,
    typeChecker,
    context,
    onTransformedFunction,
    debug
  );
  if (!newBody) {
    return node;
  }
  return factory.updateFunctionExpression(
    node,
    modifiers,
    node.asteriskToken,
    node.name,
    node.typeParameters,
    node.parameters,
    node.type,
    newBody
  );
}

function visitArrowFunction(
  node: ts.ArrowFunction,
  visit: ts.Visitor,
  modifiers: readonly ts.Modifier[],
  parameters: ts.ParameterDeclaration[],
  typeChecker: ts.TypeChecker,
  onTransformedFunction: (node: ts.Node) => void,
  factory: ts.NodeFactory,
  context: ts.TransformationContext,
  debug: boolean
) {
  const intermediateExpression = factory.updateArrowFunction(
    node,
    modifiers,
    node.typeParameters,
    parameters,
    node.type,
    node.equalsGreaterThanToken,
    node.body
  );
  const newBody = visitFunctionLikeBody(
    intermediateExpression,
    visit,
    typeChecker,
    context,
    onTransformedFunction,
    debug
  );
  if (!newBody) {
    return node;
  }
  return factory.updateArrowFunction(
    node,
    modifiers,
    node.typeParameters,
    node.parameters,
    node.type,
    node.equalsGreaterThanToken,
    newBody
  );
}

function visitFunctionLike(
  node: ts.FunctionLikeDeclaration,
  visit: ts.Visitor,
  typeChecker: ts.TypeChecker,
  context: ts.TransformationContext,
  onTransformedFunction: (node: ts.Node) => void,
  debug: boolean,
  options: visitorOptions
): ts.Node {
  const factory = context.factory;

  // Mark the function as async if not already
  let modifiers = ts.getModifiers(node) || [];
  const hasAsyncModifier = modifiers.some(
    (mod) => mod.kind === ts.SyntaxKind.AsyncKeyword
  );
  if (!hasAsyncModifier) {
    modifiers = factory.createNodeArray([
      ...modifiers,
      factory.createModifier(ts.SyntaxKind.AsyncKeyword),
    ]);
  }

  const parameters = visitFunctionParameterDeclarations(
    node,
    typeChecker,
    options
  );
  // Update the function with new modifiers and body
  if (ts.isFunctionDeclaration(node)) {
    return visitFunctionDeclaration(
      node,
      visit,
      modifiers,
      parameters,
      typeChecker,
      context,
      onTransformedFunction,
      debug
    );
  } else if (ts.isFunctionExpression(node)) {
    return visitFunctionExpression(
      node,
      visit,
      modifiers,
      parameters,
      typeChecker,
      context,
      onTransformedFunction,
      debug
    );
  } else if (ts.isArrowFunction(node)) {
    return visitArrowFunction(
      node,
      visit,
      modifiers,
      parameters,
      typeChecker,
      onTransformedFunction,
      factory,
      context,
      debug
    );
  } else if (ts.isMethodDeclaration(node)) {
    const intermediateExpression = factory.updateMethodDeclaration(
      node,
      modifiers,
      node.asteriskToken,
      node.name,
      node.questionToken,
      node.typeParameters,
      parameters,
      node.type,
      node.body
    );
    const newBody = visitFunctionLikeBody(
      intermediateExpression,
      visit,
      typeChecker,
      context,
      onTransformedFunction,
      debug
    );
    if (!newBody) {
      return node;
    }
    return factory.updateMethodDeclaration(
      node,
      modifiers,
      node.asteriskToken,
      node.name,
      node.questionToken,
      node.typeParameters,
      node.parameters,
      node.type,
      newBody
    );
  } else {
    // Other function-like declarations can be added here
    return node;
  }
}

function walkMemberExpressions(expr: ts.Expression): ts.Expression[] {
  const expressions: ts.Expression[] = [];
  let current = expr;

  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    expressions.unshift(current);
    current = current.expression;
  }
  expressions.unshift(current);

  return expressions;
}

function addNonProxyTypeAssertionToExpression(
  node: ts.Expression
): ts.Expression {
  // Create type assertion
  const typeAssertion = ts.factory.createParenthesizedExpression(
    ts.factory.createAsExpression(
      node,
      ts.factory.createTypeReferenceNode("NonProxy")
    )
  );

  return typeAssertion;
}

const createProxyCheckIfBlocks = (
  node: ts.Expression,
  typeChecker: ts.TypeChecker,
  context: ts.TransformationContext,
  onTransformedFunction: (node: ts.Node) => void,
  debug: boolean,
  options: visitorOptions
) => {
  const expressions = walkMemberExpressions(node);
  const retVal: { check: ts.PropertyAccessChain; expr: ts.Expression }[] = [];

  for (let i = 0; i < expressions.length; i++) {
    const proxyCheckExpression = expressions[i];
    const expressionToProxify = expressions[expressions.length - 1];
    const nonProxySide = i === 0 ? undefined : expressions[i - 1];

    const readyToProxify = nonProxySide
      ? ts.transform(expressionToProxify, [
          (context) =>
            function visitor(node: ts.Node): ts.Node {
              if (node === nonProxySide) {
                const typeAssertion =
                  addNonProxyTypeAssertionToExpression(nonProxySide); // as (nonProxySide as NonProxy);
                return typeAssertion;
              }
              return ts.visitEachChild(node, visitor, context);
            },
        ]).transformed[0]
      : expressionToProxify;

    const transformedExpr = visitNode(
      readyToProxify,
      typeChecker,
      context,
      onTransformedFunction,
      debug,
      { ...options, unknownsAreAsyncMock: true }
    ) as ts.Expression;

    const check = createProxyCheck(proxyCheckExpression);

    retVal.push({ check, expr: transformedExpr });
  }

  return retVal;
};

function visitAssignmentWithRuntimeCheck(
  node: ts.AssignmentExpression<ts.AssignmentOperatorToken>,
  typeChecker: ts.TypeChecker,
  context: ts.TransformationContext,
  onTransformedFunction: (node: ts.Node) => void,
  debug: boolean,
  options: visitorOptions
) {
  const checksAndStatements = createProxyCheckIfBlocks(
    node.left,
    typeChecker,
    context,
    onTransformedFunction,
    debug,
    options
  );

  const transformedRightSide = visitNode(
    node.right,
    typeChecker,
    context,
    onTransformedFunction,
    debug,
    options
  ) as ts.Expression;

  // e.g. resultMap = {};
  // don't transform the above - we're reassigning a var;
  if (ts.isIdentifier(node.left)) {
    return node;
  }

  const removeNonProxyCasts = (node: ts.Node) => {
    const handleAsExpression = (node: ts.AsExpression) => {
      const typeRef = node.type as ts.TypeReferenceNode;
      if (ts.isIdentifier(typeRef.typeName)) {
        const typeName = typeRef.typeName.escapedText;
        if (typeName === "NonProxy") {
          return node.expression;
        }
      }
    };

    if (ts.isAsExpression(node)) {
      return handleAsExpression(node);
    }
    return ts.visitEachChild(node, removeNonProxyCasts, context);
  };

  const newRetVal = checksAndStatements.map((val) => {
    const callExpression = ts.isAwaitExpression(val.expr)
      ? ((val.expr as ts.AwaitExpression).expression as ts.CallExpression)
      : val.expr;

    const sanitizedCallExpression = ts.visitNode(
      callExpression,
      removeNonProxyCasts
    ) as ts.CallExpression;
    // create new call expression with same everything but new args
    const newCallExpression = ts.factory.createCallExpression(
      sanitizedCallExpression.expression,
      undefined,
      [
        createObjectLiteral(transformedRightSide, [
          { type: "type", value: "assignment" },
        ]),
      ] // node.right transformed
    );

    const check = val.check;

    return {
      check,
      expression: ts.factory.createAwaitExpression(newCallExpression),
    };
  });

  const ternary = newRetVal.reverse().reduce((acc, curr) => {
    return ts.factory.createConditionalExpression(
      curr.check,
      undefined,
      curr.expression,
      undefined,
      acc
    );
  }, node as ts.Expression);

  return ts.factory.createParenthesizedExpression(ternary);
}

type visitorOptions = {
  unknownsAreAsyncMock?: boolean;
  unknownsAreNotAsyncMock?: boolean;
};

function visitNode(
  parentNode: ts.Node,
  typeChecker: ts.TypeChecker,
  context: ts.TransformationContext,
  onTransformedFunction: (node: ts.Node) => void,
  debug: boolean,
  options: visitorOptions = {}
): ts.Node {
  const visit = (node: ts.Node) => {
    if (isExplicitlyNonProxyNode(node)) {
      return node;
    }

    // to capture calls to `new Function`
    if (ts.isNewExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Function"
      ) {
        const transformedArgs = node.arguments
          ? node.arguments.map(
              (arg) =>
                visitNode(
                  arg,
                  typeChecker,
                  context,
                  onTransformedFunction,
                  debug,
                  options
                ) as ts.Expression
            )
          : [];
        // create a call expression to `__newFunction` with the transformed args
        const callExpression = ts.factory.createAwaitExpression(
          ts.factory.createCallExpression(
            ts.factory.createIdentifier("__newFunction"),
            undefined,
            transformedArgs
          )
        );
        return callExpression;
      }
    }

    if (ts.isArrayLiteralExpression(node)) {
      if (node.elements.length === 1) {
        const firstElement = node.elements[0];
        if (ts.isSpreadElement(firstElement)) {
          const asyncCall = visitNode(
            firstElement,
            typeChecker,
            context,
            onTransformedFunction,
            debug,
            options
          );
          return asyncCall;
        }
      }
    }

    if (ts.isSpreadElement(node)) {
      // return awaited function call
      // `[...a]` becomes `await asyncIterate(a)`
      const childrenVisited = ts.visitEachChild(
        node,
        visit,
        context
      ) as ts.SpreadElement;
      return ts.factory.createAwaitExpression(
        ts.factory.createCallExpression(
          ts.factory.createIdentifier("asyncIterate"),
          undefined,
          [childrenVisited.expression]
        )
      );
    }

    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isCallExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const leftmostExp = findLeftmostExpression(node.expression);

      // handle `new Function` explicitly
      const isFunctionNewExpression =
        ts.isNewExpression(leftmostExp) &&
        ts.isIdentifier(leftmostExp.expression) &&
        leftmostExp.expression.text === "Function";

      if (isFunctionNewExpression) {
        return ts.visitEachChild(node, visit, context);
      }

      const baseType = typeChecker.getTypeAtLocation(leftmostExp);

      // handle direct function calls e.g. alert('hello') rather than something.alert('hello')
      const isDirectFunctionCall = leftmostExp === node.expression;

      if (isAsyncMockType(node, baseType, typeChecker, options)) {
        if (ts.isCallExpression(node)) {
          return visitCallExpression(node, visit, typeChecker, debug, options);
        } else if (ts.isPropertyAccessExpression(node)) {
          return visitPropertyAccess(node, visit, debug);
        } else if (ts.isElementAccessExpression(node)) {
          return visitElementAccessExpression(
            node,
            visit,
            typeChecker,
            debug,
            options
          );
        }
      }
      if (
        !isFunctionNewExpression &&
        couldBeAsyncMockType(node, baseType, typeChecker, options)
      ) {
        if (ts.isCallExpression(node)) {
          return visitCallExpressionWithRuntimeCheck(
            node,
            visit,
            typeChecker,
            debug,
            options
          );
        } else if (
          ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node)
        ) {
          return visitPropertyAccessWithRuntimeCheck(node, visit, debug);
        }
        throw new Error("Unexpected node type in visitNode");
      }

      // IIFE
      if (baseType.symbol?.name === "__function") {
        return ts.visitEachChild(node, visit, context);
      }
    }

    if (ts.isForOfStatement(node)) {
      const result = ts.factory.createForOfStatement(
        /* awaitModifier */ ts.factory.createToken(ts.SyntaxKind.AwaitKeyword),
        node.initializer,
        ts.visitNode(node.expression, visit) as ts.Expression,
        ts.visitNode(node.statement, visit) as ts.Statement
      );
      return result;
    }

    if (ts.isVariableDeclaration(node)) {
      return ts.visitEachChild(node, visit, context);
    }
    // Check for assignments
    if (isAssignmentExpression(node)) {
      const leftmostExp = findLeftmostExpression(node.left);

      const baseType = typeChecker.getTypeAtLocation(leftmostExp);

      if (isAsyncMockType(leftmostExp, baseType, typeChecker, options)) {
        return visitAssignment(node, visit, debug);
      }

      if (couldBeAsyncMockType(leftmostExp, baseType, typeChecker, options)) {
        return visitAssignmentWithRuntimeCheck(
          node,
          typeChecker,
          context,
          onTransformedFunction,
          debug,
          options
        );
      }
    }

    if (isBinaryExpression(node)) {
      return visitComparisonWithRuntimeCheck(
        node,
        visit,
        typeChecker,
        debug,
        options
      );
    }

    if (isFunctionLikeExpression(node)) {
      const rest = visitFunctionLike(
        node,
        visit,
        typeChecker,
        context,
        onTransformedFunction,
        debug,
        options
      );
      return rest;
    }

    if (ts.isSpreadElement(node)) {
      return visitSpreadElement(node, visit, typeChecker, debug);
    }

    // Continue visiting other nodes
    const res = ts.visitEachChild(node, visit, context);
    return res;
  };
  const res = ts.visitNode(parentNode, visit);
  return res;
}

function isExplicitlyNonProxyNode(node: ts.Node | undefined): boolean {
  if (!node) return false;
  const handleAsExpression = (node: ts.AsExpression) => {
    const typeRef = node.type as ts.TypeReferenceNode;
    if (!typeRef?.typeName) {
      return false;
    }
    if (ts.isIdentifier(typeRef?.typeName)) {
      const typeName = typeRef.typeName.escapedText;
      return typeName === "NonProxy";
    }
    return false;
  };

  if (ts.isParenthesizedExpression(node)) {
    const innerNode = node.expression;
    if (ts.isAsExpression(innerNode)) {
      return handleAsExpression(innerNode);
    }
  }
  if (ts.isAsExpression(node)) {
    return handleAsExpression(node);
  }
  return false;
}

function isAsyncMockType(
  node: ts.Node | undefined,
  type: ts.Type,
  typeChecker: ts.TypeChecker,
  options: visitorOptions
): boolean {
  // first check if node is a (x as Type) expression:
  if (isExplicitlyNonProxyNode(node) || options.unknownsAreNotAsyncMock) {
    return false;
  }

  if (options.unknownsAreAsyncMock) {
    return true;
  }

  if (!type) return false;
  // Check for error types
  if (type.symbol?.name === "NonProxy") {
    return false;
  }

  if (type.flags & ts.TypeFlags.Any || type.flags & ts.TypeFlags.Unknown) {
    return false;
  }

  // Check if it's a Promise<AsyncMock>
  if (type.symbol?.name === "Promise") {
    const typeArguments =
      type.aliasTypeArguments || (type as any).typeArguments;
    if (typeArguments && typeArguments.length > 0) {
      return isAsyncMockType(undefined, typeArguments[0], typeChecker, {});
    }
  }

  // Direct AsyncMock check
  if (type.symbol?.name === "AsyncMock") {
    return true;
  }

  // Check if it's a call expression type - using proper bitwise comparison
  if ((type.flags & ts.TypeFlags.Object) !== 0) {
    // changed from === true
    const objType = type as ts.ObjectType;
    const callSignatures = objType.getCallSignatures();
    if (callSignatures.length > 0) {
      const returnType = typeChecker.getReturnTypeOfSignature(
        callSignatures[0]
      );
      return isAsyncMockType(undefined, returnType, typeChecker, options);
    }
  }

  // Check if it's a property of AsyncMock
  const parentType = (type as any).parent;
  if (parentType?.symbol?.name === "AsyncMock") {
    return true;
  }

  return false;
}

function visitSpreadElement(
  node: ts.SpreadElement,
  visit: ts.Visitor,
  typeChecker: ts.TypeChecker,
  debug: boolean
): ts.Node {
  const transformedExpression = ts.visitNode(
    node.expression,
    visit
  ) as ts.Expression;
  return ts.factory.createSpreadElement(transformedExpression);
}

function couldBeAsyncMockType(
  node: ts.Node | undefined,
  type: ts.Type,
  typeChecker: ts.TypeChecker,
  options: visitorOptions
): boolean {
  if (isExplicitlyNonProxyNode(node) || options.unknownsAreNotAsyncMock) {
    return false;
  }

  if (options.unknownsAreNotAsyncMock) {
    return false;
  }
  if (!type) return false;

  // If the type is 'any' or 'unknown', it could be an AsyncMock
  if (type.flags & ts.TypeFlags.Any || type.flags & ts.TypeFlags.Unknown) {
    return true;
  }

  // If the type is a union, check if any constituent type is AsyncMock
  if (type.isUnion()) {
    return type.types.some(
      (t) =>
        isAsyncMockType(undefined, t, typeChecker, {}) ||
        couldBeAsyncMockType(undefined, t, typeChecker, {})
    );
  }

  return false;
}

function isAssignmentExpression(
  node: ts.Node
): node is ts.AssignmentExpression<ts.EqualsToken> {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken
  );
}

function isBinaryExpression(node: ts.Node): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
      node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken ||
      node.operatorToken.kind === ts.SyntaxKind.GreaterThanToken ||
      node.operatorToken.kind === ts.SyntaxKind.LessThanToken ||
      node.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken ||
      node.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken)
  );
}

function isFunctionLikeExpression(
  node: ts.Node
): node is ts.FunctionLikeDeclaration {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node)
  );
}

// transformation functions

function visitArgument(
  arg: ts.Expression,
  visit: ts.Visitor,
  typeChecker: ts.TypeChecker,
  debug: boolean,
  options: visitorOptions
): ts.Expression {
  // Recursively transform the argument
  return ts.visitNode(arg, (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      const leftmostExp = findLeftmostExpression(node);
      const baseType = typeChecker.getTypeAtLocation(leftmostExp);
      if (isAsyncMockType(leftmostExp, baseType, typeChecker, options)) {
        return visitPropertyAccess(node, visit, debug);
      }
      if (couldBeAsyncMockType(leftmostExp, baseType, typeChecker, options)) {
        return visitPropertyAccessWithRuntimeCheck(
          node,
          visit,
          debug
        ) as ts.Expression;
      }
    } else if (ts.isCallExpression(node)) {
      const leftmostExp = findLeftmostExpression(node.expression);
      const baseType = typeChecker.getTypeAtLocation(leftmostExp);
      if (isAsyncMockType(leftmostExp, baseType, typeChecker, options)) {
        return visitCallExpression(node, visit, typeChecker, debug, options);
      }
      if (couldBeAsyncMockType(leftmostExp, baseType, typeChecker, options)) {
        return visitCallExpressionWithRuntimeCheck(
          node,
          visit,
          typeChecker,
          debug,
          options
        ) as ts.Expression;
      }
    }
    return ts.visitEachChild(
      node,
      (child) =>
        visitArgument(
          child as ts.Expression,
          visit,
          typeChecker,
          debug,
          options
        ),
      undefined
    );
  }) as ts.Expression;
}

function visitCallExpressionWithRuntimeCheck(
  node: ts.CallExpression,
  visit: ts.Visitor,
  typeChecker: ts.TypeChecker,
  debug: boolean,
  options: visitorOptions
): ts.Node {
  const factory = ts.factory;

  const transformCall = (node: ts.CallExpression) => {
    if (ts.isPropertyAccessExpression(node.expression)) {
      const transformedBase = ts.visitNode(
        node.expression.expression,
        visit
      ) as ts.Expression;

      // Transform each argument, handling AsyncMock parameters
      const transformedArguments = node.arguments.map((arg) => {
        return visitArgument(arg, visit, typeChecker, debug, options);
      });

      return factory.createCallExpression(
        factory.createPropertyAccessExpression(
          transformedBase,
          node.expression.name
        ),
        node.typeArguments,
        transformedArguments
      );
    }

    return ts.visitNode(node.expression, visit) as ts.Expression;
  };

  // Transform the callee expression
  const transformedExpression = transformCall(node);

  // Create the AsyncMock path: await a.method(...transformedArguments)
  const asyncCall = factory.createAwaitExpression(transformedExpression);

  // Create the runtime check: a.isProxy ? await a.method(...args) : a.method(...args)
  const leftmostExp = findLeftmostExpression(node.expression);
  if (leftmostExp === node.expression) {
    return proxyWrapNode(
      leftmostExp,
      factory.createAwaitExpression(transformedExpression),
      node
    );
  }
  return proxyWrapNode(leftmostExp, asyncCall, transformedExpression);
}

function proxyWrapNode(
  nodeToCheck: ts.Expression,
  nonProxyExpression: ts.Expression,
  proxyExpression: ts.Expression
) {
  const condition = createProxyCheck(nodeToCheck);

  return ts.factory.createAwaitExpression(
    ts.factory.createParenthesizedExpression(
      ts.factory.createConditionalExpression(
        condition,
        undefined,
        nonProxyExpression,
        undefined,
        proxyExpression
      )
    )
  );
}

function visitFunctionParameterDeclarations(
  node: ts.FunctionLikeDeclaration,
  typeChecker: ts.TypeChecker,
  options: visitorOptions
): ts.ParameterDeclaration[] {
  const factory = ts.factory;
  const parameters = [...node.parameters];
  const transformedParameters = parameters.map((param) => {
    const paramType = typeChecker.getTypeAtLocation(param);

    if (couldBeAsyncMockType(undefined, paramType, typeChecker, options)) {
      return factory.updateParameterDeclaration(
        param,
        undefined,
        undefined,
        param.name,
        param.questionToken,
        createMaybeProxyTypeLiteral(factory),
        param.initializer
      );
    }
    return param;
  });

  return transformedParameters;
}

function visitPropertyAccessWithRuntimeCheck(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  visit: ts.Visitor,
  debug: boolean
): ts.Expression {
  printNode(node, debug);

  const factory = ts.factory;
  // Transform the expression part (e.g., 'b' in 'b.parent')
  const transformedExpression = ts.visitNode(
    node.expression,
    visit
  ) as ts.Expression;

  const propertyName = ts.isElementAccessExpression(node)
    ? node.argumentExpression
    : ts.factory.createStringLiteral(node.name.text);

  // Create the AsyncMock path: await b.parent()
  const asyncCall = factory.createAwaitExpression(
    factory.createCallExpression(
      factory.createElementAccessExpression(
        transformedExpression,
        propertyName
      ),
      undefined,
      []
    )
  );

  // Create the regular path: b.parent
  const regularAccess = factory.createElementAccessExpression(
    transformedExpression,
    propertyName
  );

  return proxyWrapNode(node.expression, asyncCall, regularAccess);
}

function visitFunctionLikeBody(
  funcNode: ts.FunctionLikeDeclaration,
  visit: ts.Visitor,
  typeChecker: ts.TypeChecker,
  context: ts.TransformationContext,
  onTransformedFunction: (node: ts.Node) => void,
  debug: boolean
): ts.Block | undefined {
  const factory = context.factory;

  if (!funcNode.body) {
    return funcNode.body;
  }
  // Normalize the body to a block
  let functionBody: ts.Block;
  if (ts.isBlock(funcNode.body!)) {
    functionBody = funcNode.body;
  } else {
    functionBody = factory.createBlock(
      [factory.createReturnStatement(funcNode.body)],
      true
    );
  }

  // Transform the function body
  const newStatements = functionBody.statements.map((statement) =>
    visitNode(statement, typeChecker, context, onTransformedFunction, debug)
  );

  return factory.createBlock(newStatements as ts.Statement[], true);
}

function visitElementAccessExpression(
  node: ts.ElementAccessExpression,
  visit: ts.Visitor,
  typeChecker: ts.TypeChecker,
  debug: boolean,
  options: visitorOptions
): ts.Node {
  const visitedExpression = ts.visitNode(
    node.expression,
    visit
  ) as ts.Expression;

  const transformArgument = (arg: ts.Expression) => {
    const visited = ts.visitNode(arg, visit) as ts.Expression;
    if (ts.isPropertyAccessExpression(arg)) {
      const leftmostExp = findLeftmostExpression(arg);
      const baseType = typeChecker.getTypeAtLocation(leftmostExp);
      if (isAsyncMockType(leftmostExp, baseType, typeChecker, options)) {
        return visitPropertyAccess(arg, visit, debug) || visited;
      }
    }
    return visited;
  };

  const transformedArgument = transformArgument(node.argumentExpression);

  const elementAccessExpression = ts.factory.createElementAccessExpression(
    visitedExpression,
    transformedArgument as ts.Expression
  );

  const call = ts.factory.createCallExpression(
    elementAccessExpression,
    undefined,
    []
  );

  return ts.factory.createAwaitExpression(call);
}

function visitCallExpression(
  node: ts.CallExpression,
  visit: ts.Visitor,
  typeChecker: ts.TypeChecker,
  debug: boolean,
  options: visitorOptions
): ts.Node {
  printNode(node, debug);

  const visitedExpression = ts.visitNode(
    node.expression,
    visit
  ) as ts.Expression;
  // Transform each argument and await it if it's a property access on an AsyncMock
  const transformedArguments = node.arguments.map((arg) => {
    const visited = ts.visitNode(arg, visit) as ts.Expression;
    // If the argument is a property access that wasn't transformed (because it was in an argument position),
    // we need to transform it now
    if (ts.isPropertyAccessExpression(arg)) {
      const leftmostExp = findLeftmostExpression(arg);
      const baseType = typeChecker.getTypeAtLocation(leftmostExp);
      if (isAsyncMockType(leftmostExp, baseType, typeChecker, options)) {
        return visitPropertyAccess(arg, visit, debug) || visited;
      }
    }
    return visited;
  });

  const callExpression = ts.factory.createCallExpression(
    visitedExpression,
    node.typeArguments,
    transformedArguments as ts.Expression[]
  );

  return ts.factory.createAwaitExpression(callExpression);
}

function visitPropertyAccess(
  node: ts.PropertyAccessExpression,
  visit: ts.Visitor,
  debug: boolean
): ts.Node {
  printNode(node, debug);

  const parent = node.parent;
  if (parent && ts.isCallExpression(parent) && parent.expression === node) {
    return ts.visitEachChild(node, visit, undefined);
  }

  const transformedExpression = ts.visitNode(
    node.expression,
    visit
  ) as ts.Expression;

  const propertyAccess = ts.factory.createElementAccessExpression(
    transformedExpression,
    ts.factory.createStringLiteral(node.name.text)
  );

  const call = ts.factory.createCallExpression(propertyAccess, undefined, []);

  return ts.factory.createAwaitExpression(call);
}

function visitAssignment(
  node: ts.BinaryExpression,
  visit: ts.Visitor,
  debug: boolean
): ts.Node {
  const transformedLeftSide = ts.visitNode(node.left, visit) as ts.Expression;
  const transformedRightSide = ts.visitNode(node.right, visit) as ts.Expression;

  const innerLeftSide = (transformedLeftSide as ts.AwaitExpression).expression;
  const methodCall = (innerLeftSide as ts.AwaitExpression)
    .expression as ts.CallExpression;

  const newCallExpr = ts.factory.createCallExpression(
    methodCall,
    methodCall.typeArguments,
    [
      createObjectLiteral(transformedRightSide, [
        { type: "type", value: "assignment" },
      ]),
    ]
  );

  return ts.factory.createAwaitExpression(newCallExpr);
}

function visitComparisonWithRuntimeCheck(
  node: ts.BinaryExpression,
  visit: ts.Visitor,
  typeChecker: ts.TypeChecker,
  debug: boolean,
  options: visitorOptions
): ts.Node {
  return visitComparison(node, visit, typeChecker, debug, options);
}

function visitComparison(
  node: ts.BinaryExpression,
  visit: ts.Visitor,
  typeChecker: ts.TypeChecker,
  debug: boolean,
  options: visitorOptions
): ts.Node {
  const leftType = typeChecker.getTypeAtLocation(node.left);
  const rightType = typeChecker.getTypeAtLocation(node.right);

  const isLeftAsyncMock = isAsyncMockType(
    node.left,
    leftType,
    typeChecker,
    options
  );
  const isRightAsyncMock = isAsyncMockType(
    node.right,
    rightType,
    typeChecker,
    options
  );
  const couldLeftBeAsyncMock = couldBeAsyncMockType(
    node.left,
    leftType,
    typeChecker,
    options
  );
  const couldRightBeAsyncMock = couldBeAsyncMockType(
    node.right,
    rightType,
    typeChecker,
    options
  );

  // If neither side could be AsyncMock, return original
  if (
    !isLeftAsyncMock &&
    !isRightAsyncMock &&
    !couldLeftBeAsyncMock &&
    !couldRightBeAsyncMock
  ) {
    return node;
  }

  const transformedLeftSide = ts.visitNode(node.left, visit) as ts.Expression;
  const transformedRightSide = ts.visitNode(node.right, visit) as ts.Expression;

  if (couldLeftBeAsyncMock && !couldRightBeAsyncMock) {
    return createProxiedOneSideCompareCall(
      transformedLeftSide,
      node.right,
      node,
      node.operatorToken.kind
    );
  }

  if (!couldLeftBeAsyncMock && couldRightBeAsyncMock) {
    return createProxiedOneSideCompareCall(
      transformedRightSide,
      node.left,
      node,
      getInvertedOperator(node.operatorToken.kind)
    );
  }

  if (couldLeftBeAsyncMock && couldRightBeAsyncMock) {
    const leftIsProxyCheck = createProxyCheck(transformedLeftSide);
    const rightIsProxyCheck = createProxyCheck(transformedRightSide);

    return ts.factory.createConditionalExpression(
      leftIsProxyCheck,
      ts.factory.createToken(ts.SyntaxKind.QuestionToken),
      // left is proxy
      ts.factory.createConditionalExpression(
        rightIsProxyCheck,
        ts.factory.createToken(ts.SyntaxKind.QuestionToken),
        // both are proxies
        createProxiedCompareCall(
          transformedLeftSide,
          ts.factory.createAwaitExpression(
            ts.factory.createCallExpression(transformedRightSide, undefined, [])
          ),
          node.operatorToken.kind
        ),
        ts.factory.createToken(ts.SyntaxKind.ColonToken),
        // only left is proxy
        createProxiedCompareCall(
          transformedLeftSide,
          transformedRightSide,
          node.operatorToken.kind
        )
      ),
      ts.factory.createToken(ts.SyntaxKind.ColonToken),
      // left is not proxy
      ts.factory.createConditionalExpression(
        rightIsProxyCheck,
        ts.factory.createToken(ts.SyntaxKind.QuestionToken),
        // only right is proxy
        createProxiedCompareCall(
          transformedRightSide,
          transformedLeftSide,
          getInvertedOperator(node.operatorToken.kind)
        ),
        ts.factory.createToken(ts.SyntaxKind.ColonToken),
        // neither is proxy
        ts.factory.createBinaryExpression(
          transformedLeftSide,
          node.operatorToken,
          transformedRightSide
        )
      )
    );
  }

  return node;
}

function createMaybeProxyTypeLiteral(factory: ts.NodeFactory): ts.TypeNode {
  return factory.createUnionTypeNode([
    // Reference to AsyncMock type
    factory.createTypeReferenceNode(
      factory.createIdentifier("AsyncMock"),
      undefined
    ),
    // Any type
    factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
  ]);
}

// Helper function to invert comparison operators
function getInvertedOperator(kind: ts.BinaryOperator): ts.SyntaxKind {
  switch (kind) {
    case ts.SyntaxKind.GreaterThanToken:
      return ts.SyntaxKind.LessThanToken;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return ts.SyntaxKind.LessThanEqualsToken;
    case ts.SyntaxKind.LessThanToken:
      return ts.SyntaxKind.GreaterThanToken;
    case ts.SyntaxKind.LessThanEqualsToken:
      return ts.SyntaxKind.GreaterThanEqualsToken;
    // These don't need to be inverted
    case ts.SyntaxKind.EqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      return kind;
    default:
      return kind;
  }
}

function findLeftmostExpression(node: ts.Node): ts.Expression {
  let leftmostExp = node as ts.Expression;
  while (
    ts.isPropertyAccessExpression(leftmostExp) ||
    ts.isCallExpression(leftmostExp) ||
    ts.isElementAccessExpression(leftmostExp)
  ) {
    leftmostExp = leftmostExp.expression;
  }
  return leftmostExp;
}

const createProxiedOneSideCompareCall = (
  maybeProxyExpr: ts.Expression,
  valueExpr: ts.Expression,
  originalExpr: ts.Expression,
  operator: ts.SyntaxKind
) => {
  const proxyCheck = createProxyCheck(maybeProxyExpr);

  return ts.factory.createConditionalExpression(
    proxyCheck,
    ts.factory.createToken(ts.SyntaxKind.QuestionToken),
    // left is proxy
    createProxiedCompareCall(maybeProxyExpr, valueExpr, operator),
    ts.factory.createToken(ts.SyntaxKind.ColonToken),
    // left is not proxy
    originalExpr
  );
};

const createProxiedCompareCall = (
  proxyExpr: ts.Expression,
  valueExpr: ts.Expression,
  operator: ts.SyntaxKind
) => {
  return ts.factory.createAwaitExpression(
    ts.factory.createCallExpression(
      ts.factory.createPropertyAccessExpression(proxyExpr, "__compare"),
      undefined,
      [ts.factory.createStringLiteral(operator.toString()), valueExpr]
    )
  );
};

function createObjectLiteral(
  rightSideExpr: ts.Expression,
  extraProps: { type: string; value: string }[]
): ts.Expression {
  return ts.factory.createObjectLiteralExpression(
    [
      ...extraProps.map((prop) =>
        ts.factory.createPropertyAssignment(
          ts.factory.createStringLiteral(prop.type),
          ts.factory.createStringLiteral(prop.value)
        )
      ),
      // Create the 'value' property with the expression
      ts.factory.createPropertyAssignment(
        ts.factory.createStringLiteral("value"),
        rightSideExpr
      ),
    ],
    true
  ); // true for multiline formatting
}

function createProxyCheck(expr: ts.Expression): ts.PropertyAccessChain {
  return ts.factory.createPropertyAccessChain(
    expr,
    ts.factory.createToken(ts.SyntaxKind.QuestionDotToken),
    "isProxy"
  );
}
