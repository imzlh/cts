import { readText, ensureDir, writeText } from './utils/io';
import { fs, __use_fn } from './utils/index';
import { unTarGz, type TarFile } from './utils/misc';

const curlMod = __use_fn('curl') as typeof CModuleCURL;

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
    | ArchiveUntarGzStep;

export type Flow<T> = Generator<Step, T, any>;

function bytesOf(data: Uint8Array | ArrayBuffer): Uint8Array | ArrayBuffer {
    if (data instanceof Uint8Array) return data;
    return data;
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
    if (step.onProgress) {
        curl.onProgress((dltotal, dlnow) => {
            step.onProgress!(Number(dlnow), Number(dltotal));
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

function getAsyncPool(): CModuleCURL.ConnPool {
    if (!asyncPool) {
        asyncPool = new curlMod.ConnPool({
            maxConnections: 16,
            maxConnectionsPerHost: 4,
            pipelining: true,
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
    const res = await curl.perform()
    return toResult(res);
}

function fetchSync(step: NetFetchStep): NetFetchResult {
    const pool = getSyncPool();
    const curl = new curlMod.CURL(pool);
    configureCurl(curl, step);
    return toResult(curl.performSync());
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

function executeStep(step: Step, fetch: (step: NetFetchStep) => unknown): unknown {
    switch (step.type) {
        case StepType.FS_EXISTS:
            return fs.exists(step.path);
        case StepType.FS_READ_TEXT:
            return readText(step.path);
        case StepType.FS_READ_BYTES:
            return fs.readFile(step.path);
        case StepType.FS_WRITE_TEXT:
            writeText(step.path, step.text);
            return undefined;
        case StepType.FS_WRITE_BYTES:
            fs.writeFile(step.path, bytesOf(step.data));
            return undefined;
        case StepType.FS_ENSURE_DIR:
            ensureDir(step.path);
            return undefined;
        case StepType.NET_FETCH:
            return fetch(step);
        case StepType.ARCHIVE_UNTAR_GZ:
            return unTarGz(step.data);
    }
}

function executeSync(step: Step): unknown {
    return executeStep(step, fetchSync);
}

async function executeAsync(step: Step): Promise<unknown> {
    return executeStep(step, fetchAsync);
}

export function runSync<T>(flow: Flow<T>): T {
    let state = flow.next();
    while (!state.done) {
        try {
            state = flow.next(executeSync(state.value as Step));
        } catch (e) {
            state = flow.throw ? flow.throw(e) : (() => { throw e; })();
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
            state = flow.throw ? flow.throw(e) : (() => { throw e; })();
        }
    }
    return state.value;
}

export type { TarFile };
