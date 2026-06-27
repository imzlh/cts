// utils/index.ts — re-export everything
export * from './path';
export * from './io';
export * from './misc';

const os = import.meta.use('os');
export const uname = os.uname();
export const isWindows = uname.sysname.includes('Windows');