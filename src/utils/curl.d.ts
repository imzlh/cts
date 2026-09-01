export interface CurlTarget {
    protocol: string;
}
export type CurlInitHook = (curl: CModuleCURL.CURL, url: CurlTarget) => void;
export declare function createCurlTarget(input: string): CurlTarget;
export declare function setCurlInitHook(hook: CurlInitHook | null): void;
export declare function getCurlInitHook(): CurlInitHook | null;
//# sourceMappingURL=curl.d.ts.map
