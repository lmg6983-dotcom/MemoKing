// laya-ts (Apache-2.0, Convai Innovations) — https://github.com/NandhaKishorM/laya 0a05a45052e23ae0b887a490fe8d6d9c8cff2ab5 의 laya-ts/src 를
//   esbuild 0.28.2 로 묶음 (npm 에 없어서 손으로): Agent · parseTokenizerJson · encodeWithData · feed · feedHead. 원본 라이선스는 LICENSES.md
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/providers.ts
var providers_exports = {};
__export(providers_exports, {
  PINNED_REVISIONS: () => PINNED_REVISIONS,
  createNodeProvider: () => createNodeProvider,
  createWebProvider: () => createWebProvider,
  feed: () => feed,
  feedHead: () => feedHead,
  loadNodeBundle: () => loadNodeBundle,
  loadWebBundle: () => loadWebBundle,
  resolveRevision: () => resolveRevision
});
function resolveRevision(_repoOrId, revision) {
  return revision || null;
}
async function sha256Hex(data) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("laya-ts: SHA-256 verification requires Web Crypto (globalThis.crypto.subtle)");
  }
  const digest = await subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
function normaliseDigestPath(rel) {
  const raw = String(rel).replace(/\\/g, "/");
  if (/^(?:[A-Za-z]:|\/)/.test(raw)) {
    throw new Error(`laya-ts: unsafe absolute path in expectedSha256: ${JSON.stringify(rel)}`);
  }
  const norm = raw;
  if (!norm || norm === ".." || norm.startsWith("../") || norm.includes("/../")) {
    throw new Error(`laya-ts: unsafe path in expectedSha256: ${JSON.stringify(rel)}`);
  }
  return norm;
}
async function expectDigest(rel, data, expected) {
  const want = expected[rel] ?? expected[normaliseDigestPath(rel)];
  if (want === void 0) return;
  const got = await sha256Hex(data);
  if (got.toLowerCase() !== String(want).trim().toLowerCase()) {
    throw new Error(
      `laya-ts: SHA-256 mismatch for ${rel}: expected ${want}, got ${got}. Refusing to load the artifact.`
    );
  }
}
function toNested(data, dims) {
  let total = 1;
  for (const d of dims) total *= d;
  const flat = new Array(total);
  for (let i = 0; i < total; i++) {
    const v = data[i];
    flat[i] = typeof v === "bigint" ? Number(v) : v;
  }
  if (dims.length === 0) return flat[0];
  const steps = new Array(dims.length);
  for (let d = 0; d < dims.length; d++) {
    let s = 1;
    for (let k = d + 1; k < dims.length; k++) s *= dims[k];
    steps[d] = s;
  }
  const rec = (d, off) => {
    if (d === dims.length - 1) return flat.slice(off, off + dims[d]);
    const out = new Array(dims[d]);
    for (let i = 0; i < dims[d]; i++) out[i] = rec(d + 1, off + i * steps[d]);
    return out;
  };
  return rec(0, 0);
}
function i64(ort, arr, dims) {
  const out = new BigInt64Array(dims.reduce((a, b) => a * b, 1));
  let p = 0;
  if (Array.isArray(arr[0])) {
    for (const row of arr) for (const v of row) out[p++] = BigInt(Math.trunc(v));
  } else {
    for (const v of arr) out[p++] = BigInt(Math.trunc(v));
  }
  return new ort.Tensor("int64", out, dims);
}
function feed(ort, b) {
  const n = b.inputIds.length;
  let L = 1;
  for (const r of b.inputIds) if (r.length > L) L = r.length;
  return {
    input_ids: i64(ort, b.inputIds, [n, L]),
    attention_mask: i64(ort, b.attentionMask, [n, L])
  };
}
function feedHead(ort, hidden, b) {
  const n = b.markerPos.length;
  let k = 1;
  for (const r of b.markerPos) if (r.length > k) k = r.length;
  const nH = hidden.length ?? n;
  const S = hidden[0]?.length ?? 1;
  const Hd = hidden[0]?.[0]?.length ?? 1;
  const flatH = new Float32Array(nH * S * Hd);
  let p = 0;
  for (let i = 0; i < nH; i++) {
    const bi = hidden[i] ?? [];
    for (let j = 0; j < S; j++) {
      const hj = bi[j] ?? [];
      for (let h = 0; h < Hd; h++) flatH[p++] = Number(hj[h] ?? 0);
    }
  }
  const H = new ort.Tensor("float32", flatH, [nH, S, Hd]);
  const maskRows = b.attentionMask.map((r) => {
    const row = r.slice(0, S);
    while (row.length < S) row.push(0);
    return row;
  });
  return {
    hidden_states: H,
    marker_pos: i64(ort, b.markerPos, [n, k]),
    marker_mask: new ort.Tensor("bool", (() => {
      const out = new Uint8Array(n * k);
      let q = 0;
      for (const row of b.markerMask)
        for (let j = 0; j < k; j++) out[q++] = row[j] ? 1 : 0;
      return out;
    })(), [n, k]),
    qtype: i64(ort, b.qtype.map((v) => [v]), [n, 1]),
    // Padding mask for the head transformer (py DecisionModel.forward).
    // Without it, batch mates of unequal length corrupt each other's markers.
    attention_mask: i64(ort, maskRows, [n, S])
  };
}
function pickOutput(out, names) {
  for (const n of names) if (out[n] !== void 0) return out[n];
  const vals = Object.values(out);
  return vals[0];
}
function applyNumThreads(ort, numThreads) {
  try {
    const raw = numThreads ?? (typeof process !== "undefined" ? Number(process.env?.["LAYA_THREADS"]) : NaN);
    if (Number.isFinite(raw) && raw > 0 && ort?.env) {
      ort.env.numThreads = Math.trunc(raw);
    }
  } catch {
  }
}
function isOomError(e) {
  const m = String(e?.message ?? e).toLowerCase();
  return m.includes("memory") || m.includes("cuda") || m.includes("out of memory") || m.includes("oom");
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function fetchWithRetry(url, init, retries = 2) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(100 * (attempt + 1));
        continue;
      }
      return res;
    } catch (e) {
      last = e;
      if (e?.name === "AbortError") throw e;
      if (attempt < retries) {
        await sleep(100 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw last instanceof Error ? last : new Error(`fetch failed for ${url}`);
}
async function fetchArrayBuffer(url, opts) {
  const g = globalThis;
  let cache = null;
  let hit = null;
  try {
    if (g.caches && typeof g.caches.open === "function") {
      try {
        cache = await g.caches.open(CACHE_KEY);
        try {
          hit = await cache.match(url);
        } catch {
          hit = null;
        }
      } catch {
        cache = null;
      }
    }
  } catch {
    cache = null;
  }
  if (cache) {
    try {
      const res2 = await fetchWithRetry(url, { signal: opts?.signal ?? void 0 });
      opts?.onHeaders?.(res2);
      if (res2.ok) {
        try {
          await cache.put(url, res2.clone());
        } catch {
        }
        return await res2.arrayBuffer();
      }
    } catch (e) {
      if (hit) {
        try {
          return await hit.arrayBuffer();
        } catch {
        }
      }
      throw e;
    }
    if (hit) {
      try {
        return await hit.arrayBuffer();
      } catch {
      }
    }
    throw new Error(`fetch failed for ${url}`);
  }
  const res = await fetchWithRetry(url, { signal: opts?.signal ?? void 0 });
  opts?.onHeaders?.(res);
  if (!res.ok) throw new Error(`fetch failed for ${url}: ${res.status}`);
  return await res.arrayBuffer();
}
async function loadNodeBundle(modelDirOrRepo, opts) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const sub = opts?.subfolder ?? null;
  let dir = opts?.localDir ?? modelDirOrRepo;
  let resolvedRevision = null;
  try {
    const st = await fs.stat(sub ? path.join(dir, sub) : dir);
    if (st.isDirectory()) dir = sub ? path.join(dir, sub) : dir;
    else dir = path.dirname(dir);
  } catch {
    const revision = resolveRevision(modelDirOrRepo, opts?.revision);
    resolvedRevision = revision;
    const cache = path.join(
      os.homedir(),
      ".cache",
      "laya-ts",
      "hf",
      modelDirOrRepo.replace(/\//g, "__"),
      sub ?? "root",
      ...revision && revision !== "main" ? [revision] : []
    );
    await fs.mkdir(cache, { recursive: true });
    const token = opts?.token ?? (typeof process !== "undefined" ? process.env?.["HF_TOKEN"] : void 0);
    const files = ["rl_agent_config.json", "tokenizer.json", "tokenizer/tokenizer.json", "encoder.onnx", "head.onnx"];
    let done = 0;
    for (const f of files) {
      try {
        await fs.stat(path.join(cache, f));
      } catch {
        const url = `https://huggingface.co/${modelDirOrRepo}/resolve/${revision ?? "main"}/${sub ? sub + "/" : ""}${f}`;
        const res = await fetchWithRetry(
          url,
          {
            ...token ? { headers: { Authorization: `Bearer ${token}` } } : {},
            signal: opts?.signal ?? void 0
          }
        );
        const commit = res.headers?.get?.("x-repo-commit");
        if (commit) resolvedRevision = commit;
        if (!res.ok) {
          if (f === "rl_agent_config.json") {
            throw new Error(
              `Incompatible model: ${JSON.stringify(modelDirOrRepo)} does not contain 'rl_agent_config.json'.`
            );
          }
          continue;
        }
        const target = path.join(cache, f);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const tmp = `${target}.tmp-${typeof process !== "undefined" ? process.pid : 0}`;
        await fs.writeFile(tmp, new Uint8Array(await res.arrayBuffer()));
        await fs.rename(tmp, target);
      }
      done++;
      opts?.onProgress?.(done, files.length, f);
    }
    dir = cache;
  }
  if (opts?.expectedSha256) {
    const { createHash } = await import("node:crypto");
    for (const [rel, want] of Object.entries(opts.expectedSha256)) {
      const norm = normaliseDigestPath(rel);
      let buf;
      try {
        buf = new Uint8Array(await fs.readFile(path.join(dir, norm)));
      } catch {
        throw new Error(`laya-ts: cannot verify ${JSON.stringify(rel)}: not found under ${dir}`);
      }
      const got = createHash("sha256").update(buf).digest("hex");
      if (got.toLowerCase() !== String(want).trim().toLowerCase()) {
        throw new Error(
          `laya-ts: SHA-256 mismatch for ${rel}: expected ${want}, got ${got}. Refusing to load the artifact.`
        );
      }
    }
  }
  let cfg = {};
  try {
    cfg = JSON.parse(await fs.readFile(path.join(dir, "rl_agent_config.json"), "utf8"));
  } catch {
    throw new Error(
      `Incompatible model: ${JSON.stringify(modelDirOrRepo)} does not contain 'rl_agent_config.json'.`
    );
  }
  let tokenizerJson = null;
  for (const candidate of TOKENIZER_CANDIDATES) {
    try {
      tokenizerJson = JSON.parse(await fs.readFile(path.join(dir, candidate), "utf8"));
      break;
    } catch {
    }
  }
  return { dir, cfg, tokenizerJson, revision: resolvedRevision };
}
function trimSlashes(value, leading = false) {
  let start = 0;
  let end = value.length;
  if (leading) while (start < end && value[start] === "/") start++;
  while (end > start && value[end - 1] === "/") end--;
  return value.slice(start, end);
}
function baseUrlFor(repoOrUrl, subfolder, revision) {
  const sub = subfolder ? `/${trimSlashes(subfolder, true)}` : "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(repoOrUrl)) {
    return `${trimSlashes(repoOrUrl)}${sub}`;
  }
  return `https://huggingface.co/${repoOrUrl}/resolve/${revision ?? "main"}${sub}`;
}
async function loadWebBundle(repoOrUrl, opts) {
  const revision = resolveRevision(repoOrUrl, opts?.revision);
  const base = baseUrlFor(repoOrUrl, opts?.subfolder ?? null, revision);
  let reportedRevision = revision;
  const fetchVerifiedJson = async (rel) => {
    const buf = await fetchArrayBuffer(`${base}/${rel}`, {
      signal: opts?.signal ?? void 0,
      onHeaders: (response) => {
        const commit = response.headers?.get?.("x-repo-commit");
        if (commit) reportedRevision = commit;
      }
    });
    if (opts?.expectedSha256) await expectDigest(rel, buf, opts.expectedSha256);
    return JSON.parse(new TextDecoder().decode(buf));
  };
  let cfg;
  try {
    cfg = await fetchVerifiedJson("rl_agent_config.json");
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("laya-ts: SHA-256 mismatch")) throw e;
    if (e?.name === "AbortError") throw e;
    throw new Error(`Incompatible model: ${JSON.stringify(repoOrUrl)} does not contain 'rl_agent_config.json'.`);
  }
  opts?.onProgress?.(1, 2, "rl_agent_config.json");
  let tokenizerJson = null;
  for (const candidate of TOKENIZER_CANDIDATES) {
    try {
      tokenizerJson = await fetchVerifiedJson(candidate);
      break;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("laya-ts: SHA-256 mismatch")) throw e;
    }
  }
  opts?.onProgress?.(2, 2, "tokenizer.json");
  return { dir: base, cfg, tokenizerJson, revision: reportedRevision };
}
async function createNodeProvider(modelDir, opts) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  for (const f of ["encoder.onnx", "head.onnx"]) {
    const p = path.join(modelDir, f);
    try {
      await fs.stat(p);
    } catch {
      throw new Error(`Incompatible model: '${f}' not found in ${JSON.stringify(modelDir)} (expected ${p}).`);
    }
    if (opts?.expectedSha256) await expectDigest(f, await fs.readFile(p), opts.expectedSha256);
  }
  const spec = "onnxruntime-node";
  const ort = await import(
    /* @vite-ignore */
    spec
  );
  applyNumThreads(ort, opts?.numThreads);
  const dev = String(opts?.device ?? "cpu").toLowerCase();
  const want = dev === "cuda" ? "cuda" : dev === "dml" ? "dml" : "cpu";
  const make = async (ep) => {
    const e = await ort.InferenceSession.create(`${modelDir}/encoder.onnx`, {
      executionProviders: [ep]
    });
    const h = await ort.InferenceSession.create(`${modelDir}/head.onnx`, {
      executionProviders: ["cpu"]
    });
    return { e, h };
  };
  let enc;
  let head;
  let activeEP = want;
  try {
    ({ e: enc, h: head } = await make(want));
  } catch (e) {
    if (want !== "cpu") {
      console.warn(`Warning: ${want.toUpperCase()} requested but not available. Falling back to CPU.`);
      ({ e: enc, h: head } = await make("cpu"));
      activeEP = "cpu";
    } else {
      throw e;
    }
  }
  let cpuEnc = null;
  let cpuHead = null;
  const ensureCpu = async () => {
    if (!cpuEnc) {
      cpuEnc = await ort.InferenceSession.create(`${modelDir}/encoder.onnx`, {
        executionProviders: ["cpu"]
      });
      cpuHead = await ort.InferenceSession.create(`${modelDir}/head.onnx`, {
        executionProviders: ["cpu"]
      });
    }
    return { cpuEnc, cpuHead };
  };
  const runWithCpuFallback = async (fn) => {
    try {
      return await fn(enc, head);
    } catch (e) {
      if (activeEP !== "cpu" && isOomError(e)) {
        console.warn("Warning: GPU memory exceeded during inference. Falling back to CPU...");
        const { cpuEnc: ce, cpuHead: ch } = await ensureCpu();
        enc = ce;
        head = ch;
        activeEP = "cpu";
        return await fn(enc, head);
      }
      if (isOomError(e)) {
        throw new Error(`${e.message} (GPU out of memory; try device: "cpu")`);
      }
      throw e;
    }
  };
  return {
    runEncoder: async (b) => runWithCpuFallback(async (e) => {
      const out = await e.run(feed(ort, b));
      const t = pickOutput(out, ["last_hidden_state", "lastHidden", "hidden_states"]);
      return { lastHidden: toNested(t.data, t.dims) };
    }),
    runHead: async (h, b) => runWithCpuFallback(async (_e, hd) => {
      const out = await hd.run(feedHead(ort, h, b));
      const vals = Object.values(out);
      const lt = pickOutput(out, ["logits"]);
      const at = pickOutput(out, ["act_logits", "act"]) ?? vals[1] ?? vals[0];
      return { logits: toNested(lt.data, lt.dims), act: toNested(at.data, at.dims) };
    })
  };
}
async function fetchSidecar(url) {
  const name = `${url.split("/").pop()}.data`;
  const sidecarUrl = `${trimSlashes(url).split("/").slice(0, -1).join("/")}/${name}`;
  try {
    const buf = await fetchArrayBuffer(sidecarUrl);
    return { path: name, data: new Uint8Array(buf) };
  } catch {
    return null;
  }
}
async function createWebProvider(modelUrl, opts) {
  const spec = "onnxruntime-web";
  const ort = await import(
    /* @vite-ignore */
    spec
  );
  applyNumThreads(ort, opts?.numThreads);
  const base = trimSlashes(modelUrl);
  const encUrl = `${base}/encoder.onnx`;
  const headUrl = `${base}/head.onnx`;
  const readEncoderParts = async (signal) => {
    const buf = await fetchArrayBuffer(encUrl, { signal: signal ?? void 0 });
    const sidecar = await fetchSidecar(encUrl);
    return { buf, extra: sidecar ? { externalData: [sidecar] } : {} };
  };
  let encBuf;
  let encExtra;
  try {
    ({ buf: encBuf, extra: encExtra } = await readEncoderParts(opts?.signal));
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new Error(`Incompatible model: 'encoder.onnx' not found (expected ${encUrl}).`);
  }
  opts?.onProgress?.(1, 2, "encoder.onnx");
  let headBuf;
  try {
    headBuf = await fetchArrayBuffer(headUrl, { signal: opts?.signal ?? void 0 });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new Error(`Incompatible model: 'head.onnx' not found (expected ${headUrl}).`);
  }
  opts?.onProgress?.(2, 2, "head.onnx");
  if (opts?.expectedSha256) {
    await expectDigest("encoder.onnx", encBuf, opts.expectedSha256);
    await expectDigest("head.onnx", headBuf, opts.expectedSha256);
  }
  const headSidecar = await fetchSidecar(headUrl);
  const headExtra = headSidecar ? { externalData: [headSidecar] } : {};
  let enc;
  try {
    enc = await ort.InferenceSession.create(new Uint8Array(encBuf), {
      executionProviders: ["webgpu", "wasm"],
      graphOptimizationLevel: "basic",
      ...encExtra
    });
  } catch (e) {
    enc = await ort.InferenceSession.create(new Uint8Array(encBuf), {
      executionProviders: ["wasm"],
      ...encExtra
    });
  }
  const head = await ort.InferenceSession.create(new Uint8Array(headBuf), {
    executionProviders: ["wasm"],
    ...headExtra
  });
  let encWasm = null;
  const runEncoderOn = async (session, b) => {
    const out = await session.run(feed(ort, b));
    const t = pickOutput(out, ["last_hidden_state", "lastHidden", "hidden_states"]);
    return { lastHidden: toNested(t.data, t.dims) };
  };
  return {
    runEncoder: async (b) => {
      if (encWasm) {
        try {
          return await runEncoderOn(encWasm, b);
        } catch (e) {
          if (isOomError(e)) throw new Error(`${e.message} (out of memory; try fewer questions per call)`);
          throw e;
        }
      }
      try {
        return await runEncoderOn(enc, b);
      } catch (e) {
        if (isOomError(e)) throw new Error(`${e.message} (WebGPU out of memory; WASM fallback already active)`);
        if (/\[webgpu\]/i.test(String(e?.message ?? e))) {
          console.warn(
            `laya: WebGPU encoder run failed (${String(e?.message ?? e)}); falling back to WASM.`
          );
          if (!encWasm) {
            let parts;
            try {
              parts = await readEncoderParts();
            } catch {
              throw e;
            }
            encWasm = await ort.InferenceSession.create(new Uint8Array(parts.buf), {
              executionProviders: ["wasm"],
              ...parts.extra
            });
          }
          try {
            return await runEncoderOn(encWasm, b);
          } catch (e2) {
            if (isOomError(e2)) throw new Error(`${e2.message} (out of memory; try fewer questions per call)`);
            throw e2;
          }
        }
        throw e;
      }
    },
    runHead: async (h, b) => {
      try {
        const out = await head.run(feedHead(ort, h, b));
        const vals = Object.values(out);
        const lt = pickOutput(out, ["logits"]);
        const at = pickOutput(out, ["act_logits", "act"]) ?? vals[1] ?? vals[0];
        return { logits: toNested(lt.data, lt.dims), act: toNested(at.data, at.dims) };
      } catch (e) {
        if (isOomError(e)) throw new Error(`${e.message} (out of memory; try fewer questions per call)`);
        throw e;
      }
    }
  };
}
var PINNED_REVISIONS, CACHE_KEY, TOKENIZER_CANDIDATES;
var init_providers = __esm({
  "src/providers.ts"() {
    "use strict";
    PINNED_REVISIONS = {
      "convaiinnovations/laya": "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851",
      "convaiinnovations/laya-multilingual": "e4e9ddf21a7b1903b7acffd8814ad4307bf63a67",
      "convaiinnovations/laya-typed-decisions": "1a793eb568e6718f15941d08f85432581df534e3"
    };
    CACHE_KEY = "laya-ts";
    TOKENIZER_CANDIDATES = ["tokenizer.json", "tokenizer/tokenizer.json"];
  }
});

// src/common.ts
function pyNumber(v) {
  const [mant, exp] = v.toExponential().split("e");
  const e = Number(exp);
  return e >= -4 ? String(v) : `${mant}e-${String(-e).padStart(2, "0")}`;
}
function pyJson(v) {
  if (v === null) return "null";
  if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "NaN";
    if (v === Infinity) return "Infinity";
    if (v === -Infinity) return "-Infinity";
    return pyNumber(v);
  }
  if (Array.isArray(v)) return `[${v.map((x) => pyJson(x) ?? "null").join(", ")}]`;
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return void 0;
    const parts = [];
    for (const [k, x] of Object.entries(v)) {
      const s = pyJson(x);
      if (s !== void 0) parts.push(`${JSON.stringify(k)}: ${s}`);
    }
    return `{${parts.join(", ")}}`;
  }
  return void 0;
}
function serializeState(state) {
  if (typeof state === "string") return state;
  return pyJson(state) ?? String(state);
}
function renderCriterion(v) {
  return typeof v === "string" ? v : pyJson(v) ?? String(v);
}
function renderOptions(q) {
  if (q.t === "choice") {
    const crit2 = q.crit;
    return Object.entries(crit2).map(([k, v]) => v === null || v === void 0 || v === "" ? k : `${k}: ${renderCriterion(v)}`);
  }
  if (q.t === "score") {
    return q.crit.map((c, i) => `level ${i}: ${renderCriterion(c)}`);
  }
  const crit = q.crit ?? {};
  const labels = q.labels ?? { false: "false", true: "true" };
  const f = crit["false"], t = crit["true"];
  return [
    labels.false + ": " + (f !== null && f !== void 0 && f !== "" ? renderCriterion(f) : "no, the statement does not hold"),
    labels.true + ": " + (t !== null && t !== void 0 && t !== "" ? renderCriterion(t) : "yes, the statement holds")
  ];
}
var prefixCache = /* @__PURE__ */ new WeakMap();
function buildQuestionPrefix(tok, q, maxLen = 512, headMaxLen = 192, optionOrder) {
  let per = prefixCache.get(tok);
  if (!per) {
    per = /* @__PURE__ */ new Map();
    prefixCache.set(tok, per);
  }
  const key = JSON.stringify([q.t, q.ins, renderOptions(q), maxLen, headMaxLen, optionOrder ?? null]);
  const hit = per.get(key);
  if (hit) return hit;
  const built = buildQuestionPrefixUncached(tok, q, maxLen, headMaxLen, optionOrder);
  if (per.size > 1e3) per.clear();
  per.set(key, built);
  return built;
}
function buildQuestionPrefixUncached(tok, q, maxLen = 512, headMaxLen = 192, optionOrder) {
  const maskTok = tok.maskToken;
  const opts = renderOptions(q);
  const order = optionOrder ?? opts.map((_, i) => i);
  const ins = String(q.ins).split(maskTok).join(" ");
  let headIds = tok.encode(`${q.t} question: ${ins}`);
  let optIds = order.map((i) => [tok.maskId, ...tok.encode(" " + opts[i].split(maskTok).join(" ")).slice(0, 48)]);
  let budget = headMaxLen - optIds.reduce((a, o) => a + o.length, 0);
  let tokensPerOption = null;
  if (budget < 16) {
    const per = Math.max(4, Math.floor((headMaxLen - 16) / Math.max(1, optIds.length)));
    optIds = optIds.map((o) => o.slice(0, per));
    budget = headMaxLen - optIds.reduce((a, o) => a + o.length, 0);
    tokensPerOption = per;
  }
  headIds = headIds.slice(0, Math.max(8, budget));
  const ids = [tok.clsId, ...headIds, tok.sepId];
  const markers = [];
  for (const o of optIds) {
    markers.push(ids.length);
    ids.push(...o);
  }
  ids.push(tok.sepId);
  return {
    ids,
    markers,
    nOptions: opts.length,
    optionStats: {
      total: opts.length,
      distinct: new Set(optIds.map((o) => o.join(","))).size,
      tokens_per_option: tokensPerOption
    }
  };
}
function sequenceWithState(prefix, stateIds, sepId, maxLen = 512, truncateLeft = false) {
  const room = Math.max(0, maxLen - prefix.ids.length - 1);
  const kept = truncateLeft ? stateIds.slice(Math.max(0, stateIds.length - room)) : stateIds.slice(0, room);
  const ids = [...prefix.ids, ...kept, sepId].slice(0, maxLen);
  const used = Math.max(0, Math.min(kept.length, maxLen - prefix.ids.length));
  return {
    ids,
    markers: prefix.markers.filter((m) => m < maxLen),
    stats: {
      state_tokens: stateIds.length,
      state_tokens_used: used,
      state_tokens_dropped: stateIds.length - used,
      truncated: used < stateIds.length,
      options: prefix.optionStats
    }
  };
}
function collapsedOptions(qids, stats) {
  const out = {};
  qids.forEach((qid, i) => {
    const s = stats[i]?.options;
    if (s && s.distinct < s.total) out[qid] = {
      total: s.total,
      distinct: s.distinct,
      tokens_per_option: s.tokens_per_option
    };
  });
  return out;
}
function unpermuteProbs(p, order) {
  if (!order || order.length !== p.length) return p;
  const canonical = new Array(p.length);
  for (let s = 0; s < order.length; s++) canonical[order[s]] = p[s];
  return canonical;
}
function softmax(z) {
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}
function confidenceFromProbs(p) {
  const k = p.length;
  if (k < 2) return 1;
  const ent = -p.reduce((a, v) => a + v * Math.log(Math.max(v, 1e-12)), 0);
  return Math.min(1, Math.max(0, 1 - ent / Math.log(k)));
}
function answerConfidence(p) {
  if (p.length < 1) return 1;
  return Math.min(1, Math.max(0, Math.max(...p)));
}
function pyRepr(v) {
  if (typeof v === "boolean") return v ? "True" : "False";
  if (v === null || v === void 0) return "None";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    return String(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (typeof v === "object") {
    const entries = Object.entries(v).map(
      ([k, val]) => `${pyRepr(k)}: ${pyRepr(val)}`
    );
    return `{${entries.join(", ")}}`;
  }
  return String(v);
}
var BUCKET_TYPES = ["choice", "score", "noul"];
var BUCKET_SIZES = ["2", "3-5", "6-10", "11+"];
function optionCountBucketSize(k) {
  return k <= 2 ? BUCKET_SIZES[0] : k <= 5 ? BUCKET_SIZES[1] : k <= 10 ? BUCKET_SIZES[2] : BUCKET_SIZES[3];
}
var BUCKET_KEY = new RegExp(
  `^(${BUCKET_TYPES.join("|")}):(${BUCKET_SIZES.map((size) => size.replace("+", "\\+")).join("|")})$`
);
function checkMinConfidenceMap(m) {
  if (!m || typeof m !== "object" || Array.isArray(m) || Object.keys(m).length === 0) {
    throw new Error(`a min_confidence map must be a non-empty dict of bucket -> float, got ${pyRepr(m)}`);
  }
  const out = {};
  for (const [key, val] of Object.entries(m)) {
    if (key !== "default" && !BUCKET_KEY.test(key)) {
      throw new Error(`min_confidence map keys must be a bucket like 'choice:3-5' or 'default', got ${pyRepr(key)}`);
    }
    if (typeof val === "boolean" || typeof val !== "number" || !Number.isFinite(val) || val < 0 || val > 1) {
      throw new Error(`min_confidence must be a float in [0.0, 1.0], got ${pyRepr(val)}`);
    }
    out[key] = val;
  }
  return out;
}
function checkMinConfidence(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return checkMinConfidenceMap(v);
  }
  if (typeof v === "boolean" || typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new Error(`min_confidence must be a float in [0.0, 1.0], got ${pyRepr(v)}`);
  }
  return v;
}
function optionBucket(answer) {
  const qt = answer.type;
  if (qt !== "choice" && qt !== "score" && qt !== "noul") return null;
  const probs = answer.probabilities;
  let k;
  if (probs && typeof probs === "object" && !Array.isArray(probs)) {
    k = Object.keys(probs).length;
  } else if (qt === "noul") {
    k = 2;
  } else {
    return null;
  }
  const size = optionCountBucketSize(k);
  return `${qt}:${size}`;
}
function resolveMinConfidence(answer, thresholds, defaultVal = 0) {
  const key = optionBucket(answer);
  if (key !== null) {
    const threshold = thresholds[key];
    if (threshold !== void 0) return threshold;
  }
  return thresholds.default ?? defaultVal;
}
function gateConfidence(answer) {
  const primary = answer.answer_confidence;
  if (typeof primary === "number" && Number.isFinite(primary)) return primary;
  const fallback = answer.confidence;
  if (typeof fallback === "number" && Number.isFinite(fallback)) return fallback;
  return null;
}
function flagLowConfidence(results, minConfidence) {
  const isMap = typeof minConfidence === "object" && minConfidence !== null;
  const list = Array.isArray(results) ? results : [results];
  for (const res of list) {
    const answers = res && typeof res === "object" ? res.answers : null;
    if (!answers || typeof answers !== "object") continue;
    for (const a of Object.values(answers)) {
      if (!a || typeof a !== "object") continue;
      const ansObj = a;
      const conf = gateConfidence(ansObj);
      if (conf === null) {
        delete ansObj.low_confidence;
        continue;
      }
      const thr = isMap ? resolveMinConfidence(ansObj, minConfidence) : minConfidence;
      if (conf < thr) {
        ansObj.low_confidence = true;
      } else {
        delete ansObj.low_confidence;
      }
    }
  }
}
var TEMP_MIN = 0.5;
var TEMP_MAX = 5;
function clampTemperature(t) {
  let f;
  if (typeof t === "number" || typeof t === "bigint") f = Number(t);
  else if (typeof t === "string" && t.trim() !== "") f = Number(t);
  else return 1;
  if (!Number.isFinite(f)) return 1;
  return Math.min(TEMP_MAX, Math.max(TEMP_MIN, f));
}
function tempBucket(qtype, k) {
  return `${BUCKET_TYPES[qtype]}:${optionCountBucketSize(k)}`;
}
function checkBinningMap(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) {
    throw new Error(`binning_map must be an object of bucket -> {bins, values}, got ${pyRepr(m)}`);
  }
  const out = {};
  for (const [name, entry] of Object.entries(m)) {
    if (!BUCKET_KEY.test(name)) {
      throw new Error(`binning_map key ${pyRepr(name)} is not a bucket like "choice:2" or "score:3-5"`);
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`binning_map[${pyRepr(name)}] must be an object with "bins" and "values", got ${pyRepr(entry)}`);
    }
    const rec = entry;
    const nBins = rec.bins;
    const values = rec.values;
    if (typeof nBins === "boolean" || typeof nBins !== "number" || !Number.isInteger(nBins) || nBins < 1) {
      throw new Error(`binning_map[${pyRepr(name)}] must have an integer "bins" >= 1, got ${pyRepr(nBins)}`);
    }
    if (!Array.isArray(values) || values.length !== nBins) {
      throw new Error(`binning_map[${pyRepr(name)}] must have "values" of length "bins" (${nBins})`);
    }
    const parsedValues = [];
    for (const v of values) {
      if (typeof v === "boolean" || typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
        throw new Error(`binning_map[${pyRepr(name)}] values must be numbers in [0, 1], got ${pyRepr(v)}`);
      }
      parsedValues.push(v);
    }
    out[name] = { bins: nBins, values: parsedValues };
  }
  return out;
}
function applyBinningMap(confidence, bucket, binningMap) {
  if (!Number.isFinite(confidence)) return confidence;
  const entry = binningMap?.[bucket];
  if (!entry) {
    return confidence;
  }
  const bins = entry.bins;
  const b = Math.min(bins - 1, Math.max(0, Math.floor(confidence * bins)));
  return entry.values[b];
}
function collateItems(batch, padId) {
  const items = (batch ?? []).flat();
  if (items.length === 0) return null;
  let L = 0;
  let K = 0;
  for (const it of items) {
    if (it.ids.length > L) L = it.ids.length;
    if (it.markers.length > K) K = it.markers.length;
  }
  const hasTarget = items.some((it) => "target" in it);
  const inputIds = items.map((it) => [...it.ids, ...Array(L - it.ids.length).fill(padId)]);
  const attentionMask = items.map((it) => [...Array(it.ids.length).fill(1), ...Array(L - it.ids.length).fill(0)]);
  const markerPos = items.map((it) => [...it.markers, ...Array(K - it.markers.length).fill(0)]);
  const markerMask = items.map((it) => [...it.markers.map(() => true), ...Array(K - it.markers.length).fill(false)]);
  const qtype = items.map((it) => it.qtype);
  const label = items.map((it) => typeof it.label === "number" ? it.label : -1);
  const meta = items.map((it) => {
    const { ids: _ids, markers: _markers, target: _target, ...m } = it;
    return m;
  });
  const out = { inputIds, attentionMask, markerPos, markerMask, qtype, label, meta };
  if (hasTarget) {
    out.target = items.map((it, i) => {
      const t = Array.isArray(it.target) ? it.target : [];
      const k = it.markers.length;
      if (t.length > k) {
        throw new Error(
          `collateItems: item ${i} has ${t.length} target entries but only ${k} marker positions; a target needs one entry per option`
        );
      }
      return [...t, ...Array(K - t.length).fill(0)];
    });
  }
  return out;
}

// src/tokenizer.ts
var CHECKPOINT_IDS = { cls: 50281, sep: 50282, mask: 50284, pad: 50283, unk: 50280 };
var SPECIAL_ALIASES = {
  cls: ["[CLS]", "<bos>", "<s>"],
  sep: ["[SEP]", "<eos>", "</s>"],
  pad: ["[PAD]", "<pad>"],
  mask: ["[MASK]", "<mask>"],
  unk: ["[UNK]", "<unk>"]
};
var METASPACE_REPLACEMENT = "\u2581";
function byteUnicodeMaps() {
  const b2u = /* @__PURE__ */ new Map();
  const u2b = /* @__PURE__ */ new Map();
  const extra = (n) => n < 256 ? n + 256 : n;
  const ranges = [[33, 126], [161, 172], [174, 255]];
  let k = 0;
  const inRange = (b) => ranges.some(([lo, hi]) => b >= lo && b <= hi);
  for (let b = 0; b < 256; b++) {
    const cp = inRange(b) ? b : extra(k++);
    b2u.set(b, String.fromCodePoint(cp));
    u2b.set(String.fromCodePoint(cp), b);
  }
  return { b2u, u2b };
}
var cached = null;
function maps() {
  if (!cached) cached = byteUnicodeMaps();
  return cached;
}
var GPT2_SPLIT = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
var HEAP_MIN_LEN = 32;
function bpeWord(chars, rank) {
  if (chars.length >= HEAP_MIN_LEN) return bpeWordHeap(chars, rank);
  let word = chars.slice();
  if (word.length <= 1) return word;
  for (; ; ) {
    let best = Infinity, idx = -1;
    for (let i = 0; i < word.length - 1; i++) {
      const r = rank.get(word[i] + " " + word[i + 1]);
      if (r !== void 0 && r < best) {
        best = r;
        idx = i;
      }
    }
    if (idx < 0) return word;
    word = [...word.slice(0, idx), word[idx] + word[idx + 1], ...word.slice(idx + 2)];
  }
}
function bpeWordHeap(chars, rank) {
  const n = chars.length;
  const tok = chars.slice();
  if (n <= 1) return tok;
  const next = new Int32Array(n), prev = new Int32Array(n);
  const version = new Int32Array(n);
  const dead = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    prev[i] = i - 1;
    next[i] = i + 1 < n ? i + 1 : -1;
  }
  let heapCap = 3 * n;
  let heapRank = new Int32Array(heapCap), heapSlot = new Int32Array(heapCap), heapVer = new Int32Array(heapCap);
  let heapLen = 0;
  const offer = (slot) => {
    const j = next[slot];
    if (j < 0) return;
    const r = rank.get(tok[slot] + " " + tok[j]);
    if (r === void 0) return;
    if (heapLen === heapCap) {
      heapCap *= 2;
      const r2 = new Int32Array(heapCap);
      r2.set(heapRank);
      heapRank = r2;
      const s2 = new Int32Array(heapCap);
      s2.set(heapSlot);
      heapSlot = s2;
      const v2 = new Int32Array(heapCap);
      v2.set(heapVer);
      heapVer = v2;
    }
    const ver = version[slot];
    let c = heapLen++;
    while (c > 0) {
      const p = c - 1 >> 1;
      if (heapRank[p] < r || heapRank[p] === r && heapSlot[p] < slot) break;
      heapRank[c] = heapRank[p];
      heapSlot[c] = heapSlot[p];
      heapVer[c] = heapVer[p];
      c = p;
    }
    heapRank[c] = r;
    heapSlot[c] = slot;
    heapVer[c] = ver;
  };
  for (let i = 0; i < n - 1; i++) offer(i);
  while (heapLen > 0) {
    const slot = heapSlot[0], ver = heapVer[0];
    const lastRank = heapRank[--heapLen], lastSlot = heapSlot[heapLen], lastVer = heapVer[heapLen];
    if (heapLen > 0) {
      let c = 0;
      for (; ; ) {
        const l = 2 * c + 1;
        if (l >= heapLen) break;
        const r = l + 1;
        let m = l;
        if (r < heapLen && (heapRank[r] < heapRank[l] || heapRank[r] === heapRank[l] && heapSlot[r] < heapSlot[l])) m = r;
        if (heapRank[m] > lastRank || heapRank[m] === lastRank && heapSlot[m] > lastSlot) break;
        heapRank[c] = heapRank[m];
        heapSlot[c] = heapSlot[m];
        heapVer[c] = heapVer[m];
        c = m;
      }
      heapRank[c] = lastRank;
      heapSlot[c] = lastSlot;
      heapVer[c] = lastVer;
    }
    if (dead[slot] || version[slot] !== ver) continue;
    const j = next[slot];
    if (j < 0 || dead[j]) continue;
    tok[slot] = tok[slot] + tok[j];
    dead[j] = 1;
    const k = next[j];
    next[slot] = k;
    if (k >= 0) prev[k] = slot;
    version[slot]++;
    offer(slot);
    const p = prev[slot];
    if (p >= 0) {
      version[p]++;
      offer(p);
    }
  }
  const out = [];
  for (let i = 0; i >= 0; i = next[i]) out.push(tok[i]);
  return out;
}
var sharedEncoder = null;
function bpeEncode(vocab, merges, text) {
  const { b2u } = maps();
  const unkId = vocab.get("[UNK]") ?? CHECKPOINT_IDS.unk;
  const out = [];
  const enc = sharedEncoder ??= new TextEncoder();
  const parts = text.normalize("NFC").match(GPT2_SPLIT);
  if (!parts) return out;
  for (const piece of parts) {
    const chars = [];
    for (const b of enc.encode(piece)) chars.push(b2u.get(b) ?? "");
    for (const tok of bpeWord(chars, merges)) out.push(vocab.get(tok) ?? unkId);
  }
  return out;
}
function metaspaceEncode(vocab, merges, text, unkId, replaces = [[" ", METASPACE_REPLACEMENT]], byteFallback = false) {
  const unk = unkId ?? vocab.get("<unk>") ?? vocab.get("[UNK]") ?? CHECKPOINT_IDS.unk;
  if (!text) return [];
  let t = text;
  for (const [from, to] of replaces) t = t.split(from).join(to);
  const out = [];
  const push = (piece) => {
    for (const tok of bpeWord(Array.from(piece), merges)) {
      const id = vocab.get(tok);
      if (id !== void 0) {
        out.push(id);
        continue;
      }
      const bytes = byteFallback ? Array.from((sharedEncoder ??= new TextEncoder()).encode(tok), (b) => vocab.get(`<0x${b.toString(16).toUpperCase().padStart(2, "0")}>`)) : [];
      if (bytes.length > 0 && bytes.every((b) => b !== void 0)) out.push(...bytes);
      else out.push(unk);
    }
  };
  for (const seg of t.split(/(\n+)/)) {
    if (!seg) continue;
    if (seg[0] === "\n") {
      push(seg);
    } else {
      const w = seg.startsWith(METASPACE_REPLACEMENT) ? seg : METASPACE_REPLACEMENT + seg;
      for (const chunk of w.split(METASPACE_REPLACEMENT).slice(1)) {
        push(chunk ? METASPACE_REPLACEMENT + chunk : METASPACE_REPLACEMENT);
      }
    }
  }
  return out;
}
function encodeSegment(data, text) {
  return data.kind === "metaspace" ? metaspaceEncode(data.vocab, data.merges, text, data.ids.unk, data.replaces, data.byteFallback) : bpeEncode(data.vocab, data.merges, text);
}
function trieSource(words) {
  const root = { kids: /* @__PURE__ */ new Map(), end: false };
  for (const w of words) {
    let n = root;
    for (const ch of w) {
      let k = n.kids.get(ch);
      if (!k) n.kids.set(ch, k = { kids: /* @__PURE__ */ new Map(), end: false });
      n = k;
    }
    n.end = true;
  }
  const walk = (n) => {
    const alts = [...n.kids].map(([c, k]) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + walk(k));
    if (!alts.length) return "";
    const body = alts.length === 1 ? alts[0] : "(?:" + alts.join("|") + ")";
    return n.end ? "(?:" + body + ")?" : body;
  };
  return walk(root);
}
var addedPhases = /* @__PURE__ */ new WeakMap();
function phasesOf(data) {
  let phases = addedPhases.get(data);
  if (!phases) {
    phases = [false, true].flatMap((normalized) => {
      const toks = (data.added ?? []).filter((t) => t.normalized === normalized && t.content);
      if (!toks.length) return [];
      const re = new RegExp(trieSource(toks.map((t) => t.content)), "gu");
      return [{ re, byContent: new Map(toks.map((t) => [t.content, t])), normalized }];
    });
    addedPhases.set(data, phases);
  }
  return phases;
}
function splitOnAdded(text, { re, byContent }) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const tok = byContent.get(m[0]);
    let before = text.slice(last, m.index);
    if (tok.lstrip) before = before.trimEnd();
    if (before) out.push(before);
    out.push(tok);
    last = m.index + m[0].length;
    if (tok.rstrip) while (last < text.length && /\s/u.test(text[last])) last++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function encodeWithData(data, text) {
  let pieces = [text];
  for (const phase of phasesOf(data)) {
    pieces = pieces.flatMap((p) => {
      if (typeof p !== "string") return [p];
      return splitOnAdded(phase.normalized && data.kind === "bytelevel" ? p.normalize("NFC") : p, phase);
    });
  }
  const out = [];
  for (const p of pieces) {
    if (typeof p === "string") out.push(...encodeSegment(data, p));
    else out.push(p.id);
  }
  return out;
}
function childNodes(node) {
  if (!node || typeof node !== "object") return [];
  const o = node;
  const out = [];
  for (const k of ["normalizers", "pre_tokenizers", "decoders"]) {
    const v = o[k];
    if (Array.isArray(v)) out.push(...v);
  }
  return out;
}
function hasNodeType(node, want) {
  if (!node || typeof node !== "object") return false;
  if (node["type"] === want) return true;
  return childNodes(node).some((c) => hasNodeType(c, want));
}
function collectReplaces(node, out) {
  if (!node || typeof node !== "object") return;
  const o = node;
  if (o["type"] === "Replace") {
    const pat = o["pattern"];
    const from = pat?.["String"];
    const to = o["content"];
    if (typeof from === "string" && typeof to === "string") out.push([from, to]);
  }
  for (const c of childNodes(node)) collectReplaces(c, out);
}
function parseTokenizerJson(raw) {
  try {
    const r = raw;
    const vocabObj = r?.model?.vocab;
    if (!vocabObj || typeof vocabObj !== "object") return null;
    const vocab = new Map(Object.entries(vocabObj));
    const merges = /* @__PURE__ */ new Map();
    for (const [i, m] of (r.model?.merges ?? []).entries()) {
      const pair = typeof m === "string" ? m.split(" ") : m;
      if (pair.length >= 2) merges.set(pair[0] + " " + pair[1], i);
    }
    const added = /* @__PURE__ */ new Map();
    const addedTokens = [];
    for (const t of r.added_tokens ?? []) {
      if (typeof t?.content === "string" && typeof t?.id === "number") {
        added.set(t.content, t.id);
        addedTokens.push({
          content: t.content,
          id: t.id,
          normalized: t.normalized === true,
          lstrip: t.lstrip === true,
          rstrip: t.rstrip === true
        });
      }
    }
    const pick = (aliases, fb) => {
      for (const a of aliases) {
        const v = added.get(a) ?? vocab.get(a);
        if (v !== void 0) return { id: v, token: a };
      }
      return { id: fb, token: aliases[0] };
    };
    const cls = pick(SPECIAL_ALIASES.cls, CHECKPOINT_IDS.cls);
    const sep = pick(SPECIAL_ALIASES.sep, CHECKPOINT_IDS.sep);
    const mask = pick(SPECIAL_ALIASES.mask, CHECKPOINT_IDS.mask);
    const pad = pick(SPECIAL_ALIASES.pad, CHECKPOINT_IDS.pad);
    const unk = pick(SPECIAL_ALIASES.unk, CHECKPOINT_IDS.unk);
    const kind = hasNodeType(r?.pre_tokenizer, "Metaspace") ? "metaspace" : "bytelevel";
    const replaces = [];
    collectReplaces(r?.normalizer, replaces);
    if (kind === "metaspace" && replaces.length === 0) replaces.push([" ", METASPACE_REPLACEMENT]);
    return {
      vocab,
      merges,
      ids: { cls: cls.id, sep: sep.id, mask: mask.id, pad: pad.id, unk: unk.id },
      kind,
      maskToken: mask.token,
      replaces,
      byteFallback: r.model?.byte_fallback === true,
      added: addedTokens
    };
  } catch {
    return null;
  }
}

// src/structured.ts
var MAX_PROPERTIES = 32;
var MAX_OPTIONS = 32;
var MAX_SCORE_LEVELS = 10;
var SchemaError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaError";
  }
};
var r4 = (v) => Math.round(v * 1e4) / 1e4;
function pyType(v) {
  if (v === null || v === void 0) return "NoneType";
  if (Array.isArray(v)) return "list";
  switch (typeof v) {
    case "boolean":
      return "bool";
    case "number":
      return Number.isInteger(v) ? "int" : "float";
    case "string":
      return "str";
    case "object":
      return "dict";
    default:
      return typeof v;
  }
}
function schemaOf(model) {
  const m = model;
  for (const key of ["toJSONSchema", "model_json_schema", "schema"]) {
    if (typeof m?.[key] === "function") return m[key]();
  }
  if (m !== null && typeof m === "object" && !Array.isArray(m)) return m;
  throw new SchemaError(`expected a JSON schema object or a model with toJSONSchema(), got ${pyType(model)}`);
}
function noulField(name, description) {
  return {
    name,
    kind: "noul",
    question: { type: "noul", instructions: description || `Is \`${name}\` true?` }
  };
}
function enumField(path, name, values, description) {
  if (values.length > MAX_OPTIONS) {
    throw new SchemaError(`${path}: ${values.length} options exceeds MAX_OPTIONS=${MAX_OPTIONS}`);
  }
  if (values.length === 0) throw new SchemaError(`${path}: 'enum' must not be empty`);
  if (values.every((v) => typeof v === "boolean")) return noulField(name, description);
  const options = values.map((v) => [v == null ? "null" : String(v), v]);
  if (new Set(options.map(([label]) => label)).size !== options.length) {
    throw new SchemaError(`${path}: enum values produce duplicate choice labels`);
  }
  return {
    name,
    kind: "choice",
    question: {
      type: "choice",
      instructions: description || `What is \`${name}\`?`,
      criteria: Object.fromEntries(options.map(([label]) => [label, null]))
    },
    options
  };
}
function scoreField(path, name, prop, description) {
  const lo = prop.minimum;
  const hi = prop.maximum;
  if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
    throw new SchemaError(`${path}: a numeric field needs integer 'minimum' and 'maximum' to become a score`);
  }
  const loN = lo;
  const hiN = hi;
  if (hiN < loN) throw new SchemaError(`${path}: 'maximum' ${hiN} is below 'minimum' ${loN}`);
  const span = hiN - loN + 1;
  if (span > MAX_SCORE_LEVELS) {
    throw new SchemaError(
      `${path}: ${span} levels exceeds MAX_SCORE_LEVELS=${MAX_SCORE_LEVELS}; narrow the range or use an enum`
    );
  }
  return {
    name,
    kind: "score",
    question: {
      type: "score",
      instructions: description || `Score \`${name}\` from ${loN} to ${hiN}`,
      criteria: Array.from({ length: span }, (_, i) => String(loN + i))
    },
    minimum: loN
  };
}
function fieldFor(path, name, prop) {
  if (prop === null || typeof prop !== "object" || Array.isArray(prop)) {
    throw new SchemaError(`${path}: property must be an object, got ${pyType(prop)}`);
  }
  const p = prop;
  const description = p.description;
  if (!("const" in p || "enum" in p || "type" in p)) {
    const union = p.anyOf ?? p.oneOf;
    if (union !== void 0 && Array.isArray(union)) {
      const branches = union.filter(
        (b) => b !== null && typeof b === "object" && !Array.isArray(b) && b.type !== "null"
      );
      if (branches.length !== 1) {
        throw new SchemaError(
          `${path}: only 'Optional[...]' unions (one non-null branch) are supported, got ${branches.length}`
        );
      }
      const branch = { ...branches[0] };
      if (branch.description === void 0 && description !== void 0) {
        branch.description = description;
      }
      return fieldFor(path, name, branch);
    }
  }
  if ("const" in p) return enumField(path, name, [p.const], description);
  if ("enum" in p) {
    if (!Array.isArray(p.enum)) throw new SchemaError(`${path}: 'enum' must be a list, got ${pyType(p.enum)}`);
    return enumField(path, name, p.enum, description);
  }
  let jtype = p.type;
  if (Array.isArray(jtype)) {
    const nonNullTypes = jtype.filter((t) => t !== "null");
    if (nonNullTypes.length > 1) {
      throw new SchemaError(`${path}: 'type' has multiple non-null types; unions are not supported`);
    }
    jtype = nonNullTypes[0];
  }
  if (jtype === "boolean") return noulField(name, description);
  if (jtype === "string") {
    throw new SchemaError(`${path}: a free string cannot be a fixed option set; use 'enum' or a boolean`);
  }
  if (jtype === "integer" || jtype === "number") return scoreField(path, name, p, description);
  if (jtype === "array") throw new SchemaError(`${path}: arrays are not supported; ask one field per element`);
  if (jtype === "object") throw new SchemaError(`${path}: nested objects are not supported; flatten the schema`);
  if ("$ref" in p) throw new SchemaError(`${path}: $ref/recursion is not supported; flatten the schema`);
  throw new SchemaError(`${path}: unsupported schema ${JSON.stringify(prop)}`);
}
function planFromJsonSchema(schema) {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new SchemaError(`expected a JSON schema object, got ${pyType(schema)}`);
  }
  const s = schema;
  if (!(s.type === void 0 || s.type === null || s.type === "object") || !("properties" in s)) {
    throw new SchemaError("the top level must be an object with 'properties'");
  }
  const properties = s.properties;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties) || Object.keys(properties).length === 0) {
    throw new SchemaError("'properties' must be a non-empty object");
  }
  const entries = Object.entries(properties);
  if (entries.length > MAX_PROPERTIES) {
    throw new SchemaError(`${entries.length} properties exceeds MAX_PROPERTIES=${MAX_PROPERTIES}`);
  }
  return entries.map(([name, prop]) => fieldFor(`properties.${name}`, name, prop));
}
function project(answers, fields) {
  const values = {};
  for (const f of fields) {
    const answer = answers[f.name];
    if (answer == null) continue;
    if (answer.low_confidence) {
      values[f.name] = null;
      continue;
    }
    if (f.kind === "noul") {
      values[f.name] = Number(answer.noul ?? 0) >= 0.5;
    } else if (f.kind === "score") {
      const probs = answer.probabilities ?? {};
      const n = Object.keys(probs).length;
      let idx;
      if (n > 0) {
        idx = 0;
        let best = -Infinity;
        for (let i = 0; i < n; i++) {
          const v = Number(probs[String(i)] ?? 0);
          if (v > best) {
            best = v;
            idx = i;
          }
        }
      } else {
        idx = Math.round(Number(answer.score ?? 0));
      }
      values[f.name] = (f.minimum ?? 0) + idx;
    } else {
      const label = String(answer.choice);
      const hit = (f.options ?? []).find(([l]) => l === label);
      values[f.name] = hit ? hit[1] : label;
    }
  }
  return values;
}
function answerConfidenceValue(answer) {
  const conf = answer.answer_confidence;
  if (typeof conf === "number" && typeof conf !== "boolean" && Number.isFinite(conf)) {
    return conf;
  }
  return null;
}
function detailsOf(values, answers, result) {
  const confidence = {};
  const answerConfidence2 = {};
  const probabilities = {};
  for (const [name, answer] of Object.entries(answers)) {
    if (answer == null) continue;
    confidence[name] = Number(answer.confidence ?? 0);
    answerConfidence2[name] = answerConfidenceValue(answer);
    if (answer.type === "noul") {
      const p = Number(answer.noul ?? 0);
      probabilities[name] = { false: r4(1 - p), true: r4(p) };
    } else {
      probabilities[name] = { ...answer.probabilities ?? {} };
    }
  }
  return {
    values,
    confidence,
    answerConfidence: answerConfidence2,
    probabilities,
    answers: { ...answers },
    usage: result.usage,
    routing: result.routing
  };
}
async function decide(runner, state, schema, opts = {}) {
  const { questions, returnDetails = false, minConfidence, min_confidence, ...predictOpts } = opts;
  if (schema == null === (questions == null)) {
    throw new Error("pass exactly one of schema= or questions=");
  }
  const mcOpt = minConfidence ?? min_confidence;
  const mc = mcOpt !== void 0 && mcOpt !== null ? checkMinConfidence(mcOpt) : null;
  if (mc !== null) {
    predictOpts.minConfidence = mc;
  }
  let fields = null;
  let qs = questions;
  if (schema != null) {
    fields = planFromJsonSchema(schemaOf(schema));
    qs = Object.fromEntries(fields.map((f) => [f.name, f.question]));
  }
  const result = await runner.predict(state, qs, predictOpts);
  if (mc !== null && result && typeof result === "object") {
    flagLowConfidence(result, mc);
  }
  const answers = result.answers ?? {};
  const values = fields ? project(answers, fields) : { ...answers };
  if (returnDetails) return detailsOf(values, answers, result);
  return values;
}
async function decideBatch(runner, states, schema, opts = {}) {
  const {
    questions,
    returnDetails = false,
    minConfidence,
    min_confidence,
    ...predictOpts
  } = opts;
  if (schema == null === (questions == null)) {
    throw new Error("pass exactly one of schema= or questions=");
  }
  if (typeof states === "string" || !Array.isArray(states)) {
    throw new TypeError(`states must be an array of states, not ${pyType(states)}`);
  }
  const mcOpt = minConfidence ?? min_confidence;
  const mc = mcOpt !== void 0 && mcOpt !== null ? checkMinConfidence(mcOpt) : null;
  let fields = null;
  let qs = questions;
  if (schema != null) {
    fields = planFromJsonSchema(schemaOf(schema));
    qs = Object.fromEntries(fields.map((f) => [f.name, f.question]));
  }
  const r = runner;
  const predictBatchFn = typeof r.predictBatch === "function" ? r.predictBatch : null;
  if (!predictBatchFn) {
    const runnerName = r?.constructor?.name ?? typeof runner;
    throw new TypeError(`${runnerName} has no predictBatch; loop decide() over the states instead`);
  }
  const isRouter = typeof r.routeBatch === "function";
  let results;
  if (isRouter) {
    const requests = states.map((s) => ({ state: s, questions: qs, ...predictOpts }));
    const batchSize = predictOpts.batchSize ?? null;
    results = await predictBatchFn.call(runner, requests, batchSize);
  } else {
    results = await predictBatchFn.call(runner, states, qs, predictOpts);
  }
  if (mc !== null && Array.isArray(results)) {
    flagLowConfidence(results, mc);
  }
  const one = (res) => {
    const answers = (res && typeof res === "object" ? res.answers : null) || {};
    const values = fields !== null ? project(answers, fields) : { ...answers };
    if (returnDetails) {
      return detailsOf(values, answers, res || {});
    }
    return values;
  };
  return (results || []).map(one);
}

// src/hooks.ts
var PredictContext = class {
  /** `states` / `questions` may be rewritten by `onPredictStart`. */
  states;
  questions;
  /** Shared by every hook of one call. */
  runId;
  /** Set by `skip()` or after inference; `onPredictEnd` may rewrite it. */
  results = null;
  /** Router: the RouteDecision. */
  decision = null;
  /** Resolved checkpoint name. */
  model = null;
  agent = null;
  router = null;
  /** Per-call token-budget overrides; null = agent config. */
  maxLen = null;
  headMaxLen = null;
  /** Aggregated input/output tokens across results. */
  usage = null;
  startedAt;
  elapsedMs = null;
  error = null;
  constructor(init) {
    this.states = init.states;
    this.questions = init.questions;
    this.runId = newRunId();
    this.startedAt = now();
    for (const [k, v] of Object.entries(init)) {
      if (k !== "states" && k !== "questions" && v !== void 0) {
        this[k] = v;
      }
    }
  }
  /** Set cached results from a start hook; inference is skipped, end hooks still run. */
  skip(results) {
    this.results = results;
  }
  /** Set elapsedMs from startedAt. Called by the dispatching call, not by hooks. */
  markElapsed() {
    this.elapsedMs = now() - this.startedAt;
  }
};
function newRunId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID().replaceAll("-", "");
  let hex = "";
  for (let i = 0; i < 32; i++) hex += Math.floor(Math.random() * 16).toString(16);
  return hex;
}
function now() {
  const p = globalThis.performance;
  return p && typeof p.now === "function" ? p.now() : Date.now();
}
var HOOK_EVENTS = [
  "onPredictStart",
  "onPredictEnd",
  "onRoute",
  "onLoad",
  "onEvict",
  "onError"
];
function isHookLike(item) {
  return typeof item === "object" && item !== null && HOOK_EVENTS.some((e) => typeof item[e] === "function");
}
function typeName(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "Array";
  if (typeof v === "object") return v.constructor?.name ?? "object";
  return typeof v;
}
function normaliseHooks(hooks, onPredictStart, onPredictEnd) {
  const out = [];
  const append = (item) => {
    if (item === null || item === void 0) return;
    if (typeof item === "function") {
      if (HOOK_EVENTS.some((e) => typeof item[e] === "function")) {
        throw new TypeError(
          "a hook must be a plain callable or implement hook methods, not both"
        );
      }
      throw new TypeError(
        "a plain callable is ambiguous; pass it as onPredictStart or onPredictEnd"
      );
    }
    if (Array.isArray(item)) {
      for (const h of item) append(h);
      return;
    }
    if (typeof item !== "object") {
      throw new TypeError(`hooks must be Hook objects, got ${typeName(item)}`);
    }
    if (!isHookLike(item)) {
      throw new TypeError(
        `a hook must implement at least one hook method (${HOOK_EVENTS.join(", ")})`
      );
    }
    out.push(item);
  };
  append(hooks);
  if (onPredictStart !== null && onPredictStart !== void 0) {
    if (typeof onPredictStart !== "function") {
      throw new TypeError(`onPredictStart must be callable, got ${typeName(onPredictStart)}`);
    }
    out.push({ onPredictStart });
  }
  if (onPredictEnd !== null && onPredictEnd !== void 0) {
    if (typeof onPredictEnd !== "function") {
      throw new TypeError(`onPredictEnd must be callable, got ${typeName(onPredictEnd)}`);
    }
    out.push({ onPredictEnd });
  }
  if (onPredictStart !== null && onPredictStart !== void 0 && onPredictStart === onPredictEnd) {
    throw new TypeError(
      "onPredictStart and onPredictEnd must be different callables; one callable cannot serve both events"
    );
  }
  return out;
}
var defaultHooksList = [];
var defaultsRan = /* @__PURE__ */ new WeakSet();
function defaultsAlreadyRan(opts) {
  return defaultsRan.has(opts);
}
function composeHooks(installed, hooks, onPredictStart, onPredictEnd) {
  if (defaultHooksList.length === 0 && installed.length === 0 && (hooks === null || hooks === void 0) && (onPredictStart === null || onPredictStart === void 0) && (onPredictEnd === null || onPredictEnd === void 0)) {
    return EMPTY_HOOKS;
  }
  return [...defaultHooksList, ...installed, ...normaliseHooks(hooks, onPredictStart, onPredictEnd)];
}
var EMPTY_HOOKS = [];
Object.freeze(EMPTY_HOOKS);
var HookRegistry = class {
  hooks = [];
  /** Install one hook or a list of them. Returns this for chaining. */
  addHook(hook) {
    const added = normaliseHooks(hook);
    if (added.length > 0) this.hooks = [...this.hooks, ...added];
    return this;
  }
  /** Remove a hook by identity. Returns true if it was installed. */
  removeHook(hook) {
    const before = this.hooks.length;
    this.hooks = this.hooks.filter((installed) => installed !== hook);
    return this.hooks.length !== before;
  }
  /**
   * Run `fn` with hooks installed, then remove them -- works for sync and async `fn`:
   *
   *     await router.withHooks([tracer], () => router.predict(state, questions));
   */
  withHooks(hookArgs, fn) {
    const added = normaliseHooks(hookArgs);
    this.hooks = [...this.hooks, ...added];
    const release = () => {
      this.hooks = this.hooks.filter((installed) => !added.includes(installed));
    };
    let out;
    try {
      out = fn();
    } catch (err) {
      release();
      throw err;
    }
    if (out instanceof Promise) {
      return out.finally(release);
    }
    release();
    return out;
  }
};
function aggregateUsage(results) {
  const total = (key) => results.reduce((acc, r) => {
    const usage = r?.["usage"];
    const v = usage?.[key];
    return acc + (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);
  }, 0);
  return { input_tokens: total("input_tokens"), output_tokens: total("output_tokens") };
}
function reportHookFailure(hook, event, err) {
  const name = hook?.constructor?.name ?? "hook";
  console.warn(`laya: hook ${name}.${event} failed: ${String(err)}`);
}
function isThenable(value) {
  return typeof value?.then === "function";
}
function trimTrailingZeros(decimal) {
  const dot = decimal.indexOf(".");
  if (dot < 0) return decimal;
  let end = decimal.length;
  while (end > 0 && decimal.charAt(end - 1) === "0") end--;
  if (end > 0 && decimal.charAt(end - 1) === ".") end--;
  return decimal.slice(0, end);
}
function formatTimeoutSeconds(timeoutMs) {
  const value = timeoutMs / 1e3;
  if (!Number.isFinite(value)) return String(value);
  const scientific = value.toExponential(5);
  const marker = scientific.indexOf("e");
  if (marker < 0) return scientific;
  const exponent = Number(scientific.slice(marker + 1));
  if (exponent < -4 || exponent >= 6) {
    const sign = exponent < 0 ? "-" : "+";
    return trimTrailingZeros(scientific.slice(0, marker)) + `e${sign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  return trimTrailingZeros(value.toFixed(5 - exponent));
}
function hookTimeoutError(operationName, timeoutMs) {
  const err = new Error(`laya: hook ${operationName} exceeded ${formatTimeoutSeconds(timeoutMs)}s`);
  err.name = "TimeoutError";
  return err;
}
async function runWithTimeout(result, timeoutMs, operationName) {
  if (timeoutMs === null || timeoutMs === void 0) {
    await result;
    return;
  }
  if (!isThenable(result)) return;
  let timer;
  try {
    await Promise.race([
      result,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(hookTimeoutError(operationName, timeoutMs));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer !== void 0) clearTimeout(timer);
  }
}
async function dispatchAsync(hooks, event, ctx, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? null;
  const raiseErrors = opts.raiseErrors ?? true;
  for (const hook of hooks) {
    const method = hook?.[event];
    if (typeof method !== "function") continue;
    const operationName = `${hook?.constructor?.name ?? "hook"}.${event}`;
    try {
      await runWithTimeout(method.call(hook, ctx), timeoutMs, operationName);
    } catch (err) {
      if (raiseErrors) throw err;
      reportHookFailure(hook, event, err);
    }
  }
}

// src/agent.ts
var QTYPES = { choice: 0, score: 1, noul: 2 };
function qidStr(qid) {
  return JSON.stringify(qid);
}
function optionCount(qdef) {
  if (qdef["type"] === "noul") return 2;
  const crit = qdef["criteria"];
  return Array.isArray(crit) || typeof crit === "object" && crit !== null ? Object.keys(crit).length : 0;
}
function checkQuestion(qid, qdef) {
  if (typeof qid !== "string" || !qid.trim()) {
    throw new Error(`question id must be a non-empty string, got ${qidStr(qid)}`);
  }
  if (typeof qdef !== "object" || qdef === null || Array.isArray(qdef)) {
    const got = Array.isArray(qdef) ? "list" : qdef === null ? "NoneType" : typeof qdef;
    throw new Error(`question ${qidStr(qid)}: definition must be a dict, got ${got}`);
  }
  const q = qdef;
  const t = q["type"];
  if (t !== "choice" && t !== "score" && t !== "noul") {
    throw new Error(
      `question ${qidStr(qid)}: unknown type ${JSON.stringify(t)}; use one of ${JSON.stringify(Object.keys(QTYPES).sort())}`
    );
  }
  if (!("instructions" in q)) {
    throw new Error(`question ${qidStr(qid)}: no 'instructions'; add the text the model should answer`);
  }
  const ins = q["instructions"];
  if (ins === null || ins === void 0) {
    throw new Error(
      `question ${qidStr(qid)}: 'instructions' must not be None; add the text the model should answer`
    );
  }
  if (typeof ins === "string" && !ins.trim()) {
    throw new Error(
      `question ${qidStr(qid)}: 'instructions' must not be empty; add the text the model should answer`
    );
  }
  if (typeof ins === "object" && Object.keys(ins).length === 0) {
    throw new Error(
      `question ${qidStr(qid)}: 'instructions' must not be empty; add the text the model should answer`
    );
  }
  if (!["string", "object", "number", "bigint", "boolean"].includes(typeof ins)) {
    throw new Error(
      `question ${qidStr(qid)}: 'instructions' must be a string, dict, or list, got ${typeof ins}`
    );
  }
  const crit = q["criteria"];
  if (t === "choice") {
    if (typeof crit !== "object" || crit === null) {
      throw new Error(
        `question ${qidStr(qid)}: a choice question takes 'criteria' as a dict of label -> description, or a list of labels`
      );
    }
    if (Object.keys(crit).length === 0) {
      throw new Error(`question ${qidStr(qid)}: a choice question needs at least one criterion`);
    }
    if (Array.isArray(crit)) {
      for (let i = 0; i < crit.length; i++) {
        const label = crit[i];
        if (label === null || label === void 0) {
          throw new Error(
            `question ${qidStr(qid)}: choice label ${i} is null; a label is rendered as option text and used as the answer key, so it must be a string, number or bool`
          );
        }
        if (typeof label !== "object") continue;
        throw new Error(
          `question ${qidStr(qid)}: choice label ${i} is a ${Array.isArray(label) ? "list" : "dict"}; a label is rendered as option text and used as the answer key, so it must be a scalar (a string, number or bool), got ${JSON.stringify(label)}`
        );
      }
      const seen = /* @__PURE__ */ new Map();
      crit.forEach((label, i) => {
        const key = String(label);
        const first = seen.get(key);
        if (first === void 0) {
          seen.set(key, i);
          return;
        }
        throw new Error(
          `question ${qidStr(qid)}: choice label ${i} (${JSON.stringify(label)}) repeats label ${first}; the labels are the answer keys, so every option needs its own (1 and "1" are one key)`
        );
      });
    }
  } else if (t === "score") {
    if (!Array.isArray(crit)) {
      throw new Error(
        `question ${qidStr(qid)}: a score question takes 'criteria' as a list of level descriptions, index 0 first`
      );
    }
    if (crit.length === 0) {
      throw new Error(`question ${qidStr(qid)}: a score question needs at least one level`);
    }
    const nullAt = crit.findIndex((c) => c === null || c === void 0);
    if (nullAt >= 0) {
      throw new Error(
        `question ${qidStr(qid)}: score level ${nullAt} is null; give every level a description, index 0 first`
      );
    }
  } else if (crit !== void 0 && crit !== null && (typeof crit !== "object" || Array.isArray(crit))) {
    throw new Error(
      `question ${qidStr(qid)}: a noul question takes 'criteria' as a dict with optional 'true'/'false' descriptions, or omits it`
    );
  } else if (crit && typeof crit === "object" && !Array.isArray(crit)) {
    const invalid = Object.keys(crit).filter((key) => key.toLowerCase() !== "true" && key.toLowerCase() !== "false");
    if (invalid.length > 0) {
      throw new Error(
        `question ${qidStr(qid)}: noul criteria may contain only 'true' and 'false'; got ${JSON.stringify(invalid)}`
      );
    }
  }
  if (Object.hasOwn(q, "option_order")) {
    const order = q["option_order"];
    const n = optionCount(q);
    const ints = Array.isArray(order) ? order.filter((i) => typeof i === "number" && Number.isInteger(i)) : null;
    const isPermutation = ints !== null && ints.length === n && [...ints].sort((a, b) => a - b).join(",") === Array.from({ length: n }, (_, i) => i).join(",");
    if (!isPermutation) {
      throw new Error(
        `question ${qidStr(qid)}: 'option_order' must be a permutation of range(${n}) -- one slot per option, each option once -- got ${JSON.stringify(order)}`
      );
    }
  }
  if ("labels" in q && t !== "noul") {
    throw new Error(`question ${qidStr(qid)}: 'labels' is only supported for noul questions`);
  }
  if (t === "noul" && q["labels"] !== null && q["labels"] !== void 0) {
    const labels = q["labels"];
    if (typeof labels !== "object" || labels === null || Array.isArray(labels)) {
      throw new Error(`question ${qidStr(qid)}: noul labels must be an object with 'false' and 'true'`);
    }
    const entries = Object.entries(labels);
    const keys = entries.map(([key]) => key).sort();
    if (keys.length !== 2 || keys[0] !== "false" || keys[1] !== "true" || entries.some(([, value]) => typeof value !== "string" || value.trim() === "")) {
      throw new Error(`question ${qidStr(qid)}: noul labels must map exactly 'false' and 'true' to distinct non-empty strings`);
    }
    const falseLabel = String(labels["false"]).trim();
    const trueLabel = String(labels["true"]).trim();
    if (falseLabel === trueLabel) {
      throw new Error(`question ${qidStr(qid)}: noul labels must be distinct`);
    }
  }
}
function isPlainDict(o) {
  if (typeof o !== "object" || o === null || Array.isArray(o)) return false;
  const proto = Object.getPrototypeOf(o);
  return proto === null || proto === Object.prototype;
}
function isEmptyOverride(v) {
  if (v === null || v === void 0 || v === false || v === "") return true;
  if (v === 0) return true;
  return Array.isArray(v) && v.length === 0;
}
function toInternal(qdef) {
  const t = qdef["type"];
  let crit = qdef["criteria"];
  if (t === "choice" && Array.isArray(crit)) {
    crit = Object.fromEntries(crit.map((c) => [c, null]));
  } else if (t === "noul" && crit !== null && crit !== void 0 && typeof crit === "object" && !Array.isArray(crit)) {
    crit = Object.fromEntries(Object.entries(crit).map(([k, v]) => [String(k).toLowerCase(), v]));
  }
  let ins = qdef["instructions"];
  if (typeof ins !== "string") ins = serializeState(ins);
  const out = {
    t,
    ins,
    crit
  };
  if (t === "noul" && qdef["labels"] && typeof qdef["labels"] === "object" && !Array.isArray(qdef["labels"])) {
    const labels = qdef["labels"];
    out.labels = { false: String(labels["false"]).trim(), true: String(labels["true"]).trim() };
  }
  if (Object.hasOwn(qdef, "option_order")) {
    out.optionOrder = qdef["option_order"].map((i) => Math.trunc(Number(i)));
  }
  return out;
}
function defaultTokenizer() {
  return {
    clsId: 101,
    sepId: 102,
    maskId: 103,
    padId: 0,
    maskToken: "[MASK]",
    encode(text) {
      return text.split(/\s+/).filter(Boolean).map((w, i) => 1e3 + (w.length * 31 + i * 7) % 2e4);
    }
  };
}
function tokenizerFromHF(tokenizerJson) {
  const data = parseTokenizerJson(tokenizerJson);
  if (!data) return null;
  return {
    clsId: data.ids.cls,
    sepId: data.ids.sep,
    maskId: data.ids.mask,
    padId: data.ids.pad,
    maskToken: data.maskToken,
    encode: (text) => encodeWithData(data, text)
  };
}
var r42 = (v) => Math.round(v * 1e4) / 1e4;
var Agent = class _Agent extends HookRegistry {
  hooksRaise;
  hooksTimeout;
  cfg;
  provider;
  revision;
  tok;
  maxLen;
  headMaxLen;
  temperatureRaw;
  temperatureByOptionsRaw;
  temperature;
  temperatureByOptions;
  binningMap;
  langTemperatures;
  constructor(opts) {
    super();
    if (!opts || !opts.provider) throw new Error("Agent needs a provider");
    this.provider = opts.provider;
    this.revision = opts.revision ?? null;
    this.hooks = normaliseHooks(opts.hooks, opts.onPredictStart, opts.onPredictEnd);
    this.hooksRaise = opts.hooksRaise ?? true;
    this.hooksTimeout = opts.hooksTimeout ?? null;
    const cfg = { ...opts.cfg ?? {} };
    if (opts.max_len !== void 0) cfg.max_len = opts.max_len;
    if (opts.head_max_len !== void 0) cfg.head_max_len = opts.head_max_len;
    if (opts.temperature !== void 0) cfg.temperature = opts.temperature;
    if (opts.temperature_by_options !== void 0) cfg.temperature_by_options = opts.temperature_by_options;
    if (opts.binning_map !== void 0) cfg.binning_map = opts.binning_map;
    if (opts.binningMap !== void 0) cfg.binning_map = opts.binningMap;
    this.cfg = cfg;
    this.maxLen = Number(cfg.max_len ?? 512);
    this.headMaxLen = Number(cfg.head_max_len ?? 192);
    this.tok = opts.tok ?? defaultTokenizer();
    const bmapRaw = cfg.binning_map;
    this.binningMap = bmapRaw !== void 0 && bmapRaw !== null ? checkBinningMap(bmapRaw) : null;
    const raw = cfg.temperature ?? [1, 1, 1];
    this.temperatureRaw = raw;
    if (!Array.isArray(raw) || raw.length !== 3) {
      throw new Error(`Incompatible model: temperature must be a list of 3 floats, got ${JSON.stringify(raw)}`);
    }
    const rawList = raw;
    this.temperature = rawList.map((t) => clampTemperature(t));
    this.temperatureByOptionsRaw = cfg.temperature_by_options ?? {};
    this.temperatureByOptions = Object.fromEntries(
      Object.entries(this.temperatureByOptionsRaw).map(([k, v]) => [k, clampTemperature(v)])
    );
    const entries = [
      ...Object.entries(this.temperatureByOptionsRaw).map(
        ([k, v]) => [k, v, this.temperatureByOptions[k]]
      ),
      ...[0, 1, 2].map(
        (i) => [`temperature[${i}]`, rawList[i], this.temperature[i]]
      )
    ];
    const rejected = [];
    for (const [name, rawV, applied] of entries) {
      if (typeof rawV !== "boolean" && Number(rawV) === applied) continue;
      rejected.push(`${name}=${JSON.stringify(rawV) ?? String(rawV)} -> ${applied}`);
    }
    if (rejected.length > 0) {
      console.warn(
        `laya: this checkpoint ships invalid temperatures or values outside [${TEMP_MIN}, ${TEMP_MAX}]; using ${rejected.join(", ")}. Treat confidence from the affected entries as uncalibrated.`
      );
    }
    this.langTemperatures = {};
    for (const [l, lc] of Object.entries(opts.lang_temperatures ?? {})) {
      const normL = l.split("-")[0].toLowerCase();
      const tRaw = lc?.temperature ?? rawList;
      if (!Array.isArray(tRaw) || tRaw.length !== 3) {
        throw new Error(
          `Language override ${JSON.stringify(l)} temperature must be a list of 3 floats`
        );
      }
      const tboRaw = lc?.temperature_by_options;
      if (!isEmptyOverride(tboRaw) && !isPlainDict(tboRaw)) {
        throw new Error(
          `Language override ${JSON.stringify(l)} temperature_by_options must be a mapping of bucket -> float, got ${Array.isArray(tboRaw) ? "list" : typeof tboRaw}`
        );
      }
      const tboDict = isPlainDict(tboRaw) ? tboRaw : {};
      this.langTemperatures[normL] = {
        temperature: [0, 1, 2].map((i) => clampTemperature(tRaw[i])),
        temperatureByOptions: Object.fromEntries(
          Object.entries(tboDict).map(([k, v]) => [k, clampTemperature(v)])
        )
      };
    }
  }
  /**
   * Evaluate typed questions across one state in a single forward pass.
   *
   * `hooks` / `onPredictStart` / `onPredictEnd` observe or shape the prediction, appended
   * after any hooks installed on the Agent; a start hook may rewrite the state/questions or
   * call `ctx.skip(...)` to short-circuit inference, an end hook may rewrite the results.
   * See hooks.ts. `hooksRaise` overrides the Agent's setting for this call.
   */
  async systemOne(state, questions, opts = {}) {
    return (await this._predictHooked([state], questions, opts))[0];
  }
  async _predictHooked(states, questions, opts) {
    const mcOpt = opts.minConfidence ?? opts.min_confidence;
    const mc = mcOpt !== void 0 && mcOpt !== null ? checkMinConfidence(mcOpt) : null;
    const active = defaultsAlreadyRan(opts) ? [...this.hooks, ...normaliseHooks(opts.hooks, opts.onPredictStart, opts.onPredictEnd)] : composeHooks(this.hooks, opts.hooks, opts.onPredictStart, opts.onPredictEnd);
    const raiseErrors = opts.hooksRaise ?? this.hooksRaise;
    const hooksTimeout = opts.hooksTimeout ?? this.hooksTimeout;
    const timeoutMs = typeof hooksTimeout === "number" ? hooksTimeout * 1e3 : null;
    const ctx = new PredictContext({
      states,
      questions,
      agent: this,
      maxLen: opts.maxLen ?? null,
      headMaxLen: opts.headMaxLen ?? null
    });
    try {
      await dispatchAsync(active, "onPredictStart", ctx, { raiseErrors, timeoutMs });
      if (ctx.results === null) {
        if (!Array.isArray(ctx.states)) {
          throw new TypeError(
            "predictBatch expects an array of states; pass a single state to predict()/systemOne()."
          );
        }
        if (!isPlainDict(ctx.questions)) {
          const typeName2 = ctx.questions === null ? "NoneType" : Array.isArray(ctx.questions) ? "list" : typeof ctx.questions === "object" ? ctx.questions.constructor?.name ?? "object" : typeof ctx.questions;
          throw new TypeError(
            `questions must be a dict of question id -> definition, got ${typeName2}`
          );
        }
        for (const st of ctx.states) {
          if (st === null || st === void 0) {
            throw new TypeError("state must not be None; pass a string, dict, or list");
          }
        }
        const out = await this._systemOneMany(ctx.states, ctx.questions, {
          maxLen: ctx.maxLen,
          headMaxLen: ctx.headMaxLen,
          batchSize: opts.batchSize ?? null,
          lang: opts.lang ?? null
        });
        ctx.results = out;
        ctx.model ??= out[0]?.model ?? null;
      }
    } catch (err) {
      ctx.error = err;
      try {
        await dispatchAsync(active, "onError", ctx, { raiseErrors });
      } catch {
      }
      throw err;
    } finally {
      ctx.markElapsed();
      if (ctx.results !== null) {
        ctx.usage = aggregateUsage(ctx.results);
        if (mc !== null) {
          flagLowConfidence(ctx.results, mc);
        }
      }
      try {
        await dispatchAsync(active, "onPredictEnd", ctx, { raiseErrors, timeoutMs });
      } catch (hookErr) {
        if (ctx.error === null) throw hookErr;
      }
    }
    return ctx.results;
  }
  /** Encode one state into one sequence row per question; the state text is tokenized once. */
  _encodeItems(state, ids, internals, maxLen, headMaxLen) {
    const stAll = this.tok.encode(serializeState(state).split(this.tok.maskToken).join(" "));
    const items = [];
    const stats = [];
    for (let qi = 0; qi < ids.length; qi++) {
      const qid = ids[qi];
      const q = internals[qi];
      const prefix = buildQuestionPrefix(this.tok, q, maxLen, headMaxLen, q.optionOrder);
      const seq = sequenceWithState(
        prefix,
        stAll,
        this.tok.sepId,
        maxLen,
        Array.isArray(state)
      );
      if (seq.markers.length !== renderOptions(q).length) {
        throw new Error(`question ${qidStr(qid)} options exceed head_max_len=${headMaxLen}`);
      }
      items.push({ ids: seq.ids, markers: seq.markers, qtype: QTYPES[q.t] });
      stats.push(seq.stats);
    }
    return { items, nTokens: items.reduce((a, it) => a + it.ids.length, 0), stats };
  }
  /**
   * Evaluate one shared question schema over many states. Each chunk of up to `batchSize`
   * states is collated into a single encoder+head forward pass; results align with `states`
   * by index. (Python `Agent.predict_batch` parity; its `sort_by_length` is not ported.)
   */
  async _systemOneMany(states, questions, opts = {}) {
    if (states.length === 0) return [];
    const ids = Object.keys(questions ?? {});
    if (ids.length === 0) {
      return states.map(() => ({
        model: "laya-rl-agent",
        answers: {},
        usage: { input_tokens: 0, output_tokens: 0 }
      }));
    }
    const maxLen = opts.maxLen ?? this.maxLen;
    const headMaxLen = opts.headMaxLen ?? this.headMaxLen;
    const internals = ids.map((qid) => {
      checkQuestion(qid, questions[qid]);
      return toInternal(questions[qid]);
    });
    const chunkSize = opts.batchSize && opts.batchSize > 0 ? Math.floor(opts.batchSize) : states.length;
    const out = [];
    for (let start = 0; start < states.length; start += chunkSize) {
      const chunk = states.slice(start, start + chunkSize);
      const built = chunk.map((st) => this._encodeItems(st, ids, internals, maxLen, headMaxLen));
      const collated = collateItems(built.map((b) => b.items), this.tok.padId);
      if (!collated) throw new Error("no items to collate");
      const batch = collated;
      const { lastHidden } = await this.provider.runEncoder(batch);
      const { logits, act } = await this.provider.runHead(lastHidden, batch);
      const rows = chunk.length * ids.length;
      if (!Array.isArray(logits) || !Array.isArray(act) || logits.length < rows || act.length < rows) {
        throw new Error("model provider returned fewer output rows than input items");
      }
      for (let s = 0; s < chunk.length; s++) {
        for (let qi = 0; qi < ids.length; qi++) {
          const r = s * ids.length + qi;
          const k = built[s].items[qi].markers.length;
          const logitRow = logits[r];
          const actRow = act[r];
          if (!Array.isArray(logitRow) || logitRow.length < k || !Array.isArray(actRow) || actRow.length === 0 || logitRow.some((v) => !Number.isFinite(v)) || actRow.some((v) => !Number.isFinite(v))) {
            throw new Error(`model provider returned invalid output for question ${ids[qi]}`);
          }
        }
      }
      let row = 0;
      for (let s = 0; s < chunk.length; s++) {
        const answers = {};
        for (let qi = 0; qi < ids.length; qi++) {
          answers[ids[qi]] = this._decodeRow(
            logits[row],
            // The action head is normalised here, at the model boundary, as `laya/agent.py`'s
            // `_forward` (agent.py:1329) and `laya/onnx_agent.py` (onnx_agent.py:805) do: the decode
            // layer's contract -- the Java decoder's `actionProbabilities`, and the `act` rows in
            // `laya-java/fixtures/decode.json` -- is a probability row. Softmaxing it a second time
            // inside `_decodeRow` reported 0.6899 for the row `[0.9, 0.1]`, where the reference
            // reports 0.9.
            softmax(act[row] ?? [1, 0]),
            internals[qi],
            built[s].items[qi].markers.length,
            opts.lang ?? null
          );
          row++;
        }
        const st = built[s].stats;
        const dropped = st.reduce((a, x) => Math.max(a, x.state_tokens_dropped), 0);
        const collapsed = collapsedOptions(ids, st);
        out.push({
          model: "laya-rl-agent",
          answers,
          usage: {
            input_tokens: built[s].nTokens,
            output_tokens: 0,
            state_tokens: st[0]?.state_tokens ?? 0,
            state_tokens_dropped: dropped,
            truncated: dropped > 0,
            truncated_questions: ids.filter((_, qi) => st[qi].truncated),
            ...Object.keys(collapsed).length ? { options: collapsed } : {}
          }
        });
      }
    }
    return out;
  }
  /**
   * Decode one head row into the answer for its question. `actRow` is the model boundary's
   * normalised action-probability row, so its first entry is the reported `act_probability` --
   * exactly what `Agent._decode_answers` reads as `act[r, 0]`.
   */
  _decodeRow(logitsRow, actRow, q, k, lang = null) {
    const qt = QTYPES[q.t];
    const bucket = tempBucket(qt, k);
    const langCfg = lang ? this.langTemperatures[lang.split("-")[0].toLowerCase()] : void 0;
    const scale = langCfg ? langCfg.temperatureByOptions[bucket] ?? langCfg.temperature[qt] ?? 1 : this.temperatureByOptions[bucket] ?? this.temperature[qt] ?? 1;
    const z = logitsRow.slice(0, k).map((v) => v / scale);
    const p = unpermuteProbs(softmax(z), q.optionOrder);
    const ext = { act_probability: r42(actRow[0]) };
    const ansRaw = answerConfidence(p);
    const langOverride = Boolean(lang && lang.split("-")[0].toLowerCase() in this.langTemperatures);
    const ansConf = r42(
      this.binningMap && !langOverride ? applyBinningMap(ansRaw, bucket, this.binningMap) : ansRaw
    );
    if (q.t === "choice") {
      const keys = Object.keys(q.crit);
      let best = 0;
      for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
      return {
        type: "choice",
        choice: keys[best],
        probabilities: Object.fromEntries(keys.map((kk, i) => [kk, r42(p[i] ?? 0)])),
        confidence: r42(confidenceFromProbs(p)),
        answer_confidence: ansConf,
        action: ext
      };
    }
    if (q.t === "score") {
      const exp = p.reduce((a, v, i) => a + i * v, 0);
      return {
        type: "score",
        score: r42(exp),
        // `renderCriterion`, not the raw `c`: a legend maps an index to the TEXT of a level, and
        // the keys are already strings. A numeric scale written directly used to come back with
        // the caller's own JSON types (`{"0": 1}`), so a client that reads a level as a string
        // had to handle a number, a boolean and null as well -- and `{"0": null}` is not even
        // parseable by a Jev client (#302). Same change as the Python `agent.py` and
        // `onnx_agent.py` legends, so the two runtimes return the same value types.
        legend: Object.fromEntries(
          q.crit.map((c, i) => [String(i), renderCriterion(c)])
        ),
        probabilities: Object.fromEntries(p.map((v, i) => [String(i), r42(v)])),
        confidence: r42(confidenceFromProbs(p)),
        answer_confidence: ansConf,
        action: ext
      };
    }
    const pt = p[1] ?? 0;
    return {
      type: "noul",
      noul: r42(pt),
      confidence: r42(Math.max(pt, 1 - pt)),
      // over two options max(p_true, 1 - p_true) is max(p): identical to confidence here
      answer_confidence: ansConf,
      action: ext
    };
  }
  async predict(state, questions, opts = {}) {
    return this.systemOne(state, questions, opts);
  }
  /**
   * Evaluate the same questions over many states, packing each chunk of up to
   * `opts.batchSize` states into one shared forward pass (Python `Agent.predict_batch`
   * parity). This is the throughput path: `systemOne`/`predict` run one state per forward
   * pass, which leaves most of the batch dimension idle on GPU. Results align with
   * `states` by index and are identical in shape to `systemOne`'s output.
   *
   * `opts.maxLen` / `opts.headMaxLen` override the agent config for this call; a start
   * hook may also set `ctx.maxLen` / `ctx.headMaxLen` or call `ctx.skip(results)`.
   * Python's `sort_by_length` grouping is not ported.
   */
  async predictBatch(states, questions, opts = {}) {
    return this._predictHooked(states, questions, opts);
  }
  async decide(state, schema, opts = {}) {
    return decide(this, state, schema, opts);
  }
  async decideBatch(states, schema, opts = {}) {
    return decideBatch(this, states, schema, opts);
  }
  static async load(modelDirOrRepo, opts) {
    const sub = opts?.subfolder ?? null;
    const isBrowser = typeof globalThis.window !== "undefined";
    let cfg = {};
    let tokenizerJson = null;
    let dir = opts?.localDir ?? modelDirOrRepo;
    let revision = null;
    let provider;
    if (isBrowser) {
      const { loadWebBundle: loadWebBundle2, createWebProvider: createWebProvider2 } = await Promise.resolve().then(() => (init_providers(), providers_exports));
      const bundle = await loadWebBundle2(modelDirOrRepo, {
        subfolder: sub,
        revision: opts?.revision,
        expectedSha256: opts?.expectedSha256,
        signal: opts?.signal,
        onProgress: opts?.onProgress
      });
      cfg = bundle.cfg;
      tokenizerJson = bundle.tokenizerJson;
      dir = bundle.dir;
      revision = bundle.revision;
      provider = await createWebProvider2(dir, {
        numThreads: opts?.numThreads,
        expectedSha256: opts?.expectedSha256
      });
    } else {
      const { loadNodeBundle: loadNodeBundle2, createNodeProvider: createNodeProvider2 } = await Promise.resolve().then(() => (init_providers(), providers_exports));
      const bundle = await loadNodeBundle2(modelDirOrRepo, {
        subfolder: sub,
        localDir: opts?.localDir,
        token: opts?.token,
        revision: opts?.revision,
        expectedSha256: opts?.expectedSha256,
        signal: opts?.signal,
        onProgress: opts?.onProgress
      });
      cfg = bundle.cfg;
      tokenizerJson = bundle.tokenizerJson;
      dir = bundle.dir;
      revision = bundle.revision;
      provider = await createNodeProvider2(dir, {
        device: opts?.device,
        numThreads: opts?.numThreads,
        expectedSha256: opts?.expectedSha256
      });
    }
    if (!tokenizerJson) {
      throw new Error(
        `Incompatible model: tokenizer.json is missing or invalid in ${JSON.stringify(dir)}`
      );
    }
    let tok;
    try {
      const parsed = tokenizerFromHF(tokenizerJson);
      if (!parsed) throw new Error("unsupported tokenizer.json format");
      tok = parsed;
    } catch (error) {
      throw new Error(
        `Incompatible model: tokenizer.json is missing or invalid in ${JSON.stringify(dir)}: ${String(error)}`
      );
    }
    return new _Agent({ provider, tok, cfg, revision, lang_temperatures: opts?.lang_temperatures });
  }
};

// entry.ts
init_providers();
export {
  Agent,
  encodeWithData,
  feed,
  feedHead,
  parseTokenizerJson
};
