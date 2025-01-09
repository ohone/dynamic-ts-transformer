// alias function to avoid name conflict
import { originalTranspileTypescript } from "./Transpiler.js";
const cache = new Map();
export async function transpileTypescript(codeString, sourceUrl, globalProxyNames = [], globalNonProxyNames = [], debug = false, sourceMap = true) {
    if (cache.has(codeString)) {
        return cache.get(codeString);
    }
    console.log("Transpiling code:", sourceUrl);
    const transpiledCode = await originalTranspileTypescript(codeString, sourceUrl, globalProxyNames, globalNonProxyNames, debug, sourceMap);
    console.log("Transpiled");
    cache.set(codeString, transpiledCode);
    return transpiledCode;
}
//# sourceMappingURL=CachingTranspiler.js.map