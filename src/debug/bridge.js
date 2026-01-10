const sys = import.meta.use('sys');
const engine = import.meta.use('engine');
const fs = import.meta.use('fs');
const arg_0 = sys.args.splice(1, 1);

const content = engine.decodeString(fs.readFile(arg_0));
const mod = new engine.Module(content, arg_0);
Object.assign(mod.meta, import.meta);
mod.eval();