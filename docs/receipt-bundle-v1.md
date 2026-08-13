# OwnHow Receipt Bundle Protocol v1

Receipt Bundle v1 carries a minimal task Receipt from an unreachable remote Agent to a trusted OwnHow installation through an existing chat or copy-and-paste channel. It requires no OwnHow server or account.

## Transport

A capsule is one UTF-8 line, at most 256 KiB:

```text
ownhow:receipt-bundle:v1:<base64url(canonical JSON envelope)>
```

Base64url has no padding. All text fields must be non-empty within their declared limits and must not contain C0 or DEL control characters.

## Envelope

```json
{
  "protocol": "ownhow.receipt-bundle",
  "version": 1,
  "bundleId": "bundle-...",
  "createdAt": "2026-08-13T01:00:00.000Z",
  "source": {
    "agentId": "customer-research-a",
    "runtime": "hermes"
  },
  "receipt": {
    "id": "receipt-...",
    "createdAt": "2026-08-13T00:59:00.000Z",
    "task": "Research customer onboarding",
    "outcome": "failure",
    "correction": "Cite the customer's observed workflow",
    "plan": {
      "methodId": null,
      "primary": null,
      "augment": [],
      "risks": []
    }
  },
  "privacy": {
    "redactions": []
  },
  "digest": "sha256:<64 lowercase hex characters>"
}
```

Allowed runtimes are `codex`, `hermes`, `claude`, `pi`, `opencode`, `openclaw`, `all`, and `unknown`. Outcome is `success` or `failure`. Correction may be `null`. In v1, exported `methodId`, `primary`, and `augment` are intentionally empty to avoid disclosing local component identifiers. Unknown or missing fields are invalid.

## Canonicalization and digest

Canonical JSON recursively sorts object keys by JavaScript string ordering, preserves array order, uses standard JSON string serialization, and adds no whitespace. Compute SHA-256 over the UTF-8 canonical envelope with the top-level `digest` field omitted. Encode the result as `sha256:` plus lowercase hexadecimal.

The digest verifies that the payload has not changed since export. It is not a signature and does not authenticate `agentId`, the remote machine, the conversation, or the user.

## Import state machine

```text
capsule -> validate -> pending -> accept -> local Receipt
                         |
                         +-> reject -> audit record
```

An implementation must not append a pending import to the local Receipt log. It must require explicit acceptance, preserve provenance on the accepted Receipt, and never execute imported strings. Rejection should preserve an audit entry. Repeated bundle IDs and digests are duplicates; a source Receipt ID is a duplicate only within the same source Agent label.

## Privacy

The exporter must omit raw conversations, inventories, Skill bodies, arbitrary traces, full local paths, credentials, and local component identifiers. OwnHow applies limited pattern-based redaction, but the remote Agent or user must review task, correction, and risk text for customer or confidential data before transport.

## Agent behavior

The remote Agent records only user-confirmed or objectively observed outcomes, asks before exporting potentially confidential metadata, and returns the capsule through the user's existing channel. The receiving Agent imports into pending state, displays the self-asserted source, runtime, task, outcome, correction, and warnings, and requests explicit accept or reject. Neither side may claim identity authentication or automatically accept, propose, apply, or forward a bundle.
