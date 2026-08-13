import { createHash, randomUUID } from "node:crypto";
import { appendReceipt, loadInbox, loadInboxEntry, loadReceipts, saveInboxEntry } from "./store.js";

export const CAPSULE_PREFIX = "ownhow:receipt-bundle:v1:";
const MAX_CAPSULE_BYTES = 256 * 1024;
const OUTCOMES = new Set(["success", "failure"]);
const RUNTIMES = new Set(["codex", "hermes", "claude", "pi", "opencode", "openclaw", "all", "unknown"]);

function validateInboxId(entryId) {
  if (typeof entryId !== "string" || !/^import-[a-f0-9]{16,64}$/.test(entryId)) throw new Error("Invalid Inbox entry id.");
  return entryId;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(object(value, label)).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
}

function textValue(value, label, { nullable = false, max = 8192 } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  if (Buffer.byteLength(value, "utf8") > max) throw new Error(`${label} is too large.`);
  if (/[\u0000-\u001F\u007F]/.test(value)) throw new Error(`${label} contains unsupported control characters.`);
  return value;
}

function stringArray(value, label, maxItems = 64) {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} must be an array with at most ${maxItems} items.`);
  return value.map((item, index) => textValue(item, `${label}[${index}]`, { max: 2048 }));
}

function isoDate(value, label) {
  textValue(value, label, { max: 64 });
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`);
  return value;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestFor(envelope) {
  const { digest: _digest, ...unsigned } = envelope;
  return `sha256:${createHash("sha256").update(canonicalJson(unsigned)).digest("hex")}`;
}

function redact(value, redactions) {
  if (value === null) return null;
  let output = value;
  const replacements = [
    [/(^|[\s"'`(])\/(?:Users|home|root|var|tmp|etc|opt|srv|mnt)\/[^\s"'`)]+/g, "$1[redacted-path]", "filesystem-path"],
    [/[A-Za-z]:\\(?:[^\s"'`]+\\)*[^\s"'`]+/g, "[redacted-path]", "filesystem-path"],
    [/\b(?:sk|ghp|github_pat|xox[baprs]|AKIA)[-_A-Za-z0-9]{12,}\b/g, "[redacted-secret]", "credential-like-value"],
    [/\b(?:api[_-]?key|access[_-]?token|authorization|password)\s*[:=]\s*[^\s,;]+/gi, "[redacted-secret]", "credential-like-value"]
  ];
  for (const [pattern, replacement, category] of replacements) {
    const next = output.replace(pattern, replacement);
    if (next !== output) redactions.add(category);
    output = next;
  }
  return output;
}

function exportReceipt(receipt, redactions) {
  const plan = receipt.plan ?? {};
  return {
    id: textValue(receipt.id, "receipt.id", { max: 256 }),
    createdAt: isoDate(receipt.createdAt, "receipt.createdAt"),
    task: redact(textValue(receipt.task, "receipt.task"), redactions),
    outcome: receipt.outcome,
    correction: redact(receipt.correction === null || receipt.correction === undefined ? null : textValue(receipt.correction, "receipt.correction"), redactions),
    plan: {
      methodId: null,
      primary: null,
      augment: [],
      risks: stringArray(plan.risks ?? [], "receipt.plan.risks").map((item) => redact(item, redactions))
    }
  };
}

export function createReceiptCapsule(receipt, { agentId, runtime } = {}) {
  const redactions = new Set();
  const safeAgentId = redact(textValue(agentId, "agentId", { max: 256 }), redactions);
  const safeRuntime = runtime ?? receipt.runtime ?? "unknown";
  if (!RUNTIMES.has(safeRuntime)) throw new Error("runtime is not supported by receipt-bundle v1.");
  if (!OUTCOMES.has(receipt.outcome)) throw new Error("receipt.outcome must be success or failure.");
  const envelope = {
    protocol: "ownhow.receipt-bundle",
    version: 1,
    bundleId: `bundle-${Date.now()}-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    source: { agentId: safeAgentId, runtime: safeRuntime },
    receipt: exportReceipt(receipt, redactions),
    privacy: { redactions: [...redactions].sort() }
  };
  envelope.digest = digestFor(envelope);
  return {
    capsule: `${CAPSULE_PREFIX}${Buffer.from(canonicalJson(envelope), "utf8").toString("base64url")}`,
    envelope
  };
}

export function parseReceiptCapsule(input) {
  if (typeof input !== "string") throw new Error("Receipt capsule must be text.");
  if (Buffer.byteLength(input, "utf8") > MAX_CAPSULE_BYTES) throw new Error("Receipt capsule is too large.");
  const capsule = input.trim();
  if (!capsule.startsWith(CAPSULE_PREFIX)) throw new Error("Invalid receipt capsule prefix or unsupported version.");
  const encoded = capsule.slice(CAPSULE_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Receipt capsule payload is not valid base64url.");
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Receipt capsule payload is not valid JSON.");
  }
  exactKeys(envelope, ["protocol", "version", "bundleId", "createdAt", "source", "receipt", "privacy", "digest"], "envelope");
  if (envelope.protocol !== "ownhow.receipt-bundle" || envelope.version !== 1) throw new Error("Unsupported receipt-bundle protocol or version.");
  textValue(envelope.bundleId, "bundleId", { max: 256 });
  isoDate(envelope.createdAt, "createdAt");
  exactKeys(envelope.source, ["agentId", "runtime"], "source");
  textValue(envelope.source.agentId, "source.agentId", { max: 256 });
  if (!RUNTIMES.has(envelope.source.runtime)) throw new Error("source.runtime is unsupported.");
  exactKeys(envelope.receipt, ["id", "createdAt", "task", "outcome", "correction", "plan"], "receipt");
  textValue(envelope.receipt.id, "receipt.id", { max: 256 });
  isoDate(envelope.receipt.createdAt, "receipt.createdAt");
  textValue(envelope.receipt.task, "receipt.task");
  if (!OUTCOMES.has(envelope.receipt.outcome)) throw new Error("receipt.outcome must be success or failure.");
  textValue(envelope.receipt.correction, "receipt.correction", { nullable: true });
  exactKeys(envelope.receipt.plan, ["methodId", "primary", "augment", "risks"], "receipt.plan");
  for (const key of ["methodId", "primary"]) textValue(envelope.receipt.plan[key], `receipt.plan.${key}`, { nullable: true, max: 256 });
  stringArray(envelope.receipt.plan.augment, "receipt.plan.augment");
  stringArray(envelope.receipt.plan.risks, "receipt.plan.risks");
  exactKeys(envelope.privacy, ["redactions"], "privacy");
  stringArray(envelope.privacy.redactions, "privacy.redactions", 16);
  if (!/^sha256:[a-f0-9]{64}$/.test(envelope.digest) || envelope.digest !== digestFor(envelope)) throw new Error("Receipt capsule digest does not match its payload.");
  return envelope;
}

function warningsFor(envelope) {
  return [
    "Source identity is not authenticated; the digest verifies transport integrity only.",
    "Review task and correction for customer or confidential data before accepting.",
    ...envelope.privacy.redactions.map((category) => `Exporter redacted: ${category}.`)
  ];
}

export async function importReceiptCapsule(stateDir, capsule) {
  const bundle = parseReceiptCapsule(capsule);
  const inbox = await loadInbox(stateDir);
  const existing = inbox.find((entry) => entry.bundle.bundleId === bundle.bundleId
    || entry.bundle.digest === bundle.digest
    || (entry.bundle.source.agentId === bundle.source.agentId && entry.bundle.receipt.id === bundle.receipt.id));
  if (existing) return { entry: existing, duplicate: true };
  let idLength = 16;
  let entryId = `import-${bundle.digest.slice("sha256:".length, "sha256:".length + idLength)}`;
  while (inbox.some((entry) => entry.id === entryId)) {
    idLength += 8;
    if (idLength > 64) throw new Error("Cannot allocate a unique Inbox entry id.");
    entryId = `import-${bundle.digest.slice("sha256:".length, "sha256:".length + idLength)}`;
  }
  const entry = {
    id: entryId,
    status: "pending",
    importedAt: new Date().toISOString(),
    transport: "agent-copy-paste",
    bundle,
    warnings: warningsFor(bundle),
    sourceAuthenticated: false
  };
  await saveInboxEntry(stateDir, entry);
  return { entry, duplicate: false };
}

export async function acceptInboxEntry(stateDir, entryId) {
  validateInboxId(entryId);
  const entry = await loadInboxEntry(stateDir, entryId);
  if (!entry) throw new Error(`Inbox entry not found: ${entryId}`);
  if (entry.status === "rejected") throw new Error(`Inbox entry was rejected: ${entryId}`);
  if (entry.status === "accepted") return { entry, receipt: (await loadReceipts(stateDir)).find((item) => item.id === entry.acceptedReceiptId), duplicate: true };
  const bundle = parseReceiptCapsule(`${CAPSULE_PREFIX}${Buffer.from(canonicalJson(entry.bundle), "utf8").toString("base64url")}`);
  const receiptId = `receipt-imported-${bundle.digest.slice("sha256:".length, "sha256:".length + 16)}`;
  const receipts = await loadReceipts(stateDir);
  let receipt = receipts.find((item) => item.id === receiptId || item.provenance?.bundleId === bundle.bundleId || item.provenance?.digest === bundle.digest);
  if (!receipt) {
    receipt = {
      id: receiptId,
      createdAt: bundle.receipt.createdAt,
      task: bundle.receipt.task,
      outcome: bundle.receipt.outcome,
      correction: bundle.receipt.correction,
      plan: bundle.receipt.plan,
      runtime: bundle.source.runtime,
      provenance: {
        transport: entry.transport,
        bundleId: bundle.bundleId,
        digest: bundle.digest,
        sourceReceiptId: bundle.receipt.id,
        sourceAgentId: bundle.source.agentId,
        sourceAuthenticated: false,
        importedAt: entry.importedAt
      }
    };
    await appendReceipt(stateDir, receipt);
  }
  entry.status = "accepted";
  entry.acceptedAt = new Date().toISOString();
  entry.acceptedReceiptId = receipt.id;
  await saveInboxEntry(stateDir, entry);
  return { entry, receipt, duplicate: false };
}

export async function rejectInboxEntry(stateDir, entryId) {
  validateInboxId(entryId);
  const entry = await loadInboxEntry(stateDir, entryId);
  if (!entry) throw new Error(`Inbox entry not found: ${entryId}`);
  if (entry.status === "accepted") throw new Error(`Inbox entry was accepted: ${entryId}`);
  if (entry.status === "rejected") return { entry, duplicate: true };
  entry.status = "rejected";
  entry.rejectedAt = new Date().toISOString();
  await saveInboxEntry(stateDir, entry);
  return { entry, duplicate: false };
}
