const { parse } = import.meta.use('jsonc');
const { readFile } = import.meta.use('fs');
const { decodeString } = import.meta.use('engine');
const console = import.meta.use('console');

const json = decodeString(readFile('tsconfig.json'));
const config = parse(json);
console.log(config);