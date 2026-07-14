import { readText, readBytes, ensureDir, writeText, unTarGz, type TarFile, fmtBytes, isEnabled, log, dirname, getMemoryFile } from './utils';
import { getCurlInitHook } from './utils/curl';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const curlMod = import.meta.use('curl');
const asyncfs = import.meta.use('asyncfs');

export type ProgressCallback = (now: number, total: number) => void;
export interface FetchOptions {
    headers?: Record<string, string>;
    timeout?: number;
}

export const enum StepType {
    FS_EXISTS,
    FS_READ_TEXT,
    FS_READ_BYTES,
    FS_WRITE_TEXT,
    FS_WRITE_BYTES,
    FS_ENSURE_DIR,
    NET_FETCH,
    ARCHIVE_UNTAR_GZ,
    FLOW,
    FLOW_ALL,
}

export interface FsExistsStep {
    type: StepType.FS_EXISTS;
    path: string;
}

export interface FsReadTextStep {
    type: StepType.FS_READ_TEXT;
    path: string;
}

export interface FsReadBytesStep {
    type: StepType.FS_READ_BYTES;
    path: string;
}

export interface FsWriteTextStep {
    type: StepType.FS_WRITE_TEXT;
    path: string;
    text: string;
}

export interface FsWriteBytesStep {
    type: StepType.FS_WRITE_BYTES;
    path: string;
    data: Uint8Array | ArrayBuffer;
}

export interface FsEnsureDirStep {
    type: StepType.FS_ENSURE_DIR;
    path: string;
}

export interface NetFetchStep {
    type: StepType.NET_FETCH;
    url: string;
    headers?: Record<string, string>;
    timeout?: number;
    onProgress?: ProgressCallback;
}

export interface ArchiveUntarGzStep {
    type: StepType.ARCHIVE_UNTAR_GZ;
    data: Uint8Array | ArrayBuffer;
}

/** Run a nested flow. A key coalesces concurrent work such as package installs. */
export interface FlowStep {
    type: StepType.FLOW;
    flow: Flow<void>;
    key?: string;
}

/** Run independent flows with bounded concurrency. */
export interface FlowAllStep {
    type: StepType.FLOW_ALL;
    flows: Flow<void>[];
    concurrency: number;
}

export interface NetFetchResult {
    status: number;
    headers: Array<[string, string]>;
    body: Uint8Array;
}

export type Step =
    | FsExistsStep
    | FsReadTextStep
    | FsReadBytesStep
    | FsWriteTextStep
    | FsWriteBytesStep
    | FsEnsureDirStep
    | NetFetchStep
    | ArchiveUntarGzStep
    | FlowStep
    | FlowAllStep;

export type StepResult = boolean | string | Uint8Array | ArrayBuffer | NetFetchResult | TarFile[] | undefined;
export type Flow<T> = Generator<Step, T, StepResult>;

export function expectText(value: StepResult): string {
    if (typeof value === 'string') return value;
    throw new TypeError('Flow step did not return text');
}

export function expectFetch(value: StepResult): NetFetchResult {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'status' in value && 'body' in value) {
        return value as NetFetchResult;
    }
    throw new TypeError('Flow step did not return fetch result');
}

export function expectTarFiles(value: StepResult): TarFile[] {
    if (Array.isArray(value)) return value;
    throw new TypeError('Flow step did not return tar files');
}

function parseHeaders(raw: string): Array<[string, string]> {
    let current: Array<[string, string]> = [];
    let last: [string, string] | null = null;
    for (const line of raw.split(/\r?\n/)) {
        if (!line) continue;
        if (/^HTTP\//i.test(line)) {
            current = [];
            last = null;
            continue;
        }
        if ((line[0] === ' ' || line[0] === '\t') && last) {
            last[1] += ' ' + line.trim();
            continue;
        }
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        const header: [string, string] = [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
        current.push(header);
        last = header;
    }
    return current;
}

function configureCurl(curl: CModuleCURL.CURL, step: NetFetchStep): void {
    getCurlInitHook()?.(curl);
    curl.setUrl(step.url)
        .setMethod('GET')
        .setFollowRedirects(true)
        .setMaxRedirects(20)
        .setAcceptEncoding();
    if (step.headers) curl.setHeaders(step.headers);
    if (typeof step.timeout === 'number' && Number.isFinite(step.timeout) && step.timeout > 0) {
        curl.setTimeout(step.timeout);
        curl.setConnectTimeout(step.timeout);
    }
    if (step.onProgress || isEnabled('fetch')) {
        let lastLog = 0;
        let lastDone = -1;
        curl.onProgress((dltotal, dlnow) => {
            const done = Number(dlnow);
            const total = Number(dltotal);
            step.onProgress?.(done, total);
            const now = Date.now();
            if (isEnabled('fetch') && done !== lastDone && now - lastLog >= 1000) {
                lastLog = now;
                lastDone = done;
                log.debug('fetch', () => `progress ${shortUrl(step.url)} ${fmtProgress(done, total)}`);
            }
            return true;
        });
    }
}

function toResult(response: CModuleCURL.Response): NetFetchResult {
    return {
        status: response.status,
        headers: parseHeaders(response.headers),
        body: response.body ? new Uint8Array(response.body) : new Uint8Array(0),
    };
}

let asyncPool: CModuleCURL.ConnPool | null = null;
let syncPool: CModuleCURL.ConnPool | null = null;
const activeFlows = new Map<string, Promise<void>>();

function getAsyncPool(): CModuleCURL.ConnPool {
    if (!asyncPool) {
        asyncPool = new curlMod.ConnPool({
            maxConnections: 32,
            maxConnectionsPerHost: 8,
            pipelining: false,
        });
    }
    return asyncPool;
}

function getSyncPool(): CModuleCURL.ConnPool {
    if (!syncPool) {
        syncPool = new curlMod.ConnPool({
            maxConnections: 4,
            maxConnectionsPerHost: 2,
            pipelining: false,
        });
    }
    return syncPool;
}

async function fetchAsync(step: NetFetchStep): Promise<NetFetchResult> {
    const pool = getAsyncPool();
    const curl = new curlMod.CURL(pool);
    configureCurl(curl, step);
    log.debug('fetch', () => `start ${step.url}`);
    const started = Date.now();
    const res = await curl.perform()
    log.debug('fetch', () => `done ${step.url} ${res.status} ${fmtBytes(res.body ? res.body.byteLength : 0)} ${Date.now() - started}ms`);
    return toResult(res);
}

function fetchSync(step: NetFetchStep): NetFetchResult {
    const pool = getSyncPool();
    const curl = new curlMod.CURL(pool);
    configureCurl(curl, step);
    log.debug('fetch', () => `start ${step.url}`);
    const started = Date.now();
    const res = curl.performSync();
    log.debug('fetch', () => `done ${step.url} ${res.status} ${fmtBytes(res.body ? res.body.byteLength : 0)} ${Date.now() - started}ms`);
    return toResult(res);
}

/** Close all connection pools */
export function closeConnectionPools(): void {
    if (asyncPool) {
        asyncPool.close();
        asyncPool = null;
    }
    if (syncPool) {
        syncPool.close();
        syncPool = null;
    }
}

function executeStep(step: Step, fetch: (step: NetFetchStep) => NetFetchResult): StepResult {
    switch (step.type) {
        case StepType.FS_EXISTS:
            // Active VFS (pack:) is not on disk — has() is the existence oracle.
            if (getMemoryFile(step.path) !== undefined) return true;
            return fs.exists(step.path);
        case StepType.FS_READ_TEXT:
            return readText(step.path);
        case StepType.FS_READ_BYTES:
            // Prefer VFS (pack:) — same as readText; raw fs misses overlays.
            return readBytes(step.path);
        case StepType.FS_WRITE_TEXT:
            writeText(step.path, step.text);
            return undefined;
        case StepType.FS_WRITE_BYTES:
            fs.writeFile(step.path, step.data);
            return undefined;
        case StepType.FS_ENSURE_DIR:
            ensureDir(step.path);
            return undefined;
        case StepType.NET_FETCH:
            return fetch(step);
        case StepType.ARCHIVE_UNTAR_GZ:
            log.debug('archive', () => `untar.gz start ${fmtBytes(step.data.byteLength)}`);
            const started = Date.now();
            const files = unTarGz(step.data);
            log.debug('archive', () => `untar.gz done ${files.length} entries ${Date.now() - started}ms`);
            return files;
        case StepType.FLOW:
            runSync(step.flow);
            return undefined;
        case StepType.FLOW_ALL:
            for (const flow of step.flows) runSync(flow);
            return undefined;
    }
}

function executeSync(step: Step): StepResult {
    return executeStep(step, fetchSync);
}

async function existsAsync(path: string): Promise<boolean> {
    try {
        await asyncfs.stat(path);
        return true;
    } catch {
        return false;
    }
}

async function ensureDirAsync(dir: string): Promise<void> {
    if (await existsAsync(dir)) return;
    const parent = dirname(dir);
    if (parent && parent !== dir && parent !== '.') await ensureDirAsync(parent);
    try {
        await asyncfs.mkdir(dir, 0o755);
    } catch {
        if (!await existsAsync(dir)) throw new Error(`Failed to create directory: ${dir}`);
    }
}

function arrayBufferBackedBytes(data: Uint8Array | ArrayBuffer): Uint8Array<ArrayBuffer> {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return copy;
}

async function writeFileAsync(path: string, data: Uint8Array | ArrayBuffer): Promise<void> {
    const bytes = arrayBufferBackedBytes(data);
    const file = await asyncfs.open(path, 'w');
    try {
        let off = 0;
        while (off < bytes.byteLength) {
            off += await file.write(bytes.subarray(off));
        }
    } finally {
        await file.close();
    }
}

async function executeAsync(step: Step): Promise<StepResult> {
    switch (step.type) {
        case StepType.FS_EXISTS:
            if (getMemoryFile(step.path) !== undefined) return true;
            return existsAsync(step.path);
        case StepType.FS_READ_TEXT: {
            const v = getMemoryFile(step.path);
            if (v !== undefined) return engine.decodeString(v);
            return engine.decodeString(await asyncfs.readFile(step.path));
        }
        case StepType.FS_READ_BYTES: {
            const v = getMemoryFile(step.path);
            if (v !== undefined) return v;
            return asyncfs.readFile(step.path);
        }
        case StepType.FS_WRITE_TEXT:
            await writeFileAsync(step.path, engine.encodeString(step.text));
            return undefined;
        case StepType.FS_WRITE_BYTES:
            await writeFileAsync(step.path, step.data);
            return undefined;
        case StepType.FS_ENSURE_DIR:
            await ensureDirAsync(step.path);
            return undefined;
        case StepType.NET_FETCH:
            return fetchAsync(step);
        case StepType.ARCHIVE_UNTAR_GZ:
            log.debug('archive', () => `untar.gz start ${fmtBytes(step.data.byteLength)}`);
            const started = Date.now();
            const files = unTarGz(step.data);
            log.debug('archive', () => `untar.gz done ${files.length} entries ${Date.now() - started}ms`);
            return files;
        case StepType.FLOW:
            await runNestedFlow(step);
            return undefined;
        case StepType.FLOW_ALL:
            await runNestedFlows(step.flows, step.concurrency);
            return undefined;
    }
}

async function runNestedFlow(step: FlowStep): Promise<void> {
    if (!step.key) {
        await runAsync(step.flow);
        return;
    }
    let active = activeFlows.get(step.key);
    if (!active) {
        // Owner chain: create the shared promise. Nested work under this key
        // must not re-yield the same key (see npm installOnce body vs prepare).
        active = runAsync(step.flow);
        activeFlows.set(step.key, active);
        try {
            await active;
        } finally {
            if (activeFlows.get(step.key) === active) activeFlows.delete(step.key);
        }
        return;
    }
    // Coalesce: other chains wait for the owner (safe; not same-chain re-await).
    await active;
}

async function runNestedFlows(flows: Flow<void>[], concurrency: number): Promise<void> {
    const count = Math.min(flows.length, Math.max(1, Math.floor(concurrency) || 1));
    let next = 0;
    const worker = async () => {
        while (next < flows.length) {
            const flow = flows[next++];
            if (flow) await runAsync(flow);
        }
    };
    await Promise.all(Array.from({ length: count }, () => worker()));
}

export function runSync<T>(flow: Flow<T>): T {
    let state = flow.next();
    while (!state.done) {
        try {
            state = flow.next(executeSync(state.value as Step));
        } catch (e) {
            if (flow.throw) {
                state = flow.throw(e);
            } else {
                throw e;
            }
        }
    }
    return state.value;
}

export async function runAsync<T>(flow: Flow<T>): Promise<T> {
    let state = flow.next();
    while (!state.done) {
        try {
            state = flow.next(await executeAsync(state.value as Step));
        } catch (e) {
            if (flow.throw) {
                state = flow.throw(e);
            } else {
                throw e;
            }
        }
    }
    return state.value;
}

export type { TarFile };

function fmtProgress(done: number, total: number): string {
    if (total > 0) return `${fmtBytes(done)}/${fmtBytes(total)} ${Math.floor(done / total * 100)}%`;
    return `${fmtBytes(done)}`;
}

function shortUrl(url: string): string {
    return url.length <= 100 ? url : '...' + url.slice(-97);
}
