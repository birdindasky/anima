// Register / deregister anima's three hooks in ~/.claude/settings.json.
//   bun scripts/setup-hooks.ts install <bunBin> <appDir>
//   bun scripts/setup-hooks.ts remove
//
// Safety contract:
//   - Always writes a timestamped backup next to settings.json before touching it.
//   - Idempotent: re-running install replaces any previous anima entries (including ones
//     pointing at an old install path) instead of stacking duplicates.
//   - Touches ONLY anima's own entries and env keys; everything else passes through verbatim.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const HOOK_FILES = {
  SessionStart: "session-start.ts",
  Stop: "stop.ts",
  SessionEnd: "session-end.ts",
} as const;
const ANIMA_HOOK_RE = /\/hooks\/(session-start|stop|session-end)\.ts"?\s*$/;
const ENV_KEYS = ["ANIMA_WORKER_ENABLED", "ANIMA_DAYSPLIT"];

const [mode, bunBin, appDir] = process.argv.slice(2);
if (mode !== "install" && mode !== "remove") {
  console.error("usage: setup-hooks.ts install <bunBin> <appDir> | remove");
  process.exit(1);
}
if (mode === "install" && (!bunBin || !appDir)) {
  console.error("install mode needs <bunBin> <appDir>");
  process.exit(1);
}

const existed = existsSync(SETTINGS_PATH);
if (mode === "remove" && !existed) {
  console.log("[anima] no settings.json — nothing to remove");
  process.exit(0);
}

let settings: any = {};
if (existed) {
  try {
    settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    console.error(`[anima] ${SETTINGS_PATH} is not valid JSON — fix it first, nothing was changed.`);
    process.exit(1);
  }
  const backup = `${SETTINGS_PATH}.bak-anima-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(SETTINGS_PATH, backup);
  console.log(`[anima] settings backup: ${backup}`);
}

settings.hooks ??= {};

const isAnimaEntry = (entry: any): boolean =>
  Array.isArray(entry?.hooks) &&
  entry.hooks.some((h: any) => typeof h?.command === "string" && ANIMA_HOOK_RE.test(h.command));

// strip any existing anima entries (both modes start from a clean slate)
for (const event of Object.keys(HOOK_FILES) as (keyof typeof HOOK_FILES)[]) {
  if (Array.isArray(settings.hooks[event])) {
    settings.hooks[event] = settings.hooks[event].filter((e: any) => !isAnimaEntry(e));
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
}

if (mode === "install") {
  for (const [event, file] of Object.entries(HOOK_FILES)) {
    settings.hooks[event] ??= [];
    settings.hooks[event].push({
      hooks: [
        {
          type: "command",
          command: `${bunBin} "${appDir}/hooks/${file}"`,
          timeout: 30,
        },
      ],
    });
  }
  settings.env ??= {};
  settings.env.ANIMA_WORKER_ENABLED = "1"; // live daytime digestion (recommended default)
  settings.env.ANIMA_DAYSPLIT = "1"; // attribute sessions to real calendar days
  console.log("[anima] hooks registered: SessionStart / Stop / SessionEnd");
} else {
  if (settings.env) {
    for (const k of ENV_KEYS) delete settings.env[k];
    if (Object.keys(settings.env).length === 0) delete settings.env;
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  console.log("[anima] hooks deregistered");
}

writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
