/** Writes the persona service's copy of the confirmed talent facts (see agentWorld in src/world.ts). */
import { writeFileSync } from 'node:fs';
import { agentWorldJson } from '../src/world';

const target = new URL('../../../apps/agent/app/world.json', import.meta.url);
writeFileSync(target, agentWorldJson());
console.log(`wrote ${target.pathname}`);
