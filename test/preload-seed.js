// Loaded with `node --import` into the processes the smoke test starts, so the mock car drives the same laps every run.
import { seedRandom } from './helpers.js';

seedRandom(Number(process.env.PADDOCK_TEST_SEED) || 1);
