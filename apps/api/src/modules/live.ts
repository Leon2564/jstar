import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../env';
import { requireDevice } from '../app';
import { createViduGateway, LIVE_STARS } from '../lib/vidu';

const Start = z.object({
  star: z.enum(LIVE_STARS),
  lang: z.enum(['ja', 'zh-Hant', 'en', 'ko']).default('zh-Hant'),
  layout: z.enum(['desktop', 'mobile']).default('mobile')
});
const Text = z.object({ text: z.string().trim().min(1).max(300) });
const Events = z.object({
  after: z.coerce.number().int().min(0).default(0),
  lang: z.enum(['ja', 'zh-Hant', 'en', 'ko']).default('ja')
});

export const registerLive: FastifyPluginAsync = async (app) => {
  const gateway = createViduGateway(env);
  const translations = new Map<string, Promise<string | null>>();
  const retryAt = new Map<string, number>();

  const translated = async (star: typeof LIVE_STARS[number], liveId: string, seq: number, text: string, lang: z.infer<typeof Events>['lang']) => {
    if (lang === 'ja') return text;
    const restate = app.her?.restate;
    if (!restate) return text;
    const key = `${liveId}|${seq}|${lang}`;
    if ((retryAt.get(key) ?? 0) > Date.now()) return null;
    let pending = translations.get(key);
    if (!pending) {
      pending = restate({ star, lang, text }).catch(() => null);
      translations.set(key, pending);
    }
    const value = await pending;
    if (!value) {
      translations.delete(key);
      retryAt.set(key, Date.now() + 2_000);
      return text;
    }
    return value;
  };

  app.post('/session', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { star, layout } = Start.parse(req.body);
    const session = await gateway.start(requireDevice(req), star, 'ja', layout);
    if (!session) return reply.status(503).send({ error: 'vidu_not_configured' });
    return session;
  });

  app.post('/:id/message', async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(80) }).parse(req.params);
    const { text } = Text.parse(req.body);
    if (!gateway.message(id, requireDevice(req), text)) return reply.status(404).send({ error: 'live_not_found' });
    return { ok: true };
  });

  app.get('/:id/events', async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(80) }).parse(req.params);
    const { after, lang } = Events.parse(req.query);
    const device = requireDevice(req);
    const star = gateway.star(id, device);
    if (!star) return reply.status(404).send({ error: 'live_not_found' });
    const source = gateway.events(id, device, after);
    const events = await Promise.all(source.map(async (event) => {
      const text = await translated(star, id, event.seq, event.text, lang);
      return text ? { seq: event.seq, text, spoken: event.text } : null;
    }));
    return { events: events.filter((event): event is NonNullable<typeof event> => Boolean(event)) };
  });

  app.post('/:id/end', async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(80) }).parse(req.params);
    const ok = gateway.end(id, requireDevice(req));
    for (const key of translations.keys()) if (key.startsWith(`${id}|`)) translations.delete(key);
    for (const key of retryAt.keys()) if (key.startsWith(`${id}|`)) retryAt.delete(key);
    return { ok };
  });
};
