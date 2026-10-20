// The package ships its types under another module name.
declare module '@fugood/react-native-audio-pcm-stream' {
  const LiveAudioStream: {
    init(options: { sampleRate: number; channels: number; bitsPerSample: number; audioSource?: number; bufferSize?: number; wavFile: string }): void;
    start(): void;
    stop(): Promise<string>;
    on(event: 'data', callback: (base64Pcm: string) => void): void;
  };
  export default LiveAudioStream;
}
