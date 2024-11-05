import ts from "typescript";
import { getTypeDefinitions } from "./type-definitions.js";

const rootFileName = "input.ts";

const runtimeTypes: Record<
  string,
  (names: string[], debug: boolean) => string
> = {
  "node_modules/my-runtime-types.d.ts": getTypeDefinitions,
};

export async function transpileTypescript(
  codeString: string,
  sourceUrl?: string | undefined,
  globalMockNames: string[] = [],
  debug: boolean = false
) {
  const typeChecker = await createTypeChecker(
    codeString,
    globalMockNames,
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

async function createInMemoryCompilerHost(
  sourceCode: string,
  globalMockNames: string[],
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
          runtimeTypes[fileName](globalMockNames, debug),
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
        return runtimeTypes[fileName](globalMockNames, debug);
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
  return (context) => {
    const visit: ts.Visitor = (node: ts.Node): ts.Node => {
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
          } else {
            console.warn("Property access");
            printNode(node, debug);
            const transformed = transformPropertyAccess(node as ts.PropertyAccessExpression, visit, debug);

            if (transformed){
              console.warn("Transformed to");
              printNode(transformed, debug);
              return transformed;
            }
            else{
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

    return (sourceFile) => ts.visitNode(sourceFile, visit) as ts.SourceFile;
  };
}

// Helper functions
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

function transformCallExpression(
  node: ts.CallExpression,
  visit: ts.Visitor,
  typeChecker: ts.TypeChecker,
  debug: boolean
): ts.Node {
  console.log("Call expression");
  printNode(node, debug);

  const visitedExpression = ts.visitNode(node.expression, visit) as ts.Expression;
  // Transform each argument and await it if it's a property access on an AsyncMock
  const transformedArguments = node.arguments.map(arg => {
    console.log("Argument");
    printNode(arg, debug);
    const visited = ts.visitNode(arg, visit) as ts.Expression;
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

  const callExpression = ts.factory.createCallExpression(
    visitedExpression,
    node.typeArguments,
    transformedArguments as ts.Expression[]
  );

  return ts.factory.createAwaitExpression(
    ts.factory.createParenthesizedExpression(callExpression)
  );
}

function transformPropertyAccess(
  node: ts.PropertyAccessExpression,
  visit: ts.Visitor,
  debug: boolean
): ts.Node | undefined {
  console.log("Property access");
  
  const parent = node.parent;
  if (ts.isCallExpression(parent) && parent.expression === node) {
    return undefined;
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

function transformAssignment(
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
    [createObjectLiteral(transformedRightSide)]
  );

  return ts.factory.createAwaitExpression(newCallExpr);
}

function isAsyncMockType(type: ts.Type, typeChecker: ts.TypeChecker): boolean {
  if (!type) return false;
  // Check for error types
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

async function createTypeChecker(
  sourceCode: string,
  globalObjectNames: string[],
  debug: boolean
): Promise<ts.TypeChecker> {
  const compilerHost = await createInMemoryCompilerHost(
    sourceCode,
    globalObjectNames,
    debug
  );
  const program = createProgram(compilerHost);
  return program.getTypeChecker();
}


function functionIsAsync(node: ts.FunctionLikeDeclaration): boolean {
  return !!node.modifiers?.some(
    (mod) => mod.kind === ts.SyntaxKind.AsyncKeyword
  );
}

function transformContainingFunction(node: ts.Node): ts.Node {
  return node;
}

function nodeIsFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node)
  );
}

function createObjectLiteral(rightSideExpr: ts.Expression): ts.Expression {
  return ts.factory.createObjectLiteralExpression(
    [
      // Create the 'type' property
      ts.factory.createPropertyAssignment(
        ts.factory.createStringLiteral("type"),
        ts.factory.createStringLiteral("assignment")
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
