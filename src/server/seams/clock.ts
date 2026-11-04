// The clock seam. Everything time-dependent (expiries, nonces, budget periods)
// reads the current instant through a Clock rather than calling Date.now()
// directly, so tests can freeze time by injecting a fixed clock.

export interface Clock {
  now(): Date;
}

// The real clock: reports wall-clock time.
export const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
};

// A frozen clock: every now() returns the same injected instant.
export function fixedClock(instant: Date): Clock {
  const frozen = instant.getTime();
  return {
    now(): Date {
      return new Date(frozen);
    },
  };
}
