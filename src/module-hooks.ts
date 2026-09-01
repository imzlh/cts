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

export type ModuleResolveHook = (
    specifier: string,
    context: ModuleResolveContext,
    nextResolve: (specifier: string, context?: ModuleResolveContext) => ModuleResolveResult,
) => ModuleResolveResult;

export type ModuleLoadHook = (
    url: string,
    context: ModuleLoadContext,
    nextLoad: (url: string, context?: ModuleLoadContext) => ModuleLoadResult,
) => ModuleLoadResult;

export interface SynchronousModuleHooks {
    resolve?: ModuleResolveHook;
    load?: ModuleLoadHook;
}

interface HookRegistration extends SynchronousModuleHooks {
    active: boolean;
}

const registrations: HookRegistration[] = [];

/** Process-wide synchronous hooks installed through node:module.registerHooks(). */
export function registerModuleHooks(hooks: SynchronousModuleHooks): { deregister(): void } {
    const registration: HookRegistration = {
        resolve: typeof hooks?.resolve === 'function' ? hooks.resolve : undefined,
        load: typeof hooks?.load === 'function' ? hooks.load : undefined,
        active: true,
    };
    registrations.push(registration);

    return {
        deregister(): void {
            if (!registration.active) return;
            registration.active = false;
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

/** Run newest-first, matching Node's synchronous customization-hook chain. */
export function runModuleResolveHooks(
    specifier: string,
    context: ModuleResolveContext,
    terminal: (specifier: string, context: ModuleResolveContext) => ModuleResolveResult,
): ModuleResolveResult {
    let next: (specifier: string, context?: ModuleResolveContext) => ModuleResolveResult =
        (nextSpecifier, nextContext) => terminal(nextSpecifier, nextContext ?? context);

    for (const registration of registrations) {
        if (!registration.resolve) continue;
        const hook = registration.resolve;
        const downstream = next;
        next = (nextSpecifier, nextContext) => hook(nextSpecifier, nextContext ?? context, downstream);
    }
    return next(specifier, context);
}

export function runModuleLoadHooks(
    url: string,
    context: ModuleLoadContext,
    terminal: (url: string, context: ModuleLoadContext) => ModuleLoadResult,
): ModuleLoadResult {
    let next: (url: string, context?: ModuleLoadContext) => ModuleLoadResult =
        (nextUrl, nextContext) => terminal(nextUrl, nextContext ?? context);

    for (const registration of registrations) {
        if (!registration.load) continue;
        const hook = registration.load;
        const downstream = next;
        next = (nextUrl, nextContext) => hook(nextUrl, nextContext ?? context, downstream);
    }
    return next(url, context);
}
