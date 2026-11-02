// Regenerates infra/cloudflare/src/hans.ts: Traditional → Simplified Chinese, one code point to one code point, from
// ICU's CLDR `Hant-Hans` transliterator (macOS Foundation). Only BMP → BMP pairs (rare extension-B targets dropped).
//
//     swift tools/voice/t2s.swift > infra/cloudflare/src/hans.ts
import Foundation

var pairs: [(String, String)] = []
for range in [0x3400...0x4DBF, 0x4E00...0x9FFF, 0xF900...0xFAFF] as [ClosedRange<UInt32>] {
  for cp in range {
    guard let sc = Unicode.Scalar(cp) else { continue }
    let s = String(Character(sc))
    guard let t = s.applyingTransform(StringTransform("Hant-Hans"), reverse: false), t != s,
          t.unicodeScalars.count == 1, t.unicodeScalars.first!.value < 0x10000 else { continue }
    pairs.append((s, t))
  }
}
let table = pairs.map { $0.0 + $0.1 }.joined()
print("""
/**
 * Traditional → Simplified Chinese, character by character, for what a TTS vendor reads (never what he sees): her
 * zh-Hant lines are Mandarin, and a vendor that reads Simplified better gets them converted (tts.ts HANT_AS_HANS).
 * Also the pilot's CER normalisation (tools/voice/pilot.py reads TABLE from this file).
 *
 * Generated from ICU's CLDR `Hant-Hans` transliterator (\(pairs.count) pairs, BMP only) by
 * `swift tools/voice/t2s.swift > infra/cloudflare/src/hans.ts`; regenerate rather than edit.
 */
export const TABLE =
  '\(table)';

let map: Map<string, string> | null = null;
export function toSimplified(text: string): string {
  if (!map) { map = new Map(); for (let i = 0; i + 1 < TABLE.length; i += 2) map.set(TABLE[i], TABLE[i + 1]); }
  let out = '';
  for (const ch of text) out += map.get(ch) ?? ch;
  return out;
}
""")
