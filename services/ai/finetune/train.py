"""LoRA fine-tune a small open model to extract voice-note fields as JSON.

    python -m finetune.train --data finetune/data --out finetune/out/qwen05b

Loss is computed on the assistant's JSON only (the prompt is masked). The LoRA
adapter is merged into the base weights at the end so the result converts
directly to GGUF for llama.cpp / Ollama / on-device use.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import time
from pathlib import Path

import torch
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer


def load(path: Path) -> list[list[dict]]:
    return [json.loads(l)["messages"] for l in path.read_text().splitlines() if l.strip()]


def encode(tok, messages: list[dict], max_len: int) -> tuple[list[int], list[int]]:
    prompt = tok.apply_chat_template(messages[:2], add_generation_prompt=True, tokenize=False)
    full = prompt + messages[2]["content"] + tok.eos_token
    p_ids = tok(prompt, add_special_tokens=False)["input_ids"]
    ids = tok(full, add_special_tokens=False)["input_ids"][:max_len]
    labels = [-100] * min(len(p_ids), len(ids)) + ids[len(p_ids) :]
    return ids, labels


def batches(rows, size, pad_id, shuffle, rng):
    order = list(range(len(rows)))
    if shuffle:
        rng.shuffle(order)
    for i in range(0, len(order), size):
        chunk = [rows[j] for j in order[i : i + size]]
        n = max(len(ids) for ids, _ in chunk)
        ids = torch.full((len(chunk), n), pad_id)
        lab = torch.full((len(chunk), n), -100)
        att = torch.zeros((len(chunk), n), dtype=torch.long)
        for k, (a, b) in enumerate(chunk):
            ids[k, : len(a)] = torch.tensor(a)
            lab[k, : len(b)] = torch.tensor(b)
            att[k, : len(a)] = 1
        yield ids, lab, att


@torch.no_grad()
def evaluate(model, rows, size, pad_id, device) -> float:
    model.eval()
    total, count = 0.0, 0
    for ids, lab, att in batches(rows, size, pad_id, False, None):
        out = model(input_ids=ids.to(device), attention_mask=att.to(device), labels=lab.to(device))
        n = int((lab != -100).sum())
        total += out.loss.item() * n
        count += n
    model.train()
    return total / max(count, 1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="Qwen/Qwen2.5-0.5B-Instruct")
    ap.add_argument("--data", default="finetune/data")
    ap.add_argument("--out", default="finetune/out/qwen05b")
    ap.add_argument("--epochs", type=float, default=2)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--accum", type=int, default=2)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--max-len", type=int, default=384)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()

    torch.manual_seed(a.seed)
    rng = random.Random(a.seed)
    device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
    tok = AutoTokenizer.from_pretrained(a.base)
    pad_id = tok.pad_token_id if tok.pad_token_id is not None else tok.eos_token_id
    model = AutoModelForCausalLM.from_pretrained(a.base, torch_dtype=torch.float32).to(device)
    model = get_peft_model(
        model,
        LoraConfig(
            r=a.rank,
            lora_alpha=2 * a.rank,
            lora_dropout=0.05,
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
            task_type="CAUSAL_LM",
        ),
    )
    model.print_trainable_parameters()

    data = Path(a.data)
    train = [encode(tok, m, a.max_len) for m in load(data / "train.jsonl")]
    valid = [encode(tok, m, a.max_len) for m in load(data / "valid.jsonl")]
    steps_per_epoch = math.ceil(len(train) / a.batch / a.accum)
    total = int(steps_per_epoch * a.epochs)
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=a.lr, weight_decay=0.0)
    warmup = max(1, total // 20)
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: min(1.0, (s + 1) / warmup) * 0.5 * (1 + math.cos(math.pi * min(s, total) / total))
    )

    print(f"device={device} train={len(train)} valid={len(valid)} steps={total}")
    print(f"step 0 valid_loss={evaluate(model, valid, a.batch, pad_id, device):.4f}", flush=True)
    step, micro, t0 = 0, 0, time.time()
    log: list[dict] = []
    while step < total:
        for ids, lab, att in batches(train, a.batch, pad_id, True, rng):
            loss = model(input_ids=ids.to(device), attention_mask=att.to(device), labels=lab.to(device)).loss / a.accum
            loss.backward()
            micro += 1
            if micro % a.accum:
                continue
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            opt.zero_grad()
            step += 1
            if step % 25 == 0 or step == total:
                entry = {"step": step, "train_loss": round(loss.item() * a.accum, 4), "elapsed_s": round(time.time() - t0)}
                if step % 100 == 0 or step == total:
                    entry["valid_loss"] = round(evaluate(model, valid, a.batch, pad_id, device), 4)
                log.append(entry)
                print(json.dumps(entry), flush=True)
            if step >= total:
                break

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    merged = model.merge_and_unload()
    merged.save_pretrained(out, safe_serialization=True)
    tok.save_pretrained(out)
    (out / "train_log.json").write_text(json.dumps({"args": vars(a), "log": log}, indent=2))
    print(f"saved merged model to {out} in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
