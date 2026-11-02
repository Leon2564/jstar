/**
 * The pilot's synthesizer (#73): the Worker's own adapters (infra/cloudflare/src/tts.ts), run on this Mac against the
 * vendors, so the pilot measures exactly the requests production sends.
 *
 *     npx tsx tools/voice/tts_synth.ts JOBS.jsonl OUT_DIR      (keys in the environment, as for the Worker)
 *
 * A job is `{id, provider, voiceId, text, lang}`. Each take goes to OUT_DIR/<id>.wav and one JSON line per job is
 * printed: `{id, ok, seconds, headersMs, ttfbMs, totalMs, bytes, error?}` — headersMs when the vendor answered, ttfbMs
 * when the first bytes of audio arrived, totalMs when the whole sentence was in. Jobs run one after another, as a
 * sentence queue does. Her text is never printed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitSentences } from '@jstar/shared/voice';
import { TTS_ADAPTERS, keyFor, type TtsEnv } from '../../infra/cloudflare/src/tts';

/** `split`: as production, one request per sentence (splitSentences, `minLen` its merge threshold), audio joined. */
type Job = { id: string; provider: keyof typeof TTS_ADAPTERS; voiceId: string; text: string; lang: string; split?: boolean; minLen?: number };

async function main() {
  const [jobsFile, outDir] = process.argv.slice(2);
  if (!jobsFile || !outDir) throw new Error('usage: tts_synth.ts JOBS.jsonl OUT_DIR');
  mkdirSync(outDir, { recursive: true });
  const env = process.env as TtsEnv;
  const jobs = readFileSync(jobsFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Job);
  for (const job of jobs) {
    const adapter = TTS_ADAPTERS[job.provider];
    const apiKey = keyFor(env, job.provider);
    if (!adapter || !apiKey) {
      console.log(JSON.stringify({ id: job.id, ok: false, error: adapter ? 'no key' : 'no adapter' }));
      continue;
    }
    const t0 = performance.now();
    // headersMs: the vendor answered; ttfbMs: the first bytes of its body (the first audio piece) arrived.
    let headers: number | null = null;
    let ttfb: number | null = null;
    const timed = (async (...args: Parameters<typeof fetch>) => {
      const res = await fetch(...args);
      if (headers !== null || !res.body) return res;
      headers = performance.now() - t0;
      const body = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) { if (ttfb === null && chunk.byteLength) ttfb = performance.now() - t0; ctl.enqueue(chunk); }
      }));
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    }) as typeof fetch;
    try {
      const parts = job.split ? splitSentences(job.text, undefined, job.minLen).map((p) => p.trim()) : [job.text];
      const outs = [];
      for (const part of parts) outs.push(await adapter({ voiceId: job.voiceId, text: part, lang: job.lang, apiKey, fetch: timed, env }));
      // MP3 frames (and one WAV's PCM) join end to end; the pilot only plays MP3 joins.
      const out = { audio: Buffer.concat(outs.map((o) => Buffer.from(o.audio))), seconds: outs.reduce((n, o) => n + o.seconds, 0), sentences: parts.length };
      const totalMs = performance.now() - t0;
      writeFileSync(join(outDir, `${job.id}.wav`), out.audio);
      console.log(JSON.stringify({ id: job.id, ok: true, seconds: out.seconds, headersMs: Math.round(headers ?? totalMs), ttfbMs: Math.round(ttfb ?? totalMs), totalMs: Math.round(totalMs), bytes: out.audio.byteLength, sentences: out.sentences }));
    } catch (e) {
      console.log(JSON.stringify({ id: job.id, ok: false, totalMs: Math.round(performance.now() - t0), error: e instanceof Error ? e.message : 'failed' }));
    }
  }
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
