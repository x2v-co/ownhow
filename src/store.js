import { mkdir, readFile, readdir, rename, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export function stateDirectory(override) {
  return path.resolve(override ?? process.env.OWNHOW_HOME ?? path.join(os.homedir(), ".ownhow"));
}

export async function ensureState(stateDir) {
  await Promise.all([
    mkdir(stateDir, { recursive: true }),
    mkdir(path.join(stateDir, "proposals"), { recursive: true }),
    mkdir(path.join(stateDir, "methods"), { recursive: true })
  ]);
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`Cannot read JSON ${file}: ${error.message}`);
  }
}

export async function saveInventory(stateDir, inventory) {
  await ensureState(stateDir);
  await writeJson(path.join(stateDir, "inventory.json"), inventory);
}

export async function loadInventory(stateDir) {
  const inventory = await readJson(path.join(stateDir, "inventory.json"));
  if (!inventory) throw new Error("No inventory found. Run `ownhow scan` first.");
  return inventory;
}

export async function appendReceipt(stateDir, receipt) {
  await ensureState(stateDir);
  await appendFile(path.join(stateDir, "receipts.jsonl"), `${JSON.stringify(receipt)}\n`, "utf8");
}

export async function loadReceipts(stateDir) {
  try {
    const text = await readFile(path.join(stateDir, "receipts.jsonl"), "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function listJsonFiles(directory) {
  try {
    const names = await readdir(directory);
    return names.filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function loadMethods(stateDir) {
  const directory = path.join(stateDir, "methods");
  const names = await listJsonFiles(directory);
  return Promise.all(names.map((name) => readJson(path.join(directory, name))));
}
