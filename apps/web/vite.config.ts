import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { compactMediaModule, coverSizes, heroFacesModule, parseMediaSource } from './src/data/mediaCompact';

// Content-Security-Policy is injected for the normal (hosted) build only.
// The single-file build inlines its script, so the hosting page supplies the policy instead.
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);

const CSP = [
  "default-src 'self'",
  // Cloudflare Web Analytics beacon and Turnstile (the Worker sends the same origins in its header policy).
  "script-src 'self' https://static.cloudflareinsights.com https://challenges.cloudflare.com https://g.alicdn.com",
  "frame-src https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' wss://*.workers.dev https://cloudflareinsights.com https://*.aliyuncs.com wss://*.aliyuncs.com https://*.aliyun.com wss://*.aliyun.com https://*.alicdn.com wss://*.alicdn.com https://*.alivecdn.com wss://*.alivecdn.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

function csp(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
    }
  };
}

/**
 * The home stage's first poster is its largest paint. Announce it at the top of the HTML (per orientation) so the
 * browser fetches it while the JS is still downloading, instead of after React renders. Mirrors heroEntry() in
 * src/data/heroMedia.ts for the first talent and HeroClip in src/pages/site.tsx: where motion is welcome she is first
 * seen in her entrance clip, so its posters are announced (A-M11: the HD loop's full poster, which only shows once the
 * entrance has ended, was fetched up front instead and took the slow-4G bandwidth her clip and sharp poster needed);
 * with reduced motion, the HD loop's. Her small poster first (painted at once, the LCP), then the full one, with the
 * stage's own srcset and sizes (coverSizes) so the file preloaded is the file the <img> picks.
 */
function preloadHero(): Plugin {
  return {
    name: 'preload-hero',
    transformIndexHtml(html) {
      const file = resolve(__dirname, 'src/data/media.gen.ts');
      if (!existsSync(file)) return html.replace('<!--PRELOAD-->', '');
      const media = parseMediaSource(readFileSync(file, 'utf8'));
      const pick = (ids: string[]) => ids.map((id) => media[id]).find(Boolean);
      type E = { posters?: { src: string; width: number }[]; poster: string; ratio: string };
      const smallOf = (e: E) => (e.posters && e.posters.length > 1 ? e.posters.reduce((x, y) => (y.width < x.width ? y : x)).src : null);
      const link = (q: string, href: string, high: boolean, e?: E) =>
        `<link rel="preload" as="image" fetchpriority="${high ? 'high' : 'low'}" media="${q}" href="${href}"${e?.posters ? ` imagesrcset="${e.posters.map((p) => `${p.src} ${p.width}w`).join(', ')}" imagesizes="${coverSizes(e.ratio)}"` : ''}>`;
      const both = (q: string, e: E) => { const sm = smallOf(e); return sm ? [link(q, sm, true), link(q, e.poster, false, e)] : [link(q, e.poster, true, e)]; };
      const links = ([['portrait', '9x16', '16x9'], ['landscape', '16x9', '9x16']] as const)
        .flatMap(([o, a, b]) => {
          const hero = pick([`mahiro-herohd-${a}`, `mahiro-hero-${a}`, `mahiro-night-${a}`, `mahiro-herohd-${b}`, `mahiro-hero-${b}`, `mahiro-night-${b}`]);
          if (!hero) return [];
          const enter = pick([`mahiro-enter-${a}`, `mahiro-enter-${b}`]);
          const q = `(orientation: ${o})`;
          return enter ? [...both(`${q} and (prefers-reduced-motion: no-preference)`, enter), ...both(`${q} and (prefers-reduced-motion: reduce)`, hero)] : both(q, hero);
        })
        .join('\n');
      return html.replace('<!--PRELOAD-->', links);
    }
  };
}

/** The face map, cut down to the clips the home stage plays (src/data/mediaCompact.ts). */
function heroFaces(): Plugin {
  const ID = 'virtual:hero-faces';
  return {
    name: 'hero-faces',
    resolveId: (id) => (id === ID ? `\0${ID}` : null),
    load(id) {
      if (id !== `\0${ID}`) return null;
      const file = resolve(__dirname, 'src/data/faces.gen.json');
      this.addWatchFile(file);
      return heroFacesModule(existsSync(file) ? readFileSync(file, 'utf8') : '{}');
    }
  };
}

/** The media catalogue ships compact in the build (same object at runtime; tests/unit/mediaCompact.test.ts). */
function compactMedia(): Plugin {
  return {
    name: 'compact-media',
    apply: 'build',
    enforce: 'pre',
    transform: (code, id) => (id.endsWith('/src/data/media.gen.ts') ? { code: compactMediaModule(code), map: null } : null)
  };
}

export default defineConfig(({ mode }) => ({
  // A fixed port: the API's CORS allow-list (PUBLIC_WEB_ORIGIN) expects the web app here.
  server: {
    port: 5173,
    strictPort: true,
    allowedHosts: ['.trycloudflare.com'],
    // Large static video assets are served as-is. Watching them on Windows can
    // fail with EBUSY while Git LFS, the browser, or an encoder has the file open.
    watch: {
      ignored: ['**/public/media/**', '**/public/cards/**']
    },
    proxy: {
      '/v1/agent/chat': {
        target: process.env.VITE_AGENT_PROXY_TARGET || 'https://jstar-leon.lionellong.workers.dev',
        changeOrigin: true
      },
      // Local and tunnel previews keep the API on the page's HTTPS origin. The private API port is never exposed.
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '')
      }
    }
  },
  plugins: mode === 'single' ? [react(), heroFaces(), compactMedia(), viteSingleFile()] : [react(), heroFaces(), compactMedia(), csp(), preloadHero()],
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    target: 'es2020',
    sourcemap: false
  },
  test: {
    environment: 'jsdom',
    // Node 22+ ships its own localStorage global, which shadows jsdom's and lacks clear(); turn it off in the workers.
    poolOptions: { forks: { execArgv: NODE_MAJOR >= 22 ? ['--no-experimental-webstorage'] : [] } },
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    // Waits for a lazy screen get 8 s (tests/unit/setup.ts); a test that makes a few of them needs room for them.
    setupFiles: ['tests/unit/setup.ts'],
    testTimeout: 20_000
  }
}));
