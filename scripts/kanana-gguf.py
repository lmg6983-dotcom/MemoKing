# 카나나2 GGUF 만들기 도우미 (.github/workflows/kanana-gguf.yml)
#   text  <wiki.parquet> <out_dir>      : 한국어 글 — calib.txt (imatrix 용: README · 메모 + 위키 앞부분) · eval.txt (견주기 용: 위키 뒷부분)
#   remap <ckpt> <out_dir>              : llama.cpp 가 아는 구조(qwen3)로 config 만 바꾼 폴더들 — 가중치는 그대로(링크)
#   hf-ppl <ckpt> <eval.txt> <chunks>   : 원래 모델(transformers)의 PPL — llama-perplexity 와 같은 방식(512 토큰, 뒤 절반만 셈)
import json, math, os, sys


def text(parquet, out):
    import pyarrow.parquet as pq
    arts = [t for t in pq.read_table(parquet, columns=["text"]).column("text").to_pylist() if len(t) > 2000]
    memos = json.load(open("scripts/laya-bench/tags.json"))
    own = open("README.md").read() + "\n\n" + "\n\n".join(m["body"] for m in memos["vault"]) + "\n\n" + "\n\n".join(c["text"] for c in memos["cases"])
    calib, i = [own], 0
    while sum(map(len, calib)) < 400_000:
        calib.append(arts[i]); i += 1
    ev = []
    while sum(map(len, ev)) < 120_000:
        ev.append(arts[i]); i += 1
    os.makedirs(out, exist_ok=True)
    open(f"{out}/calib.txt", "w").write("\n\n".join(calib))
    open(f"{out}/eval.txt", "w").write("\n\n".join(ev))
    print("calib", sum(map(len, calib)), "글자 · eval", sum(map(len, ev)), "글자")


def remap(ckpt, out):
    cfg = json.load(open(f"{ckpt}/config.json"))
    arch = cfg["architectures"][0]
    print("구조:", arch, {k: cfg.get(k) for k in ["num_hidden_layers", "hidden_size", "head_dim", "num_attention_heads", "num_key_value_heads",
          "sliding_window", "max_position_embeddings", "rope_theta", "rope_scaling", "rope_parameters", "tie_word_embeddings", "vocab_size"]})
    if "layer_types" in cfg:
        print("layer_types:", cfg["layer_types"])
    if arch != "Kanana2TinyForCausalLM":
        print("variants: as-is")
        os.symlink(os.path.abspath(ckpt), f"{out}/as-is")
        return
    # 하이브리드(SWA 3 : 전체 1, 층마다 다른 RoPE) — llama.cpp qwen3 는 한 가지 RoPE 만 안다. 둘 다 만들어 원래 모델과 가까운 쪽을 고른다
    rp = cfg.get("rope_parameters") or {}
    swa = rp.get("sliding_attention") or {"rope_theta": cfg.get("rope_theta", 10000)}
    full = rp.get("full_attention") or {"rope_theta": cfg.get("rope_theta"), **(cfg.get("rope_scaling") or {})}
    print("SWA RoPE:", swa, "· 전체 RoPE:", full)
    yarn = {k: v for k, v in full.items() if k != "rope_theta"}
    if yarn.get("rope_type", yarn.get("type")) in (None, "default"):
        yarn = None
    variants = {"swa": (swa["rope_theta"], None), "full": (full["rope_theta"], yarn)}
    for name, (theta, scaling) in variants.items():
        d = f"{out}/{name}"
        os.makedirs(d)
        for f in os.listdir(ckpt):
            if f != "config.json":
                os.symlink(os.path.abspath(f"{ckpt}/{f}"), f"{d}/{f}")
        c = {k: v for k, v in cfg.items() if k not in ("auto_map", "layer_types", "sliding_window", "rope_parameters", "rope_scaling", "use_sliding_window", "max_window_layers")}
        c.update(architectures=["Qwen3ForCausalLM"], model_type="qwen3", rope_theta=theta, rope_scaling=scaling)
        json.dump(c, open(f"{d}/config.json", "w"), indent=1)
    print("variants:", " ".join(variants))


def hf_ppl(ckpt, path, chunks):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    tok = AutoTokenizer.from_pretrained(ckpt, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(ckpt, trust_remote_code=True, torch_dtype=torch.bfloat16).eval()
    ids = tok(open(path).read(), add_special_tokens=False).input_ids
    n, first = 512, 256
    print("토큰", len(ids))
    nll, count = 0.0, 0
    with torch.no_grad():
        for c in range(min(chunks, len(ids) // n)):
            x = torch.tensor([ids[c * n:(c + 1) * n]])
            logp = torch.log_softmax(model(x).logits[0].float(), -1)
            for j in range(first, n - 1):
                nll -= logp[j, x[0, j + 1]].item()
                count += 1
    print(f"HF PPL = {math.exp(nll / count):.4f}")


if __name__ == "__main__":
    cmd, *a = sys.argv[1:]
    {"text": lambda: text(*a), "remap": lambda: remap(*a), "hf-ppl": lambda: hf_ppl(a[0], a[1], int(a[2]))}[cmd]()
