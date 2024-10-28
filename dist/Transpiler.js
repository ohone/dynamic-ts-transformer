import ts, { isCallExpression } from "typescript";
import { getTypeDefinitions } from "./generated/type-definitions.js";
const runtimeTypes = {
    "node_modules/my-runtime-types.d.ts": getTypeDefinitions,
};
export async function transpileTypescript(codeString, sourceUrl, globalMockNames) {
    const typeChecker = await createTypeChecker(codeString, globalMockNames);
    const { outputText } = ts.transpileModule(`//\n//\n` +
        codeString, {
        compilerOptions: {
            module: ts.ModuleKind.ES2022,
            target: ts.ScriptTarget.ES2023,
            inlineSourceMap: true, //Disabled for now, as the maps were mangled, happy to use JS debugging for now
            inlineSources: true,
            sourceMap: true,
        },
        fileName: sourceUrl,
        transformers: {
            before: [createTransformer(typeChecker)],
        },
    });
    // WHY ??
    // the map files are off by 2, so we added two comment lines before transpiling
    // we then trim those lines before gen of dynamic function, so that we correct the off by 2
    return (outputText.split("\n").slice(2).join("\n") + "\n//# sourceURL=" + sourceUrl);
}
async function createInMemoryCompilerHost(sourceCode, globalMockNames) {
    const sourceFile = ts.createSourceFile("input.ts", sourceCode, ts.ScriptTarget.Latest, true);
    return {
        getSourceFile: (fileName, languageVersion) => {
            if (fileName === "input.ts") {
                return sourceFile;
            }
            if (runtimeTypes[fileName] !== undefined) {
                console.log("Loading lib file:", fileName);
                return ts.createSourceFile(fileName, runtimeTypes[fileName](globalMockNames), languageVersion);
            }
            console.warn("[getFileSource]File does not exist:", fileName);
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
                console.log("Checking for lib file:", fileName);
                return true;
            }
            console.warn("[fileExists]File does not exist:", fileName);
            return false;
        },
        readFile: (fileName) => {
            if (fileName === "input.ts") {
                return sourceCode;
            }
            if (runtimeTypes[fileName] !== undefined) {
                console.log("Reading lib file:", fileName);
                return runtimeTypes[fileName](globalMockNames);
            }
            console.warn("[readFile]File does not exist:", fileName);
            return undefined;
        },
    };
}
function createTransformer(typeChecker) {
    return (context) => {
        const visit = (node) => {
            if (ts.isPropertyAccessExpression(node) ||
                ts.isElementAccessExpression(node)) {
                const type = typeChecker.getTypeAtLocation(node.expression);
                if (type?.symbol !== undefined) {
                    console.log("visited type:", type?.symbol);
                }
                if (isRipulTransformedType(type)) {
                    console.log("Found ripul type", type);
                    return ts.factory.createAwaitExpression(node);
                }
            }
            if (isCallExpression(node)) {
                const expressionType = typeChecker.getTypeAtLocation(node);
                if (isRipulTransformedType(expressionType)) {
                    console.log("Found ripul type", expressionType);
                    return ts.factory.createAwaitExpression(node);
                }
            }
            return ts.visitEachChild(node, visit, context);
        };
        function isRipulTransformedType(type) {
            if (type.symbol?.name === "AsyncMock") {
                console.log(type.symbol.name);
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
async function createTypeChecker(sourceCode, globalObjectNames) {
    const compilerHost = await createInMemoryCompilerHost(sourceCode, globalObjectNames);
    const program = createProgram(compilerHost);
    return program.getTypeChecker();
}
//# sourceMappingURL=Transpiler.js.map