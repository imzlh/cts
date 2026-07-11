export type ModuleFormat = 'esm' | 'cjs';
export type FileKind     = 'source' | 'json' | 'wasm' | 'binary' | 'text';
export type LifecycleScriptName = 'install' | 'postinstall';

// 'normal': no node_modules generated (default).
// 'soft': project top-level directory symlinks/junctions into the flat npm store.
// 'hard': full nested node_modules materialization using per-file hard links,
//         falling back to a copy only when the store and project are on
//         different volumes.
export type NodeModulesMode = 'normal' | 'soft' | 'hard';

export interface ModuleInfo {
    specPath:  string;
    localPath: string;
    format:    ModuleFormat;
    fileKind:  FileKind;
    /** QuickJS-facing runtime identity when a request needs a non-canonical module view. */
    moduleId?: string;
    /** Some source modules cannot safely round-trip through serialized bytecode. */
    cacheBytecode?: boolean;
}

export function moduleRef(info: Pick<ModuleInfo, 'specPath' | 'moduleId'>): string {
    return info.moduleId ?? info.specPath;
}

/** Collision-free runtime identity for alternate text/bytes/json views. */
export function moduleViewRef(specPath: string, fileKind: FileKind): string {
    return `ctsview:${fileKind}/${encodeURIComponent(specPath)}`;
}

export interface LifecycleScriptEntry {
    name:      string;
    version:   string;
    dir:       string;
    lifecycle: LifecycleScriptName;
    script:    string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ConfigOptions {
    cacheDir?:      string;
    enableHttp?:    boolean;
    enableJsr?:     boolean;
    enableNode?:    boolean;
    silent?:        boolean;
    jsrCacheTTL?:   number;
    requestTimeout?: number;
    memoryLimit?:   number;
    maxStackSize?:  number;
    pathAliases?:   Record<string, string[]>;
    baseUrl?:       string;
    importMap?:     Record<string, string>;
    conditions?:    string[];
    polyfill?:      string;
    enableCache?:   boolean;
    cachedOnly?:    boolean;
    enableOxc?:     boolean;
    eval?:          string;   // inline code to evaluate (-e / --eval)
    // Lock options
    lockDir?:       string;   // dir containing cts.lock (default: entry file dir)
    frozen?:        boolean;  // refuse to resolve anything not already in lock
    disableLock?:   boolean;  // disable lock entirely
    persistLock?:   boolean;  // write cts.lock to disk (only `cno cache`); else read-only/in-memory
    // Lifecycle scripts
    ignoreScripts?: boolean;  // skip deferred npm lifecycle scripts during cno cache
    // node_modules materialization (see NodeModulesMode)
    nodeModulesMode?: NodeModulesMode;
    // JSX options
    jsxPragma?:     string;   // JSX element factory (default: React.createElement)
    jsxFragmentPragma?: string; // JSX fragment factory (default: React.Fragment)
}

// RuntimeConfig: ConfigOptions with fields that createConfig() always fills
// (via DEFAULTS) promoted to required. All other fields stay optional.
export interface RuntimeConfig extends ConfigOptions {
    // Always set by createConfig() (see config.ts DEFAULTS)
    cacheDir:       string;
    enableHttp:     boolean;
    enableJsr:      boolean;
    enableNode:     boolean;
    silent:         boolean;
    jsrCacheTTL:    number;
    requestTimeout: number;
    enableCache:    boolean;
    cachedOnly:     boolean;
    enableOxc:      boolean;
    ignoreScripts:  boolean;
    nodeModulesMode: NodeModulesMode;
    polyfill:       string;
    // Injected by ModuleResolver constructor
    lockStore?:     import('./lock').LockStore;
    // CLI parse output
    _?:             string;
    _args?:         string[];
    _offset:        number;
    _cli?:          import('./utils/misc').ParsedArgs;
}

// ---------------------------------------------------------------------------
// Package.json
// ---------------------------------------------------------------------------

export interface PackageJson {
    name?:         string;
    version?:      string;
    main?:         string;
    module?:       string;
    exports?:      string | Record<string, unknown>;
    type?:         'module' | 'commonjs';
    imports?:      Record<string, string>;
    bin?:          string | Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    os?:           string[];
    cpu?:          string[];
    scripts?:      Record<string, string>;
}

// ---------------------------------------------------------------------------
// JSR registry
// ---------------------------------------------------------------------------

export interface JsrPackageMeta {
    versions: Record<string, { yanked?: boolean }>;
    latest?:  string;
}

export interface JsrVersionMeta {
    manifest: Record<string, { size: number; checksum: string }>;
    exports?: Record<string, string>;
}

export interface ParsedJsrSpec {
    scope:   string;
    name:    string;
    version: string | null;
    path:    string;
}

export type NodeBuiltinResolver = (name: string, parent?: string) => string | null;
