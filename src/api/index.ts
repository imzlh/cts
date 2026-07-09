// api/index.ts — public API surface for external consumers (cno-cli, etc.)
// Re-exports only; internal refactors behind this boundary don't break callers.

export { createRuntime, TypeScriptRuntime } from '../runtime/index';
export { createConfig, loadConfigFile, CLI_TPL } from '../config';
export { Transformer } from '../source/transform';
export { loadTasks, BinResolver } from '../task';
export { LockStore } from '../lock';
export {
    ParseDriver,
    PrecompileDriver,
    isParseWorker,
    isCompilerWorker,
    runParseWorker,
    runCompilerWorker,
} from '../parse';
export { fatal, formatError, err, ErrorKind, TransformError } from '../errors';
export {
    log, errMsg, uname, isWindows, stripJsonc,
    dirname, normalizePath, isAbsolute, joinPaths, cwd, toPosixPath,
    resolvePath, resolveFile, isRelative, extname, canonicalizePath,
} from '../utils';
export { createResourceManager, ResourceManager } from '../runtime/resources';
export type {
    ModuleInfo, ModuleFormat, FileKind,
    ConfigOptions, RuntimeConfig, PackageJson,
    NodeBuiltinResolver, NodeModulesMode,
} from '../types';
