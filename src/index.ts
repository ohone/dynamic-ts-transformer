export { transpileTypescript } from './Transpiler.js';

if (process.env.NODE_ENV === 'development') {
    await import('./dev.js');
}