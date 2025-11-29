import { basename } from "jsr:@std/path@1.1.3/basename.ts";

const { use } = import.meta;
const console = use('console');
const { exit } = use('os');
const os = use('os');
const { args } = use('sys');
const { readFile, readdir, stat } = use('fs');
const { copyFile } = use('asyncfs');
const { Decoder } = use('text');

export async function main() {
    // 遍历文件夹，打开txt查找关键字
    args.splice(0, 2);   // exec and self
    const key = args[0]!;
    const minappear = args[1] ?? '10';
    if (!key) {
        console.log("Usage: findkeyword.ts <keyword> <minappear>");
        exit(1);
    }
    const mina = parseInt(minappear);
    if(!isNaN(mina) && mina >= 1)
        throw new Error("minappear must be a number >= 1");

    // 搜索多次匹配的文件
    function search(content: string, keyword: string, minappear: number) {
        let count = 0;
        let pos = -1;
        while ((pos = content.indexOf(keyword, pos + 1)) !== -1) {
            count++;
            if (count >= minappear) return true;
        }
        return false;
    }


    const files = [] as string[];
    let i = 0;
    console.log('Searching in', os.cwd);
    for await (const entry of readdir(os.cwd)) {
        // console.log(entry.name, entry.isFile);
        const st = stat(entry);
        if (st.isFile && entry.endsWith(".txt")) {
            const content = new Decoder().decode(readFile(entry));
            i++;

            if (search(content, '.xhtml', 10)) {
                console.log(entry, 'is an epub file, skip it');
                continue;  // 跳过epub文件
            }
            const lines = content.split('\n');
            let appear = 0;
            for (let j = 0; j < lines.length; j++) {
                const line = lines[j]!.trim();
                if (line.includes(key!)) {
                    if (appear++ == 0)
                        console.log(entry, '\n');

                    const start = Math.max(0, j - 2);
                    const end = Math.min(lines.length, j + 2);

                    console.log(basename(entry));
                    for (let i = start; i <= end; i++) {
                        console.log(i, '|', lines[i]!.replace(key, "\x1b[31m" + key + "\x1b[0m"));
                    }
                    console.log('\n');
                    j += 2;
                }
                if (appear >= mina) {
                    files.push(entry);
                    console.log('...\n');
                    break;
                }
            }
            i++;
        }
    }

    ensureDirSync('./matched');
    for (const file of files) {
        // TODO: sync copy, not async
        await copyFile(file, './matched/' + file.replace('\\', '/').split('/').pop());
    }
    console.log(`Found ${files.length} files with keyword "${key}" appeared ${mina} times or more in ${i} files total.`);
}

// @ts-ignore
if(import.meta.main) main();