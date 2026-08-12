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
