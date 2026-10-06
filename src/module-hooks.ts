export interface ModuleResolveContext {
    parentURL?: string;
    conditions?: string[];
    importAttributes?: Record<string, unknown>;
}

export interface ModuleResolveResult {
    url: string;
    format?: string | null;
    shortCircuit?: boolean;
}

export interface ModuleLoadContext {
    format?: string | null;
    conditions?: string[];
    importAttributes?: Record<string, unknown>;
}

export interface ModuleLoadResult {
    format?: string | null;
    source?: string | null;
    shortCircuit?: boolean;
}

type ModuleHook<Context, Result> = (
    specifier: string,
    context: Context,
    next: (specifier: string, context?: Context) => Result,
) => Result;

export type ModuleResolveHook = ModuleHook<ModuleResolveContext, ModuleResolveResult>;
export type ModuleLoadHook = ModuleHook<ModuleLoadContext, ModuleLoadResult>;

export interface SynchronousModuleHooks {
    resolve?: ModuleResolveHook;
    load?: ModuleLoadHook;
}

const registrations: SynchronousModuleHooks[] = [];

/** Process-wide synchronous hooks installed through node:module.registerHooks(). */
export function registerModuleHooks(hooks: SynchronousModuleHooks): { deregister(): void } {
    const registration: SynchronousModuleHooks = {
        resolve: typeof hooks?.resolve === 'function' ? hooks.resolve : undefined,
        load: typeof hooks?.load === 'function' ? hooks.load : undefined,
    };
    registrations.push(registration);

    return {
        deregister(): void {
            const index = registrations.indexOf(registration);
            if (index !== -1) registrations.splice(index, 1);
        },
    };
}

export function hasModuleResolveHooks(): boolean {
    return registrations.some((registration) => registration.resolve !== undefined);
}

export function hasModuleLoadHooks(): boolean {
    return registrations.some((registration) => registration.load !== undefined);
}

/** Snapshot the chain before invoking hooks; newest registration runs first. */
function runModuleHooks<Context, Result>(
    select: (registration: SynchronousModuleHooks) => ModuleHook<Context, Result> | undefined,
    specifier: string,
    context: Context,
    terminal: (specifier: string, context: Context) => Result,
): Result {
    let next: (specifier: string, context?: Context) => Result =
        (nextSpecifier, nextContext) => terminal(nextSpecifier, nextContext ?? context);

    for (const registration of registrations) {
        const hook = select(registration);
        if (!hook) continue;
        const downstream = next;
        next = (nextSpecifier, nextContext) => hook(nextSpecifier, nextContext ?? context, downstream);
    }
    return next(specifier, context);
}

export function runModuleResolveHooks(
    specifier: string,
    context: ModuleResolveContext,
    terminal: (specifier: string, context: ModuleResolveContext) => ModuleResolveResult,
): ModuleResolveResult {
    return runModuleHooks((registration) => registration.resolve, specifier, context, terminal);
}

export function runModuleLoadHooks(
    url: string,
    context: ModuleLoadContext,
    terminal: (url: string, context: ModuleLoadContext) => ModuleLoadResult,
): ModuleLoadResult {
    return runModuleHooks((registration) => registration.load, url, context, terminal);
}
