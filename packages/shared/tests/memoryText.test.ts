import { describe, expect, it } from 'vitest';
import { memoryStillFor, memoryTitleIn, promiseTextIn } from '../src/memoryText';
import { LINES } from '../src/lines';

// N-25: every kind of memory card reads in the language of the moment; a promise card has a picture.
describe('memory cards in every language (N-25)', () => {
  const promise = LINES.mahiro.promises.find((l) => l.promise.ja === '明日の夜、おかえりを言う')!.promise;

  it('her written promise, her confession and a scene\'s memory: in the language of the moment', () => {
    expect(memoryTitleIn({ star: 'mahiro', kind: 'promise', title: '明日の夜、おかえりを言う' }, 'en')).toBe(promise.en);
    expect(memoryTitleIn({ star: 'mahiro', kind: 'promise', title: promise.en }, 'ko')).toBe(promise.ko);
    expect(memoryTitleIn({ star: 'mahiro', kind: 'confession', title: '告白', sceneId: 'confession-mahiro' }, 'en')).toBe('The confession');
    expect(memoryTitleIn({ star: 'mahiro', title: '告白', sceneId: 'confession-mahiro-again' }, 'ko')).toBe('고백');
    expect(memoryTitleIn({ star: 'mahiro', kind: 'scene', title: 'おかえりの夜', sceneId: 'demo-evening' }, 'en')).toBe('A Night Back Home');
  });

  it('words she promised in free chat, and a chat card, stay as they were said', () => {
    expect(memoryTitleIn({ star: 'mahiro', kind: 'promise', title: '夜9時、朗読を聞かせる' }, 'en')).toBe('夜9時、朗読を聞かせる');
    expect(memoryTitleIn({ star: 'mahiro', kind: 'chat', title: '寒い夜のおかえり' }, 'en')).toBe('寒い夜のおかえり');
    expect(promiseTextIn('mahiro', '夜9時、朗読を聞かせる', 'en')).toBe('夜9時、朗読を聞かせる');
  });

  it('a promise card\'s picture: its scene\'s opening shot, else her home poster', () => {
    expect(memoryStillFor({ star: 'mahiro', kind: 'promise', title: 'x', sceneId: 'demo-evening' })).toMatch(/^mahiro-/);
    expect(memoryStillFor({ star: 'nana', kind: 'promise', title: 'x' })).toBe('nana-hero');
  });
});

describe('memory cards keyed by their scene (N-34)', () => {
  it('system and variant scenes, whatever language the card was made in; older cards without their scene', () => {
    expect(memoryTitleIn({ star: 'mahiro', kind: 'scene', title: '一緒に祝った誕生日', sceneId: 'her-birthday-mahiro' }, 'ko')).toBe('함께 축하한 생일');
    expect(memoryTitleIn({ star: 'mahiro', kind: 'scene', title: 'The birthday she celebrated with you', sceneId: 'his-birthday-mahiro' }, 'ja')).toBe('祝ってもらった誕生日');
    expect(memoryTitleIn({ star: 'eimi', kind: 'scene', title: '新しい服と、キミの顔', sceneId: 'variant-eimi-1' }, 'en')).toBe('New Outfit, Your Face');
    expect(memoryTitleIn({ star: 'mahiro', title: 'おそろいのマグカップ' }, 'zh-Hant')).toBe('成對的馬克杯');
    expect(memoryTitleIn({ star: 'mahiro', title: '告白' }, 'en')).toBe('The confession');
    expect(memoryTitleIn({ star: 'mahiro', kind: 'chat', title: '寒い夜のおかえり' }, 'en')).toBe('寒い夜のおかえり');
  });

  it('a still this build does not have gives way to the scene\'s opening shot, then her home poster', () => {
    expect(memoryStillFor({ star: 'eimi', title: 'x', sceneId: 'variant-eimi-1', still: 'gone' }, (id) => id !== 'gone')).not.toBe('gone');
    expect(memoryStillFor({ star: 'nana', title: 'x', still: 'gone' }, (id) => id !== 'gone')).toBe('nana-hero');
  });
});
