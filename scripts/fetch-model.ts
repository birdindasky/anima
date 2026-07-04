// One-time embedding-model download for install.
// Runtime is strictly offline (embed.ts pins allowRemoteModels=false); this script is the
// single sanctioned place where remote download is allowed, so a fresh machine can be
// provisioned. Idempotent: if the model is already cached it verifies and exits fast.
import { EMBED_MODEL, MODEL_CACHE_DIR } from "../src/embed.ts";

const { env, pipeline } = await import("@huggingface/transformers");
env.cacheDir = MODEL_CACHE_DIR;
env.allowRemoteModels = true; // install-time only; runtime stays offline

console.log(`[anima] fetching ${EMBED_MODEL} → ${MODEL_CACHE_DIR}`);
const pipe: any = await pipeline("feature-extraction", EMBED_MODEL);

// Force a real forward pass so every weight file is actually present, not just the config.
const out = await pipe(["hello 你好"], { pooling: "cls", normalize: true });
const dim = out.dims[out.dims.length - 1];
if (dim !== 768) {
  console.error(`[anima] unexpected embedding dim ${dim} (want 768)`);
  process.exit(1);
}
await pipe.dispose?.();
console.log("[anima] model ready (768-dim, offline from now on).");
