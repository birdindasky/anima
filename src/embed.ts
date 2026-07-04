// 语义指纹：本地离线 bge 中文 embedding。只算指纹用于排序找回，绝不渲染喂回模型（守铁律）。
// 依赖 bunfig.toml 的 stub-sharp 预载（transformers 静态 import sharp，anima 不碰图片）。
//
// 命门（事故 2026-06-12「hook 干重活」）：@huggingface/transformers 的库图 import（~38ms）绝不能
// 落进 hook 的静态传递闭包。本模块被 vectorize/hybridSearch→recall/digest→index барrel 层层带进
// 三个 live hook 的静态图——若这里静态 `import ... from "@huggingface/transformers"`，整条 hook 热
// 路径每次开会话/收工都白白付这 38ms。故 transformers **只走动态 import**，在真要算指纹（extractor）
// 时才上膛；纯函数（vecToBlob/cosine/维度常量）与 env 配置都不触发库加载。守住「hook 静态闭包
// transformers-free」这条设计不变量，且新增 embed 消费者也自动免疫，不再靠人肉纪律盯 import。
import { homedir } from "node:os";
import { join } from "node:path";

export const EMBED_MODEL = "Xenova/bge-base-zh-v1.5";
export const EMBED_MODEL_VER = "bge-base-zh-v1.5";
export const EMBED_DIM = 768;

// bge 非对称检索：查询加指令前缀，文档不加。
const QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章：";

// 模型永久落在 anima 私有目录，离线加载（首次须预先放好——从 spike 拷或单独下载脚本）。
export const MODEL_CACHE_DIR = join(homedir(), ".claude", "anima", "models");

let _pipe: Promise<unknown> | null = null;
function extractor(): Promise<any> {
  // 动态 import：把 transformers 的库图 import 挡在模块加载期之外，只有真算指纹才上膛（见文件头命门）。
  // IIFE 的 Promise 同步赋给 _pipe → 并发调用共享同一次加载，保持原「单次懒加载、幂等」语义。
  return (_pipe ??= (async () => {
    const { env, pipeline } = await import("@huggingface/transformers");
    env.cacheDir = MODEL_CACHE_DIR; // 模型落 anima 私有目录，离线加载
    env.allowRemoteModels = false; // 铁律：离线，不在运行时联网下载
    return pipeline("feature-extraction", EMBED_MODEL);
  })()) as Promise<any>;
}

async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const pipe = await extractor();
  const out = await pipe(texts, { pooling: "cls", normalize: true });
  const data = out.data as Float32Array;
  const dim = out.dims[out.dims.length - 1] as number;
  const rows: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    rows.push(Float32Array.from(data.subarray(i * dim, (i + 1) * dim)));
  }
  return rows;
}

/** 给经历/文档算指纹（入库存储用，不加查询指令）。 */
export function embedDocuments(texts: string[]): Promise<Float32Array[]> {
  return embed(texts);
}

/** 给查询算指纹（加 bge 检索指令前缀，非对称召回更准）。 */
export async function embedQuery(text: string): Promise<Float32Array> {
  const [v] = await embed([QUERY_INSTRUCTION + text]);
  return v;
}

/**
 * 释放 ONNX 会话。onnxruntime-node + bun 在进程退出时清理原生资源会抛 C++ 异常致崩溃
 * （bun teardown 已知坑），用完显式 dispose 可干净释放。夜跑算完指纹、测试收尾都该调。
 */
export async function disposeEmbedder(): Promise<void> {
  if (!_pipe) return;
  const pending = _pipe;
  _pipe = null;
  try {
    const pipe = (await pending) as any;
    await pipe?.dispose?.();
  } catch {
    // 释放失败无所谓——指纹已算完落库，下次重新懒加载。
  }
}

/** Float32 向量 ⇄ SQLite BLOB（紧凑拷贝，避免视图别名/字节对齐问题）。 */
export function vecToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}
export function blobToVec(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b); // 独立 buffer + 4 字节对齐
  return new Float32Array(copy.buffer);
}

/** 余弦相似度。存的是已归一化向量，等价点积；此处做完整余弦以防未归一化输入。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  // 维度不一致（换 embedder / backfill 半途混版）直接返 0：不算「短向量越界读 NaN → 被地板漏召」，
  // 也不算「查询维 < 存储维 → 截断出假高余弦顶格抢第一」（AUDIT-2026-07-01 rank9，读侧防混版）。
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}
