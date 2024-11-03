export function getTypeDefinitions(names: string[], debug: boolean = false) {
  const typeDef =  `
declare global {
    interface AsyncMock {
        [K: string]: ((...args: any[]) => AsyncMock);
    }

    ${names.map((name) => `const ${name}: AsyncMock;`).join("\n    ")}
}

export {}
    `;
    debug && console.log(typeDef);
    return typeDef;
}
