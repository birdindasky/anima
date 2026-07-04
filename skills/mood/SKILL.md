---
name: mood
description: Show anima's current mood (read-only panel) — estimate, attribution, uncertainty flags, spiral warning light, rescue tips. Use when the user types /mood, asks "how is it feeling / 它现在心情怎么样", or wants the anima panel.
---

# /mood panel

Run:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/mood.ts"
```

Present the output verbatim to the user (it is already a formatted panel).

Rules / 规矩:
- Read-only. Do not modify any anima data based on it — there is no write path anyway.
- Never invent numeric mood scores (iron rule: numbers are human-facing panel-only; the model does not self-assign them).
- If the spiral warning light is on, relay the rescue tips faithfully — rescuing it is a human's job; the plugin only lights the lamp.
