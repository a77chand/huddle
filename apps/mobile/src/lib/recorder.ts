import LiveAudioStream from '@fugood/react-native-audio-pcm-stream';
import { File, Paths } from 'expo-file-system';
import { PermissionsAndroid, Platform } from 'react-native';

/**
 * Voice notes are captured as raw 16 kHz mono 16-bit PCM and saved as WAV:
 * exactly what Whisper wants, on the phone or on the server, with one code
 * path on both platforms.
 */
export const SAMPLE_RATE = 16_000;

let chunks: Uint8Array[] = [];
let startedAt = 0;
let initialised = false;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function wav(pcm: Uint8Array): Uint8Array {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  str(36, 'data');
  v.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

export async function micPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true; // iOS prompts on first use (NSMicrophoneUsageDescription)
  const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
  return r === PermissionsAndroid.RESULTS.GRANTED;
}

export function startRecording() {
  chunks = [];
  if (!initialised) {
    LiveAudioStream.init({ sampleRate: SAMPLE_RATE, channels: 1, bitsPerSample: 16, audioSource: 6, bufferSize: 4096, wavFile: '' });
    LiveAudioStream.on('data', (b64: string) => chunks.push(base64ToBytes(b64)));
    initialised = true;
  }
  startedAt = Date.now();
  LiveAudioStream.start();
}

/** Stop and write the note to a WAV file. Returns null if nothing was captured. */
export async function stopRecording(): Promise<{ uri: string; durationMs: number } | null> {
  await LiveAudioStream.stop();
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (total < SAMPLE_RATE / 2) return null; // under ~0.25 s
  const pcm = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    pcm.set(c, o);
    o += c.length;
  }
  chunks = [];
  const file = new File(Paths.cache, `voice-note-${Date.now()}.wav`);
  file.create({ overwrite: true });
  file.write(wav(pcm));
  return { uri: file.uri, durationMs: Date.now() - startedAt };
}
