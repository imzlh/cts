import { parseShellCommand } from '../shell';

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

export type LifecycleSpawn = (command: LifecycleCommand) => Promise<number>;

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
    const resolved = resolveBin(bin);
    return resolved ? [resolved, ...args] : argv;
}

export async function runLifecyclePlan(plan: LifecyclePlan, spawn: LifecycleSpawn): Promise<number> {
    let code = 0;
    for (let i = 0; i < plan.commands.length; i++) {
        const command = plan.commands[i];
        if (!command) continue;
        code = await spawn(command);

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
