import { parseShellCommand } from '../shell';
import { isAbsolute, joinPaths, normalizePath, toPosixPath } from '../utils/path';

const fs = import.meta.use('fs');

export interface LifecyclePlanOptions {
    exePath: string;
    shell: string;
    shellArg: string;
}

export interface LifecycleCommand {
    argv: string[];
    op?: '&&' | '||' | ';';
}

export interface LifecyclePlan {
    commands: LifecycleCommand[];
    fallback: boolean;
}

/** Mutable state for one lifecycle script run (cwd + env carry across segments). */
export interface LifecycleSession {
    cwd: string;
    env: Record<string, string>;
}

export type LifecycleSpawn = (command: LifecycleCommand, session: LifecycleSession) => Promise<number>;

/** Builtins interpreted by applyShellBuiltin (never bare-spawned). */
const INTERPRETED_BUILTINS = new Set(['exit', 'true', 'false', ':', 'cd', 'export', 'unset']);

/** Names that force shell when we cannot interpret them (e.g. shift needs positionals). */
const SHELL_ONLY_BUILTINS = new Set(['shift']);

export interface BuiltinApplyOptions {
    /** Directory existence check; default uses fs.stat. */
    isDirectory?: (path: string) => boolean;
}

function toLifecycleOperator(op: string | undefined): LifecycleCommand['op'] | undefined {
    switch (op) {
        case '&&':
        case '||':
        case ';':
            return op;
        default:
            return undefined;
    }
}

function isPathLikeCommand(command: string): boolean {
    return command.startsWith('/') || command.startsWith('.') || command.includes('/');
}

function shellPlan(script: string, opts: LifecyclePlanOptions): LifecyclePlan {
    return {
        commands: [{ argv: [opts.shell, opts.shellArg, script] }],
        fallback: true,
    };
}

function nodeArgv(args: string[], exePath: string): string[] | null {
    const [first, second, ...rest] = args;
    if (first === '-e' || first === '--eval') {
        if (!second) return null;
        return [exePath, 'eval', second, ...rest];
    }
    if (first?.startsWith('--eval=')) {
        return [exePath, 'eval', first.slice('--eval='.length), ...rest];
    }
    if (!first) return null;
    return [exePath, 'run', ...args];
}

function hasShellOnlySyntax(bin: string, args: string[]): boolean {
    const tokens = [bin, ...args];
    return bin.includes('=') || tokens.some((token) =>
        token.includes('<') || token.includes('>') || token.startsWith('$'),
    );
}

/** `$` / backticks need real shell expansion — do not invent with regex. */
function needsShellExpansion(args: string[]): boolean {
    for (const a of args) {
        for (let i = 0; i < a.length; i++) {
            const c = a.charCodeAt(i);
            if (c === 36 /* $ */ || c === 96 /* ` */) return true;
        }
    }
    return false;
}

/** POSIX-ish env name: [A-Za-z_][A-Za-z0-9_]* via char walk. */
function isEnvName(name: string): boolean {
    if (!name.length) return false;
    const c0 = name.charCodeAt(0);
    const ok0 = (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95;
    if (!ok0) return false;
    for (let i = 1; i < name.length; i++) {
        const c = name.charCodeAt(i);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95) continue;
        return false;
    }
    return true;
}

function defaultIsDirectory(path: string): boolean {
    try {
        return fs.stat(path).isDirectory;
    } catch {
        return false;
    }
}

function resolveCdTarget(cwd: string, target: string): string {
    const t = toPosixPath(target);
    if (isAbsolute(t)) return normalizePath(t);
    return normalizePath(joinPaths(toPosixPath(cwd), t));
}

/**
 * Interpret a shell builtin from argv tokens; mutates session for cd/export/unset.
 * Returns exit code, or null if argv is not an interpreted builtin (caller should spawn).
 */
export function applyShellBuiltin(
    argv: string[],
    session: LifecycleSession,
    opts?: BuiltinApplyOptions,
): number | null {
    const bin = argv[0];
    if (!bin || isPathLikeCommand(bin)) return null;
    const name = bin.toLowerCase();
    if (!INTERPRETED_BUILTINS.has(name)) return null;

    if (name === 'true' || name === ':') return 0;
    if (name === 'false') return 1;

    if (name === 'exit') {
        const raw = argv[1];
        if (raw === undefined || raw === '') return 0;
        const n = Number.parseInt(raw, 10);
        return Number.isFinite(n) ? (n & 0xff) : 1;
    }

    if (name === 'cd') {
        // cd with no args → $HOME if set, else fail closed
        const destArg = argv[1];
        if (argv.length > 2) return 1; // cd a b — not supported
        let dest: string;
        if (destArg === undefined || destArg === '') {
            const home = session.env['HOME'] ?? session.env['USERPROFILE'];
            if (!home) return 1;
            dest = home;
        } else {
            dest = destArg;
        }
        if (needsShellExpansion([dest])) return 1;
        const next = resolveCdTarget(session.cwd, dest);
        const isDir = opts?.isDirectory ?? defaultIsDirectory;
        if (!isDir(next)) return 1;
        session.cwd = next;
        return 0;
    }

    if (name === 'export') {
        // export alone succeeds; walk tokens NAME=value or NAME
        for (let i = 1; i < argv.length; i++) {
            const token = argv[i]!;
            if (needsShellExpansion([token])) return 1;
            const eq = token.indexOf('=');
            if (eq === -1) {
                if (!isEnvName(token)) return 1;
                // export NAME with no value: mark-only; leave existing value
                continue;
            }
            const key = token.slice(0, eq);
            const val = token.slice(eq + 1);
            if (!isEnvName(key)) return 1;
            session.env[key] = val;
        }
        return 0;
    }

    if (name === 'unset') {
        if (argv.length < 2) return 0;
        for (let i = 1; i < argv.length; i++) {
            const key = argv[i]!;
            if (!isEnvName(key)) return 1;
            delete session.env[key];
        }
        return 0;
    }

    return null;
}

/** @deprecated prefer applyShellBuiltin — kept for simple exit/true/false unit checks */
export function emulateShellBuiltin(argv: string[]): number | null {
    const session: LifecycleSession = { cwd: '.', env: {} };
    return applyShellBuiltin(argv, session);
}

export function isShellBuiltinName(bin: string): boolean {
    if (!bin || isPathLikeCommand(bin)) return false;
    const n = bin.toLowerCase();
    return INTERPRETED_BUILTINS.has(n) || SHELL_ONLY_BUILTINS.has(n);
}

function isInterpretedBuiltin(bin: string): boolean {
    if (!bin || isPathLikeCommand(bin)) return false;
    return INTERPRETED_BUILTINS.has(bin.toLowerCase());
}

export function planLifecycleScript(script: string, opts: LifecyclePlanOptions): LifecyclePlan {
    const segments = parseShellCommand(script);
    if (!segments.length) return { commands: [], fallback: false };

    if (segments.length === 1) {
        const seg = segments[0];
        if (!seg) return { commands: [], fallback: false };
        const rawOp = seg.op;
        const op = toLifecycleOperator(rawOp);
        if (rawOp && !op) return shellPlan(script, opts);
        if (op && op !== ';') return shellPlan(script, opts);
        if (isInterpretedBuiltin(seg.bin) && !hasShellOnlySyntax(seg.bin, seg.args) && !needsShellExpansion(seg.args)) {
            return { commands: [{ argv: [seg.bin, ...seg.args], op }], fallback: false };
        }
        if (seg.bin === 'node' && !hasShellOnlySyntax(seg.bin, seg.args)) {
            const argv = nodeArgv(seg.args, opts.exePath);
            if (argv) return { commands: [{ argv, op }], fallback: false };
        }
        return shellPlan(script, opts);
    }

    const commands: LifecycleCommand[] = [];
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!seg) return shellPlan(script, opts);
        if (!seg.bin || hasShellOnlySyntax(seg.bin, seg.args)) return shellPlan(script, opts);
        const rawOp = seg.op;
        const op = toLifecycleOperator(rawOp);
        if (rawOp && !op) return shellPlan(script, opts);
        if (i < segments.length - 1 && !op) return shellPlan(script, opts);
        if (i === segments.length - 1 && op && op !== ';') return shellPlan(script, opts);

        if (isShellBuiltinName(seg.bin)) {
            const n = seg.bin.toLowerCase();
            // shift etc. need a real shell; expansion in args too
            if (SHELL_ONLY_BUILTINS.has(n) || needsShellExpansion(seg.args)) {
                return shellPlan(script, opts);
            }
            if (!isInterpretedBuiltin(seg.bin)) return shellPlan(script, opts);
            if (op) commands.push({ argv: [seg.bin, ...seg.args], op });
            else commands.push({ argv: [seg.bin, ...seg.args] });
            continue;
        }

        const argv = seg.bin === 'node' ? nodeArgv(seg.args, opts.exePath) : [seg.bin, ...seg.args];
        if (!argv) return shellPlan(script, opts);
        if (op) commands.push({ argv, op });
        else commands.push({ argv });
    }

    return { commands, fallback: false };
}

export function resolveLifecycleCommandArgv(argv: string[], resolveBin: (name: string) => string | null): string[] {
    const [bin, ...args] = argv;
    if (!bin || isPathLikeCommand(bin) || bin === 'sh' || bin === 'cmd' || bin === 'cmd.exe') return argv;
    if (isShellBuiltinName(bin)) return argv;
    const resolved = resolveBin(bin);
    return resolved ? [resolved, ...args] : argv;
}

export async function runLifecyclePlan(
    plan: LifecyclePlan,
    spawn: LifecycleSpawn,
    session?: LifecycleSession,
    applyOpts?: BuiltinApplyOptions,
): Promise<number> {
    const sess: LifecycleSession = session ?? { cwd: '.', env: Object.create(null) as Record<string, string> };
    let code = 0;
    for (let i = 0; i < plan.commands.length; i++) {
        const command = plan.commands[i];
        if (!command) continue;
        const applied = applyShellBuiltin(command.argv, sess, applyOpts);
        code = applied !== null ? applied : await spawn(command, sess);

        if (command.op === '&&') {
            if (code !== 0) return code;
            continue;
        }

        if (command.op === '||') {
            if (code === 0) {
                while (i < plan.commands.length - 1 && plan.commands[i]?.op === '||') i++;
            }
            continue;
        }

        if (command.op === ';') continue;
        return code;
    }
    return code;
}
