import { expect, test } from 'vitest';
import { transpileTypescript } from "../dist/Transpiler.js";

const url = "http://localhost:8080/dev.ts";

function createProxy(obj: any){
    return new Proxy(obj, {
        get(target, prop) {
            if (prop === "isProxy") return true;
            return Promise.resolve(target[prop]);
        }
    })
}

function createFunction(code: string){
    return `
    return (async function() {
    ${code}
  })()`;
}

// call expressions

test("returns from proxy call expression", async () => {
    const userCode = 'return proxy.something();';
    const transformedCode = await transpileTypescript(userCode, url, ["proxy"],[], false);
    const asyncWrappedCode = createFunction(transformedCode);
    const result = await new Function('proxy',asyncWrappedCode)(createProxy({something: () => "hello"}));
    expect(result).toBe("hello");
})

test("returns from non-proxy call expression", async () => {
    const userCode = 'return nonProxy.something();';
    const transformedCode = await transpileTypescript(userCode, url, [],[], false);
    const asyncWrappedCode = createFunction(transformedCode);
    const result = await new Function('nonProxy',asyncWrappedCode)({something: () => "hello"});
    expect(result).toBe("hello");
})

test("returns from proxy element access expression", async () => {
    const userCode = 'return proxy.something;';
    const transformedCode = await transpileTypescript(userCode, url, ["proxy"],[], false);
    const asyncWrappedCode = createFunction(transformedCode);
    const result = await new Function('proxy',asyncWrappedCode)(createProxy({something: "hello"}));
    expect(result).toBe("hello");
})

test("returns from non-proxy element access expression", async () => {
    const userCode = 'return nonProxy.something;';
    const transformedCode = await transpileTypescript(userCode, url, [],[], false);
    const asyncWrappedCode = createFunction(transformedCode);
    const result = await new Function('nonProxy',asyncWrappedCode)({something: "hello"});
    expect(result).toBe("hello");
})