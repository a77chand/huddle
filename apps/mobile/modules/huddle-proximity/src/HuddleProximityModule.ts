import { NativeModule, requireOptionalNativeModule } from 'expo';

import type { HuddleProximityModuleEvents, ProximityState } from './HuddleProximity.types';

declare class HuddleProximityModule extends NativeModule<HuddleProximityModuleEvents> {
  /** Scan for `scanMs` out of every `periodMs` (bursts save battery). */
  start(service: string, token: string, scanMs: number, periodMs: number): Promise<void>;
  setToken(token: string): void;
  stop(): void;
  state(): ProximityState;
}

/** null in Expo Go and on web, where the native module isn't built in. */
export default requireOptionalNativeModule<HuddleProximityModule>('HuddleProximity');
