import type { Lang, StarId } from '@jstar/shared';

/**
 * Her own written greeting (round 11): each talent in her voice, in four languages — うんぱい and えいみ no longer say
 * まひろ's line word for word. API-side only (never in the web entry). By the gap since he last wrote (first / same
 * day / long), the part of her day for the day after, and the relationship: once they are close (ambiguous and on),
 * her `close` words follow. `{call}` is what she calls him, else `you` — never a name she was not given (round 10).
 * Korean keeps her register (persona.py KO_REGISTER): アリス 해요체, the other four 반말.
 */
export type Part = 'early morning' | 'morning' | 'daytime' | 'evening' | 'late night';
export interface StarGreeting { first: string; same: string; long: string; next: Record<Part, string>; close: string; you: string }

const L = (first: string, same: string, long: string, next: [string, string, string, string, string], close: string, you: string): StarGreeting => ({
  first, same, long, close, you,
  next: { 'early morning': next[0], morning: next[1], daytime: next[2], evening: next[3], 'late night': next[4] }
});

export const GREETING_LINES: Record<StarId, Record<Lang, StarGreeting>> = {
  mahiro: {
    ja: L('はじめまして、まひろです。……来てくれて、うれしいな。', 'また来てくれたんだ。……ふふ、うれしい。', 'ひさしぶり……{days}日ぶりだね。ちゃんと、待ってたよ。', [
      '早起きだね。おはよう、{call}。わたしも、いま起きたところ。', 'おはよう、{call}。今日も、無理しすぎないでね。', '{call}、こんにちは。お昼、ちゃんと食べた？',
      'おかえり、{call}。今日もおつかれさま。', 'こんな時間まで起きてたの？……わたしも、話したかったんだ。'
    ], '……会えるの、ずっと楽しみにしてた。', 'あなた'),
    'zh-Hant': L('初次見面。……你來了，我好開心。', '你又來了呀。……呵呵，好開心。', '好久不見……已經{days}天了呢。我一直都在等你喔。', [
      '好早起喔。早安，{call}。我也才剛起床。', '早安，{call}。今天也別太勉強自己喔。', '{call}，午安。午餐有好好吃嗎？',
      '歡迎回來，{call}。今天也辛苦了。', '這麼晚還醒著呀？……我也好想跟你說話。'
    ], '……一直好期待見到你。', '你'),
    en: L("Nice to meet you, I'm Mahiro. …I'm really glad you came.", 'You came back. …That makes me happy.', "It's been {days} days… I was waiting for you, you know.", [
      'Up early? Good morning, {call}. I just woke up too.', "Good morning, {call}. Don't push yourself too hard today.", 'Hi {call}. Did you eat a proper lunch?',
      'Welcome back, {call}. You worked hard today.', 'Still up at this hour? …I wanted to talk to you too.'
    ], "…I've been looking forward to seeing you.", 'you'),
    ko: L('처음이네, 나는 마히로야. ……와 줘서 기뻐.', '또 와 줬구나. ……후후, 기뻐.', '오랜만이야…… {days}일 만이네. 계속 기다렸어.', [
      '일찍 일어났네. 좋은 아침, {call}. 나도 방금 일어났어.', '좋은 아침, {call}. 오늘도 너무 무리하지 마.', '{call}, 안녕. 점심은 잘 챙겨 먹었어?',
      '어서 와, {call}. 오늘도 수고했어.', '이 시간까지 깨어 있었어? ……나도 얘기하고 싶었어.'
    ], '……계속 보고 싶었어.', '너')
  },
  nana: {
    ja: L('はじめまして！奈々だよ。来てくれて、めっちゃうれしい！', 'あ、また来てくれた！やったー！', 'もー、{days}日ぶりじゃん！奈々、ずっと待ってたんだからね？', [
      'わ、早起き！おはよ、{call}！奈々はまだちょっと眠い……', 'おはよ、{call}！今日もいっしょにがんばろっ！', '{call}、やっほー！いま休憩中？',
      'おかえり、{call}！今日はどんな一日だった？', 'こんな時間まで起きてるの？……えへへ、奈々もだよ。'
    ], 'えへへ、会いたかったんだ。', 'キミ'),
    'zh-Hant': L('初次見面！你來了，我超開心的！', '啊，你又來了！耶～！', '厚～已經{days}天了耶！我一直在等你喔？', [
      '哇，好早起！早安，{call}！我還有點睏……', '早安，{call}！今天也一起加油吧！', '{call}，嗨～！現在在休息嗎？',
      '歡迎回來，{call}！今天過得怎麼樣？', '這麼晚還醒著？……嘿嘿，我也是喔。'
    ], '嘿嘿，好想你喔。', '你'),
    en: L("Nice to meet you! I'm Nana. I'm so happy you came!", 'Oh, you came back! Yay!', "Hey, it's been {days} days! Nana was waiting the whole time, you know?", [
      "Whoa, up early! Morning, {call}! I'm still kinda sleepy…", "Morning, {call}! Let's do our best today!", 'Heyyy, {call}! On a break?',
      'Welcome back, {call}! How was your day?', 'Still up this late? …Hehe, me too.'
    ], 'Hehe, I missed you.', 'you'),
    ko: L('처음 만나네! 와 줘서 완전 기뻐!', '앗, 또 와 줬다! 야호!', '정말, {days}일 만이잖아! 계속 기다렸단 말이야?', [
      '와, 일찍 일어났네! 좋은 아침, {call}! 나는 아직 좀 졸려……', '좋은 아침, {call}! 오늘도 같이 힘내자!', '{call}, 안녕~! 지금 쉬는 중이야?',
      '어서 와, {call}! 오늘 하루 어땠어?', '이 시간까지 안 자? ……헤헤, 나도야.'
    ], '헤헤, 보고 싶었어.', '너')
  },
  eimi: {
    ja: L('はじめまして、えいみだよ。……ふふ、緊張してる？', 'また来たの？……ふふ、えいみのこと、好きすぎ。', '{days}日も放っておくなんて、いい度胸。……でも、許してあげる。', [
      'こんな早くに？おはよ、{call}。……寝ぐせ、ついてない？', 'おはよ、{call}。今日もえいみのこと、考えててね。', '{call}、お昼休み？ちょっとだけ、えいみに付き合って。',
      'おかえり、{call}。今日はちゃんと甘えていいよ。', 'まだ起きてるの？……悪い子。えいみも、だけど。'
    ], '……会いたかったの、バレてる？', 'キミ'),
    'zh-Hant': L('初次見面。……呵呵，在緊張嗎？', '又來啦？……呵呵，你也太喜歡我了吧。', '竟然放著我{days}天，膽子不小喔。……不過，就原諒你吧。', [
      '這麼早？早安，{call}。……頭髮沒有翹起來吧？', '早安，{call}。今天也要想著我喔。', '{call}，午休嗎？陪我一下下就好。',
      '歡迎回來，{call}。今天可以好好跟我撒嬌喔。', '還醒著？……壞孩子。不過，我也是。'
    ], '……想見你這件事，被你發現了嗎？', '你'),
    en: L("Nice to meet you, I'm Eimi. …Hehe, nervous?", "Back again? …Hehe, you like me way too much.", 'Leaving me alone for {days} days? Bold of you. …Fine, I forgive you.', [
      'This early? Morning, {call}. …No bed hair, right?', 'Morning, {call}. Keep thinking about me today, okay?', 'Lunch break, {call}? Spend a little of it with me.',
      'Welcome back, {call}. You can be spoiled a little tonight.', "Still up? …Bad boy. Though so am I."
    ], '…Did you notice I missed you?', 'you'),
    ko: L('처음이네. ……후후, 긴장했어?', '또 왔어? ……후후, 나를 너무 좋아하는 거 아니야?', '{days}일이나 내버려 두다니, 배짱 좋네. ……그래도, 용서해 줄게.', [
      '이렇게 일찍? 좋은 아침, {call}. ……머리 뻗치진 않았지?', '좋은 아침, {call}. 오늘도 내 생각 해 줘.', '{call}, 점심시간이야? 잠깐만 나랑 놀아 줘.',
      '어서 와, {call}. 오늘은 마음껏 어리광 부려도 돼.', '아직 안 자? ……나쁜 아이. 나도 그렇지만.'
    ], '……보고 싶었던 거, 들켰어?', '너')
  },
  alice: {
    ja: L('はじめまして、アリスです。……来てくださって、うれしいです。', 'また来てくれたんですね。……ふふ、うれしいです。', '{days}日ぶりですね。……少しだけ、寂しかったです。', [
      '早起きですね。おはようございます、{call}。', 'おはようございます、{call}。今日も、いい一日になりますように。', '{call}、こんにちは。いまは、ひと休みですか？',
      'おかえりなさい、{call}。今日もおつかれさまでした。', 'こんな時間まで……。私も、まだ起きていました。'
    ], '……お会いできるの、待っていました。', 'あなた'),
    'zh-Hant': L('初次見面。……你願意來，我很開心。', '你又來了呢。……呵呵，好開心。', '已經{days}天沒見了呢。……我有一點點寂寞。', [
      '好早起呢。早安，{call}。', '早安，{call}。願今天也是美好的一天。', '{call}，午安。現在是在休息嗎？',
      '歡迎回家，{call}。今天也辛苦您了。', '這麼晚了……。我也還醒著呢。'
    ], '……我一直在等著見你。', '你'),
    en: L("Nice to meet you, I'm Alice. …I'm glad you came.", "You came back. …I'm glad.", "It's been {days} days. …I was a little lonely.", [
      "You're up early. Good morning, {call}.", 'Good morning, {call}. I hope today is a good day for you.', 'Hello, {call}. Taking a little break?',
      'Welcome home, {call}. Thank you for your hard work today.', 'At this hour…. I was still awake too.'
    ], '…I was waiting to see you.', 'you'),
    ko: L('처음 뵙겠어요. ……와 주셔서 기뻐요.', '또 와 주셨네요. ……후후, 기뻐요.', '{days}일 만이네요. ……조금, 쓸쓸했어요.', [
      '일찍 일어나셨네요. 좋은 아침이에요, {call}.', '좋은 아침이에요, {call}. 오늘도 좋은 하루 되길 바라요.', '{call}, 안녕하세요. 지금은 잠깐 쉬는 중이에요?',
      '어서 오세요, {call}. 오늘도 수고 많으셨어요.', '이런 시간까지……. 저도 아직 깨어 있었어요.'
    ], '……만나길 기다리고 있었어요.', '당신')
  },
  unpai: {
    ja: L('んー、はじめまして。うんぱいだよ。……来たんだ、きみ。', 'お、また来た。……うちのこと、気になる？', '{days}日ぶり、か。……べつに、数えてたわけじゃないけど。', [
      'え、早っ。おはよ、{call}。うちはまだ半分寝てる。', 'おはよ、{call}。今日ものんびりいこ。', '{call}、おつー。いまサボり中？',
      'おかえり、{call}。夜はこれからだね。', 'こんな時間？……いいね、夜ふかし仲間。'
    ], '……ま、会いたかったのは、ほんと。', 'きみ'),
    'zh-Hant': L('嗯——初次見面。……你來了啊。', '喔，又來了。……對我有興趣？', '{days}天沒見了啊。……我才沒有在數呢。', [
      '咦，這麼早。早，{call}。我還有一半在睡。', '早，{call}。今天也慢慢來吧。', '{call}，辛苦啦。現在在偷懶嗎？',
      '歡迎回來，{call}。夜晚才正要開始呢。', '這種時間？……不錯嘛，熬夜夥伴。'
    ], '……嗯，想見你，是真的。', '你'),
    en: L("Mm, nice to meet you. I'm Unpai. …So you came.", 'Oh, back again. …Curious about me?', "{days} days, huh. …Not that I was counting.", [
      "Whoa, early. Morning, {call}. I'm still half asleep.", "Morning, {call}. Let's take it easy today.", 'Hey, {call}. Slacking off right now?',
      'Welcome back, {call}. The night is just getting started.', 'This late? …Nice. A fellow night owl.'
    ], '…Okay, I did want to see you. For real.', 'you'),
    ko: L('음, 처음이네. ……왔구나.', '오, 또 왔네. ……나한테 관심 있어?', '{days}일 만인가. ……딱히 세고 있던 건 아니지만.', [
      '어, 일찍이네. 좋은 아침, {call}. 나는 아직 반쯤 자는 중.', '좋은 아침, {call}. 오늘도 느긋하게 가자.', '{call}, 수고~. 지금 땡땡이 중이야?',
      '어서 와, {call}. 밤은 이제부터지.', '이 시간에? ……좋네, 밤샘 동지.'
    ], '……뭐, 보고 싶었던 건 진짜야.', '너')
  }
};
