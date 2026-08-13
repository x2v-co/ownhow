import test from "node:test";
import assert from "node:assert/strict";
import { resolveTask } from "../src/resolver.js";

const governanceSkill = {
  id: "skill:ownhow:govern-personal-methods",
  kind: "skill",
  name: "govern-personal-methods",
  description: "检查本地方法、分析 Skill 或 Plugin 冲突、为当前任务选择方法，并治理 Personal Methods with OwnHow and Codex.",
  source: "/plugin/ownhow/skills/govern-personal-methods",
  metadata: {},
  triggers: [],
  sideEffects: [],
  writes: []
};

test("selects a governance Skill from several independent task signals", () => {
  const plan = resolveTask({ components: [governanceSkill] }, "检查我的本地 Codex methods，分析冲突，并告诉我当前任务应该使用哪个 method。", []);
  assert.equal(plan.primary?.name, "govern-personal-methods");
  assert.ok(plan.primary.sharedTokens.includes("当前"));
  assert.ok(!plan.primary.sharedTokens.includes("前任"));
  assert.equal(plan.methodId, null);
});

test("does not select a Skill from incidental overlap", () => {
  const plan = resolveTask({ components: [governanceSkill] }, "修复 Codex 项目中的一个按钮", []);
  assert.equal(plan.primary, null);
});

test("uses only session-visible components for authoritative inventories", () => {
  const base = {
    schemaVersion: "0.2",
    analysisScope: "session-visible",
    components: [
      { id: "visible", kind: "skill", name: "visible-review", description: "review merge requests", triggers: [], metadata: {}, sideEffects: [], writes: [], lifecycle: { discovered: true, installed: true, enabled: true, sessionVisible: true } },
      { id: "hidden", kind: "skill", name: "hidden-review", description: "review merge requests", triggers: [], metadata: {}, sideEffects: [], writes: [], lifecycle: { discovered: true, installed: true, enabled: false, sessionVisible: false } }
    ]
  };
  const plan = resolveTask(base, "review merge requests", []);
  assert.equal(plan.primary.id, "visible");
  assert.ok(!plan.excluded.some((item) => item.id === "hidden"));
});
