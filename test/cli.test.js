import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("supports conventional top-level help", async () => {
  const { stdout } = await exec(process.execPath, [path.join(root, "src", "cli.js"), "--help"]);
  assert.match(stdout, /OwnHow MVP/);
  assert.match(stdout, /ownhow scan/);
});
