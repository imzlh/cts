const os = import.meta.use('os');

export const uname = os.uname();
export const isWindows = uname.sysname.includes('Windows');
