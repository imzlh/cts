// types.ts — shared types

export type ModuleFormat = 'esm' | 'cjs';
export type FileKind     = 'source' | 'json' | 'wasm' | 'binary' | 'text';

export interface ModuleInfo {
    specPath:  string;
    localPath: string;
    format:    ModuleFormat;
    fileKind:  FileKind;
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
    memoryLimit?:   number;
    maxStackSize?:  number;
    pathAliases?:   Record<string, string[]>;
    baseUrl?:       string;
    importMap?:     Record<string, string>;
    polyfill?:      string;
    disableCache?:  boolean;
    eval?:          string;   // inline code to evaluate (-e / --eval)
    // Lock options
    lockDir?:       string;   // dir containing cts.lock (default: entry file dir)
    frozen?:        boolean;  // refuse to resolve anything not already in lock
    noLock?:        boolean;  // disable lock entirely
}

// Fields that are always required after createConfig()
// Optional fields remain optional (no value → feature disabled)
export interface RuntimeConfig extends Required<Omit<ConfigOptions,
    'pathAliases'|'baseUrl'|'importMap'|'memoryLimit'|'maxStackSize'|
    'lockDir'|'frozen'|'noLock'|'eval'>> {
    pathAliases?:  Record<string, string[]>;
    baseUrl?:      string;
    importMap?:    Record<string, string>;
    memoryLimit?:  number;
    maxStackSize?: number;
    lockDir?:      string;
    frozen?:       boolean;
    noLock?:       boolean;
    eval?:         string;
    // CLI parse output
    _?:            string;
    _args?:        string[];
    _offset:       number;
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
    dependencies?: Record<string, string>;
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
