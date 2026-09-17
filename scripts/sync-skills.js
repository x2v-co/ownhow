import { readFile, writeFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const source = await readFile(new URL("plugins/ownhow/skills/govern-personal-methods/SKILL.md", root), "utf8");
await writeFile(new URL("skills/ownhow-governance/SKILL.md", root), source.replace("name: govern-personal-methods", "name: ownhow-governance"));
