import ts from "typescript";
import { getTypeDefinitions } from "./generated/type-definitions.js";
const runtimeTypes = {
    "node_modules/my-runtime-types.d.ts": getTypeDefinitions,
};
export async function transpileTypescript(codeString, sourceUrl, globalMockNames, debug = false) {
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
function createTransformer(typeChecker, debug) {
    return (context) => {
        const visit = (node) => {
            debug && console.log(`Visiting node: ${node.getText()}`, node);
            // Handle property access expressions
            if (ts.isPropertyAccessExpression(node)) {
                debug && console.log("Visiting property access:", node);
                const expressionType = typeChecker.getTypeAtLocation(node.expression);
                const expressionSymbol = typeChecker.getSymbolAtLocation(node.expression);
                debug && console.log("Property access expression type:", expressionType);
                debug && console.log("Property access expression symbol:", expressionSymbol);
                // Get the declaration of the identifier
                if (ts.isIdentifier(node.expression)) {
                    const symbol = typeChecker.getSymbolAtLocation(node.expression);
                    if (symbol?.declarations?.[0]) {
                        const declType = typeChecker.getTypeAtLocation(symbol.declarations[0]);
                        debug && console.log("Declaration type:", declType);
                        if (isRipulTransformedType(declType)) {
                            debug && console.log("Found AsyncMock type in property access via declaration");
                            return ts.factory.createAwaitExpression(node);
                        }
                    }
                }
                if (isRipulTransformedType(expressionType)) {
                    debug && console.log("Found AsyncMock type in property access", expressionType);
                    return ts.factory.createAwaitExpression(node);
                }
            }
            // Handle variable declarations
            if (ts.isVariableDeclaration(node)) {
                debug && console.log("Variable declaration:", node.getText());
                if (node.initializer) {
                    const initializerType = typeChecker.getTypeAtLocation(node.initializer);
                    const variableType = typeChecker.getTypeAtLocation(node);
                    debug && console.log("Initializer type:", initializerType);
                    debug && console.log("Variable type:", variableType);
                    // Store the type information in the symbol table
                    if (ts.isIdentifier(node.name)) {
                        const symbol = typeChecker.getSymbolAtLocation(node.name);
                        if (symbol && isRipulTransformedType(initializerType)) {
                            debug && console.log("Marking variable as AsyncMock:", node.name.getText());
                            // You might need to modify your type checker to store this information
                        }
                    }
                }
            }
            // Handle call expressions
            if (ts.isCallExpression(node)) {
                debug && console.log("Visiting call expression:", node);
                // Check the base object type (e.g., 'document' in document.querySelector)
                const baseObj = getBaseObject(node.expression);
                const baseObjType = baseObj && typeChecker.getTypeAtLocation(baseObj);
                if (baseObjType && isRipulTransformedType(baseObjType)) {
                    debug && console.log("Found ripul type in base object of call expression", baseObjType);
                    return ts.factory.createAwaitExpression(node);
                }
                const expressionType = typeChecker.getTypeAtLocation(node.expression);
                debug && console.log("expressionType:", expressionType.symbol);
                if (isRipulTransformedType(expressionType)) {
                    debug && console.log("Found ripul type in call expression", expressionType);
                    return ts.factory.createAwaitExpression(node);
                }
            }
            return ts.visitEachChild(node, visit, context);
        };
        // Helper function to get the base object of a property access chain
        function getBaseObject(node) {
            if (ts.isPropertyAccessExpression(node)) {
                return getBaseObject(node.expression);
            }
            if (ts.isCallExpression(node)) {
                return getBaseObject(node.expression);
            }
            return node;
        }
        function isRipulTransformedType(type) {
            debug && console.log("Checking type:", type);
            if (!type)
                return false;
            // Check for error types
            if (type.flags & ts.TypeFlags.Any || type.flags & ts.TypeFlags.Unknown) {
                debug && console.log("Found error or any type");
                return false;
            }
            // Check if it's a Promise<AsyncMock>
            if (type.symbol?.name === "Promise") {
                const typeArguments = type.aliasTypeArguments || type.typeArguments;
                if (typeArguments && typeArguments.length > 0) {
                    return isRipulTransformedType(typeArguments[0]);
                }
            }
            // Direct AsyncMock check
            if (type.symbol?.name === "AsyncMock") {
                return true;
            }
            // Check if it's a property of AsyncMock
            const parentType = type.parent;
            if (parentType?.symbol?.name === "AsyncMock") {
                return true;
            }
            // Check if it's a union type
            if (type.flags & ts.TypeFlags.Union) {
                const unionType = type;
                return unionType.types.some(t => isRipulTransformedType(t));
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
//# sourceMappingURL=Transpiler.js.map