"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTransformer = createTransformer;
exports.transpileTypescript = transpileTypescript;
const typescript_1 = __importStar(require("typescript"));
const type_definitions_1 = require("./generated/type-definitions");
const libFileMap = {
    "lib.dom.d.ts": "types/lib.dom.d.ts",
    "lib.dom.iterable.d.ts": "types/lib.dom.iterable.d.ts",
    "ChromeMessenger.d.ts": "types/ChromeMessenger/src/index.d.ts",
    "ChromeMessenger/global.d.ts": "types/ChromeMessenger/src/chrome-global.d.ts",
};
const libFileContentsMap = {};
const runtimeTypes = {
    "my-types.d.ts": type_definitions_1.myTypeDefinitions
};
function createInMemoryCompilerHost(sourceCode) {
    return __awaiter(this, void 0, void 0, function* () {
        const sourceFile = typescript_1.default.createSourceFile("input.ts", sourceCode, typescript_1.default.ScriptTarget.Latest, true);
        return {
            getSourceFile: (fileName, languageVersion) => {
                if (fileName === "input.ts") {
                    return sourceFile;
                }
                if (fileName.includes("lib.")) {
                    console.log("Loading lib file:", fileName);
                    const content = libFileContentsMap[fileName];
                    if (content) {
                        return typescript_1.default.createSourceFile(fileName, content, languageVersion);
                    }
                }
                if (libFileMap[fileName] !== undefined) {
                    console.log(fileName);
                    return typescript_1.default.createSourceFile(fileName, sourceCode, languageVersion);
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
                if (fileName.includes("lib.") || libFileMap[fileName] !== undefined) {
                    console.log("Checking for lib file:", fileName);
                    const result = libFileMap[fileName] !== undefined;
                    if (!result) {
                        console.warn("[fileExists]Could not load lib file:", fileName);
                    }
                    return result;
                }
                console.warn("[fileExists]File does not exist:", fileName);
                return false;
            },
            readFile: (fileName) => {
                if (fileName === "input.ts") {
                    return sourceCode;
                }
                if (fileName.includes("lib.")) {
                    console.log("Reading lib file:", fileName);
                    return libFileMap[fileName];
                }
                console.warn("[readFile]File does not exist:", fileName);
                return undefined;
            },
        };
    });
}
function createTransformer(typeChecker) {
    return (context) => {
        const visit = (node) => {
            if (typescript_1.default.isPropertyAccessExpression(node) ||
                typescript_1.default.isElementAccessExpression(node)) {
                const type = typeChecker.getTypeAtLocation(node.expression);
                if ((type === null || type === void 0 ? void 0 : type.symbol) !== undefined) {
                    console.log("visited type:", type === null || type === void 0 ? void 0 : type.symbol);
                }
                if (isRipulTransformedType(type)) {
                    console.log("Found ripul type", type);
                    return typescript_1.default.factory.createAwaitExpression(node);
                }
            }
            if ((0, typescript_1.isCallExpression)(node)) {
                const expressionType = typeChecker.getTypeAtLocation(node);
                if (isRipulTransformedType(expressionType)) {
                    console.log("Found ripul type", expressionType);
                    return typescript_1.default.factory.createAwaitExpression(node);
                }
            }
            return typescript_1.default.visitEachChild(node, visit, context);
        };
        function isRipulTransformedType(type) {
            var _a;
            if ((_a = type.symbol) === null || _a === void 0 ? void 0 : _a.name.startsWith("ripul_")) {
                console.log(type.symbol.name);
                return true;
            }
            return false;
        }
        return (sourceFile) => typescript_1.default.visitNode(sourceFile, visit);
    };
}
function transpileTypescript(codeString, sourceUrl) {
    return __awaiter(this, void 0, void 0, function* () {
        const typeChecker = yield createTypeChecker(codeString);
        const { outputText } = typescript_1.default.transpileModule(`//\n//\n` + `
/// <reference types="chromemessenger" />
/// <reference types="chromemessenger/global" /> \n` + codeString, {
            compilerOptions: {
                module: typescript_1.default.ModuleKind.ES2022,
                target: typescript_1.default.ScriptTarget.ES2023,
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
    });
}
function createProgram(compilerHost) {
    // Create a program to trigger lib loading
    const program = typescript_1.default.createProgram({
        rootNames: ["input.ts"],
        options: {
            lib: ["dom", "dom.iterable", "chromemessenger", "chromemessenger/global"],
            types: ["chromemessenger"],
            target: typescript_1.default.ScriptTarget.ESNext,
        },
        host: compilerHost,
    });
    return program;
}
function createTypeChecker(sourceCode) {
    return __awaiter(this, void 0, void 0, function* () {
        const compilerHost = yield createInMemoryCompilerHost(sourceCode);
        const program = createProgram(compilerHost);
        return program.getTypeChecker();
    });
}
