import { configure } from '@testing-library/react';

// Every screen is a lazy chunk (src/App.tsx), so the first screen a test file opens waits for its chunk to load and
// run. On a loaded machine (CI, the three packages' suites at once) that alone can take longer than the library's
// 1 s default, and the test failed on the wait rather than on what it checks. Waits give up after 8 s instead (a wait
// that finds its element returns at once, so a passing suite is no slower); a test's own budget is raised to match
// (vite.config.ts `testTimeout`).
configure({ asyncUtilTimeout: 8000 });

// N-61: the web fetches the scene catalogue as a JSON asset; jsdom has no server for it, so unit tests read the same
// JSON from disk through the loader's test seam (tests of the loader itself replace it again).
import { setSceneLoader } from '../../src/data/media';
setSceneLoader(async () => (await import('../../src/data/media.scene.gen.json')).default as never);

// QA #5: her touch lines are a JSON asset too (lib/touchLines.ts): read from disk here.
import { setTouchLoader } from '../../src/lib/touchLines';
setTouchLoader(async () => (await import('@jstar/shared/touch.json')).default as never);
