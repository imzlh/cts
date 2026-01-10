const suite = [
  // JSR 边缘包
  "jsr:@std/encoding@0.216.0/hex",          // 指定旧版
  "jsr:@luca/flag@1.0.0",                   // 冷门小库
  "jsr:@marvin/hack-that-does-not-exist",    // 肯定没有

  // HTTP(S) 边缘
  "https://deno.land/x/fresh@1.6.8/dev.ts", // 远程 dev 工具
  "https://raw.githubusercontent.com/denoland/deno_std/main/uuid/mod.ts",
  "https://example.com/fake.ts",            // 404 地址

  // 文件系统偏门
  "file:///etc/shadow",                     // 权限不足 / 不存在

  // 协议混搭
  "data:application/typescript;base64,ZXhwb3J0IGNvbnN0IHggPSAibm9vcCI7",
];

for (const url of suite) {
  try {
    const mod = await import(url);
    console.log(`✅ ${url}  → `, Object.keys(mod));
  } catch (e) {
    console.log(`❌ ${url}  → `, (e as Error).message.split("\n")[0]);
  }
}