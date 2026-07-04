import { test, expect, describe, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  vecToBlob,
  blobToVec,
  cosine,
  embedDocuments,
  embedQuery,
  disposeEmbedder,
  EMBED_DIM,
  EMBED_MODEL_VER,
  MODEL_CACHE_DIR,
} from "../src/embed";

// 模型测试默认不跑：① 省得每次单测都载 ~400MB ONNX；② onnxruntime-node + bun 退出清理
// 有原生崩溃坑（测试结果已出、崩在 teardown），会污染默认测试门的退出码。
// 要验模型：`ANIMA_EMBED_TEST=1 bun test tests/embed.test.ts`（崩在退出无妨，看 pass 行即可）。
const RUN_MODEL = existsSync(join(MODEL_CACHE_DIR, "Xenova", "bge-base-zh-v1.5")) &&
  process.env.ANIMA_EMBED_TEST === "1";

afterAll(async () => {
  await disposeEmbedder(); // 释放 ONNX 会话（尽力而为；bun teardown 仍可能崩，故默认不跑模型测试）
});

describe("embed 纯函数（无需模型）", () => {
  test("vecToBlob/blobToVec 往返保真", () => {
    const v = new Float32Array([0.1, -0.5, 1.0, 0, 0.3333333]);
    const back = blobToVec(vecToBlob(v));
    expect(back.length).toBe(v.length);
    for (let i = 0; i < v.length; i++) expect(back[i]).toBeCloseTo(v[i], 6);
  });

  test("BLOB 字节数 = 维度 × 4", () => {
    expect(vecToBlob(new Float32Array(EMBED_DIM)).byteLength).toBe(EMBED_DIM * 4);
  });

  test("从大 buffer 切片也保真（防视图别名）", () => {
    const big = new Float32Array([9, 9, 1, 2, 3, 9]); // 取中间 3 个
    const slice = big.subarray(2, 5);
    const back = blobToVec(vecToBlob(slice));
    expect([...back]).toEqual([1, 2, 3]);
  });

  test("cosine 同向=1 反向=-1 正交=0", () => {
    expect(cosine(new Float32Array([1, 0, 0]), new Float32Array([1, 0, 0]))).toBeCloseTo(1, 6);
    expect(cosine(new Float32Array([1, 0, 0]), new Float32Array([-1, 0, 0]))).toBeCloseTo(-1, 6);
    expect(cosine(new Float32Array([1, 0, 0]), new Float32Array([0, 1, 0]))).toBeCloseTo(0, 6);
  });

  test("model_ver 锁定 bge-base-zh-v1.5", () => {
    expect(EMBED_MODEL_VER).toBe("bge-base-zh-v1.5");
  });
});

describe("embed 模型（本地离线，需模型已落盘）", () => {
  test.skipIf(!RUN_MODEL)("文档指纹 768 维且已归一化", async () => {
    const [v] = await embedDocuments(["登录 token 过期进不去"]);
    expect(v.length).toBe(EMBED_DIM);
    let ss = 0;
    for (const x of v) ss += x * x;
    expect(Math.sqrt(ss)).toBeCloseTo(1, 3);
  });

  test.skipIf(!RUN_MODEL)("语义相近 > 无关", async () => {
    const [auth, login, weather] = await embedDocuments([
      "鉴权问题排查",
      "登录时 token 过期导致进不去",
      "今天天气不错适合散步",
    ]);
    expect(cosine(auth, login)).toBeGreaterThan(cosine(auth, weather));
  });

  test.skipIf(!RUN_MODEL)("查询指纹也是 768 维", async () => {
    expect((await embedQuery("鉴权")).length).toBe(EMBED_DIM);
  });
});
