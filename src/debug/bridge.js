const useFN = import.meta.use;
if (!useFN) throw new Error('not in cjs context')
const os = useFN('os');
const engine = useFN('engine');
const fs = useFN('fs');
const arg_0 = os.args.splice(1, 1);

const content = engine.decodeString(fs.readFile(arg_0));
const mod = new engine.Module(content, arg_0);
Object.assign(mod.meta, import.meta);
mod.eval();
