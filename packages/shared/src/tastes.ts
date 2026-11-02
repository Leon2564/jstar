import { STAR_IDS, localText, type LocalText, type StarId } from './domain';
import { GIFT_RULES } from './rules';
import { GIFTS, giftById, type GiftId, type GiftTaste } from './gifts';

/**
 * Her tastes (#77, docs/requirements.md §14.3): which gifts each talent likes and dislikes, the words that give a taste
 * away when she mentions it, and her own line for each kind of gift. PROVISIONAL — taken from the persona bibles'
 * `likes` / `dislikes` (apps/agent/app/personas), which the agency has not signed off yet (#84).
 *
 * The server reads this; the web's entry bundle never does (it would give her secrets away): prototype mode loads it
 * lazily. Kept free of zod.
 */
export interface Taste { likes: readonly GiftId[]; dislikes: readonly GiftId[] }

export const TASTES: Record<StarId, Taste> = {
  // 夜の散歩, あったかい飲みもの, 猫, 甘いパン; dislikes 朝早いこと.
  mahiro: { likes: ['melonpan', 'cocoa', 'cat-plush'], dislikes: ['alarm'] },
  // カラオケ, 焼肉, 夏フェス.
  nana: { likes: ['yakiniku', 'karaoke-mic', 'fes-towel'], dislikes: [] },
  // ゲーム, 深夜のコンビニおやつ, ぬくぬくの毛布; dislikes 早起き.
  unpai: { likes: ['new-game', 'konbini-sweets', 'blanket'], dislikes: ['alarm'] },
  // 紅茶, 本屋さん, 手紙, 花; dislikes 大きな音 (an alarm clock's ring).
  alice: { likes: ['tea-leaves', 'paperback', 'letter-set', 'bouquet'], dislikes: ['alarm'] },
  // おしゃれ, 旅行, 夜景.
  eimi: { likes: ['lipstick', 'travel-guide', 'night-view'], dislikes: [] }
};

export function tasteOf(star: StarId, giftId: GiftId): GiftTaste {
  const t = TASTES[star];
  return t.likes.includes(giftId) ? 'liked' : t.dislikes.includes(giftId) ? 'disliked' : 'plain';
}

/** Her affinity XP for a gift: its price in XP, times her taste (GIFT_RULES; liked is exactly twice plain). */
export function giftXp(giftId: GiftId, taste: GiftTaste): number {
  const base = Math.round(GIFT_RULES.prices[giftId] * GIFT_RULES.xpPerPoint);
  return Math.max(1, Math.floor(base * GIFT_RULES.taste[taste]));
}

/** The XP her variant gets while she wears it (#75): the gift's XP times VARIANT_RULES.giftMultiplier's range. */
export function variantGiftXp(xp: number, taste: GiftTaste, wished: boolean): number {
  return xp * GIFT_RULES.variantMultiplier[wished && taste === 'liked' ? 'wished' : taste];
}

/**
 * Words that give a liked gift away when she says them, in any language she speaks. Latin words match as whole words
 * (case-insensitive, plural allowed); Japanese and Chinese words as they appear.
 */
export const GIFT_WORDS: Partial<Record<GiftId, readonly string[]>> = {
  melonpan: ['メロンパン', '甘いパン', '菠蘿麵包', '甜麵包', 'melon bread', 'melonpan', 'sweet bread'],
  cocoa: ['ココア', 'あったかい飲み', '可可', '熱飲', 'cocoa', 'hot drink'],
  'cat-plush': ['猫', 'ねこ', 'ネコ', '貓', 'cat', 'kitty', 'kitten'],
  yakiniku: ['焼肉', '燒肉', 'yakiniku', 'barbecue', 'bbq'],
  'karaoke-mic': ['カラオケ', '卡拉OK', 'karaoke'],
  'fes-towel': ['フェス', '音樂祭', '音樂節', 'festival', 'fest'],
  'new-game': ['ゲーム', '遊戲', 'game', 'video game'],
  'konbini-sweets': ['コンビニ', 'おやつ', '超商', '零食', 'konbini', 'convenience store', 'snack'],
  blanket: ['毛布', '毛毯', 'blanket'],
  'tea-leaves': ['紅茶', '茶葉', 'black tea', 'tea'],
  paperback: ['本屋', '文庫', '小説', '書店', '小說', 'bookstore', 'bookshop', 'novel', 'book'],
  'letter-set': ['手紙', 'レター', '寫信', '信紙', 'letter'],
  bouquet: ['花束', 'お花', '花', 'flower', 'bouquet'],
  lipstick: ['リップ', '口紅', 'コスメ', 'おしゃれ', '唇膏', '化妝品', 'lipstick', 'makeup', 'cosmetic'],
  'travel-guide': ['旅行', '旅遊', 'travel', 'trip'],
  'night-view': ['夜景', 'night view', 'night-view', 'city lights']
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matcher = (w: string) => (/^[\x20-\x7e]+$/.test(w) ? new RegExp(`\\b${escape(w)}s?\\b`, 'i') : new RegExp(escape(w)));
const MATCHERS = new Map<GiftId, RegExp[]>(Object.entries(GIFT_WORDS).map(([id, words]) => [id as GiftId, words!.map(matcher)]));

/** The gifts she likes that her own words just mentioned (in her likes order); he has learned these about her. */
export function wishesIn(star: StarId, text: string): GiftId[] {
  return TASTES[star].likes.filter((id) => (MATCHERS.get(id) ?? []).some((re) => re.test(text)));
}

/**
 * The one thing she may mention wanting on this message, or null. `sent` = his messages with her before this one: she
 * brings a taste up on his GIFT_RULES.hintAtTurn-th message and every hintEveryTurns after it, one he has not learned
 * yet, in turn. Deterministic, so a retry or a second tab never makes her say it twice as often.
 */
export function wishToHint(star: StarId, sent: number, known: readonly GiftId[]): GiftId | null {
  const turn = sent + 1;
  if (turn < GIFT_RULES.hintAtTurn || (turn - GIFT_RULES.hintAtTurn) % GIFT_RULES.hintEveryTurns !== 0) return null;
  const open = TASTES[star].likes.filter((id) => !known.includes(id));
  return open.length ? open[Math.floor((turn - GIFT_RULES.hintAtTurn) / GIFT_RULES.hintEveryTurns) % open.length] : null;
}

/** Which of her reactions a gift gets: `wished` = a liked gift she had mentioned to him. */
export type GiftReactionKind = GiftTaste | 'wished';
export const reactionKind = (taste: GiftTaste, wished: boolean): GiftReactionKind => (taste === 'liked' && wished ? 'wished' : taste);

/**
 * Her line for a gift, written ahead: what she says when the persona service cannot answer (it is also the model's
 * fallback). `{gift}` is the gift's name. Scale and safety as her system lines (#82): every line passes the persona
 * service's safety filter.
 */
export const GIFT_REACTIONS: Record<StarId, Record<GiftReactionKind, LocalText>> = {
  mahiro: {
    wished: { ja: '{gift}……前にわたしが言ってたの、覚えててくれたの？ ……ずるいよ、そんなのうれしすぎる。', 'zh-Hant': '{gift}……你還記得我之前說過的嗎？……太犯規了，這樣我會開心過頭的。', en: '{gift}… you remembered what I said before? …That\'s not fair, it makes me way too happy.', ko: '{gift}……전에 내가 말했던 거, 기억해 준 거야? ……치사해, 그런 거 너무 좋잖아.' },
    liked: { ja: 'え、{gift}……！ わたしの好きなもの、どうしてわかったの？ ふふ、すっごくうれしい。', 'zh-Hant': '咦，{gift}……！你怎麼知道我喜歡這個？呵呵，好開心。', en: 'Wait, {gift}…! How did you know I love this? Heh, I\'m so happy.', ko: '어, {gift}……! 내가 좋아하는 거, 어떻게 알았어? 후후, 정말 기뻐.' },
    plain: { ja: '{gift}、くれるの？ ありがとう。あなたが選んでくれたってだけで、うれしいな。', 'zh-Hant': '要送我{gift}嗎？謝謝。光是你幫我挑的，我就好開心。', en: '{gift}, for me? Thank you. Just knowing you picked it makes me happy.', ko: '{gift}, 주는 거야? 고마워. 네가 골라 줬다는 것만으로도 기뻐.' },
    disliked: { ja: '{gift}……ありがとう。ちょっとだけ苦手だけど、気持ちはちゃんと受けとったよ。', 'zh-Hant': '{gift}……謝謝。雖然這個我有一點點不太喜歡，但你的心意我確實收到了。', en: '{gift}… thank you. It\'s not really my thing, but your feelings came through, really.', ko: '{gift}……고마워. 살짝 내 취향은 아니지만, 마음은 확실히 받았어.' }
  },
  nana: {
    wished: { ja: '{gift}！？ 奈々が言ってたの、覚えててくれたの！？ うれしすぎてジャンプしちゃう！', 'zh-Hant': '{gift}！？你記得奈奈說過的話！？開心到要跳起來了！', en: '{gift}!? You remembered what I said!? I\'m so happy I could jump!', ko: '{gift}!? 나나가 말했던 거, 기억해 준 거야!? 너무 기뻐서 점프할 것 같아!' },
    liked: { ja: 'えっ、{gift}！？ やったー！ 奈々がこれ大好きなの、なんで知ってるの！？', 'zh-Hant': '咦，{gift}！？太棒了！你怎麼知道奈奈超愛這個！？', en: 'Wait, {gift}!? Yay! How did you know I love this!?', ko: '어, {gift}!? 앗싸! 나나가 이거 진짜 좋아하는 거, 어떻게 알았어!?' },
    plain: { ja: '{gift}！ ありがとっ！ キミがくれるものなら、なんでもうれしいよ！', 'zh-Hant': '{gift}！謝謝！只要是你送的，我都很開心！', en: '{gift}! Thanks! Anything from you makes me happy!', ko: '{gift}! 고마워! 네가 주는 거라면 뭐든 기뻐!' },
    disliked: { ja: '{gift}かぁ……あはは、ありがと！ 正直ちょっとニガテだけど、キミの気持ちがうれしい！', 'zh-Hant': '{gift}啊……哈哈，謝謝！老實說我有點不太喜歡這個，不過你的心意我很開心！', en: '{gift}, huh… haha, thanks! Honestly not my favorite, but I love that you thought of me!', ko: '{gift}…… 아하하, 고마워! 솔직히 좀 별로긴 한데, 네 마음이 기뻐!' }
  },
  unpai: {
    wished: { ja: '……{gift}。うちがぼそっと言ったの、聞いてたんだ。……ずるい。ありがと。', 'zh-Hant': '……{gift}。我隨口說的你也有在聽啊。……好犯規。謝謝。', en: '…{gift}. You actually heard me mumble about it. …Unfair. Thank you.', ko: '……{gift}. 내가 중얼거린 거, 듣고 있었구나. ……치사해. 고마워.' },
    liked: { ja: '……{gift}じゃん。え、うちの好きなやつ。……きみ、わかってるね。ありがと。', 'zh-Hant': '……是{gift}耶。欸，是我喜歡的。……你很懂嘛。謝啦。', en: '…That\'s {gift}. Wait, I love that one. …You get me. Thanks.', ko: '……{gift}잖아. 어, 내가 좋아하는 거네. ……너, 잘 아네. 고마워.' },
    plain: { ja: '{gift}？ ふーん……ありがと。きみがくれたって思うと、ちょっとうれしい。', 'zh-Hant': '{gift}？嗯……謝啦。想到是你送的，就有點開心。', en: '{gift}? Hmm… thanks. Knowing it\'s from you makes me kinda happy.', ko: '{gift}? 흐응…… 고마워. 네가 준 거라고 생각하면, 조금 기쁘네.' },
    disliked: { ja: '{gift}……うーん、それはちょっと。……でも、くれた気持ちはもらっとく。', 'zh-Hant': '{gift}……嗯，這個有點那個。……不過你的心意我就收下了。', en: '{gift}… hmm, not really my thing. …But I\'ll take the thought.', ko: '{gift}…… 으음, 그건 좀. ……그래도 준 마음은 받아 둘게.' }
  },
  alice: {
    wished: { ja: '{gift}……私が前にお話ししたこと、覚えていてくださったんですね。……胸がいっぱいです。', 'zh-Hant': '{gift}……你記得我之前說過的話呢。……我好感動，心裡滿滿的。', en: '{gift}… you remembered what I told you before. …My heart is full.', ko: '{gift}……제가 전에 이야기했던 걸 기억해 주셨네요. ……가슴이 벅차요.' },
    liked: { ja: '{gift}……！ 私、これが大好きなんです。どうしてわかったんですか？ ……うれしい。', 'zh-Hant': '{gift}……！我最喜歡這個了。你怎麼知道的呢？……好開心。', en: '{gift}…! I really love this. How did you know? …I\'m so happy.', ko: '{gift}……! 저, 이거 정말 좋아해요. 어떻게 아셨어요? ……기뻐요.' },
    plain: { ja: '{gift}を、私に？ ありがとうございます。……大切にしますね。', 'zh-Hant': '{gift}，要送我嗎？謝謝你。……我會好好珍惜的。', en: '{gift}, for me? Thank you. …I\'ll treasure it.', ko: '{gift}, 저한테요? 감사합니다. ……소중히 할게요.' },
    disliked: { ja: '{gift}……ありがとうございます。少しだけ苦手なんですけど、お気持ちはうれしいです。', 'zh-Hant': '{gift}……謝謝你。雖然我有一點點不太習慣這個，但你的心意我很開心。', en: '{gift}… thank you. It\'s not quite my thing, but your thoughtfulness makes me happy.', ko: '{gift}……감사합니다. 저한테는 조금 안 맞는 편이지만, 마음은 정말 기뻐요.' }
  },
  eimi: {
    wished: { ja: '{gift}……えいみが言ったこと、ちゃんと覚えてたんだ。ふふっ、キミのそういうとこ、ずるいなぁ。', 'zh-Hant': '{gift}……詠美說過的話，你都好好記著啊。呵呵，你這種地方真犯規。', en: '{gift}… you remembered what I said. Hehe, that\'s so unfair of you.', ko: '{gift}…… 에이미가 한 말, 제대로 기억하고 있었구나. 후훗, 너의 그런 점, 치사하다니까.' },
    liked: { ja: 'あら、{gift}？ ……ふふっ、えいみの好み、ちゃんとわかってるじゃない。ごほうびあげなきゃね。', 'zh-Hant': '哎呀，{gift}？……呵呵，你很懂詠美的喜好嘛。得給你一點獎勵才行呢。', en: 'Oh, {gift}? …Hehe, you know exactly what I like. I\'ll have to reward you.', ko: '어머, {gift}? ……후훗, 에이미 취향 제대로 알고 있잖아. 상 줘야겠네.' },
    plain: { ja: '{gift}？ ありがと。……キミが選んだって思うと、ちょっとかわいく見えてくるね。', 'zh-Hant': '{gift}？謝啦。……想到是你挑的，就覺得有點可愛呢。', en: '{gift}? Thanks. …Knowing you picked it makes it look a little cute.', ko: '{gift}? 고마워. ……네가 골랐다고 생각하니까 좀 귀엽게 보이네.' },
    disliked: { ja: '{gift}ねぇ……ふふ、正直ちょっと好みじゃないかな。でも、選んでくれたキミはかわいいよ。', 'zh-Hant': '{gift}啊……呵呵，老實說不太是我的菜。不過幫我挑禮物的你很可愛喔。', en: '{gift}, huh… hehe, honestly not quite my taste. But you picking it for me? Cute.', ko: '{gift}라니…… 후후, 솔직히 좀 취향은 아닌가. 그래도 골라 준 너는 귀여워.' }
  }
};

/** Her written line for a gift, in `lang` (Japanese when she has none in it). */
export function giftReaction(star: StarId, giftId: GiftId, taste: GiftTaste, wished: boolean, lang: string): string {
  const name = localText(giftById(giftId)?.name, lang);
  return localText(GIFT_REACTIONS[star][reactionKind(taste, wished)], lang).split('{gift}').join(name);
}

/** Every talent's likes and dislikes name catalogue gifts, and no gift is both. Checked by the shared tests. */
export function tasteProblems(): string[] {
  const ids = new Set(GIFTS.map((g) => g.id));
  return STAR_IDS.flatMap((star) => {
    const t = TASTES[star];
    return [
      ...[...t.likes, ...t.dislikes].filter((id) => !ids.has(id)).map((id) => `${star}: unknown gift ${id}`),
      ...t.likes.filter((id) => t.dislikes.includes(id)).map((id) => `${star}: ${id} is liked and disliked`),
      ...t.likes.filter((id) => !GIFT_WORDS[id]?.length).map((id) => `${star}: ${id} has no words to be mentioned by`)
    ];
  });
}
