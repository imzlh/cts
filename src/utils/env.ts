const os = import.meta.use('os');

/** The host throws for an unset variable; callers only care about "no value". */
export function readEnv(name: string): string | undefined {
    try {
        return os.getenv(name);
    } catch {
        return undefined;
    }
}
