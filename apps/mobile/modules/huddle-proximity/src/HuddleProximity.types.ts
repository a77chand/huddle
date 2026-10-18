export type ProximityState =
  | 'poweredOn'
  | 'poweredOff'
  | 'unauthorized'
  | 'unsupported'
  | 'unknown'
  | 'advertiseFailed'
  | 'scanFailed';

export type Sighting = {
  /** Uppercase UUID the other phone was broadcasting. */
  token: string;
  rssi: number;
  /** Epoch ms on this phone. */
  at: number;
};

export type HuddleProximityModuleEvents = {
  onSighting: (s: Sighting) => void;
  onState: (e: { state: ProximityState; code?: number }) => void;
};
