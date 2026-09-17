/**
 * 本地零依赖构建：在无法访问 npm registry 的环境下，
 * 使用 Node 22 内置的类型擦除把 TypeScript 转译为 JS 供测试运行。
 * 生产/CI 仍以 `tsc -p tsconfig.json` 的严格类型检查为准。
 */
import { readdir, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { stripTypeScriptTypes } from "node:module";

const root = process.cwd();
const outDir = join(root, "dist");
const dirs = ["src", "tests"];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

await rm(outDir, { recursive: true, force: true });
let count = 0;
for (const srcDir of dirs.map((d) => join(root, d))) {
  for (const file of await walk(srcDir)) {
    const source = await readFile(file, "utf8");
    const stripped = stripTypeScriptTypes(source, { mode: "strip" });
    const code = typeof stripped === "string" ? stripped : stripped.code;
    const target = join(outDir, relative(root, file)).replace(/\.ts$/, ".js");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, code, "utf8");
    count += 1;
  }
}
process.stdout.write(`strip-built ${count} files -> dist/\n`);
