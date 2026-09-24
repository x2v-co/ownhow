import test from "node:test";
import assert from "node:assert/strict";
import { analyzeInventory } from "../src/analyzer.js";

function skill(id, description, extra = {}) {
  return {
    id,
    kind: "skill",
    runtime: "codex",
    name: id,
    description,
    triggers: [],
    tools: [],
    writes: [],
    sideEffects: [],
    lifecycle: { discovered: true, installed: true, enabled: true, sessionVisible: true },
    ...extra
  };
}

test("high-frequency description tokens do not create a quadratic candidate set", () => {
  const components = Array.from({ length: 200 }, (_, index) => skill(`skill-${index}`, "review skill task workflow common words"));
  // Exact name matching remains complete even though the descriptions are
  // intentionally dominated by high-frequency generic terms.
  components.push(skill("same-name", "review skill task workflow common words"));
  components.push(skill("same-name-copy", "review skill task workflow common words", { name: "same-name" }));
  const analysis = analyzeInventory({ components });
  assert.equal(analysis.comparisons, 1);
  assert.equal(analysis.findings.filter((finding) => finding.type === "duplicate_name").length, 1);
});

test("selective semantic tokens still identify real overlap", () => {
  const analysis = analyzeInventory({ components: [
    skill("release-a", "deploy release service changes"),
    skill("release-b", "deploy release service changes safely"),
    skill("unrelated", "translate a document into another language")
  ] });
  assert.ok(analysis.findings.some((finding) => finding.type === "semantic_overlap"));
  assert.equal(analysis.findingGroups.runtime_copy.count, 0);
  assert.equal(analysis.findingGroups.duplicate_registration.count, 0);
  assert.equal(analysis.findingSummary.actionable, analysis.actionableFindings.length);
});

test("discovered-only overlap remains informational until co-visibility is proven", () => {
  const analysis = analyzeInventory({ components: [
    skill("a", "specialized task", { lifecycle: { discovered: true, installed: null, enabled: null, sessionVisible: null } }),
    skill("b", "specialized task", { lifecycle: { discovered: true, installed: null, enabled: null, sessionVisible: null } })
  ] });
  const overlap = analysis.findings.find((finding) => finding.type === "semantic_overlap");
  assert.equal(overlap?.severity, "info");
  assert.equal(analysis.actionableFindings.length, 0);
});
