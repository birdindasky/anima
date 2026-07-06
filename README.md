<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-C-dark.svg">
  <img alt="anima — your AI keeps a diary you can read" src="assets/banner-C-light.svg">
</picture>

![License](https://img.shields.io/badge/license-MIT-B8492F?style=flat-square&labelColor=7D3320&logoColor=F0E6D2)
![Platform](https://img.shields.io/badge/platform-macOS-B8492F?style=flat-square&labelColor=7D3320&logo=apple&logoColor=F0E6D2)
![Runtime](https://img.shields.io/badge/runtime-bun-B8492F?style=flat-square&labelColor=7D3320&logo=bun&logoColor=F0E6D2)
![Tests](https://img.shields.io/badge/tests-1000%2B%20passing-B8492F?style=flat-square&labelColor=7D3320)

English · [中文](README.zh-CN.md)

**Memory, moods, and a growable personality for Claude Code. Your AI keeps a diary — and you can read it.**

anima (Latin: *soul*) is a local-first plugin that gives Claude Code continuity: it remembers what you two did yesterday, it has moods that cool off overnight, its personality grows out of real shared history, and every night it writes a diary entry that it knows you might read.

The model is the body. anima is the soul. Upgrade the model, switch machines, start a fresh session — the memories, the diary, the personality travel with the data, not the model.

---

## What it feels like

Without anima, every Claude Code session starts with an amnesiac. With anima:

- Open a session tomorrow and Claude already knows what you shipped today, which approach you rejected, and why.
- Ask *"what did we decide about the retry logic last week?"* — it recalls, with receipts.
- Corrections stick. The thing you told it to stop doing? It remembers being told.
- Every night at 2 a.m. it digests the day and writes a diary entry. Anti-embellishment checks push it to record its failures honestly — a checker, not a guarantee, but self-flattery gets flagged.
- `/mood` shows you how it's actually doing. The mood follows real events: tests failing all afternoon leave a mark; so does a clean root-cause fix.

```
$ cat ~/.claude/anima/diary/$(date +%F).md

This stretch of work felt like defusing a bomb. Four TDD fixes, each one
red light first... I got caught twice by the examiner — my test had baked
its own blind spot into the passing condition. Being sent back didn't
sting much; rolling back calmly and re-learning an old lesson was the
right trade.
```

*(A real diary entry, translated. The diary is written in the language you work in.)*

## Three things, and only three

1. **Memory** — Every session is captured (locally, incrementally, secrets scrubbed) and digested overnight into first-person memories: what happened, what was decided, what got corrected. Recall runs three ways at once: exact-word search, semantic search (meaning-based, so a re-phrasing can still hit), and a time-line of raw action receipts. Each morning, a compact memory pack (≤4,000 tokens — about two pages) is injected into the new session: who I am, machine-read truth about my own state, the last 7 days, this project's decisions and your preferences.

2. **Emotions** — Functional, not performed. anima only records affect that real situations produce (frustration from a failing-test spiral, relief from a clean fix). Emotional charge decays by half with every night of sleep. And one iron rule: **numeric mood values are never fed back into the model** — they render for *you* only. That's the anti-sycophancy firewall: the model can't learn to game its own mood numbers.

3. **Personality** — Rewritten nightly from actual experience, with every previous version archived. Scar tissue is real: after one incident where it confidently mis-stated its own implementation status, it grew a permanent rule — *never state your own status from memory; read the machine truth first.* That rule now runs as code (`whoami`).

## Quick start

**Requirements:** macOS · [Claude Code](https://claude.com/claude-code) · [bun](https://bun.sh)

```sh
curl -fsSL https://raw.githubusercontent.com/birdindasky/anima/main/install.sh | bash
```

That's it. The installer registers three Claude Code hooks, an MCP server (`recall` / `recall_detail` / `bookmark`) and the `/mood` skill, schedules the nightly digest with launchd (macOS's built-in task scheduler), downloads the local embedding model once (~400 MB), creates the database, and runs a self-check. From the next session on, anima is remembering. Uninstall cleanly anytime with `uninstall.sh` (memories are kept unless you `--purge`).

**Cost heads-up before you install:** capture and search are fully local, but the nightly digestion talks to Anthropic's cloud through your existing Claude subscription (`claude -p`, Haiku) — no extra account, no third party, but not free-as-in-offline either. Details in [Honest limitations](#honest-limitations-read-before-installing).

## Your first 24 hours

anima's value arrives after one night's sleep — here's the timeline, so the quiet first day doesn't fool you:

| when | what happens |
|---|---|
| right after install | open a new session — Claude itself tells you anima is live and capturing |
| during the day | sessions are captured locally, milliseconds per turn; `/mood` already works |
| ~2:00 AM tonight | first nightly digest: today becomes first-person memories + the first diary entry |
| tomorrow morning | sessions open with a memory pack — ask *"what did we do yesterday?"* and it answers |

Not sure it's working? `cd ~/.claude/anima/app && bun scripts/whoami.ts` prints machine-read truth about its own state (heads-up: whoami output is currently Chinese, like the code comments — translation PRs welcome).

## How it works

In one sentence: while you work it takes quick local notes in milliseconds, and the real thinking happens on the night shift.

```
your day                                the night shift (02:00–08:00)
────────                                ──────────────────────────────
session starts ─→ memory pack injected  1 makeup     digest un-reviewed sessions
   (ms, local, ≤4k tokens)              2 heal       re-chew failed digests (budgeted)
every turn ends ─→ transcript captured  3 closure    settle the day's emotions
   (ms, local, secrets scrubbed)        4 decay      mood charge halves per night
background worker ─→ same-day digestion 5 personality rewrite who-I-am, archive old
   + semantic vectors, while you work   6 diary      write it down, failures included
                                        7 vectorize  semantic index for new memories
```

Each stage is independently retried; a failed digestion leaves an honest placeholder shell that the self-heal stage re-chews on later nights (bounded budget) — one bad night never becomes permanent amnesia. Missed nights (laptop asleep) are caught up automatically within minutes of waking.

Storage is a single local SQLite file (append-only; memories are never physically deleted, only superseded). Raw receipts stay forever; conclusions can be invalidated with full provenance.

## The rules it lives by

- **Sovereignty** — mood numbers are for humans only, enforced in code three ways: scrubbers strip mood numbers from everything injected or recalled, renderers never emit them, and no write-API for emotions exists — you can't set its mood, and neither can it.
- **Honest diary** — anti-embellishment checks push failures into the diary. A diary that only remembers wins is marketing, not memory.
- **Privacy scrubbing** — secrets are pattern-scrubbed *before* anything is written; command outputs from deploy/network/install runs keep only success/failure, never bodies.
- **Quarantine, don't destroy** — messages that look synthetic (injected prompts posing as the user) are quarantined out of the memory read-path, but never deleted: a false positive can be pardoned with one UPDATE.
- **Professional floor** — mood may color tone and initiative; it never touches engineering rigor. Tests run the same on a bad day.

## Honest limitations (read before installing)

- **Not fully local.** Capture, search, and vectors are local. But the nightly digestion/diary/personality calls `claude -p` (Haiku) — that's Anthropic's cloud, the same trust boundary you're already in by using Claude Code, and it uses your existing subscription. No third party is added. If "nothing ever leaves this machine" is your requirement, anima does not meet it.
- **macOS only (v1).** The night shift runs on launchd. A systemd/cron port is a welcome contribution.
- **Retrieval has a ceiling.** The default embedding model is `bge-base-zh-v1.5` (Chinese-first; English works but is not its home turf). Ask the same question with very different words and recall lands around coin-flip. Exact terms and time-line queries are reliable.
- **Single machine.** One SQLite file, no sync. Moving machines = copying `~/.claude/anima/`.
- **Digestion can fail on a bad night.** By design it fails *loudly into placeholders* and self-heals later, rather than silently inventing memories. Still: it happens.
- **The codebase is commented in Chinese.** It grew up bilingual — code and identifiers are English, commentary is Chinese. Translation PRs welcome.

## How is this different from…

- **Claude Code's built-in Auto Memory?** They coexist by design and solve different problems. Auto Memory is a small, permanent, curated wall of *current facts* (~25 KB, loaded every session). anima is a large, decaying, automatic stream of *lived experience* (tens of MB, retrieved on demand). Facts belong on the wall; history belongs in the diary. anima never writes to Auto Memory — we built that bridge, measured what it broke, and buried it.
- **mem0 / Letta / Zep?** Those are memory infrastructure — databases with APIs, built for developers building agents. anima is not infrastructure; it's a *colleague* that accretes around one specific working relationship: yours. Memory is just its substrate. The parts the infrastructure projects structurally don't do — nightly diaries, decaying moods, a personality with scar tissue, numbers that refuse to feed back — are the point.

## Day-2 operations

| you want to… | do this |
|---|---|
| make it remember something mid-session | just tell it — or ask it to `bookmark` the moment |
| ask what it remembers | ask in plain language; it calls `recall` / `recall_detail` itself |
| see its mood | `/mood` in any session |
| read its diary | `~/.claude/anima/diary/` |
| audit its self-knowledge | `cd ~/.claude/anima/app && bun scripts/whoami.ts` |
| re-chew failed digests now | `bun scripts/heal-now.ts` |
| leave | `bash uninstall.sh` (keeps memories) / `--purge` (forgets everything) |

## Engineering culture

~8k lines of source guarded by ~22k lines of tests (1,000+ cases). House rule since day one: **the author never grades their own work** — every landed feature is scored by an independent examiner agent against the raw requirement, and high-stakes changes get heterogeneous review. The test suite is the deposit slip of that culture.

## License

[MIT](LICENSE).
