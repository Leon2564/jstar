# 路线图

最后更新：2026-09-26。规则见 `docs/requirements.md`，决定与待确认项见 `docs/JSTAR-关键产品决策.md`。

## v1.0 正式（10/30，与实体卡同日上线）

免费上线：不开售，月卡只来自幸运卡序列码，登录只用邮箱验证码（LINE 登录已于 2026-09-27 移除）。上线前还要做：

1. **Redis**：序列码失败锁定、限流改为 Redis，支持多实例（现在在进程内，只能单实例，见 `docs/security.md`）。
2. **性能**：把点击响应最慢一次压到 200ms 内，主线程阻塞压到 600ms 内（见 TEST_REPORT）。
3. **法务**：AI 生成性感内容与 AV 新法的关系、概率公示文案；开放付费时的资金決済法表示。
4. **iOS Safari 与真机回归**；WebKit 加入端到端矩阵（现在 e2e 只跑 Chromium）。

## v1.1「一起生活」（`release/v1.1`，#47）

状态以合入 `release/v1.1` 的 PR 为准（issue 在里程碑收尾时统一关闭）。

| 块 | 已合入 | 未合入 |
|---|---|---|
| 基础 | #48 艺人档案与世界配置（PR #90）· #49 定时任务与收件箱（#92）· #50 Web Push 与 PWA（#93）· #51 回忆资产（#115）· #52 事件、「指標」页与端到端验收（#91 #118） | #53 文档同步（本次） |
| 关系阶段 | #54 关系阶段（#102）· #55 告白（#107）· #56 称呼、她会被你改变、相处方式、吃醋与禁聊（#111 #113） | — |
| 一天的循环 | #57 叫醒闹钟（#105）· #58 她的消息（#108）· #59 约定（#103）· #60 五人作息（#110）· #61 全年节点（#114） | — |
| 家乡与天气 | #62 气象数据（#99）· #63 天气进入她的世界（#106） | — |
| 场景与语音 | #64 场景引擎（#94）· #65 三种触发来源（#104）· #71 系统场景包（#116）· #72 语音输入（#101） | #66–#70 五幕的小游戏与测试站预览已合入（#117），场景本身等 #80 片段与 #84 母语审校 · #73 运行时 TTS · #74 语音分钟与延长 |
| 变体卡与礼物 | #75 变体卡数据模型（#97）· #77 礼物与偏好（#109）· #78 对话引出抽卡与 Pickup（#112） | #76 变体卡体验 |
| 素材 | #79 动作片段试点（#95，待负责人定生成 / 补拍）· #82 脚本与台词草稿（#100） | #80 五幕场景片段 · #81 变体卡素材 · #83 预生成语音 |
| 负责人 | — | #84 授权与确认、账号与密钥、法务、数值拍板 |

## 在测试站体验 v1.1

测试站 https://test.jstarcards.ai 是演示模式：登录用任意邮箱 + 验证码 `123456`，注册后填一个满 18 岁的生日。

- **测试站跑的是哪个分支**：push 到 main 会把测试站部署回 v1.0；看 v1.1 要对 `release/v1.1` 手动运行 Deploy test（`gh workflow run deploy-test.yml --ref release/v1.1`）。打开 https://test.jstarcards.ai/v1/config，返回里有 `asr` 字段就是 v1.1。
- **定时任务每 5 分钟跑一次，不能手动触发**：下面凡是「等下一次 tick」的，最多等 5 分钟（天气消息最多 10 分钟）。
- **片段待拍的场景只在这里可玩**：台词已于 2026-09-28 审校（告白、称呼提问、叫醒话、约定提议、天气消息、系统场景在正式环境也会出现），但五幕与变体场景要等 #80 / #81 的片段合入才在正式环境开放（发布规则，`docs/requirements.md` §9.4）。
- **调用演示接口**：登录后在浏览器开发者工具的控制台先粘贴这一行，下文的 `call(…)` 都用它（会话在 `localStorage` 的 `jstar.token`）：

```js
const call = (method, path, body) => fetch(path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.getItem('jstar.token') }, body: body && JSON.stringify(body) }).then((r) => r.json());
```

艺人 id：`mahiro`（唯井まひろ）、`nana`（八木奈々）、`unpai`（うんぱい）、`alice`（七瀬アリス）、`eimi`（深田えいみ）。

| 功能 | 怎么试 |
|---|---|
| 关系阶段（#54） | 陪伴首页名字下方是阶段、相处天数与她的一句提示。直接跳阶段：`call('POST', '/v1/relationship/demo', { star: 'mahiro', stage: 'lover' })`（`new` / `familiar` / `ambiguous` / `confession_ready` / `lover`），刷新首页 |
| 告白（#55） | 首页点「デモ：告白の日にする」（等同把阶段设为 `confession_ready`，并重置告白进度）。演示模式白天也有「まひろの話を聞く」入口；等下一次 tick 她的头像会出现告白消息。回答可以按住麦克风说，也可以打字；勾选「この答えの声を、思い出として残す」后回答「はい」，录音会出现在「カード → 思い出」 |
| 称呼（#56） | 「マイ → 呼び方」填一个名字；`call('POST', '/v1/relationship/demo', { star: 'mahiro', stage: 'familiar' })` 后打开她的聊天，她会先问能不能换称呼 |
| 现在谁在家（#60） | 首页五个头像下是在家 / 外出 / 睡觉与天气；JST 23–05 点进奈々的房间是被叫醒的台词 |
| 叫醒闹钟（#57） | 「マイ → 目覚まし」选一位，时间设为现在 + 6–10 分钟，保存后开启通知；到点后的下一次 tick 锁屏收到她的叫醒，点开进入叫醒画面，可试「あと5分」 |
| 她的消息（#58） | 先和她聊一句，再 `call('POST', '/v1/her-messages/demo', { kind: 'note' })`（也可 `invite`、`dream`），下一次 tick 头像出现角标、开了通知的设备收到推送；「マイ → 彼女からのメッセージ」可改频率 |
| 约定（#59） | 聊天里说「明日の夜9時に朗読を聞かせて。約束ね」，或离开聊天时点她提议的「約束する」。到期：`call('POST', '/v1/promises/demo', { star: 'nana', inMinutes: 1 })`，下一次 tick 收到「昨日の約束、覚えてる？」；错过：`inMinutes: -240`，下一次 tick 后进她的房间她轻轻提一句。每位同时只能有一条（409 `promise_open` 就换一位） |
| 收件箱（#49） | `call('POST', '/v1/inbox/demo', { star: 'nana', text: 'ねえ、起きてる？', inMinutes: 1 })`，下一次 tick 后首页出现角标，点头像这条就是她的开场 |
| 全年节点（#61） | 打开 `https://test.jstarcards.ai/#/me/home?day=2027-03-04`（まひろ的生日），或 `call('POST', '/v1/calendar/demo', { day: '2027-12-24' })`（圣诞）；2 小时内「今天」就是这一天，那天她的消息下一次 tick 送到。恢复：`call('POST', '/v1/calendar/demo', { day: null })`。测试站把五位的生日都当作已确认 |
| 天气（#62 #63） | 真实天气：`https://test.jstarcards.ai/v1/world`；「マイ → あなたの街」可设自己的城市。换天气：`call('PUT', '/v1/world/demo', { star: 'nana', weather: 'rain' })`（`clear` `cloudy` `fog` `rain` `snow` `thunder`），初雪加 `firstSnow: true`，预警加 `alert: 'storm'`；下一次整点刷新恢复真实天气。家乡都未确认，五位共用东京，改一位就改了全部。只看画面：首页加 `?wx=rain`（`snow` `storm` `sakura` `hot`） |
| 场景（#64 #65） | 首页「体験 シーンを体験する」进入演示场景「おかえりの夜」（まひろ）；进まひろ的房间约三成会被她提议；在她的聊天里说「おかえりの夜、やろう」由你开始 |
| 系统场景（#71） | 晚安：你本地 22:00 以后进她的房间（耳语需要月卡）。天气场景：用上面的 `/v1/world/demo` 设雨（傍晚后）、初雪或预警，下一次 tick 收到消息后打开。生日：`/v1/calendar/demo` 设为 `2027-03-04` 后进まひろ的房间。约定开场：`call('POST', '/v1/promises/demo', { star: 'mahiro', inMinutes: 1 })`，到期后进她的房间 |
| 五幕预览（#66–#70） | 首页的「撮影待ちシーンのプレビュー」或 `https://test.jstarcards.ai/#/me/preview`：五位的招牌场景与变体场景，未拍的镜头用她现有的片段代替（标「プレビュー・仮の映像」）；可以玩猜拳、夸奖、大喜利、讨价还价、弹幕 |
| 语音输入（#72） | 聊天里按住麦克风说话、松开发送；Firefox 走服务端识别 |
| 推送（#50） | 「マイ → 通知」开启后点「テスト通知を送る」。iPhone 要先「添加到主屏幕」再从图标打开 |
| 礼物（#77） | 她的聊天页顶栏或首页的「プレゼント」；新账号有 1,000 pt 新人礼 + 当天登录点数 |
| 回忆资产（#51） | 「カード → 思い出」里「思い出を書き出す」下载 JSON；同一天第二次会被拒 |
| 地区封锁预览 | 任意页面加 `?geo=KR`（或其他国家代码）看被封锁地区看到的页面 |

测试站试不了的：

- **Pickup（#78）与「指標」看板（#52）**：管理后台 admin.jstarcards.ai 连的是正式环境，测试站没有管理后台。请在本地 `npm run demo` + `npm run dev:admin`（`admin@jstar.demo` / `123456`）验收。
- **月卡权益（晚安耳语）**：月卡只来自序列码，演示码被迁移 `0005_end_demo.sql` 标为已用（它在测试站的库上同样执行），预计测试站兑换会返回「已使用」；耳语请在本地演示验收。
- **声音**：场景与系统场景目前只有字幕（预生成语音 #83、运行时 TTS #73 未合入）。

## Nest（nest.jstarcards.ai，负责人审阅 v1.1）

Nest 是审阅模式（`STAGE=review`，`infra/cloudflare/README.md`「Stages」）：行为与正式环境一致，但用自己的数据库、R2 与密钥，不被搜索引擎收录。部署：`gh workflow run deploy-nest.yml --ref release/v1.1`。

- **登录**：输入自己的邮箱 →「確認コードを送る」（Turnstile 隐形验证，一般无感）→ 邮箱收到 `noreply@jstarcards.ai` 发来的 6 位验证码（10 分钟内有效）→ 输入即登录。`123456` 在这里无效。第一次登录后填生日，未满 18 岁的账号会被关闭，与正式环境相同。
- **显示的是已发布内容**：没有演示菜单（首页「体験」）、演示接口、演示序列码与测试站的 `?geo=` 预览。标为草稿（`draft`）的 v1.1 台词在 Nest 上和正式环境一样不出现——告白、称呼提问、叫醒话、约定提议、天气消息、系统场景要等母语审校后把 `draft` 改为 false 才会出现；「機能」页的 v1.1 两项同理。
- **月卡与卡（审阅用序列码）**：打开 https://nest.jstarcards.ai/lucky，输入一个审阅码：6 张卡（第一张 SR 以上）+ 30 天月卡（晚安耳语等月卡权益），每个码只能用一次，只在 Nest 有效。码在负责人电脑的仓库根目录 **`.nest-review-codes.secret`**（已 gitignore，权限 600，不要发邮件或 IM）。首批 20 个（批次 `nest-review-202609271931`）；用完再生成：`SECRETS_ROOT=<仓库根目录> infra/cloudflare/scripts/nest-review-codes.sh 20`（追加到同一文件，只写入 `jstar-nest`）。
- **没有管理员与审阅捷径**：Nest 不设 `ADMIN_EMAILS`，没有人是管理员；管理后台 admin.jstarcards.ai 只连正式环境。需要时由负责人设置：`npx wrangler secret put ADMIN_EMAILS -c infra/cloudflare/wrangler.nest.jsonc`（之后用该邮箱重新登录）。

## 正式环境上线 v1.1 之前

`release/v1.1` 合入 main 并打 `v*` tag 之前，负责人需要准备：

1. **R2 桶 `jstar-memory`**：`npx wrangler r2 bucket create jstar-memory`，保持私有（不开公开访问、不绑域名、不设 CORS）。`wrangler.jsonc` 已绑定它，**桶不存在时正式部署会失败**；部署用的 `CLOUDFLARE_API_TOKEN` 需要 R2 编辑权限（`infra/cloudflare/README.md`）。
2. **VAPID 密钥**：`npx web-push generate-vapid-keys` 生成一对，存为 GitHub secrets `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`（可选 `VAPID_SUBJECT`）。只设一次，更换会让所有已有订阅失效。不设则正式环境没有推送，叫醒与她的消息只能在打开网站时看到。
3. **Open-Meteo 付费档**：免费档仅限非商业用途，正式商用需付费档。付费档要在请求里加 `apikey` 并换成付费档域名，需要小改 `apps/api/src/lib/weather.ts` 与 Worker 的天气中转（`infra/cloudflare/src/index.ts`）。
4. **OpenRouter key 续期**：线上聊天、她的消息、告白判定都用这把 key，**2026-10-24 过期**，余额约 $54（2026-09-26）。更新 GitHub secret 时用 `gh secret set OPENROUTER_API_KEY` 从标准输入读，不要用 `--body -`。
5. ~~**母语审校**~~：✅ 2026-09-28 完成（SOTA 模型审校 + 韩语，`docs/review/v11-lines-review.md`），各台词集 `draft: false`；场景按发布规则等片段（§9.4）。
6. **#84 的其余各项**：经纪公司书面确认（授权范围、声音克隆、五位的生日与家乡、人设终稿与禁聊清单、变体卡选卡、场景片段审核）；数值拍板（`docs/JSTAR-关键产品决策.md`「待确认的数值与决定」）；法务（Pickup、礼物与景品表示法 / 资金決済法表示、停服保全与导出保留期、隐私政策新增的段落）；运行时 TTS 的服务商账号（#73）。

## v1.0 之后

- 管理端：用户封禁（现在只有查询与补填）、用户举报处理（现在的审核队列只有被硬拦截的聊天）、素材上传直传 CDN。
- 数据：v1.0 的漏斗（扫码 → 兑换 → 试聊 → 注册），v1.1 的「指標」之外。
- 支付：接支付商托管收银台与 webhook，前端不碰卡号。
- 原生 App（当前是 Web 优先，商店风险在 TEST_REPORT 里有说明）。
- 卡面动态化（SSR 觉醒后的动卡）。
- 与 Juicy Honey 一类实体卡发行方的联名批次（管理端已支持按批次生成序列码）。
