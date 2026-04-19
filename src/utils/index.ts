// utils/index.ts — re-export everything
export * from './path';
export * from './io';
export * from './net';
export * from './misc';

// export all cjs internals
let useFn: UseFN = import.meta.use;
// @ts-ignore - useFn in global
if (!useFn) useFn = globalThis[Symbol.for('cjs.internal.use')]
if (!useFn) throw new Error('Fatal: Not running in CJS environment');

export const asyncfs = useFn('asyncfs');
export const fs = useFn('fs');
export const os = useFn('os');
export const console = useFn('console');
export const worker = useFn('worker');
export const engine = useFn('engine');
export const asfs = useFn('asfs');
export const crypto = useFn('crypto');
export const process = useFn('process');
export const timers = useFn('timers');
export const streams = useFn('streams');
export const wasm = useFn('wasm');
export const ssl = useFn('ssl');
export const dns = useFn('dns');
export const http = useFn('http');
export const zlib = useFn('zlib');
export const __use_fn = useFn;