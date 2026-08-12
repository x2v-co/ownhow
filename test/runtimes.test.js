import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { piRuntime } from "../src/runtimes/pi.js";
import { opencodeRuntime } from "../src/runtimes/opencode.js";
import { openclawRuntime } from "../src/runtimes/openclaw.js";
import { scanRoots } from "../src/scanner.js";

const skill = (name) => `---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n`;

async function putSkill(root, directory, name = directory) {
  const target = path.join(root, directory);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "SKILL.md"), skill(name));
  return path.join(target, "SKILL.md");
}

test("Pi applies trust, precedence, overrides, symlink dedupe, and package Skills", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ownhow-pi-runtime-"));
  const home = path.join(temporary, "home");
  const cwd = path.join(temporary, "project");
  const agentDir = path.join(home, ".pi", "agent");
  const packageRoot = path.join(temporary, "package");
  try {
    await Promise.all([mkdir(path.join(cwd, ".git"), { recursive: true }), mkdir(agentDir, { recursive: true })]);
    const userDuplicate = await putSkill(path.join(agentDir, "skills"), "duplicate", "duplicate");
    await putSkill(path.join(agentDir, "skills"), "disabled", "disabled");
    const projectDuplicate = await putSkill(path.join(cwd, ".pi", "skills"), "duplicate", "duplicate");
    await putSkill(path.join(cwd, ".agents", "skills"), "project-agent", "project-agent");
    const packageSkill = await putSkill(path.join(packageRoot, "skills"), "packaged", "packaged");
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "pi-package", pi: { skills: ["./skills"] } }));
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ skills: ["!skills/disabled/**"], packages: [packageRoot] }));
    await writeFile(path.join(agentDir, "trust.json"), JSON.stringify({ [cwd]: true }));
    await symlink(path.dirname(userDuplicate), path.join(agentDir, "skills", "duplicate-link"), "dir");

    const state = await piRuntime({ cwd, home, agentDir });
    assert.equal(state.trusted, true);
    assert.ok(state.skillFiles.includes(projectDuplicate));
    assert.ok(state.skillFiles.includes(userDuplicate));
    assert.ok(state.skillFiles.includes(packageSkill));
    assert.ok(!state.skillFiles.some((file) => file.includes(`${path.sep}disabled${path.sep}`)));
    assert.equal(state.skillFiles.filter((file) => file === userDuplicate).length, 1);

    const inventory = await scanRoots({ roots: state.roots, runtime: "pi", runtimeState: state, cwd, home });
    assert.equal(inventory.components.find((item) => item.name === "duplicate").source, path.dirname(projectDuplicate));
    assert.ok(inventory.components.some((item) => item.name === "project-agent"));
    assert.ok(inventory.components.some((item) => item.name === "packaged"));

    await writeFile(path.join(agentDir, "trust.json"), JSON.stringify({ [cwd]: false }));
    const untrusted = await piRuntime({ cwd, home, agentDir });
    assert.equal(untrusted.trusted, false);
    assert.ok(!untrusted.skillFiles.includes(projectDuplicate));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("OpenCode uses debug skill as the authoritative last-wins set", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ownhow-opencode-runtime-"));
  const home = path.join(temporary, "home");
  const cwd = path.join(temporary, "project");
  try {
    const selected = await putSkill(path.join(cwd, ".opencode", "skills"), "selected", "duplicate");
    const run = async (_command, args) => args[1] === "skill"
      ? [{ name: "duplicate", description: "selected", location: selected }, { name: "builtin", description: "built in", location: "builtin://skill" }]
      : { plugin: ["demo-plugin@1.0.0", "demo-plugin@2.0.0"] };
    const state = await opencodeRuntime({ cwd, home, run, env: {} });
    assert.equal(state.authoritative, true);
    assert.deepEqual(state.skillFiles, [selected]);
    assert.equal(state.syntheticSkills[0].name, "builtin");
    const inventory = await scanRoots({ roots: state.roots, runtime: "opencode", runtimeState: state, cwd, home });
    assert.deepEqual(inventory.components.filter((item) => item.kind === "skill").map((item) => item.name).sort(), ["builtin", "duplicate"]);
    assert.deepEqual(state.plugins.map((item) => item.name), ["demo-plugin"]);
    assert.ok(inventory.components.every((item) => item.runtime === "opencode"));

    const disabled = await opencodeRuntime({ cwd, home, run, env: { OPENCODE_DISABLE_EXTERNAL_SKILLS: "1" } });
    assert.ok(!disabled.roots.some((root) => root.includes(`${path.sep}.agents${path.sep}`) || root.includes(`${path.sep}.claude${path.sep}`)));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("OpenClaw filters eligible Skills and loaded Plugins while retaining pathless Skills", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ownhow-openclaw-runtime-"));
  const home = path.join(temporary, "home");
  const workspace = path.join(temporary, "workspace");
  try {
    await putSkill(path.join(workspace, "skills"), "local", "local");
    const run = async (_command, args) => {
      if (args[0] === "skills") return {
        workspaceDir: workspace, managedSkillsDir: path.join(home, ".openclaw", "skills"),
        skills: [
          { name: "local", description: "local", eligible: true, blockedByAgentFilter: false, source: "workspace" },
          { name: "bundled", description: "bundled", eligible: true, blockedByAgentFilter: false, source: "openclaw-bundled" },
          { name: "blocked", description: "blocked", eligible: false, blockedByAgentFilter: false, source: "workspace" }
        ]
      };
      return { plugins: [
        { id: "loaded", name: "Loaded", rootDir: path.join(temporary, "loaded"), enabled: true, status: "loaded", version: "1" },
        { id: "disabled", name: "Disabled", rootDir: path.join(temporary, "disabled"), enabled: false, status: "disabled", version: "1" }
      ] };
    };
    const state = await openclawRuntime({ cwd: workspace, home, run, env: {} });
    const inventory = await scanRoots({ roots: state.roots, runtime: "openclaw", runtimeState: state, cwd: workspace, home });
    assert.deepEqual(inventory.components.filter((item) => item.kind === "skill").map((item) => item.name).sort(), ["bundled", "local"]);
    assert.deepEqual(inventory.components.filter((item) => item.kind === "plugin").map((item) => item.name), ["loaded"]);
    assert.equal(inventory.components.find((item) => item.name === "bundled").source, "openclaw:openclaw-bundled");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
