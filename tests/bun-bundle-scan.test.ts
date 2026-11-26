import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig } from '../src/config.ts';
import { DepScanner } from '../src/deps.ts';
import { extractImports, isCompileTimeOnlyImport } from '../src/scan.ts';
import { ImportScanner } from '../src/import-scanner.ts';
import { LockStore } from '../src/lock.ts';
import { OxcTranspiler } from '../src/oxc.ts';
import { ParseDriver } from '../src/parse.ts';
import { ModuleResolver } from '../src/resolve/index.ts';
import { Transformer } from '../src/source/transform.ts';

function testOxc(fallback = false): OxcTranspiler {
    return new OxcTranspiler({
        transpile(source) {
            return { code: source, deps: [] };
        },
        scanImports(source) {
            if (fallback) throw new Error('injected scanner fallback');
            return extractImports(source).filter(spec => !isCompileTimeOnlyImport(spec));
        },
        version: 'test',
    });
}

Deno.test('bun:bundle detection can include type-only imports without changing graph edges', () => {
    for (const declaration of [
        `import type { feature } from 'bun:bundle';`,
        `import type Feature from 'bun:bundle';`,
        `import type * as Bundle from 'bun:bundle';`,
        `import { type feature } from 'bun:bundle';`,
        `import type { feature } from 'bun:\\x62undle';`,
    ]) {
        const source = `${declaration}\nimport './dependency.ts';`;
        deepStrictEqual(extractImports(source, true, true), ['./dependency.ts'], declaration);
        deepStrictEqual(
            extractImports(source, true, true, { includeTypeOnlyImports: true }),
            ['bun:bundle', './dependency.ts'],
            declaration,
        );
    }
    const ordinary = `
        // import type { feature } from 'bun:bundle';
        const text = "import type { feature } from 'bun:bundle';";
        import type { Feature } from './types.ts';
        import type from './value.ts';
        export type { Feature } from './export-types.ts';
    `;
    deepStrictEqual(extractImports(ordinary, true, true), ['./value.ts']);
    deepStrictEqual(extractImports(ordinary, true, true, { includeTypeOnlyImports: true }),
        ['./types.ts', './value.ts']);
});

Deno.test('bun:bundle is omitted from precache edges across scanner paths only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cts-bun-bundle-scan-'));
    const dependency = join(root, 'dependency.ts');
    const source = [
        `import { feature } from 'bun:bundle';`,
        `import './dependency.ts';`,
        `import 'bun:not-a-real-module';`,
        `if (feature('DISABLED')) throw new Error('disabled branch');`,
    ].join('\n');
    const paths = [
        { name: 'oxc', oxc: testOxc(), worker: false },
        { name: 'oxc-fallback', oxc: testOxc(true), worker: false },
        { name: 'sucrase-main', oxc: null, worker: false },
        { name: 'sucrase-worker', oxc: null, worker: true },
    ] as const;

    try {
        writeFileSync(dependency, 'export const value = 1;\n');
        for (const path of paths) {
            const entry = join(root, `${path.name}.ts`);
            const cfg = createConfig({
                cacheDir: join(root, `cache-${path.name}`),
                enableOxc: path.oxc !== null,
                silent: true,
            });
            writeFileSync(entry, source);
            const resolver = new ModuleResolver(cfg, root, false);
            const parseDriver = path.worker ? new ParseDriver(null, 1) : null;
            try {
                const result = await new DepScanner(
                    resolver,
                    cfg,
                    null,
                    path.oxc,
                    parseDriver ? parseDriver.scanFile.bind(parseDriver) : null,
                ).scan(entry, entry);

                deepStrictEqual(result.errors.map(item => item.spec), ['bun:not-a-real-module'], path.name);
                ok(result.modules.some(module => module.localPath === dependency),
                    `${path.name} must retain ordinary dependency edges`);
                deepStrictEqual(
                    resolver.lockStore.getImports(entry),
                    ['./dependency.ts', 'bun:not-a-real-module'],
                    `${path.name} must cache the same normalized graph edges`,
                );
                strictEqual(isCompileTimeOnlyImport('bun:bundle'), true);
                strictEqual(isCompileTimeOnlyImport('bun:not-a-real-module'), false);
            } finally {
                await parseDriver?.terminate();
                resolver.lockStore.close();
            }
        }

        const transformer = new Transformer({ sourceMaps: false });
        transformer.setOxcLoader(() => null);
        let rejected = false;
        try {
            transformer.transform(
                `import { feature } from 'bun:bundle'; if (feature(name)) {}`, 'invalid-feature.ts');
        } catch (error) {
            rejected = error instanceof Error && error.message.includes('bun:bundle requires native OXC transformation');
        }
        strictEqual(rejected, true, 'graph filtering must not make transform fallback accept invalid feature() use');
    } finally {
        try { LockStore.closeAll(); } catch {}
        rmSync(root, { recursive: true, force: true });
    }
});
