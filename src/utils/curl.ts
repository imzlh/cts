export interface CurlTarget {
    protocol: string;
}

declare const URL: {
    new(input: string): CurlTarget;
};

export type CurlInitHook = (curl: CModuleCURL.CURL, url: CurlTarget) => void;

export function createCurlTarget(input: string): CurlTarget {
    return new URL(input);
}

let curlInitHook: CurlInitHook | null = null;

export function setCurlInitHook(hook: CurlInitHook | null): void {
    curlInitHook = hook;
}

export function getCurlInitHook(): CurlInitHook | null {
    return curlInitHook;
}
