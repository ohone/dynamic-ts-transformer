import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const filePath = join(__dirname, '../src/types/chrome-mock.d.ts');
const typeContent = readFileSync(filePath, 'utf-8');
const output = `
// Generated file - do not edit directly
export const myTypeDefinitions = ${JSON.stringify(typeContent)};
`;
console.log(join(__dirname, '../src/generated/type-definitions.ts'));
writeFileSync(join(__dirname, '../src/generated/type-definitions.ts'), output);
//# sourceMappingURL=build-types.js.map