import type { PulseState } from "./PulseState";

export type PulseValue<T> = T & PulseState<T>;
