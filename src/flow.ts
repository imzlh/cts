import { readText, ensureDir, writeText } from './utils/io';
import { unTarGz, type TarFile } from './utils/misc';
import { fmtBytes } from './utils/misc';
import { isEnabled, log } from './utils/log';
import { dirname } from './utils/path';

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
    }
}

function executeSync(step: Step): unknown {
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

async function writeFileAsync(path: string, data: Uint8Array | ArrayBuffer): Promise<void> {
    const bytes = (data instanceof Uint8Array ? data : new Uint8Array(data)) as Uint8Array<ArrayBuffer>;
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

async function executeAsync(step: Step): Promise<unknown> {
    switch (step.type) {
        case StepType.FS_EXISTS:
            return existsAsync(step.path);
        case StepType.FS_READ_TEXT:
            return engine.decodeString(await asyncfs.readFile(step.path));
        case StepType.FS_READ_BYTES:
            return asyncfs.readFile(step.path);
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
    }
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

function fmtProgress(done: number, total: number): string {
    if (total > 0) return `${fmtBytes(done)}/${fmtBytes(total)} ${Math.floor(done / total * 100)}%`;
    return `${fmtBytes(done)}`;
}

function shortUrl(url: string): string {
    return url.length <= 100 ? url : '...' + url.slice(-97);
}
