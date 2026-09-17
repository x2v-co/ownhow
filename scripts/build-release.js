import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { validateBundle, updateNotice } from "../src/upgrade.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(process.argv[2] ?? path.join(root, "dist"));
const pkg = JSON.parse(await readFile(path.join(root, "package.json")));
const files = [];
async function collect(relative) {
  for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error("Release must not contain symlinks");
    if (entry.isDirectory()) await collect(file);
    else files.push({ path: file, content: await readFile(path.join(root, file), "utf8") });
  }
}
await collect("src");
await collect("skills/ownhow-governance");
for (const file of ["package.json", "LICENSE"]) files.push({ path: file, content: await readFile(path.join(root, file), "utf8") });
const bundle = { schemaVersion: 1, version: pkg.version, files };
validateBundle(bundle, pkg.version);
const bytes = JSON.stringify(bundle);
const manifest = { schemaVersion: 1, channel: "stable", version: pkg.version, sha256: createHash("sha256").update(bytes).digest("hex") };
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "ownhow-bundle.json"), bytes);
await writeFile(path.join(output, "ownhow-update.json"), JSON.stringify(manifest, null, 2) + "\n");
await writeFile(path.join(output, "ownhow-update-notice.txt"), updateNotice(pkg.version) + "\n");
console.log(JSON.stringify({ output, version: pkg.version, notice: updateNotice(pkg.version) }));
