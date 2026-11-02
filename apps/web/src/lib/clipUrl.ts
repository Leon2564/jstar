/**
 * Her synthesized clip as a blob: URL. The page's CSP allows `media-src 'self' blob:`, not data:, so a data: URL
 * never plays (MediaError 4) while his minutes are still charged. One URL per clip, so the preloaded element is the
 * one that plays; revoked once it has played.
 */
const clipUrls = new WeakMap<object, string>();
export function clipUrl(clip: { audio: string; mime: string }): string {
  const known = clipUrls.get(clip);
  if (known) return known;
  // No object URLs (tests without a URL API): a data: URL, which only a real page's CSP would refuse.
  if (typeof URL.createObjectURL !== 'function') return `data:${clip.mime};base64,${clip.audio}`;
  const bin = atob(clip.audio);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: clip.mime }));
  clipUrls.set(clip, url);
  return url;
}
export function releaseClipUrl(clip: object): void {
  const url = clipUrls.get(clip);
  if (!url) return;
  clipUrls.delete(clip);
  if (url.startsWith('blob:')) URL.revokeObjectURL(url);
}
