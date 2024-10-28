export function getTypeDefinitions(names) {
    return `
declare global {
    interface AsyncMock {
        [K: string]: AsyncMock | ((...args: any[]) => Promise<AsyncMock>);
    }

    ${names.map((name) => `const ${name}: AsyncMock;`).join("\n    ")}
}

export {}
    `;
}
//# sourceMappingURL=type-definitions.js.map