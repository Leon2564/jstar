/**
 * Counts the audio in an MP3 stream as it passes (#73, streamed sentences): Layer III frames, samples per frame /
 * sample rate, across chunk boundaries. An ID3v2 tag in front is skipped; a Xing / Info header frame carries no sound.
 * Seconds of her voice are charged from this, never estimated.
 */
const KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

export class Mp3Meter {
  seconds = 0;
  frames = 0;
  bytes = 0;
  private pending = Buffer.alloc(0);
  private skip = 0;
  private started = false;

  push(chunk: Buffer): void {
    this.bytes += chunk.length;
    let b = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    if (this.skip) { const n = Math.min(this.skip, b.length); this.skip -= n; b = b.subarray(n); }
    let at = 0;
    if (!this.started) {
      if (b.length < 10) { this.pending = Buffer.from(b); return; }
      this.started = true;
      if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
        const tag = 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f));
        if (tag > b.length) { this.skip = tag - b.length; this.pending = Buffer.alloc(0); return; }
        at = tag;
      }
    }
    while (at + 4 <= b.length) {
      if (b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) { at++; continue; }
      const ver = (b[at + 1] >> 3) & 3, layer = (b[at + 1] >> 1) & 3, bri = b[at + 2] >> 4, sri = (b[at + 2] >> 2) & 3, pad = (b[at + 2] >> 1) & 1;
      const rate = RATES[ver]?.[sri];
      const kbps = (ver === 3 ? KBPS_V1 : KBPS_V2)[bri];
      if (ver === 1 || layer !== 1 || !rate || !kbps) { at++; continue; }
      const samples = ver === 3 ? 1152 : 576;
      const len = Math.floor(((samples / 8) * kbps * 1000) / rate) + pad;
      // Count a frame once its header and side info are in (enough to tell an Info frame); its body may still come.
      const side = ver === 3 ? ((b[at + 3] >> 6) === 3 ? 17 : 32) : ((b[at + 3] >> 6) === 3 ? 9 : 17);
      if (at + 8 + side > b.length) break;
      const tag = b.subarray(at + 4 + side, at + 8 + side).toString('latin1');
      if (!(this.frames === 0 && (tag === 'Xing' || tag === 'Info'))) this.seconds += samples / rate;
      this.frames++;
      if (at + len > b.length) { this.skip = at + len - b.length; at = b.length; break; }
      at += len;
    }
    this.pending = Buffer.from(b.subarray(at));
  }
}
