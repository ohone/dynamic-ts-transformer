import * as fs from 'fs';
import * as path from 'path';
const typeContent = fs.readFileSync(path.join(__dirname, '../types/chrome-mock.d.ts'), 'utf-8');
const output = `
// Generated file - do not edit directly
export const myTypeDefinitions = ${JSON.stringify(typeContent)};
`;
console.log(path.join(__dirname, '../src/generated/type-definitions.ts'));
fs.writeFileSync(path.join(__dirname, '../src/generated/type-definitions.ts'), output);
//# sourceMappingURL=build-types.js.map