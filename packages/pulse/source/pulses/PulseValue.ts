import type { BasePulse } from "./BasePulse";

export type PulseValue<T> = T & BasePulse<T>;
