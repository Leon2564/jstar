# v1.1 台词审校记录（#84）

- **日期**：2026-09-28
- **决定**：负责人「去 openrouter 找 sota 模型审核」——v1.1 的全部台词由 OpenRouter 上当前最强的写作模型做母语级审校，并由同一模型写韩语（ko）。
- **模型**：**Claude Fable 5.1**（`anthropic/claude-fable-5.1`，Anthropic 的 Mythos 级旗舰，2026-09 上架），推理强度 `medium`。
- **范围**：她说的与屏幕上显示的全部 v1.1 草稿文字，共 979 处（去重后 899 条）——
  - 场景脚本 `packages/shared/src/scenes/**/*.json`：五幕（含奈々 雨夜版）、演示场景、20 个变体场景；
  - 台词集 `packages/shared/src/lines/*.json`：告白、叫醒、被叫醒、晚安 / 耳语、天气（初雪 / 雨夜 / 台风）、约定、称呼变更、婉拒、变体邀约、奈々 的朗读、えいみ 的大喜利题库、うんぱい 的弹幕反应、アリス 的讨价还价树，以及系统场景包 `system.json`；
  - 模板：`calendar.ts` `CALENDAR_LINES` / `HIS_BIRTHDAY_PUSH`、`herMessages.ts` `HER_MESSAGE_LINES`、`promises.ts` `PROMISE_LINES`、`tastes.ts` `GIFT_REACTIONS`、`scenes/confession.ts` 的标题与提示；
  - 另：她的语音时间提醒（`apps/web/src/i18n/*.ts` `voice.low.*`，5 句 × 4 语）、`world.ts` 的作息状态 / 招牌场景名 / 季节名 / 城市名（只补韩语）。
- **花费**：约 **$21**（模型对比 $1.0、审校 $14.6、校对 $5.1、其他 $0.4）。

## 选模型

OpenRouter 模型列表（`GET /api/v1/models`，2026-09-28）里三家的现役旗舰各跑同两段（`scenes/eimi/variant-eimi-6.json`、`lines/mahiro.json` 约定 / 称呼 / 婉拒 / 变体邀约，共 37 条），同一提示词：

| 模型 | 结果 |
| --- | --- |
| `anthropic/claude-fable-5.1` | 日文只改真正有问题的地方（变体邀约里的「カード」「今月」）；韩语自然、语气分寸对；另外指出了人要拍板的点（`{name}くん` 碰上昵称会变成「たっくんくん」、邀约像促销文案）。✔ 选用 |
| `openai/gpt-6-astra` | 改得多：37 条全部标为改动，连不需要重录的日文也改了措辞（如卡片文字、`unnamed` 的说法），会带来不必要的重录 |
| `google/gemini-3.1-pro-preview` | 保守，改了邀约的两处；但字幕的小偏差（如「来てくれる？」译成 “…Okay?”）没有发现，韩语偏生硬（多处以「저기」开头），也没有提出任何需要人确认的事项 |

理由：日文每改一句都要重新合成语音（按「艺人 + 日文」的哈希命名），所以要的是**判断准、改得少、该改的一定改**；同时要能写像样的韩语、看得出合规问题。Fable 5.1 三项都最好。

## 方法

1. **结构准备**（审校前）：28 句含 `{name}` 的台词各加一句不叫名字的 `unnamed` 版本（初稿由我写，交模型审）；うんぱい 的 15 个引用型弹幕模板拆成 `quote`（含 `{danmaku}`）+ `text`（之后的话，可录音）。
2. **审校 + 韩语**：按文件 / 台词区块分 59 段送审，每段附上该艺人的人设文件（`apps/agent/app/personas/<star>.yaml`）与已确认的世界设定；每条标明角色（她说出口 / 运行时语音 / 文字消息 / 标题 / 他的选项……）。标准：
   - 日文：符合该艺人的自称、对他的称呼、口癖与敬语层级，自然、像说出来的话，与公开形象一致；**只在确有必要时改日文**（每改一句要重录）；
   - zh-Hant（台湾用语）与 en：忠实、自然；
   - ko：忠实、自然，口吻与日文一致（アリス 用존댓말，其余반말；`{name}さん` → `{name} 씨`、`{name}くん` → `{name} 군`）；
   - 尺度：性感不露骨，最多到近景、耳边说话、拥抱；
   - 不出现确认事实以外的现实信息（不说城市名、年龄、他人、品牌）；
   - 不出现紧迫 / 促销字眼（景品表示法）：「今だけ」「今月」「期間限定」、卡、抽卡、点数、购买；
   - 占位符不增不减，诗保留换行，长度接近原文。
3. **校对**（同一模型，第二遍）：只看四语定稿，报告错字、简体字、意思偏差、韩语语法 / 语气错误、占位符问题——18 处，全部采纳。
4. **人工复核**（我）：逐条看了日文改动与字幕改动；修正模型留下的 3 处问题——`lines/nana.json` 邀约中文的「告訉」错字（→「告訴」）、`lines/eimi.json` 约定卡片的中文（「傳…夜景的事」→「傳訊息聊聊喜歡的夜景」）、`lines/mahiro.json` 邀约英文的 her → it；另有 2 处被人设服务的安全过滤器当成「现实见面 / 联系」而拦下（`variant-alice-1` 的中文「見面」、えいみ 称呼的英文 “call me”），改写后通过（`apps/agent/tests/test_scene_lines.py`）。
5. 人设核对：把五份人设交给同一模型对照公开资料找明显矛盾——**没有发现**（人设里没有生日、家乡等事实性内容）；它对几位的公开形象语气有疑问但不确定，不建议改动（见文末）。人设 `draft: false`、`taboo: []`。

审校后台词集 `draft: false`，场景去掉 `meta.draft`，按发布规则进 `SCENES`（`docs/requirements.md` §9.4）。

## 逐文件结果

「审校条数」按出现位置计（同一句出现在两处算两处，例如奈々 的朗读既在台词集里也在两个朗读场景里）。「新增条」= `unnamed` 与弹幕的 `quote`。うんぱい 的 17 处日文改动里有 15 处是弹幕模板拆出的录音后半句。

| 文件 | 审校条数 | ja 改动 | zh-Hant 改动 | en 改动 | 新增条 | ko |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `lines/mahiro.json` | 73 | 2 | 4 | 4 | 6 | 73 |
| `lines/nana.json` | 88 | 1 | 3 | 3 | 6 | 88 |
| `lines/unpai.json` | 108 | 17 | 20 | 18 | 21 | 108 |
| `lines/alice.json` | 85 | 1 | 4 | 2 | 6 | 85 |
| `lines/eimi.json` | 101 | 1 | 4 | 3 | 4 | 101 |
| `lines/system.json` | 69 | 0 | 3 | 3 | 0 | 69 |
| `scenes/alice/night-greenhouse.json` | 36 | 1 | 1 | 2 | 0 | 36 |
| `scenes/alice/variant-alice-1.json` | 11 | 1 | 4 | 3 | 0 | 11 |
| `scenes/alice/variant-alice-10.json` | 12 | 0 | 0 | 0 | 0 | 12 |
| `scenes/alice/variant-alice-3.json` | 8 | 0 | 0 | 0 | 0 | 8 |
| `scenes/alice/variant-alice-6.json` | 8 | 0 | 1 | 0 | 0 | 8 |
| `scenes/eimi/ogiri.json` | 25 | 0 | 0 | 0 | 0 | 25 |
| `scenes/eimi/variant-eimi-1.json` | 11 | 0 | 0 | 2 | 0 | 11 |
| `scenes/eimi/variant-eimi-10.json` | 12 | 0 | 0 | 0 | 0 | 12 |
| `scenes/eimi/variant-eimi-3.json` | 6 | 0 | 0 | 1 | 0 | 6 |
| `scenes/eimi/variant-eimi-6.json` | 8 | 0 | 1 | 0 | 0 | 8 |
| `scenes/mahiro/demo-evening.json` | 16 | 2 | 0 | 0 | 0 | 16 |
| `scenes/mahiro/variant-mahiro-1.json` | 11 | 0 | 0 | 1 | 0 | 11 |
| `scenes/mahiro/variant-mahiro-10.json` | 12 | 0 | 2 | 2 | 0 | 12 |
| `scenes/mahiro/variant-mahiro-3.json` | 11 | 0 | 0 | 0 | 0 | 11 |
| `scenes/mahiro/variant-mahiro-6.json` | 8 | 0 | 1 | 0 | 0 | 8 |
| `scenes/mahiro/welcome-home.json` | 31 | 0 | 2 | 0 | 0 | 31 |
| `scenes/nana/read-aloud-rain.json` | 34 | 0 | 0 | 0 | 0 | 34 |
| `scenes/nana/read-aloud.json` | 34 | 0 | 0 | 1 | 0 | 34 |
| `scenes/nana/variant-nana-1.json` | 11 | 1 | 2 | 1 | 0 | 11 |
| `scenes/nana/variant-nana-10.json` | 12 | 0 | 2 | 0 | 0 | 12 |
| `scenes/nana/variant-nana-3.json` | 10 | 0 | 1 | 1 | 0 | 10 |
| `scenes/nana/variant-nana-6.json` | 8 | 0 | 0 | 1 | 0 | 8 |
| `scenes/unpai/private-stream.json` | 28 | 0 | 2 | 0 | 0 | 28 |
| `scenes/unpai/variant-unpai-1.json` | 11 | 0 | 1 | 0 | 0 | 11 |
| `scenes/unpai/variant-unpai-10.json` | 12 | 0 | 1 | 0 | 0 | 12 |
| `scenes/unpai/variant-unpai-3.json` | 8 | 0 | 1 | 0 | 0 | 8 |
| `scenes/unpai/variant-unpai-6.json` | 8 | 0 | 0 | 0 | 0 | 8 |
| `scenes/confession.ts` | 3 | 0 | 0 | 0 | 0 | 3 |
| `calendar.ts` | 17 | 0 | 3 | 0 | 0 | 17 |
| `herMessages.ts` | 9 | 0 | 0 | 1 | 0 | 9 |
| `promises.ts` | 4 | 0 | 0 | 0 | 0 | 4 |
| `tastes.ts` | 20 | 0 | 6 | 5 | 0 | 20 |
| **合计** | **979** | **27** | **69** | **54** | **43** | **979** |

## 日文有改动的台词（需要重新合成语音）

录音 id = `scene/<star>/<sha256(star:ja)[:12]>`（`tools/voice/make_scene_jobs.py`）。

| 位置 | 原文 | 现在 | 录音 id |
| --- | --- | --- | --- |
| `lines/mahiro.json` `.variantInvite[0]` | ねえ、いつもと少し違う服のわたし、見てみたい？ ……そのカードを見つけたら、教えてね。 | ねえ、いつもと少し違う服のわたし、見てみたい？ ……いつか見てもらえたら、うれしいな。 | `scene/mahiro/bacb3dccce82` → `scene/mahiro/2e4997bf942d` |
| `lines/mahiro.json` `.variantInvite[2]` | 今月は、ちょっと特別なわたしがいるみたい。……出会えたら、うれしいな。 | ちょっと特別なわたしも、いるみたい。……出会えたら、うれしいな。 | `scene/mahiro/aa1f71c82e68` → `scene/mahiro/be0d521a03ea` |
| `lines/nana.json` `.variantInvite[2]` | 今だけ、特別な奈々に出会えるかも！ ……もし出会えたら、ちゃんと教えてね？ | 特別な奈々に出会えるかも！ ……もし出会えたら、ちゃんと教えてね？ | `scene/nana/17daabb952d9` → `scene/nana/c061a7b76ec9` |
| `lines/unpai.json` `.goodnight.plain` | おやすみー。また夜にね。 | おやすみー。また明日の夜ね。 | `scene/unpai/e808fc930509` → `scene/unpai/ea45aa384609` |
| `lines/unpai.json` `.variantInvite[2]` | 今、ちょっと特別なうちが来てるらしいよ。……もし出会えたら、教えてね。 | ちょっと特別なうちがいるらしいよ。……もし出会えたら、教えてね。 | `scene/unpai/3b9512f11ff7` → `scene/unpai/eb96a572aa16` |
| `lines/alice.json` `.variantInvite[2]` | 今だけ、少し特別な私に出会えるそうです。……もし出会えたら、教えてくださいね。 | 少し特別な私に、出会えることがあるそうです。……もし出会えたら、教えてくださいね。 | `scene/alice/1817f030f215` → `scene/alice/7ea2a63eb82a` |
| `lines/eimi.json` `.variantInvite[2]` | 今だけ、ちょっと特別なえいみがいるんだって。……出会えたら、ちゃんと自慢してね。 | ちょっと特別なえいみがいるんだって。……出会えたら、ちゃんと自慢してね。 | `scene/eimi/b073125def39` → `scene/eimi/e57687bfc002` |
| `scenes/alice/night-greenhouse.json` `.steps[22].text` | ……聴いていて、くださいね。 | ……聴いていてくださいね。 | `scene/alice/976e0ff27c48` → `scene/alice/14e000fd97c2` |
| `scenes/alice/variant-alice-1.json` `.steps[11].text` | ……もっと仲良くなれたら、この服の私を、もっと見てもらえたらうれしいです。 | ……もっと仲良くなったら、この服の私、たくさん見てほしいです。 | `scene/alice/64c0530b3aeb` → `scene/alice/7476a48cdf3d` |
| `scenes/mahiro/demo-evening.json` `.steps[3].text` | ……ふふ、私も。ずっと待ってたんだよ。 | ……ふふ、わたしも。ずっと待ってたんだよ。 | `scene/mahiro/fdb0230f734d` → `scene/mahiro/e97080eebaf3` |
| `scenes/mahiro/demo-evening.json` `.steps[4].text` | そっか。じゃあ今夜は、私が甘やかしてあげる。 | そっか。じゃあ今夜は、わたしが甘やかしてあげる。 | `scene/mahiro/f6aac7db9aa4` → `scene/mahiro/b5ba407ffba4` |
| `scenes/nana/variant-nana-1.json` `.steps[11].text` | もっと仲良くなったら、この服でいろんなことしようね！ | もっと仲良くなったら、この服でいっぱい遊ぼうね！ | `scene/nana/11a4dec1fb07` → `scene/nana/b112f5610115` |

`demo-evening` 的两句只是「私」→「わたし」（读音不变，这两句本来没有录音）。

**新增、可以预先录音的台词**（此前因含占位符而跳过）：

- 28 句 `unnamed`：`lines/mahiro.json` `.confession.accept[1].unnamed` `scene/mahiro/d2cf16e6f3e8`; `lines/mahiro.json` `.callName.familiar.ask.unnamed` `scene/mahiro/0dbb9e0d6c2d`; `lines/mahiro.json` `.callName.familiar.accepted.unnamed` `scene/mahiro/74d30f29f5e4`; `lines/mahiro.json` `.callName.lover.ask.unnamed` `scene/mahiro/8c3ca9d0fd2a`; `lines/mahiro.json` `.callName.lover.accepted.unnamed` `scene/mahiro/b8eca9a18442`; `lines/mahiro.json` `.callName.lover.declined.unnamed` `scene/mahiro/daa0b330b8cc`; `lines/nana.json` `.confession.accept[1].unnamed` `scene/nana/28ee8f6522f8`; `lines/nana.json` `.callName.familiar.ask.unnamed` `scene/nana/75a18cb79a80`; `lines/nana.json` `.callName.familiar.accepted.unnamed` `scene/nana/322f5db2b675`; `lines/nana.json` `.callName.lover.ask.unnamed` `scene/nana/d051049c2a32`; `lines/nana.json` `.callName.lover.accepted.unnamed` `scene/nana/95d72a7b440b`; `lines/nana.json` `.callName.lover.declined.unnamed` `scene/nana/d5ddcff1cbc5`; `lines/unpai.json` `.confession.accept[1].unnamed` `scene/unpai/3349971973ee`; `lines/unpai.json` `.callName.familiar.ask.unnamed` `scene/unpai/3074d03c00d3`; `lines/unpai.json` `.callName.familiar.accepted.unnamed` `scene/unpai/84c64290efeb`; `lines/unpai.json` `.callName.lover.ask.unnamed` `scene/unpai/2a5f15ef5f53`; `lines/unpai.json` `.callName.lover.accepted.unnamed` `scene/unpai/8db1cc8eef5a`; `lines/unpai.json` `.callName.lover.declined.unnamed` `scene/unpai/f0173a043767`; `lines/alice.json` `.confession.accept[1].unnamed` `scene/alice/30841d485563`; `lines/alice.json` `.callName.familiar.ask.unnamed` `scene/alice/70e5ef456e72`; `lines/alice.json` `.callName.familiar.accepted.unnamed` `scene/alice/618aff272170`; `lines/alice.json` `.callName.lover.ask.unnamed` `scene/alice/10407426ad9e`; `lines/alice.json` `.callName.lover.accepted.unnamed` `scene/alice/5a86f899edd4`; `lines/alice.json` `.callName.lover.declined.unnamed` `scene/alice/2e1d58caf371`; `lines/eimi.json` `.confession.accept[1].unnamed` `scene/eimi/6c3e1d355ed0`; `lines/eimi.json` `.callName.familiar.ask.unnamed` `scene/eimi/5662395fe22b`; `lines/eimi.json` `.callName.familiar.accepted.unnamed` `scene/eimi/9ec59d381f69`; `lines/eimi.json` `.callName.lover.declined.unnamed` `scene/eimi/b55856c9451e`
- 15 句弹幕后半句 `lines/unpai.json`：`.danmaku[0].text` `scene/unpai/dadde0f85151`; `.danmaku[1].text` `scene/unpai/c9c326521cb9`; `.danmaku[2].text` `scene/unpai/fa1bd9622f87`; `.danmaku[3].text` `scene/unpai/7dcb0619a61d`; `.danmaku[4].text` `scene/unpai/8a026f4ef325`; `.danmaku[5].text` `scene/unpai/447c04ea5e45`; `.danmaku[6].text` `scene/unpai/52832bec7635`; `.danmaku[7].text` `scene/unpai/ae55006c31ae`; `.danmaku[8].text` `scene/unpai/62ada9e9010b`; `.danmaku[9].text` `scene/unpai/1fb66ec48023`; `.danmaku[10].text` `scene/unpai/821419a53221`; `.danmaku[11].text` `scene/unpai/f819e4b42c8b`; `.danmaku[12].text` `scene/unpai/787a891f2fe7`; `.danmaku[13].text` `scene/unpai/f9764c0e26aa`; `.danmaku[14].text` `scene/unpai/3a13cdd8cfd0`

## 留给人工确认

合规 / 法务：
- 变体邀约去掉了「今だけ / 今月 / カード」，但「特別な〇〇に出会えるかも」仍在暗示有抽选机制——请法务确认她说这句可以接受（`lines/*.json` `variantInvite`）。
- アリス 的温室约会：付费（点数）延长选项前一句「帰っちゃうんですか……引き止めたりしませんけど」加上选择后的回报台词，可能被读作情感施压，请确认。
- うんぱい 私人直播里的「ギフトを送る？」：剧中礼物是免费的，但可能与 app 的付费礼物混淆——请确认界面清楚写明不花钱。
- えいみ 大喜利的换装奖励不应与付费的变体卡挂钩；「明日リベンジ」是回访引导，不是促销字眼。
- まひろ / アリス 变体第 1 层「更亲近之后再多给你看这身」——请确认与实际解锁方式一致，不被读作购买暗示。
- うんぱい 弹幕「今夜だけ、特別ね」是答应点播，不是促销；请合规确认可以保留。

人设 / 经纪公司：
- アリス 的温室与弹钢琴、うんぱい 的「配信」、まひろ 在他家里「おかえり」的同居式设定、由她主动告白——都是 app 的角色设计，请经纪公司知悉。
- えいみ 恋人阶段把「キミ」当作特别的称呼，但她平时本来就叫他「キミ」——请决定是否换一个特别的称呼。
- アリス 的敬语层级（おっしゃる、お顔）比她的示例台词略高一档。
- 人设语气与公开形象（模型不确定，未改）：まひろ 的「低体温・癒し系」、うんぱい 的「安静・夜型」可能与她们公开的活泼形象有出入。
- 着装场景里「不许偷看」（她在画外换衣服）在尺度内，请确认可以接受；えいみ 的一道大喜利题暗示她听到过他说梦话（题库不分关系阶段）。

产品：
- `{name}くん`：他的昵称本身已带「くん」时会变成「たっくんくん」——运行时可去掉重复的敬称，或只对真名加。
- 五位共用的日历 / 消息模板用「わたし / あなた」，而奈々、うんぱい、えいみ 平时不说「あなた」；它们是文字消息（不录音），如需要可改成按艺人分开。
- 约定「明天早上叫你起床」要确保真的会发叫醒，否则是失信。
- 告白场景的标题与回忆卡标题日文都是「告白」，英文分别是 “Her confession” / “The confession”。
- 奈々 的诗《星のしおり》约 120 字，不受 250–350 字的故事长度限制。

语音管线（`media/scene-voice` 分支的 `tools/voice/make_scene_jobs.py`，本分支未改）合并前要跟上：
- 文字对象现在是 `ja, zh-Hant, en, ko`（可能再跟 `voice`、`unnamed`）：`TEXT_RE` 要接受 `"ko"`，并跳过 / 处理嵌套的 `unnamed`；`texts()` 要下探 `unnamed`（新的可录音台词）。
- 五幕脚本从 `scenes/drafts.ts` 移到了 `scenes/index.ts`（`drafts.ts` 改名为 `media.ts`，只剩待拍片段与替身）：`draft_scene_files()` 要改读 `index.ts` 与 `variantScenes.ts`。
- 弹幕模板的 `quote` 含 `{danmaku}` 会被自动跳过，`text`（后半句）会被录音——不用改。
