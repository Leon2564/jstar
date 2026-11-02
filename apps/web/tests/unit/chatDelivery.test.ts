import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSendResT } from '@jstar/shared/contracts';
import { initialState } from '../../src/lib/state';

const transport = vi.hoisted(() => ({
  chat: vi.fn(),
  chatStream: vi.fn()
}));

vi.mock('../../src/services/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/http')>()),
  serverMode: () => true,
  http: {
    ...(await importOriginal<typeof import('../../src/services/http')>()).http,
    chat: transport.chat,
    chatStream: transport.chatStream
  }
}));

import { chat } from '../../src/services/api';

describe('reliable room chat delivery', () => {
  beforeEach(() => {
    transport.chat.mockReset();
    transport.chatStream.mockReset();
  });

  it('uses one complete server request and progressively displays the accepted reply', async () => {
    const result: ChatSendResT = {
      reply: '你好呀～今天也来找我了呢', affinityXp: 1, level: 1, memoryCard: null,
      trialMessagesLeft: null, chatLeft: 4, freePulls: 0
    };
    transport.chat.mockResolvedValue(result);
    const shown: string[] = [];

    await expect(chat(initialState(), 'eimi', '你好', 'zh-Hant', (text) => shown.push(text), true)).resolves.toBe(result);

    expect(transport.chat).toHaveBeenCalledOnce();
    expect(transport.chat).toHaveBeenCalledWith('eimi', '你好', 'zh-Hant', true);
    expect(transport.chatStream).not.toHaveBeenCalled();
    expect(shown.at(-1)).toBe(result.reply);
  });
});
