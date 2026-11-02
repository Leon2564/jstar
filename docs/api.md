# HTTP 接口

所有请求体和响应体的形状都定义在 `packages/shared/src/contracts.ts`（zod），服务端用它校验，前端用它推导类型。校验失败统一返回 `400 {"error":"invalid_request","issues":[…]}`；其他错误是 `{"error":"<机器码>"}`，5xx 一律 `internal_error`。

路由注册在 `apps/api/src/app.ts`，实现在 `apps/api/src/modules/*.ts`。全局限流 120 次 / 分钟 / IP，下表「限流」列是另加的更严限制。数值规则见 `docs/requirements.md`，代码里的出处是 `packages/shared/src/rules.ts`。

- **会话**：`Authorization: Bearer <token>`（登录接口返回）。「需登录」的接口没有会话时 401 `unauthorized`；封禁用户的会话直接失效。
- **访客身份**：浏览器生成的设备 ID，放在 `x-device-id` 请求头（8–64 位字母数字、`-`、`_`）。
- **人机验证**：发验证码、设备的第一条试聊、多次输错序列码时需要 Turnstile token；缺失或无效 403 `challenge_required`，前端跑一次 Turnstile 后重试（未配置 Turnstile 时不校验）。
- **演示模式专用**（`DEMO_MODE=true`：测试站与本地 `npm run demo`）：下文标「仅演示模式」的接口在正式环境一律 404。
- **Cloudflare 上的额外规则**（`infra/cloudflare/src/index.ts`）：公网访问 `/v1/admin/*` 与 `/v1/ops/*` 一律 404（管理接口只经 admin.jstarcards.ai 的网关，tick 只由 Cron Trigger 调用）；地区封锁开启时 451 `region_unavailable`。

## 公开

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 `{ ok, env }` |
| GET | `/v1/config` | 前端渲染前需要知道的：`{ demo, turnstile（站点 key 或 null）, vapidPublicKey（推送关闭时 null）, asr（服务端语音识别是否可用）}` |
| GET | `/v1/cards` | 卡牌目录（150 张） |
| GET | `/v1/gacha/rates` | 提供割合（`GachaRatesRes`）：`pools` 为普通卡池「全員」与每位（各档、各卡概率与含天井的 SSR 以上实际出现率，不受 Pickup 影响），`pickups` 为进行中与已排期的 Pickup（`live`、起止时间、各档与各卡概率、对象卡的 `rate` / `baseRate` / `share` / `effectiveRate`），`shardsForExchange`。均由配置计算 |
| GET | `/v1/world` | 五位的城市（已确认的家乡，否则东京）与天气 `{ weather, tempC, sunrise, sunset, isDay, alert, next6h, stale, firstSnow, … }`（`WeatherNow`），首次获取前为 `null`；登录且设置了城市时 `user` 为 `{ name, weather }`。`stale: true`（超过 3 小时未更新）时前端不显示天气、提示词不传。匿名响应可缓存 5 分钟 |

## 身份与账号

| 方法 | 路径 | 限流 | 说明 |
|---|---|---|---|
| POST | `/v1/auth/otp/start` | 5 次 / 10 分钟 | `{ email, lang }` 发送邮箱验证码（演示模式固定 `123456`，不发信）；需人机验证 |
| POST | `/v1/auth/otp/verify` | 10 次 / 10 分钟 | 校验验证码，返回会话；带 `x-device-id` 时认领该设备的试聊记录与卡。`ADMIN_EMAILS` 里的地址登录后成为 admin。错误 400 `invalid_code` |
| GET | `/v1/auth/me` | — | 需登录。用户、钱包（点数、免费抽、天井计数、碎片）、持有卡（变体卡带 `variant`）、回忆卡、各艺人亲密度、今日剩余条数与月卡到期日、兑换过的码数、本次发放的每日点数（`dailyBonus`）、月度签到、`birthdayConfirmed`、`inboxUnread`（未读收件数）、`voiceLeft`（今日剩余语音秒数）与 `voice`（`VoiceState`，#74；`voice.tts` = 她的实时语音对他开放，#73）。每个 JST 日的第一次调用发放登录点数、签到与月卡点数 |
| POST | `/v1/auth/me/birthday` | — | 需登录。`{ birthday: "YYYY-MM-DD" }`，只能填一次（409 `birthday_already_set`）；不是真实日期 400 `invalid_birthday`；未满 `RULES.minAge` 当场关闭账号（按退会处理）并 403 `underage` |
| DELETE | `/v1/auth/me` | — | 需登录。退会：`{ confirm: "DELETE" }`。删除范围见 `docs/data-model.md`「退会」；写审计 `account.delete` |
| GET | `/v1/device` | — | 访客（`x-device-id`）：剩余试聊条数、已兑换但未认领的卡、待认领的月卡天数 |

## 聊天

| 方法 | 路径 | 限流 | 关键规则 |
|---|---|---|---|
| POST | `/v1/chat/trial` | 20 次 / 10 分钟 | 访客试聊，每设备 3 条；消息存在设备名下，注册时转入账号。用完 402 `trial_exhausted` |
| POST | `/v1/chat/send` | 30 次 / 分钟 | 需登录。每日免费 20 条（JST 0 点重置），月卡不限；超额 402 `daily_limit`；被拦截或 agent 失败时退还次数。长期记忆（称呼、生日、喜好、职业 + 滚动摘要）按用户 × 艺人存在 `chat_memory`，每轮交给 agent 并保存它返回的更新；每第 3 条生成回忆卡，标题由模型概括（不截取原话），婉拒、自伤等轮次不生成。返回 `ChatSendRes`：回复、亲密度与等级、回忆卡、剩余条数、免费抽；v1.1 起另带 `relationship`（这一轮之后的关系，#54）、`promise`（这一轮约好的约定，#59）、`scene`（他要求的场景：她答应 `start` / 反提议 `offer`，#65）、`pickup`（她提到他没有的变体卡且 Pickup 进行中时的小链接，#78） |
| POST | `/v1/chat/send/stream`、`/v1/chat/trial/stream` | 同上 | 与上两条相同的一轮对话，流式返回 NDJSON（`ChatStreamEvent`：`delta` 追加文字、`replace` 审核替换已显示内容、`done` 带完整 `ChatSendRes`、`error`）。开始输出前的错误（额度、拦截 422、agent 不可用 503）仍是普通 HTTP 错误并退还次数；中途断流时已说出的部分照常保存并计数 |
| GET | `/v1/chat/history?star=` | — | 需登录。与某位艺人的对话记录 |
| POST | `/v1/chat/memory/flush` | 20 次 / 分钟 | 需登录。`{ star }`。他离开聊天页时网页以 keepalive 调用：还没进长期记忆的轮次（`chat_memory.pending`）现在并入。`{ status: empty \| saved \| failed \| off }`，失败也是 200（轮次留着，tick 任务 `memory.flush` 在安静 10 分钟后再试）。2026-09-29 降本 |
| GET | `/v1/chat/greeting?star=&lang=` | 30 次 / 分钟 | 需登录。陪伴首页的问候语：按日本时间时段、她此刻的作息、天气、距上次聊天天数、亲密度与长期记忆生成，按用户 × 艺人 × JST 日 × 语言 × 时段 × 天气缓存（`{ text, cached }`）。她在睡觉时返回她被叫醒的台词（不调模型、不缓存）；有到期约定（±3 小时）或未提过的错过约定时，返回她兑现 / 轻提的台词与 `promise`，不缓存（#59）；告白日白天返回她的暗示（#55） |
| POST | `/v1/asr?lang=` | 20 次 / 分钟 | 需登录（#72）。body 为录音本身（`audio/webm|ogg|mp4|x-m4a|aac|mpeg|wav`，≤ `VOICE_INPUT.maxBytes` 1 MB）→ `{ text, lang }`。经 Worker 的 Workers AI Whisper 转写，不落库、不写日志、不扣聊天次数。413 `audio_too_large`、415 `unsupported_audio`、400 `empty_audio`、503 `asr_unavailable` / `asr_failed` |

内容被硬拦截时返回 422，`error` 为拦截原因（`minor` / `non_consent` / `real_world_contact`），不扣次数。

## 卡牌、抽卡、序列码、商店

| 方法 | 路径 | 限流 | 关键规则 |
|---|---|---|---|
| POST | `/v1/serial/redeem` | 10 次 / 10 分钟 | 实体幸运卡 12 位码 → `{ cards[6], trialDays, claimed, passUntil, drawId }`，第 1 张 SR 以上。访客也可兑换（卡挂在设备上，`claimed: false`）；一码一用，重复返回 409 `serial_already_used`；校验位错误 400 且不计失败；码不存在 404 `serial_not_found`，设备 5 次 / IP 20 次锁 10 分钟（429 `serial_locked`） |
| GET | `/v1/serial/history` | — | 需登录。兑换记录：这个账号兑换或从设备认领的每个码与抽到的卡 |
| POST | `/v1/gacha/draw` | 30 次 / 分钟 | 需登录。`{ pool, count: 1 \| 10, useFreePull }`：服务端抽卡，先原子扣费再抽；点数不足 402 `insufficient_points`，免费抽不足或十连用免费抽 409 `no_free_pull`。`pool` 可为 `all`、`star:<id>` 或 Pickup（`pickup:<cardId>:<YYYYMMDD>`，#78）：Pickup 仅期间内可抽，否则 409 `pool_closed`；用创建时写入的概率抽，抽卡日志的 `pool_id` 即 Pickup id，可复现。抽到变体卡写 `variant.drawn` |
| POST | `/v1/gacha/exchange` | 10 次 / 分钟 | 需登录。`{ cardId }`：用 `RULES.shardsForExchange` 个碎片换一张 SSR 或变体卡（#78）；不可兑换 400 `not_exchangeable`，碎片不足 402 `insufficient_shards`，并发 409 `draw_in_progress` |
| GET | `/v1/gacha/history` | — | 需登录。最近 180 天的付费抽卡、兑换与序列码记录，新的在前 |
| GET | `/v1/cards/:id/affection` | — | 需登录（#75）。变体好感 `{ cardId, star, owned, variant }`（`variant.pinned`：主页固定了这身，#76）；卡不存在 404 `card_not_found`，不是变体卡 404 `not_a_variant` |
| PUT | `/v1/cards/:id/home-pin` | 20 次 / 分钟 | 需登录（#76）。`{ pinned }`：把她的主页固定为这张变体卡的样子（或取消），返回同上。未持有 403 `not_owned`；固定需变体 10 级（`VARIANT_RULES.homePinLevel`），不到 403 `variant_level`；卡不存在 / 非变体 404 |
| POST | `/v1/shop/points`、`/v1/shop/pass` | — | 需登录。v1.0 / v1.1 不开售（`RULES.shopOpen = false`）：一律 404 `shop_closed`。开放后：正式环境 501 `use_checkout_flow`（只能走支付商流程），演示模式直接到账；点数必须是公布的点数包（400 `unknown_pack`） |

## v1.1：定时任务、收件箱与推送（#49 #50）

| 方法 | 路径 | 限流 | 关键规则 |
|---|---|---|---|
| POST | `/v1/ops/tick` | — | 只给 Cron Trigger（Worker 每 5 分钟带 `AGENT_API_KEY` 调用）；没有密钥时 404（演示模式本地可不带密钥手动调用）。按顺序运行全部任务并返回每个任务的状态（`TickRes`），见 `docs/architecture.md`「定时任务」 |
| GET | `/v1/inbox` | — | 需登录。已投递的收件（未读优先，最近 50 条）与未读数 `{ items, unread }`；`kind` ∈ `message` `promise_due` `wakeup` `event` |
| POST | `/v1/inbox/:id/read` | — | 需登录。标为已读（幂等，保留首次已读时间）；别人的 / 未投递的 / 不存在的 404。她的消息第一次打开时写入对话历史；约定窗口内打开 `promise_due` 即兑现，返回里带 `promise` |
| POST | `/v1/inbox/demo` | — | 仅演示模式。`{ star, text, inMinutes? }`：给自己塞一条她的消息，`inMinutes` 分钟后由下一次 tick 投递 |
| POST | `/v1/push/subscribe` | 20 次 / 10 分钟 | 需登录。`{ endpoint, keys: { p256dh, auth }, tz? }`：保存这台浏览器的订阅，`tz` 写入 `users.tz`。推送关闭（没有 VAPID 密钥）时 404 `push_disabled` |
| DELETE | `/v1/push/subscribe` | — | 需登录。`{ endpoint? }`：带 endpoint 只关这台浏览器，不带关掉全部；推送关闭时也可用 → `{ ok, removed }` |
| POST | `/v1/push/test` | 5 次 / 10 分钟 | 仅演示模式。`{ star? }`：给自己的全部设备发一条她的测试通知 → `{ sent, removed, failed }` |

推送内容只有她的名字和一句话（`PushPayload`），点击打开应用内的 hash 路由。

## v1.1：场景（#64 #65 #71，需登录）

| 方法 | 路径 | 限流 | 关键规则 |
|---|---|---|---|
| POST | `/v1/scene/start` | 20 次 / 分钟 | `{ sceneId, lang?, offerId?, preview? }` → `{ run, replayed }`。`preview: true` 仅演示模式：负责人预览五幕（#66–#70）或变体场景（#76），不校验时段 / 天气 / 作息 / 持有卡，未拍的片段用替身（正式环境 404 `scene_not_found`）。发布规则（`docs/requirements.md` §9.4）：正式环境只开始已审校且片段齐全的场景（目前五幕、20 个变体场景与系统场景都是），其余 404；演示模式下其余的也可不带 `preview` 正常开始，未拍片段同样用替身。变体场景（`variant-<star>-<层>`）在任何模式都校验持有该变体卡与变体好感等级 1 / 3 / 6 / 10。校验触发条件（时段、阶段、持有卡、她城市的真实天气、她此刻的作息）与点数门槛；同一场景已在进行中则返回该运行（`replayed: true`），其他场景进行中则先结束它（`replaced`）。演示场景、片段待拍的场景与台词改回草稿的场景仅演示模式可用（正式环境 404 `scene_not_found`）；条件不满足 403 `scene_locked`；告白场景另有 403 `confession_waiting` / `confession_tonight`；点数不足 402 `insufficient_points`。开始时写 `scene.trigger`（带 `offerId` 接受提议时为该提议的 proposed / time，告白为 proposed，其余为 request）与 `scene.start`；变体场景另写 `variant.scene_opened`（`{ star, cardId, layer }`，预览不写） |
| POST | `/v1/scene/step` | 60 次 / 分钟 | `{ runId, seq, step?, choice \| input \| minigame \| timeout, voiceMs? }`。`step`：这次回答的是哪一步（步骤 id，`seq` 为运行停在这一步时的值）；运行已不在这一步上（这一步已被处理，比如他抢先回答后、她那一步的倒计时才到点）= 重复提交，原样返回（`replayed: true`），绝不当作对当前等待那一步的回答（D-N2）。`voiceMs`：这次回答他对着麦克风说了多久（≤ `VOICE_INPUT.maxMs`），按步计入语音分钟一次（#74）；由客户端上报、服务端不核对（v1.1 的已知限制，见 `docs/requirements.md` §13.6），上限即每步 30 秒、每步一次。选项带 `pay: "extend"`（アリス 的「30分延長する」）时经语音账本扣点数延长（与 `POST /v1/voice/extend` 同一规则，按 `runId`+`seq` 幂等），扣点与运行前进在同一批次里、以 `seq` 为条件：这一步先被别的提交（倒计时、另一个标签页）推进了就不扣点（返回 `replayed: true`）；点数不足 402 `insufficient_points`、今日延长已满 409 `extend_limit`，运行不前进。`minigame.hand`（猜拳，她的手由服务端随机）或 `minigame.text`（夸奖 / 大喜利 / 讨价还价 / 弹幕，由 persona 服务 `POST /v1/scene/judge` 判定，失败按安全默认处理）；`run.result` 为最近一次小游戏结果（#66–#70）。`seq` 小于当前值 = 重复提交，原样返回（`replayed: true`）不再发奖；大于当前值 409 `stale_step`。倒计时未到的 `timeout` 409 `too_early`；已结束 409 `run_ended`；不合法的提交 400 `invalid_submission` / `unknown_option`。`input.mode = free` 的一步走聊天链路（计次数，拦截 422 不前进）；弹幕（`minigame.text`）不计次数（#68）。选项带 `gift`（#68 直播送礼）时 `gift` 字段给出他在礼物面板选的礼物（`gift: "pick"` 的选项必填），与运行前进在同一批次购买（规则同 `POST /v1/gift`）；点数不足 402 `insufficient_points`、今日已满 409 `gift_limit`，运行不前进；`run.result` 为 `{ kind: "gift", giftId, taste, xp }`。`run.live`：直播层是否开着（#68） |
| POST | `/v1/scene/end` | 30 次 / 分钟 | `{ runId, reason: left \| idle }`，不扣任何已发奖励 |
| GET | `/v1/scene/previews` | — | 仅演示模式：负责人预览的场景 `{ scenes: [{ id, star, title, pending, games }] }`：五幕（#66–#70，含奈々 的雨夜版），之后是 20 个变体场景（#76）；`pending` 为仍待拍的片段（含待机循环；#80、#81 合入后为空） |
| GET | `/v1/scene/preview/:id` | — | 仅演示模式：该场景脚本（未拍的片段换成她现有的 `<star>-hero` / `-breath` / `-night`）与替换表 `standIns` |
| POST | `/v1/scene/room` | 30 次 / 分钟 | `{ star, inboxId? }`：他进入她的房间、在房间安静一阵、或打开带 `sceneId` 的收件时调用 → `{ offer }`（`SceneOfferView`：`source` proposed / time、场景标题与片段、`expiresAt`）或 `null`。先看此刻的系统场景（约定、生日、天气、晚安），再按 `TRIGGER_RULES` 掷她的提议；只提供此模式可玩且条件满足的场景 |
| POST | `/v1/scene/offer/decline` | 30 次 / 分钟 | `{ offerId }`：「また今度」，该场景 `TRIGGER_RULES.declineCooldownMs` 内不再提 |
| GET | `/v1/scene/current?star=` | — | 当前进行中的运行（刷新 / 重连后继续），无则 `null` |
| GET | `/v1/scene/runs/:id` | — | 某次运行（含已结束的），刷新后看到同一个结局；不是自己的 404 `run_not_found` |

`run` 的形状是 `SceneRunView`：`beats`（本次要播放的步骤，含服务端生成的 `<step>~<option>` 选项奖励与 `<step>~reply` 她的自由对话回复）、`waiting`、`upcoming`（各分支的下一段片段，用于预加载）、`rewards`、`rewardable`、`affinityXp`。

## v1.1：关系、告白、称呼（#54 #55 #56，需登录）

| 方法 | 路径 | 限流 | 关键规则 |
|---|---|---|---|
| GET | `/v1/relationship` | — | `{ talents: RelationshipView[] }`，五位按 `STAR_IDS` 顺序：`stage`、`daysTogether`、`anniversary`、`loverLevel`、`hint`（她的提示用的键，文案在前端；不返回门槛数字）、`progress`（0–1，按亲密度）。处于 `confession_ready` 时带 `confession: { phase: due \| waiting \| open, sceneId, tonight, reachedToday }` |
| POST | `/v1/relationship/demo` | — | 仅演示模式。`{ star, stage }` 直接设定阶段（不发免费抽），同时重置告白进度，让称呼提问可以重来 |
| GET | `/v1/confession/memories` | — | 他的告白回忆：`{ memoryId, star, transcript, audio, createdAt }[]`，新的在前 |
| PUT | `/v1/confession/memories/:id/audio?consent=yes` | 10 次 / 分钟 | body = 录音（`audio/*`，≤ `CONFESSION_RULES.voiceMaxBytes`）。无 `consent=yes` → 400 `consent_required`；每条回忆只存一次（409 `audio_exists`）；413 `audio_too_large`、415 `unsupported_audio`；记录同意时间 |
| GET | `/v1/confession/memories/:id/audio` | — | 只返回给本人，`cache-control: private, no-store` |
| DELETE | `/v1/confession/memories/:id/audio` | — | 删除录音，保留文字与回忆卡 |
| GET | `/v1/bond?star=&lang=` | — | 她怎么叫他：`{ star, callName, callStage, ask, praise }`；`ask` 是她这次要问的新称呼（台词集改回草稿时仅演示模式），`praise` 是他夸过她各种样子的次数 |
| POST | `/v1/bond/call-name` | 20 次 / 分钟 | `{ star, to, accept, lang? }`：他对称呼提问的回答 → `{ reply, bond }`，写 `call_name.answered`；她没在问 409 `not_asking` |
| GET / PUT | `/v1/bond/name` | PUT 20 次 / 分钟 | 「呼び方」：`{ name }`（null = 用昵称）。含邮箱、链接、号码样式或超过 `BOND_RULES.nameMax` 字 400 `invalid_name` |

阶段只在服务端推进：聊天（`/v1/chat/send*` 的返回里带 `relationship`）、场景与礼物都会推进，规则见 `docs/requirements.md` §10.1。告白本身是场景（`POST /v1/scene/start { sceneId: "confession-<star>" | "confession-<star>-again" }`，`/v1/scene/step { input }`）：开始条件是 `confession_ready`、轮次对应的场景、不在等待期、JST 17:00 以后（演示模式不限时间）。他的回答由 persona 服务 `POST /v1/confession/judge`（`{ star, lang, text, ask }` → `{ answer, confident, source }`）判定，任何失败都按 `not_yet`。录音存在哪里由 API 决定（#51）：绑定了 R2 桶 `MEMORY` 时存进回忆存储（key `<userId>/confession/<memoryId>/<随机>`），否则以 base64 存在 D1 行内；存储暂时不可用时 PUT / GET / DELETE 返回 503，不会只存一半。

## v1.1：一天的循环（#57 #58 #59 #61，需登录）

| 方法 | 路径 | 限流 | 关键规则 |
|---|---|---|---|
| GET | `/v1/alarm` | — | `{ alarm }`：`{ star, time, days, enabled, tz, nextAt, updatedAt }`（`AlarmView`），没设过为 `null`。`tz` 是响铃用的时区（`users.tz`，否则保存时的时区） |
| PUT | `/v1/alarm` | 30 次 / 10 分钟 | `{ star, time: 'HH:MM', days: [0–6]（0 = 周日）, enabled, tz? }`：设定 / 修改 / 关闭（`enabled: false` 保留设定）。`tz` 为浏览器的 IANA 时区，同时成为 `users.tz`；未知时区忽略。当天时刻已过则从明天起。开启状态写 events `alarm.set`。门槛 `ACCESS.wakeup`（v1.1 `free`；改为 `pass` 后无月卡 402 `pass_required`） |
| POST | `/v1/alarm/wake/open` | — | `{ id, lang? }`（`wakeup` 收件的 id）：标为已读，返回她的叫醒话 `line` / `lineId` 与录音 `voice`（#83 预生成后才有，否则 `null` 只出字幕）、两个按钮的回话 `replies`（正式环境台词审校前为 `null`）与录音 `replyVoices`、`snoozeLeft`、`item` 与 `unread`。她的叫醒约定（#57 #66「明日の朝、起こしてあげる」，这次叫醒之前做的、到期在 ±18 小时内）在此兑现，`keptPromise` 为约定原文。每个早晨第一次打开写 `wakeup.opened`。不是他的或不是叫醒 404 `wake_not_found` |
| POST | `/v1/alarm/wake/snooze` | 10 次 / 10 分钟 | `{ id }`：「あと5分」，5 分钟后再来一条 `wakeup` 收件（同样推送）。每个早晨 1 次，已用 409 `snooze_used`；不是今天（他的时钟）的叫醒或闹钟已改 409 `wake_over` |
| GET | `/v1/her-messages/settings` | — | 她主动发消息的频率 `{ mode }`：`normal`（每天最多 `HER_MESSAGE_RULES.perDay` 条）/ `less`（`lessPerDay`）/ `off`（#58） |
| PUT | `/v1/her-messages/settings` | — | `{ mode }`，立即生效（已排好的消息发送前会再检查一次） |
| POST | `/v1/her-messages/demo` | — | 仅演示模式。`{ kind: note \| invite \| dream, star? }`：给自己排一条马上到期的消息（不看时段与上限），下一次 tick 生成并投递 → 202 `{ kind, star, dueAt }` |
| GET | `/v1/promises?star=&lang=` | — | 未完成的约定（按 due 排序，每位最多 1 条）`{ promises, proposal }`；带 `star` 且与她没有未完成约定时，`proposal` 为她对下一次的提议（台词集改回草稿时仅演示模式） |
| POST | `/v1/promises` | 20 次 / 分钟 | `{ star, lineId, lang? }`：用户对提议点「約束する」→ 201 `{ promise }`；已有未完成约定 409 `promise_open`，未知台词 404 `unknown_line` |
| POST | `/v1/promises/demo` | — | 仅演示模式。`{ star, inMinutes, lang? }`：一条 `inMinutes` 分钟后到期的约定（负数 = 已过期，用于验收「错过」）；她已有未完成约定 409 `promise_open` |
| GET | `/v1/calendar` | — | 不缓存。今天与五位各自是什么日子（#61）`{ talents: [{ star, events: [{ kind, count?, season? }] }] }`，按重要程度排序；`kind` ∈ `hisBirthday` `herBirthday`（仅事务所确认后）`anniversary` `monthiversary` `season` `herBirthdaySoon`。不含日期与年份 |
| POST | `/v1/calendar/demo` | 20 次 / 分钟 | 仅演示模式。`{ day: "YYYY-MM-DD" \| null }`：2 小时内把他的「今天」当作 `day`（首页、问候、聊天提示词），并把那天她的消息立即放进收件箱（下一次 tick 投递）→ `{ day, sent, talents }`；`null` 恢复 |

叫醒由 tick 的 `alarm.ring` 任务（排在 `inbox.deliver` 前）完成：到点写一条当下到期的 `wakeup` 收件，同一次 tick 投递并推送（点击落到 `/#/me/wake?star=&inbox=`）。`wakeup` 收件的 `payload` 为 `{ text, lineId, day, snooze? }`（`WakePayload`）。

## v1.1：她的世界与天气（#62 #63）

| 方法 | 路径 | 限流 | 关键规则 |
|---|---|---|---|
| GET | `/v1/world/cities?q=&lang=` | 30 次 / 分钟 | 需登录。按名称查城市级地点（最多 5 个，坐标取整到 0.1°）；经 Open-Meteo 地理编码 |
| PUT | `/v1/world/city` | 20 次 / 10 分钟 | 需登录。`{ id, lang? }`（搜索结果的 id）：服务端按 id 重新查询，只保存真实地名与 0.1° 坐标；非城市级地点 404 `city_not_found` |
| DELETE | `/v1/world/city` | — | 需登录。清除自己的城市（天气关闭时也可用） |
| PUT | `/v1/world/demo` | 20 次 / 分钟 | 仅演示模式，需登录。`{ star, weather: clear \| cloudy \| fog \| rain \| snow \| thunder, alert?: storm \| heavy_rain \| heavy_snow \| strong_wind \| heat, tempC?, firstSnow? }`：把她城市的天气临时改成指定值直到下一次刷新（#63 验收用）；家乡未确认时五位共用东京，改一位即改全部 |

天气关闭时 503 `weather_disabled`，Open-Meteo 不可用时 502 `weather_unavailable`。数据由 tick 的 `weather.refresh` 任务每小时刷新（`apps/api/src/jobs/refreshWeather.ts`）。她此刻的作息（#60）是纯函数（`routineNow`），前端直接计算，没有接口。

## v1.1：礼物（#77，需登录）

| 方法 | 路径 | 限流 | 关键规则 |
|---|---|---|---|
| GET | `/v1/gift?star=` | — | `{ star, gifts: [{ id, price, known }], sentToday, perDay, points }`：20 种礼物与价格；`known` = 他已经知道她喜欢（她在聊天里提过或他送过），她没说过的偏好不返回 |
| POST | `/v1/gift` | 20 次 / 分钟 | `{ star, giftId, cardId?, lang? }`：扣点数 + 每日上限 + 亲密度 xp（+ 变体 xp）一次原子写入 → `{ taste, wished, reaction, affinityXp, relationship, points, freePulls, sentToday, known, variant }`；点数不足 402 `insufficient_points`，每日上限 409 `gift_limit`，`cardId` 不是他拥有的她的变体卡 400 `invalid_card`；写 events `gift.sent` |

规则见 `docs/requirements.md` §14.3；礼物 xp 不算相处天数。

## v1.1：语音分钟与她的实时语音（#74 #73，需登录）

| 方法 | 路径 | 限流 | 关键规则 |
|---|---|---|---|
| GET | `/v1/voice` | — | `VoiceState`：`{ day, leftSeconds, usedSeconds, allowanceSeconds, extensions, extensionsLeft, extendCost, extendMinutes, tts }`（与 `/v1/auth/me.voice` 相同）。JST 0:00 重置 |
| POST | `/v1/voice/extend` | 20 次 / 分钟 | `{ requestId }`（客户端生成，8–80 位 `[A-Za-z0-9_:.-]`）：扣 `VOICE_RULES.extendCostPoints` 点，今日语音时间 + `extendMinutes` 分钟 → `{ voice, points, replayed }`。同一 `requestId` 重复提交返回 `replayed: true`，不再扣点；点数不足 402 `insufficient_points`；今日已延长 `extendsPerDay` 次 409 `extend_limit`；该 id 已用于别的计费 409 `request_conflict` |
| POST | `/v1/tts` | 60 次 / 分钟 | `{ star, line, sig, index, lang?, requestId }`：`line` 是服务端给她的原话（聊天回复带 `voiceSig`、场景台词带 `voiceSigs`），`sig` 是它的签名，`index` 是要第几句（`splitSentences`，`@jstar/shared/voice`）→ `{ mode: "voice", audio（base64）, mime, seconds, leftSeconds }` 或 `{ mode: "subtitle", reason, leftSeconds }`。只念她自己的话：签名对不上（他的文字、改过的台词、别的账号的）403 `not_her_line`；`{name}` 由服务端换成她对他的称呼。所有登录会员都可用（`VOICE_RULES.ttsRoles`，负责人 2026-10-02 决定），前提是配置了服务商（Fish Audio，`docs/tts.md`），否则 `off`；今日语音用完 `no_minutes`；服务商失败 `failed`；她没有克隆音色 `no_voice`（绝不用通用音色代替）。`subtitle` 不是错误，前端照常显示字幕。每个账号每分钟最多 40 句（429 `rate_limited`），句子越界 400 `bad_index`。合成的秒数（向上取整）按 `requestId` 计入语音分钟一次：请求 id 在调用服务商之前先记入账本，所以每个 id 只合成一次，重复提交（重试、另一个标签页）409 `request_conflict`、不再合成也不再计费；服务商失败时撤回这条记录，不计费，同一 id 可以再试 |
| POST | `/v1/tts/ticket` | 60 次 / 分钟 | 她的第一句流式播放（#188，`docs/tts.md`「Sentences, prefetch and what is charged」）。请求体、签名校验、语音分钟与限流都与 `POST /v1/tts` 相同 → `{ mode: "stream", url: "/v1/tts/stream/<id>", leftSeconds }` 或与 `/v1/tts` 相同的 `subtitle`。签票时即记入请求 id 并开始向服务商合成；票一次性、30 秒内有效，过期未取则中止合成并撤回记录（不计费）。她的话只留在服务端，不进 URL。服务商不能流式合成时 404 `no_stream`（改用 `POST /v1/tts`）；重复的 `requestId` 409 `request_conflict` |
| GET | `/v1/tts/stream/:id` | — | 凭 `/v1/tts/ticket` 给的一次性 URL（`<audio>` 带不了 Authorization 头，所以不需登录，票本身即凭证）取她这一句的 MP3（`audio/mpeg`，`cache-control: no-store, no-transform`），边合成边转发、不缓冲。按实际送到的 MP3 帧计秒：播完计全部；中途停下或离开计已送出的秒数；一帧都没送出则撤回记录、不计费。票不存在、已用过或已过期 404 `no_ticket`；服务商失败 502 `tts_failed`（不能流式时 404），前端改走整句 `POST /v1/tts` |

网页按句切分她的台词、逐句请求并播放（播放当前句时预取下一句），字幕随每句开始显示；任何 `subtitle` 回答都退回字幕。规则见 `docs/requirements.md` §13.6。

## v1.1：回忆资产与导出（#51，`docs/compliance-jp.md` §7.6）

| 方法 | 路径 | 限流 | 关键规则 |
|---|---|---|---|
| GET | `/v1/me/export` | 10 次 / 分钟；**每个 JST 日 1 次** | 需登录。返回 `MemoryExport`：`account`、`memories`（与「思い出」页同一列表，带 `kind` chat / scene / confession / promise 与 `sceneId`）、`confessions`（他的回答与录音的签名链接）、`promises`（全部状态）、`chats`（每位艺人最近 `MEMORY_RULES.exportChatPerTalent` 条）。`content-disposition: attachment; filename="jstar-memories-<JST 日>.json"`，`cache-control: private, no-store`。当天第二次 → 429 `export_limit`；生成失败不占用当天次数；写审计 `memories.export` |
| GET | `/v1/memories/file?u=&kind=&id=&exp=&sig=` | 全局 | 导出里的文件链接：不需要会话（签名即权限，HMAC 用从 `JWT_SECRET` 派生的独立密钥），`MEMORY_RULES.linkTtlMs`（24 小时，待确认）后失效；过期、被改、文件已删、账号已注销一律 404。以附件下载，`private, no-store` |

## 管理（需 admin 角色）

只能经 admin.jstarcards.ai 访问（Basic 认证网关 → 正式环境的 API）；公网主机上 `/v1/admin/*` 一律 404。普通用户 403 `forbidden`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET / PUT | `/v1/admin/cards` | 卡牌列表与编辑（标题、稀有度、来源、素材 URL）；写审计 `card.upsert` |
| GET / PUT | `/v1/admin/pickups` | Pickup（#78）：`{ cardId, startsAt, endsAt }`（ISO，含时区）排期或修改结束时间。只接受变体卡；期间 ≤ `PICKUP_RULES.maxDays`；同一张卡的期间不重叠；开始后只能改结束时间（提前结束 = 设为现在）；比例在创建时从 `PICKUP_RULES.share` 写入，之后不变。写审计 `pickup.create` / `pickup.update` |
| POST | `/v1/admin/serial-batches` | `{ label, quantity ≤ 10000, trialDays, draws }` 生成小批量幸运卡码（与印刷批次同一密钥），明文仅返回一次；印刷批次用 `tools/luckcards` 离线生成并导入 D1。写审计 `serial.batch` |
| GET | `/v1/admin/serials?code=` 或 `?id=` | 按顾客念出的码或印刷序号查码的状态（unused / redeemed / void，是否挂在设备上未认领） |
| POST | `/v1/admin/serials/:id/void` | `{ reason }` 作废一个未兑换的码（丢失、泄露、印错）；已兑换 409 `serial_already_used`。写审计 `serial.void` |
| GET | `/v1/admin/users?email=` 或 `?id=` | 客服查询：账号、钱包、持有卡、兑换过的码、最近 20 次抽卡 |
| POST | `/v1/admin/users/:id/grant` | `{ points, freePulls, reason }` 事故补填；写审计 `user.grant` |
| GET | `/v1/admin/audit` | 最近 200 条审计日志 |
| GET | `/v1/admin/moderation` | 审核队列：最近 200 条被硬拦截的聊天（每条 80 字摘录） |
| GET | `/v1/admin/metrics?grain=day\|week&days=1–180` | 「指標」（#52）：v1.1 五个成功指标、场景触发来源、7 日留存差的原始计数（按 JST 天或周一起算的周，补零），定义见 `MetricsCounts` 与 `docs/requirements.md` §16 |

没有在线修改卡池概率的接口：普通卡池的概率只在 `rules.ts` 里改（`docs/compliance-jp.md` §3）。

## 错误码

`unauthorized` `forbidden` `invalid_request` `challenge_required` `region_unavailable` `not_found` `invalid_code` `line_login_not_configured` `birthday_already_set` `invalid_birthday` `underage` `device_id_required` `trial_exhausted` `daily_limit` `agent_unavailable` `serial_not_found` `serial_already_used` `serial_locked` `insufficient_points` `no_free_pull` `pool_closed` `pool_empty` `not_exchangeable` `insufficient_shards` `draw_in_progress` `card_not_found` `not_a_variant` `shop_closed` `use_checkout_flow` `unknown_pack` `push_disabled` `audio_too_large` `unsupported_audio` `empty_audio` `asr_unavailable` `asr_failed` `scene_not_found` `scene_locked` `scene_conflict` `run_not_found` `stale_step` `too_early` `run_ended` `invalid_submission` `unknown_option` `confession_waiting` `confession_tonight` `consent_required` `audio_exists` `not_asking` `invalid_name` `pass_required` `wake_not_found` `snooze_used` `wake_over` `promise_open` `unknown_line` `weather_disabled` `weather_unavailable` `city_not_found` `gift_limit` `invalid_card` `export_limit` `extend_limit` `request_conflict` `not_owned` `variant_level`；管理接口另有 `user_not_found` `invalid_serial_format` `code_collision_retry` 与 Pickup 排期的 `pickup_overlap` `pickup_started` `window_too_long` `bad_window`。内容被硬拦截时返回 422，`error` 为拦截原因（`minor` / `non_consent` / `real_world_contact`）。
