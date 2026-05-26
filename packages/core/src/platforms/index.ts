import type { PlatformAdapter } from '../engine/types.js';
import { tempoPerceive } from './tempo/perceive.js';
import { tempoConstruct } from './tempo/strategies.js';
import { privyPerceive } from './privy/perceive.js';
import { privyConstruct } from './privy/strategies.js';
import { coinbasePerceive } from './coinbase/perceive.js';
import { coinbaseConstruct } from './coinbase/strategies.js';
import { circleAdapter } from './circle/strategies.js';
import { genericPerceive } from './generic/perceive.js';
import { genericConstruct } from './generic/strategies.js';
import { stripePerceive } from './stripe/perceive.js';
import { stripeConstruct } from './stripe/strategies.js';

export const tempoAdapter: PlatformAdapter = { name: 'tempo', perceive: tempoPerceive, construct: tempoConstruct };
export const privyAdapter: PlatformAdapter = { name: 'privy', perceive: privyPerceive, construct: privyConstruct };
export const coinbaseAdapter: PlatformAdapter = { name: 'coinbase', perceive: coinbasePerceive, construct: coinbaseConstruct };
export const genericAdapter: PlatformAdapter = { name: 'generic', perceive: genericPerceive, construct: genericConstruct };
export const stripeAdapter: PlatformAdapter = { name: 'stripe', perceive: stripePerceive, construct: stripeConstruct };
export { circleAdapter };

// Default adapter chain: Circle first (most-specific URL + numeric-code fingerprint
// — needed so axios 429 errors from Circle aren't claimed by privy's generic /429/ catch),
// then Tempo → Privy → Coinbase → Stripe → Generic (fallback).
export const defaultAdapters: PlatformAdapter[] = [
  circleAdapter,
  tempoAdapter,
  privyAdapter,
  coinbaseAdapter,
  stripeAdapter,
  genericAdapter,
];
