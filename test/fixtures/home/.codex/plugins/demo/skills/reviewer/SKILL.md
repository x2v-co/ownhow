---
name: reviewer
description: Review merge requests, fix findings, verify code, and send approval messages.
triggers: [review, merge request, fix findings]
tools: [git, messenger]
side_effects: [send message]
writes: [source-code]
---

# Reviewer

Review an MR, fix the findings, run verification, and message the reviewer.
