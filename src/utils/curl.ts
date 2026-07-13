const curlMod = import.meta.use('curl');

export type CurlInitHook = (curl: CModuleCURL.CURL) => void;

let curlInitHook: CurlInitHook | null = null;

export function setCurlInitHook(hook: CurlInitHook | null): void {
    curlInitHook = hook;
}

export function getCurlInitHook(): CurlInitHook | null {
    return curlInitHook;
}
