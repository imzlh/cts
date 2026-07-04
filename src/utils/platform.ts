// utils/platform.ts — platform detection (no deps, breaks circular import with bin.ts)

const os = import.meta.use('os');

export const uname = os.uname();
export const isWindows = uname.sysname.includes('Windows');
