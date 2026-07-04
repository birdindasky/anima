// Install-time config bootstrap: capture the machine's UTC offset once, so day-boundary
// logic ("which day did this happen", "which night digests it") follows the user's clock
// instead of a hardcoded timezone.
//
// Write-once by design: if tzOffsetMinutes already exists we never overwrite it — memories
// are stored in UTC and day attribution is computed from this offset, so silently changing
// it after months of use would re-shuffle which night old sessions belong to. Travelers /
// DST: edit ~/.claude/anima/config.json yourself if you really want to move the day line.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dataDir = process.env.ANIMA_DATA_DIR ?? join(homedir(), ".claude", "anima");
const configPath = process.env.ANIMA_CONFIG_PATH ?? join(dataDir, "config.json");

mkdirSync(dataDir, { recursive: true });

let config: Record<string, unknown> = {};
if (existsSync(configPath)) {
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    console.error(`[anima] ${configPath} is not valid JSON — fix or delete it, then re-run.`);
    process.exit(1);
  }
}

if (typeof config.tzOffsetMinutes === "number") {
  console.log(`[anima] timezone already configured: UTC${fmt(config.tzOffsetMinutes)} (kept).`);
} else {
  // JS getTimezoneOffset() is minutes *behind* UTC (UTC+8 → -480), so negate.
  const offset = -new Date().getTimezoneOffset();
  config.tzOffsetMinutes = offset;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`[anima] timezone configured: UTC${fmt(offset)} (day boundaries follow your clock).`);
}

function fmt(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${h}${m ? ":" + String(m).padStart(2, "0") : ""}`;
}
