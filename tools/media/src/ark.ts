/**
 * Minimal client for BytePlus ModelArk video generation (Seedance).
 * Create a task, poll it, read `content.video_url` (a signed URL valid for 24 h).
 * `fetch` is injectable so the request shapes are unit-tested without spending credits.
 */
export const ARK_BASE = 'https://ark.ap-southeast.bytepluses.com/api/v3';

/** 'adaptive': the output follows the first-frame image (required whenever a first frame is sent). */
export type Ratio = '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9' | 'adaptive';
export type Resolution = '480p' | '720p' | '1080p';
export type ImageRole = 'first_frame' | 'last_frame' | 'reference_image';

export interface GenerationRequest {
  model: string;
  prompt: string;
  ratio: Ratio;
  duration: number;
  resolution: Resolution;
  seed?: number;
  /** Seedance 2.5 draft: a cheap low-resolution preview of the same task. */
  draft?: boolean;
  /** data: URLs or https URLs. */
  images?: { url: string; role: ImageRole }[];
}

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
export interface Task {
  id: string;
  status: TaskStatus;
  seed?: number;
  content?: { video_url?: string; last_frame_url?: string };
  usage?: { completion_tokens?: number; total_tokens?: number };
  error?: { code?: string; message?: string };
}

export class ArkError extends Error {
  constructor(message: string, public status: number, public body: string) { super(message); }
}

type Fetch = typeof fetch;

export function buildBody(req: GenerationRequest): Record<string, unknown> {
  if (!req.prompt.trim()) throw new Error('empty prompt');
  const content: Record<string, unknown>[] = [{ type: 'text', text: req.prompt.trim() }];
  for (const img of req.images ?? []) content.push({ type: 'image_url', image_url: { url: img.url }, role: img.role });
  return {
    model: req.model,
    content,
    ratio: req.ratio,
    duration: req.duration,
    resolution: req.resolution,
    // Background loops are silent; a watermark would sit on every frame of the site.
    generate_audio: false,
    watermark: false,
    ...(req.seed !== undefined ? { seed: req.seed } : {}),
    ...(req.draft ? { draft: true } : {})
  };
}

export function createClient(apiKey: string, f: Fetch = fetch, base = ARK_BASE) {
  if (!apiKey) throw new Error('ARK_API_KEY is not set (see .env.seedance)');
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await f(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...(init.headers ?? {}) }
    });
    const text = await res.text();
    if (!res.ok) throw new ArkError(`ark ${res.status} on ${path}`, res.status, text.slice(0, 500));
    return JSON.parse(text) as unknown;
  };
  return {
    async create(req: GenerationRequest): Promise<string> {
      const r = (await call('/contents/generations/tasks', { method: 'POST', body: JSON.stringify(buildBody(req)) })) as { id?: string };
      if (!r.id) throw new Error('ark returned no task id');
      return r.id;
    },
    async get(id: string): Promise<Task> {
      return (await call(`/contents/generations/tasks/${encodeURIComponent(id)}`)) as Task;
    }
  };
}

export type ArkClient = ReturnType<typeof createClient>;

export const isDone = (s: TaskStatus) => s === 'succeeded' || s === 'failed' || s === 'cancelled' || s === 'expired';
