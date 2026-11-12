/** Portable clock identity and observed instants; reading the clock belongs to the Host. */
export interface TraceClock {
  domain: string;
  monotonicNs: string;
  wallTime: string;
}
