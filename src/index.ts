export { transpileTypescript } from './CachingTranspiler.js';

if (process.env.NODE_ENV === 'development') {
    await import('./dev.js');
}