# huddle-extractor-0.5b

A 0.5B-parameter model that turns a short voice-note transcript from someone on a night out into the facts their friends can act on, with every field quoted from the speaker's words. It's small enough to run on a phone with llama.cpp.

| | |
|---|---|
| Base model | [Qwen/Qwen2.5-0.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) (Apache-2.0) |
| Method | LoRA (rank 16, all attention + MLP projections, 8.8M trainable params, 1.8%), loss on the JSON answer only, merged into the base weights |
| Training | 200 steps × batch 8 on Apple Silicon with MLX ([config](mlx_lora.yaml)); validation loss 0.86 → 0.008 |
| Data | 4,000 synthetic notes from [`generate.py`](generate.py) (+300 validation): English, Spanish, French, Portuguese and Hindi-English, speech-to-text-style noise, negations, distractors, empty notes |
| Files | `huddle-extractor-0.5b-q4_k_m.gguf` (398 MB, phone default) · `huddle-extractor-0.5b-q8_0.gguf` (531 MB) |
| License | Apache-2.0 |

## Output

```json
{"stated_location": {"said": true, "value": "near the north entrance", "quote": "I'm near the north entrance"},
 "requested_action": {"said": true, "value": "call me", "quote": "please call me"},
 "avoid": {"said": true, "value": "come inside", "quote": "don't come inside"},
 "condition": {"said": false, "value": "", "quote": ""},
 "contact_preference": {"said": true, "value": "phone call", "quote": "please call me"}}
```

Huddle always applies a **grounding check** afterwards: a field survives only if its quote appears in the transcript.

## Evaluation

The **held-out test set** ([`evals/test_notes.jsonl`](../evals/test_notes.jsonl), 40 hand-written notes) was written before the training-data generator and never used to tune it. Scores are field-level accuracy over 5 fields × 40 notes, after grounding.

| Extractor | Size | Held-out test | Dev (20 notes) | Speed on laptop* |
|---|---|---|---|---|
| Rules baseline | — | 68.0% | 77.0% | instant |
| Gemma 3 4B, few-shot prompt | 3.3 GB | 82.5% | 88.0% | 11.0 s/note |
| **huddle-extractor-0.5b Q8_0** | **531 MB** | **84.5%** | 83.0% | 1.9 s/note |
| **huddle-extractor-0.5b Q4_K_M** | **398 MB** | **83.5%** | 81.0% | 1.6 s/note |

\*Ollama on an Apple M-series laptop while other work was running, including HTTP overhead. Phone numbers will come from field testing.

**Findings worth knowing**

- At about 1/8 the download size of Gemma 3 4B, it scores within noise of it on unseen notes.
- **Constrained decoding is fine *if the engine keeps the key order*.** Through Ollama it scored 78% instead of 83.5%, because Ollama's schema-to-grammar step sorted this imported model's keys alphabetically. That made it write `quote` before `said` and `value`, so it had to copy a quote before deciding anything was said. On llama.cpp, which keeps schema order, constrained and unconstrained both scored 83.5%, and forcing alphabetical order reproduced the 78%. Gemma 3 4B is hit even harder by the same reordering: 84.0% falls to 62.5%, with 40 invented fields. If you serve it through Ollama, set `LLM_CONSTRAIN=0`. The AI service logs a warning when it sees reordered keys.
- On llama.cpp with ggml-org's standard GGUF, Gemma 3 4B scores **84.0%** on the held-out set vs **83.5%** for this model (Q4): within noise, at about 1/6 the file size.
- 4-bit quantization cost little: f16 and Q8 scored the same through the same serving path.
- It fills more fields Gemma left empty (12 vs 6 on the test set), mostly a destination ("come to the cafe") read as the speaker's location. Grounding means each one still quotes the speaker's real words.
- Scores include the **value check**: a value may only contain words from its quote. Gemma paraphrases more (10 of its values were replaced by their quotes, half of them English translations of non-English notes), so it scores 1.5 points lower than without the check. The fine-tune had 4 replaced.

Reproduce:

```bash
ollama create huddle-extractor:0.5b-q4 -f Modelfile     # FROM ./huddle-extractor-0.5b-q4_k_m.gguf, ChatML template
LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=huddle-extractor:0.5b-q4 LLM_PROMPT=finetuned LLM_CONSTRAIN=0 \
  python -m evals.run_eval --set test -v
```

## Limitations

- **Synthetic training data.** The phrase banks don't cover real slang, heavy accents' transcription errors, or every language. Real (consented) recordings from noisy venues are the most valuable next step.
- **The test set is small** (200 field decisions) and written by one person, so differences of a point or two are noise.
- **It extracts; it doesn't judge.** It never decides whether someone is in danger, and Huddle never asks it to.
