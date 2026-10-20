import { Directory, File, Paths } from 'expo-file-system';
import { initLlama, type LlamaContext } from 'llama.rn';
import { initWhisper, type WhisperContext } from 'whisper.rn/index';

/**
 * On-device voice notes: Whisper (whisper.cpp) transcribes and Huddle's
 * fine-tuned 0.5B extractor (llama.cpp) structures the note, so the audio never
 * leaves the phone and it works with no connection. The server re-checks the
 * card's quotes either way.
 */

export interface ModelSpec {
  id: 'whisper' | 'extractor';
  label: string;
  url: string;
  file: string;
  /** Approximate size, for the download button and a sanity check on completion. */
  bytes: number;
}

export const EXTRACTOR_NAME = 'huddle-extractor-0.5b';

export const MODELS: ModelSpec[] = [
  {
    id: 'whisper',
    label: 'Speech-to-text (Whisper base, multilingual)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin',
    file: 'ggml-base-q5_1.bin',
    bytes: 59_707_625,
  },
  {
    id: 'extractor',
    label: 'Alert-card model (Huddle fine-tune, 0.5B)',
    url: `https://github.com/a77chand/huddle/releases/download/extractor-v1/${EXTRACTOR_NAME}-q4_k_m.gguf`,
    file: `${EXTRACTOR_NAME}-q4_k_m.gguf`,
    bytes: 397_808_096,
  },
];

const SYSTEM =
  'Extract what the speaker explicitly says in this voice note for their friends. ' +
  'Fields: stated_location, requested_action, avoid, condition, contact_preference. ' +
  'quote must be copied word-for-word from the note. Unsaid fields: said=false. Reply with JSON only.';


const dir = () => new Directory(Paths.document, 'models');
const fileFor = (m: ModelSpec) => new File(dir(), m.file);

/** A model counts as installed only if it's (nearly) the expected size — catches partial downloads. */
export function installed(m: ModelSpec): boolean {
  const f = fileFor(m);
  return f.exists && f.size > m.bytes * 0.98;
}

export const allInstalled = () => MODELS.every(installed);

export async function download(onProgress: (fraction: number) => void): Promise<void> {
  const d = dir();
  if (!d.exists) d.create({ intermediates: true });
  const missing = MODELS.filter((m) => !installed(m));
  const total = missing.reduce((n, m) => n + m.bytes, 0);
  let done = 0;
  for (const m of missing) {
    const dest = fileFor(m);
    if (dest.exists) dest.delete();
    const task = File.createDownloadTask(m.url, dest, {
      onProgress: ({ bytesWritten }) => onProgress(Math.min(1, (done + bytesWritten) / total)),
    });
    await task.downloadAsync();
    if (!installed(m)) {
      dest.delete();
      throw new Error(`${m.label} did not download completely`);
    }
    done += m.bytes;
  }
  onProgress(1);
}

export async function removeModels() {
  await release();
  const d = dir();
  if (d.exists) d.delete();
}

let whisper: WhisperContext | null = null;
let llama: LlamaContext | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

/** Free the models' memory a while after the last voice note. */
export async function release() {
  clearTimeout(idleTimer);
  const [w, l] = [whisper, llama];
  whisper = null;
  llama = null;
  await Promise.all([w?.release(), l?.release()]);
}

function keepWarm() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void release(), 3 * 60_000);
}

export interface OnDeviceResult {
  transcript: string;
  fields: Record<string, { said: boolean; value: string; quote: string }>;
  timings: { transcribeMs: number; extractMs: number };
}

/** Transcribe a 16 kHz WAV note and extract its fields, entirely on the phone. */
export async function processVoiceNote(wavUri: string): Promise<OnDeviceResult> {
  if (!allInstalled()) throw new Error('on-device models are not downloaded');
  const [wSpec, xSpec] = [MODELS[0]!, MODELS[1]!];
  whisper ??= await initWhisper({ filePath: fileFor(wSpec).uri, useGpu: true });
  const t0 = Date.now();
  const { promise } = whisper.transcribe(wavUri, { language: 'auto' });
  const transcript = (await promise).result.trim();
  const transcribeMs = Date.now() - t0;
  if (!transcript) {
    keepWarm();
    return { transcript: '', fields: {}, timings: { transcribeMs, extractMs: 0 } };
  }

  llama ??= await initLlama({ model: fileFor(xSpec).uri, n_ctx: 1024, n_gpu_layers: 99 });
  const t1 = Date.now();
  const out = await llama.completion({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: transcript },
    ],
    n_predict: 320,
    temperature: 0,
    // No grammar constraint: the fine-tune already emits the schema, and forcing tokens cost
    // ~5 points of accuracy in evals. Unparsable or unquoted output is dropped by grounding.
    stop: ['<|im_end|>', '<|endoftext|>'],
  });
  const extractMs = Date.now() - t1;
  keepWarm();
  let fields: OnDeviceResult['fields'] = {};
  try {
    fields = JSON.parse(out.text.slice(out.text.indexOf('{'), out.text.lastIndexOf('}') + 1));
  } catch {
    /* an unparsable answer just means no fields; the transcript still goes to friends */
  }
  return { transcript, fields, timings: { transcribeMs, extractMs } };
}
