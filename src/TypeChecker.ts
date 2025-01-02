import ts from "typescript";
import { getTypeDefinitions } from "./type-definitions.js";

const rootFileName = "input.ts";
const runtimeTypes: Record<
  string,
  (asyncProxyNames: string[], nonProxyNames: string[], debug: boolean) => string
> = {
  "node_modules/my-runtime-types.d.ts": getTypeDefinitions,
};

export async function createTypeChecker(
  codeString: string,
  globalProxyNames: string[],
  globalNonProxyNames: string[],
  debug: boolean = false
) {
  const compilerHost = await createInMemoryCompilerHost(
    codeString,
    globalProxyNames,
    globalNonProxyNames,
    debug
  );
  const program = createProgram(compilerHost, ["my-runtime-types"]);
  const typeChecker = program.getTypeChecker();

  return typeChecker;
}

function createProgram(compilerHost: ts.CompilerHost, types: string[]) {
  // Create a program to trigger lib loading
  const program = ts.createProgram({
    rootNames: [rootFileName],
    options: {
      types: types,
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
        return runtimeTypes[fileName](
          globalProxyNames,
          globalNonProxyNames,
          debug
        );
      }
      debug && console.warn("[readFile]File does not exist:", fileName);
      return undefined;
    },
  };
}
