export function getTypeDefinitions(names: string[], debug: boolean = false) {
  const typeDef =  `
declare global {
    interface AsyncMock {
        [K: string]: AsyncMock | ((...args: any[]) => Promise<AsyncMock>);
    }

    ${names.map((name) => `const ${name}: AsyncMock;`).join("\n    ")}
}

export {}
    `;
    debug && console.log(typeDef);
    return typeDef;
}
