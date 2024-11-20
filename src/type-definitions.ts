export function getTypeDefinitions(asyncProxyNames: string[], nonProxyNames: string[], debug: boolean = false) {
  const typeDef =  `
declare global {
    interface AsyncMock {
        [K: string]: ((...args: any[]) => AsyncMock);
    }

    ${asyncProxyNames.map((name) => `const ${name}: AsyncMock;`).join("\n    ")}
    ${nonProxyNames.map((name) => `const ${name}: { [key: string]: any };;`).join("\n    ")}

}

export {}
    `;
    debug && console.log(typeDef);
    return typeDef;
}