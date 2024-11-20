import ts from "typescript";
import { getTypeDefinitions } from "./type-definitions.js";

const rootFileName = "input.ts";

const runtimeTypes: Record<
  string,
  (asyncProxyNames: string[], nonProxyNames: string[], debug: boolean) => string
> = {
  "node_modules/my-runtime-types.d.ts": getTypeDefinitions,
};

export async function transpileTypescript(
  codeString: string,
  sourceUrl?: string | undefined,
  globalProxyNames: string[] = [],
  globalNonProxyNames: string[] = [],
  debug: boolean = false
) {
  const typeChecker = await createTypeChecker(
    codeString,
    globalProxyNames,
    globalNonProxyNames,
    debug
  );
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
  return (
    outputText.split("\n").slice(2).join("\n") + "\n//# sourceURL=" + sourceUrl
  );
}

async function createTypeChecker(
  sourceCode: string,
  globalProxyNames: string[],
  globalNonProxyNames: string[],
  debug: boolean
): Promise<ts.TypeChecker> {
  const compilerHost = await createInMemoryCompilerHost(
    sourceCode,
    globalProxyNames,
    globalNonProxyNames,
    debug
  );
  const program = createProgram(compilerHost);
  return program.getTypeChecker();
}

function createProgram(compilerHost: ts.CompilerHost) {
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

async function createInMemoryCompilerHost(
  sourceCode: string,
  globalProxyNames: string[],
  globalNonProxyNames: string[],
  debug: boolean = false
): Promise<ts.CompilerHost> {
  const sourceFile = ts.createSourceFile(
    rootFileName,
    sourceCode,
    ts.ScriptTarget.Latest,
    true
  );

  return {
    getSourceFile: (fileName: string, languageVersion: ts.ScriptTarget) => {
      if (fileName === rootFileName) {
        return sourceFile;
      }
      if (runtimeTypes[fileName] !== undefined) {
        debug && console.log("Loading lib file:", fileName);
        return ts.createSourceFile(
          fileName,
          runtimeTypes[fileName](globalProxyNames, globalNonProxyNames, debug),
          languageVersion
        );
      }
      debug && console.warn("[getFileSource]File does not exist:", fileName);
      return undefined;
    },
    writeFile: () => {},
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => false,
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => "",
    getNewLine: () => "\n",
    getDirectories: () => [],
    fileExists: (fileName: string) => {
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
    readFile: (fileName: string) => {
      if (fileName === rootFileName) {
        return sourceCode;
      }
      if (runtimeTypes[fileName] !== undefined) {
        debug && console.log("Reading lib file:", fileName);
        return runtimeTypes[fileName](globalProxyNames, globalNonProxyNames, debug);
      }
      debug && console.warn("[readFile]File does not exist:", fileName);
      return undefined;
    },
  };
}

const getPrinter = (() => {
  let printer: ts.Printer | undefined = undefined;
  return () =>
    (printer ??= ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }));
})();

const printNode = (node: ts.Node, debug: boolean) =>
  debug &&
  console.log(
    getPrinter().printNode(ts.EmitHint.Unspecified, node, node.getSourceFile())
  );

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
  return factory.updateFunctionDeclaration(
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
  debug: boolean
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

  const parameters = visitFunctionParameterDeclarations(node, typeChecker);
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

function visitNode(
  parentNode: ts.Node,
  typeChecker: ts.TypeChecker,
  context: ts.TransformationContext,
  onTransformedFunction: (node: ts.Node) => void,
  debug: boolean
): ts.Node {
  printNode(parentNode, debug);
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node)) {
      const leftmostExp = findLeftmostExpression(node.expression);

      const baseType = typeChecker.getTypeAtLocation(leftmostExp);

      if (isAsyncMockType(baseType, typeChecker)) {
        if (ts.isCallExpression(node)) {
          return visitCallExpression(node, visit, typeChecker, debug);
        } else {
          return visitPropertyAccess(node, visit, debug);
        }
      }
      if (couldBeAsyncMockType(baseType, typeChecker)) {
        if (ts.isCallExpression(node)) {
          return visitCallExpressionWithRuntimeCheck(
            node,
            visit,
            typeChecker,
            debug
          );
        } else {
          return visitPropertyAccessWithRuntimeCheck(node, visit, debug);
        }
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

    // Check for assignments
    if (isAssignmentExpression(node)) {
      const leftmostExp = findLeftmostExpression(node.left);

      const baseType = typeChecker.getTypeAtLocation(leftmostExp);

      if (isAsyncMockType(baseType, typeChecker)) {
        return visitAssignment(node, visit, debug);
      }

      if (couldBeAsyncMockType(baseType, typeChecker)) {
        return visitAssignmentWithRuntimeCheck(node, visit, debug);
      }
    }

    if (isBinaryExpression(node)) {
      return visitComparisonWithRuntimeCheck(node, visit, typeChecker, debug);
    }

    if (isFunctionLikeExpression(node)) {
      return visitFunctionLike(
        node,
        visit,
        typeChecker,
        context,
        onTransformedFunction,
        debug
      );
    }

    if (ts.isSpreadElement(node)) {
      return visitSpreadElement(node, visit, typeChecker, debug);
    }

    // Continue visiting other nodes
    return ts.visitEachChild(node, visit, context);
  };
  return ts.visitNode(parentNode, visit);
}

function isAsyncMockType(type: ts.Type, typeChecker: ts.TypeChecker): boolean {
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
    const objType = type as ts.ObjectType;
    const callSignatures = objType.getCallSignatures();
    if (callSignatures.length > 0) {
      const returnType = typeChecker.getReturnTypeOfSignature(
        callSignatures[0]
      );
      return isAsyncMockType(returnType, typeChecker);
    }
  }

  // Check if it's a property of AsyncMock
  const parentType = (type as any).parent;
  if (parentType?.symbol?.name === "AsyncMock") {
    return true;
  }

  return false;
}

function visitSpreadElement(node: ts.SpreadElement, visit: ts.Visitor, typeChecker: ts.TypeChecker, debug: boolean): ts.Node {
  const transformedExpression = ts.visitNode(node.expression, visit) as ts.Expression;
  return ts.factory.createSpreadElement(transformedExpression);
}

function couldBeAsyncMockType(
  type: ts.Type,
  typeChecker: ts.TypeChecker
): boolean {
  if (!type) return false;

  // If the type is 'any' or 'unknown', it could be an AsyncMock
  if (type.flags & ts.TypeFlags.Any || type.flags & ts.TypeFlags.Unknown) {
    return true;
  }

  // If the type is a union, check if any constituent type is AsyncMock
  if (type.isUnion()) {
    return type.types.some(
      (t) =>
        isAsyncMockType(t, typeChecker) || couldBeAsyncMockType(t, typeChecker)
    );
  }

  return false;
}

function isAssignmentExpression(node: ts.Node): node is ts.BinaryExpression {
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
  debug: boolean
): ts.Expression {
  // Recursively transform the argument
  return ts.visitNode(arg, (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      const leftmostExp = findLeftmostExpression(node);
      const baseType = typeChecker.getTypeAtLocation(leftmostExp);
      if (isAsyncMockType(baseType, typeChecker)) {
        return visitPropertyAccess(node, visit, debug);
      }
      if (couldBeAsyncMockType(baseType, typeChecker)) {
        return visitPropertyAccessWithRuntimeCheck(
          node,
          visit,
          debug
        ) as ts.Expression;
      }
    } else if (ts.isCallExpression(node)) {
      const leftmostExp = findLeftmostExpression(node.expression);
      const baseType = typeChecker.getTypeAtLocation(leftmostExp);
      if (isAsyncMockType(baseType, typeChecker)) {
        return visitCallExpression(node, visit, typeChecker, debug);
      }
      if (couldBeAsyncMockType(baseType, typeChecker)) {
        return visitCallExpressionWithRuntimeCheck(
          node,
          visit,
          typeChecker,
          debug
        ) as ts.Expression;
      }
    }
    return ts.visitEachChild(
      node,
      (child) =>
        visitArgument(child as ts.Expression, visit, typeChecker, debug),
      undefined
    );
  }) as ts.Expression;
}

function visitCallExpressionWithRuntimeCheck(
  node: ts.CallExpression,
  visit: ts.Visitor,
  typeChecker: ts.TypeChecker,
  debug: boolean
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
        return visitArgument(arg, visit, typeChecker, debug);
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
  const condition = factory.createPropertyAccessExpression(
    leftmostExp,
    "isProxy"
  );

  return factory.createParenthesizedExpression(
    factory.createConditionalExpression(
      condition,
      undefined,
      asyncCall,
      undefined,
      transformedExpression
    )
  );
}

function visitFunctionParameterDeclarations(
  node: ts.FunctionLikeDeclaration,
  typeChecker: ts.TypeChecker
): ts.ParameterDeclaration[] {
  const factory = ts.factory;
  const parameters = [...node.parameters];
  const transformedParameters = parameters.map((param) => {
    const paramType = typeChecker.getTypeAtLocation(param);

    if (couldBeAsyncMockType(paramType, typeChecker)) {
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

function visitAssignmentWithRuntimeCheck(
  node: ts.BinaryExpression,
  visit: ts.Visitor,
  debug: boolean
): ts.Node {
  const factory = ts.factory;

  // Transform the left and right sides
  const transformedLeftSide = ts.visitNode(node.left, visit) as ts.Expression;
  const transformedRightSide = ts.visitNode(node.right, visit) as ts.Expression;

  // For AsyncMock: await a.prop(value)
  const asyncCall = factory.createAwaitExpression(
    factory.createCallExpression(transformedLeftSide, undefined, [
      transformedRightSide,
    ])
  );

  // For regular object: a.prop = value
  const regularAssignment = factory.createBinaryExpression(
    transformedLeftSide,
    ts.SyntaxKind.EqualsToken,
    transformedRightSide
  );

  // Create the runtime check: a.isProxy ? await a.prop(value) : a.prop = value
  const leftmostExp = findLeftmostExpression(node.left);
  const condition = factory.createPropertyAccessExpression(
    leftmostExp,
    "isProxy"
  );

  return factory.createParenthesizedExpression(
    factory.createConditionalExpression(
      condition,
      undefined,
      asyncCall,
      undefined,
      regularAssignment
    )
  );
}

function visitPropertyAccessWithRuntimeCheck(
  node: ts.PropertyAccessExpression,
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

  const propertyName = node.name;

  // Create the AsyncMock path: await b.parent()
  const asyncCall = factory.createAwaitExpression(
    factory.createCallExpression(
      factory.createPropertyAccessExpression(
        transformedExpression,
        propertyName
      ),
      undefined,
      []
    )
  );

  // Create the regular path: b.parent
  const regularAccess = factory.createPropertyAccessExpression(
    transformedExpression,
    propertyName
  );

  // Create the runtime check: b.isProxy ? await b.parent() : b.parent
  const condition = factory.createPropertyAccessExpression(
    transformedExpression,
    "isProxy"
  );

  return factory.createParenthesizedExpression(
    factory.createConditionalExpression(
      condition,
      undefined,
      asyncCall,
      undefined,
      regularAccess
    )
  );
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

function visitCallExpression(
  node: ts.CallExpression,
  visit: ts.Visitor,
  typeChecker: ts.TypeChecker,
  debug: boolean
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
      if (isAsyncMockType(baseType, typeChecker)) {
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
  if (ts.isCallExpression(parent) && parent.expression === node) {
    return ts.visitEachChild(node, visit, undefined);
  }

  const transformedExpression = ts.visitNode(
    node.expression,
    visit
  ) as ts.Expression;

  const propertyAccess = ts.factory.createPropertyAccessExpression(
    transformedExpression,
    node.name
  );

  const functionCall = ts.factory.createCallExpression(
    propertyAccess,
    undefined,
    []
  );

  return ts.factory.createAwaitExpression(functionCall);
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
  debug: boolean
): ts.Node {
  return visitComparison(node, visit, typeChecker, debug);
}

function visitComparison(
  node: ts.BinaryExpression,
  visit: ts.Visitor,
  typeChecker: ts.TypeChecker,
  debug: boolean
): ts.Node {
  const leftType = typeChecker.getTypeAtLocation(node.left);
  const rightType = typeChecker.getTypeAtLocation(node.right);

  const isLeftAsyncMock = isAsyncMockType(leftType, typeChecker);
  const isRightAsyncMock = isAsyncMockType(rightType, typeChecker);
  const couldLeftBeAsyncMock = couldBeAsyncMockType(leftType, typeChecker);
  const couldRightBeAsyncMock = couldBeAsyncMockType(rightType, typeChecker);

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
    const leftIsProxyCheck = ts.factory.createPropertyAccessExpression(
      transformedLeftSide,
      "isProxy"
    );
    const rightIsProxyCheck = ts.factory.createPropertyAccessExpression(
      transformedRightSide,
      "isProxy"
    );

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
    ts.isCallExpression(leftmostExp)
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
  const proxyCheck = ts.factory.createPropertyAccessExpression(
    maybeProxyExpr,
    "isProxy"
  );

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
