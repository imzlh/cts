1. use esbuild to bundle the loader
    only being used when you changed the code in `src/` directory
    npm run build
2. assume your cjs binary is in `~/cts2/cjs`
    write a test script to verify npm package resolution with subpaths
    ```typescript
        import 'npm:hono/middleware';
        console.log('passed');
    ```
3. run test file. remove DEBUG=1 to stop showing debug log
    DEBUG=1 ~/cts2/cjs /root/cts2/dist.js --polyfill /root/denort/dist.js