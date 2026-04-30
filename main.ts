// main.ts

import { createConfig, loadConfigFile, CLI_TPL } from './src/config';
import { createRuntime } from './src/runtime';
import { loadTasks } from './src/task';
import { fatal, formatError } from './src/errors';
import { dirname } from './src/utils/path';
import type { ConfigOptions, RuntimeConfig } from './src/types';
import { os, console, worker, process } from './src/utils';
import { log } from './src/utils/log';
import { version } from './package.json';

// debug
(globalThis as any).console = console;
(globalThis as any).process = process;

interface WorkerData { __cts_entry: string; name?: string }

// ---------------------------------------------------------------------------
// Colour helpers (always applied — isTTY is checked inside C)
// ---------------------------------------------------------------------------

const isTTY = os.guessHandle(os.STDIN_FILENO) == 'tty';
const C = {
    bold: (s: string) => isTTY ? `\x1b[1m${s}\x1b[0m` : s,
    cyan: (s: string) => isTTY ? `\x1b[36m${s}\x1b[0m` : s,
    dim:  (s: string) => isTTY ? `\x1b[2m${s}\x1b[0m`  : s,
    green:(s: string) => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
    warn: (s: string) => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
};

// ---------------------------------------------------------------------------
// Help & version
// ---------------------------------------------------------------------------

function showVersion(): void {
    console.log(`cts/${version}`);
}

function showHelp(): void {
    console.log(`
${C.bold('cts2')} v${version} — TypeScript runner for circu.js

${C.bold('USAGE')}
  ${C.cyan('cts')} [options] ${C.cyan('<file.ts>')} [args…]
  ${C.cyan('cts cache')} ${C.cyan('<file.ts>')}       Pre-download all deps + write lock
  ${C.cyan('cts task')}                  List deno.json tasks
  ${C.cyan('cts task')} ${C.cyan('<name>')} [args…]   Run a deno.json task

${C.bold('OPTIONS')}
  ${C.cyan('--cache-dir')} <path>      Cache directory ${C.dim('(default: ~/.cts)')}
  ${C.cyan('--polyfill')} <file>       Load a polyfill before the entry file
  ${C.cyan('--precache')}              Pre-download deps then run
  ${C.cyan('--no-lock')}               Disable lock file entirely
  ${C.cyan('--frozen')}                Fail if any import is missing from lock
  ${C.cyan('--lock-dir')} <path>       Directory for cts.lock ${C.dim('(default: entry dir)')}
  ${C.cyan('--no-http')}               Disable http/https imports
  ${C.cyan('--no-jsr')}                Disable jsr: imports
  ${C.cyan('--no-node')}               Disable Node.js compatibility
  ${C.cyan('--silent')}                Suppress download progress
  ${C.cyan('--disable-cache')}         Skip JSC bytecode cache
  ${C.cyan('--memory-limit')} <size>   e.g. ${C.cyan('256MB')}, ${C.cyan('1GB')}
  ${C.cyan('--max-stack-size')} <n>    e.g. ${C.cyan('4MB')}
  ${C.cyan('--jsr-cache-ttl')} <days>  JSR metadata TTL ${C.dim('(default: 7)')}
  ${C.cyan('--version')}, ${C.cyan('-v')}           Print version
  ${C.cyan('--help')}, ${C.cyan('-h')}              Print this message

${C.bold('ENVIRONMENT')}
  ${C.cyan('CTS_CACHE_DIR')}     Override cache directory
  ${C.cyan('CTS_SILENT')}        Suppress output ${C.dim('(true/false)')}
  ${C.cyan('CTS_POLYFILL')}      Specific polyfill to use. Especially useful with \`${C.cyan('cno task')}\`
  ${C.cyan('CTS_MEMORY_LIMIT')}  Memory limit ${C.dim('(default: 1GB)')}
  ${C.cyan('CTS_MAX_STACK_SIZE')}  Max stack size ${C.dim('(default: 0)')}
  ${C.cyan('CTS_DEBUG')}         Debug categories: ${C.cyan('resolver')}, ${C.cyan('npm')}, ${C.cyan('jsr')}, ${C.cyan('lock')}, ${C.cyan('cjs')}, ${C.cyan('loader')}, ${C.cyan('config')}, ${C.cyan('stack')}, ${C.cyan('*')}
    `.trim());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entryAndDir(raw: string): { entry: string; dir: string } {
    const hasProto = /^[a-z][a-z0-9+\-.]*:/i.test(raw) && !raw.startsWith('/');
    const entry    = (!hasProto && !raw.startsWith('/')) ? `${os.cwd}/${raw}` : raw;
    return { entry, dir: hasProto ? os.cwd : dirname(entry) };
}

// Known flags from config — used to warn on typos
const KNOWN_FLAGS = new Set(Object.keys(CLI_TPL));

function warnUnknownFlags(parsed: Record<string, any>): void {
    for (const k of Object.keys(parsed)) {
        if (!k.startsWith('_') && !KNOWN_FLAGS.has(k))
            console.error(`${C.warn('⚠')} Unknown flag ${C.cyan('--' + k)} — run ${C.cyan('cts --help')} for options`);
    }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function runCacheCmd(args: string[], baseCfg: Partial<ConfigOptions>): Promise<void> {
    const raw = args[0];
    if (!raw) {
        console.error(`Usage: ${C.cyan('cts cache')} ${C.cyan('<file.ts>')}`);
        os.exit(1); return;
    }
    const { entry, dir } = entryAndDir(raw);
    const cfg            = { ...loadConfigFile(dir), ...baseCfg, silent: false, noLock: false };
    const runtime        = createRuntime(cfg, dir);
    const info           = runtime.resolver.resolve(entry, `${os.cwd}/<cache-cmd>`);
    await runtime.precache(info.specPath, info.localPath);
    const lockDir = cfg.lockDir ?? dir;
    console.log(`${C.green('✔')} ${runtime.resolver.lockSize} modules cached`);
    console.log(C.dim(`  Lock: ${lockDir}/cts.lock`));
}

async function runTaskCmd(args: string[]): Promise<void> {
    const result = loadTasks(os.cwd);
    if (!result) {
        fatal(new Error(
            'No deno.json with tasks found in current directory or any parent.\n' +
            'Create a deno.json with a "tasks" field.'
        ), 'cts task');
    }
    const { runner, configPath } = result;
    if (!args.length || args[0] === '--list') {
        console.log(C.dim(`Tasks from ${configPath}`));
        runner.list();
        return;
    }
    const [name, ...rest] = args;
    const code = await runner.run(name!, rest);
    if (code !== 0) os.exit(code);
}

// ---------------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------------

async function run(
    entry: string, dir: string,
    cfg: Partial<ConfigOptions>,
    extra: Record<string, any> = {},
    precache = false,
): Promise<void> {
    const runtime = createRuntime(cfg, dir);

    if (runtime.config.polyfill) {
        try {
            await runtime.loadPolyfill(runtime.config.polyfill);
            log.debug('runtime', () => `polyfill: ${runtime.config.polyfill}`);
        }
        catch (e) { fatal(e, `loading polyfill ${runtime.config.polyfill}`); }
    }

    if (precache) {
        try {
            const info = runtime.resolver.resolve(entry, `${os.cwd}/<precache>`);
            await runtime.precache(info.specPath, info.localPath);
        } catch (e) {
            // Non-fatal: pre-cache failure just means slower startup, not broken program
            console.error(formatError(e, 'pre-caching'));
        }
    }

    try {
        const mod = await runtime.loadEntry(entry, extra);
        await mod.eval();
    } catch (e) { fatal(e, entry); }

    runtime.flushLock();
}

async function runMain(): Promise<void> {
    const cli    = createConfig({}) as RuntimeConfig & Record<string, any>;

    // --help, -h
    if (cli['help'] || cli['h']) {
        showHelp();
        os.exit(0);
    }

    // --version, -v
    if (cli['version'] || cli['v']) {
        showVersion();
        os.exit(0);
    }

    // sub command
    switch (cli._) {
        case 'cache':
            await runCacheCmd(cli._args ?? [], {
                noLock: cli['no-lock'], lockDir: cli['lock-dir'],
                cacheDir: cli.cacheDir, silent: cli.silent,
            });
            return;
        case 'task':
            await runTaskCmd(cli._args ?? []);
            return;
        case undefined:
            showHelp();
            os.exit(1);
    }

    // Warn on unknown flags (use raw CLI args, not normalized config)
    warnUnknownFlags(cli._cli ?? cli);

    const { entry, dir } = entryAndDir(cli._!);
    // Note: os.args modification removed to avoid affecting runtime behavior
    const fileCfg = loadConfigFile(dir);

    await run(entry, dir, {
        ...fileCfg,
        ...cli,
    }, {}, !!cli.precache);
}

async function runWorker(): Promise<void> {
    const data = worker.workerData as WorkerData;
    const { entry, dir } = entryAndDir(data.__cts_entry);
    await run(entry, dir, loadConfigFile(dir), { name: data.name });
}

(worker.isWorker ? runWorker : runMain)().catch(e => fatal(e));
