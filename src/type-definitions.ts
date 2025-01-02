export function getTypeDefinitions(asyncProxyNames: string[], nonProxyNames: string[], debug: boolean = false) {
  const typeDef =  `
declare global {
    interface AsyncMock {
        __isAsyncMock: true;
        [K: string]: ((...args: any[]) => AsyncMock);
    }

    function isProxy(obj: any): obj is AsyncMock;
    type NonProxy = { [key: string]: any };

    ${asyncProxyNames.map((name) => `const ${name}: AsyncMock;`).join("\n    ")}
    ${nonProxyNames.map((name) => `const ${name}: NonProxy;`).join("\n    ")}

}

export {}
    `;
    debug && console.log(typeDef);
    return typeDef;
}