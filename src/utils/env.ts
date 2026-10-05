const os = import.meta.use('os');

/** Read an environment variable without turning an unset value into an exception. */
export function readEnv(name: string): string | null {
    try {
        return os.getenv(name) ?? null;
    } catch {
        return null;
    }
}
