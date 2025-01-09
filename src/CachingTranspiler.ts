// alias function to avoid name conflict
import { originalTranspileTypescript } from "./Transpiler.js";

const cache = new Map<string, string>();

export async function transpileTypescript(
    codeString: string,
    sourceUrl?: string | undefined,
    globalProxyNames: string[] = [],
    globalNonProxyNames: string[] = [],
    debug: boolean = false,
    sourceMap: boolean = true
  ) {
    if (cache.has(codeString)) {
        return cache.get(codeString);
    }
    console.log("Transpiling code:", sourceUrl);
    const transpiledCode = await originalTranspileTypescript(codeString, sourceUrl, globalProxyNames, globalNonProxyNames, debug, sourceMap);
    console.log("Transpiled");
    cache.set(codeString, transpiledCode);
    return transpiledCode;
}