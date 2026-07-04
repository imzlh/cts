# cts — TypeScript Loader for circu.js

Module resolution, TS transformation, and multi-protocol support for the circu.js runtime.

## Architecture (4-Layer)

```
import 'foo'  ─→  api/          public API surface (re-exports)
                      │
                 runtime/       engine hooks + lifecycle (composition root)
                      │
                 resolve/       find files → ModuleInfo (3-level cache)
                      │
                 source/        read + transform (OXC primary, Sucrase fallback)
                      │
                 compile/       compile + cache + CJS↔ESM bridge
```

## Usage

```typescript
import { createRuntime } from 'cts/src/api';

const runtime = createRuntime({ cacheDir: '~/.cts' });
const mod = await runtime.loadEntry('./app.ts');
await mod.eval();
```

See `../AGENT.md` for full architecture details.
