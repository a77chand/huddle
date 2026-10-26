jest.mock('@fugood/react-native-audio-pcm-stream', () => ({ init: jest.fn(), start: jest.fn(), stop: jest.fn(), on: jest.fn() }));
import { SAMPLE_RATE, wav } from '../src/lib/recorder';

test('voice notes are valid 16 kHz mono 16-bit WAV, which is what Whisper needs', () => {
  const pcm = new Uint8Array(SAMPLE_RATE * 2); // one second
  const out = wav(pcm);
  const v = new DataView(out.buffer);
  const str = (o: number, n: number) => String.fromCharCode(...out.slice(o, o + n));
  expect(str(0, 4)).toBe('RIFF');
  expect(str(8, 4)).toBe('WAVE');
  expect(str(36, 4)).toBe('data');
  expect(v.getUint32(4, true)).toBe(36 + pcm.length);
  expect(v.getUint16(20, true)).toBe(1); // PCM
  expect(v.getUint16(22, true)).toBe(1); // mono
  expect(v.getUint32(24, true)).toBe(16_000);
  expect(v.getUint16(34, true)).toBe(16); // bits
  expect(v.getUint32(40, true)).toBe(pcm.length);
  expect(out.length).toBe(44 + pcm.length);
});
