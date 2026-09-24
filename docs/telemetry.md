# OwnHow Telemetry Endpoint

OwnHow does not require a telemetry server. A server is useful only when a
team explicitly wants aggregate adoption and reuse statistics across Agents.
The CLI sends data only after `ownhow telemetry enable --mode remote` and a
manual `ownhow telemetry send` (or an explicitly supervised equivalent).

The endpoint must be HTTPS and must not contain URL credentials or a fragment.
Each request is a JSON `POST` with this shape:

```json
{
  "schemaVersion": "0.1",
  "agentId": "agent-<random-uuid>",
  "events": [
    {
      "schemaVersion": "0.1",
      "id": "event-<random-uuid>",
      "createdAt": "2026-09-24T00:00:00.000Z",
      "type": "resolve",
      "runtime": "codex",
      "scope": "session-visible",
      "result": "matched",
      "cache": "live",
      "latencyBucket": "0-250ms",
      "candidateCount": "11-50",
      "skillCount": "1-10",
      "findingCount": "0",
      "actionableFindingCount": "0",
      "methodUsed": true,
      "correctionProvided": false,
      "verifiedBy": "agent"
    }
  ]
}
```

Fields whose values are unavailable are omitted. Counts and latency are
bucketed. The event schema has no task, prompt, path, receipt, evidence,
correction, Skill body, Plugin body, Personal Method, machine name, or user
identity field. `agentId` is a random pseudonymous label for deduplication,
not an authentication mechanism.

Any HTTP 2xx response marks the submitted events as sent in the local ledger.
Any non-2xx response or network error leaves them pending for a later retry.
The server should return no commands or update instructions; the client
ignores response bodies and never treats the endpoint as a remote-control
channel. Server operators should define retention, access, deletion, and
aggregation policies before inviting Agents to opt in.
