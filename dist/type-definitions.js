export function getTypeDefinitions(asyncProxyNames, nonProxyNames, debug = false) {
    const typeDef = `
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
//# sourceMappingURL=type-definitions.js.map