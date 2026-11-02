# 数据模型

权威定义见 `apps/api/migrations/`（D1 / SQLite），行类型见 `apps/api/src/db/types.ts`；这里是每张表的要点。时间一律是 ISO-8601 字符串（UTC），`day` 类字段是 `YYYY-MM-DD`（JST，除非注明是他的本地日）；JSON 列整列读写。

迁移编号：`0001`–`0012`、`0014`–`0016`、`0018`–`0021`、`0025`–`0028`。`0013`、`0017`、`0022`–`0024` 是并行分支预留后未使用的编号，D1 按文件名顺序执行，空号不影响。

## v1.0

| 表（迁移） | 关键字段 | 说明 |
|---|---|---|
| `users`（0001，0002 加列，0009 加 `tz`） | id、email / line_sub（唯一）、nickname、via（email / line）、lang、role（user / admin / moderator）、banned、age_confirmed_at；钱包 points、free_pulls（均 CHECK ≥ 0）、pass_until；聊天计数 chat_day / chat_used_today；v1.0 的 pity、shards、last_draw_id、login_day、check_month / check_days / check_claimed（JSON）、birthday、deleted_at；v1.1 的 tz | 钱包在用户行上，扣减与发放都是仓储层的单步条件语句。`birthday` 是注册后确认的生年月日（§2）。`tz` = 浏览器上报的 IANA 时区（开通知或保存闹钟时），为空按 JST。退会时不删行，而是匿名化（见文末） |
| `devices`（0001） | id、trial_used | 访客的浏览器：试聊已用条数 |
| `device_redemptions`（0001） | serial_id 主键、device_id、card_ids（JSON）、trial_days | 访客兑换的码，注册时认领进账号 |
| `otps`（0001） | email 主键、code、expires_at、attempts | 邮箱验证码 |
| `serial_batches`（0001） | id（`2026A`）、label、quantity、trial_days、draws | 印刷批次与后台生成的小批量；体验天数与抽数按批次配置 |
| `serials`（0001） | id（印刷序号）、code_hash（唯一）、batch_id、redeemed_by_user、redeemed_by_device、redeemed_at、draw_id | 只存 `HMAC-SHA256(SERIAL_HMAC_KEY, 码)`；核销是一条带 `redeemed_at IS NULL` 条件的更新，并发只成功一次。作废 = `redeemed_by_device = 'void'` |
| `cards`（0001） | id、data（JSON `CardDef`） | 150 张目录，启动时按 `packages/shared/src/catalog.s1.json` 写入（`seedCatalog`）；变体卡的 `variant` 由配置附加（`docs/catalog-spec.md`） |
| `pools`（0001） | id、data（JSON） | 卡池行。普通卡池（「全員」与每位）的概率由 `RULES.rates` 计算，不存在库里；**Pickup**（#78）存在这里，id 为 `pickup:<cardId>:<YYYYMMDD>`，创建时写入 share 与起止时间，之后概率不变 |
| `owned`（0001，0027 加索引） | (user_id, card_id) 主键、copies、first_owned_at、via_serial | 重复获得累加 copies，用于「覚醒」。索引 `owned_card_first (card_id, first_owned_at)`：tick 的 `variant.invite`（#76）按卡查今晚新得到变体卡、还没收到邀约的人（`owned.uninvited`：NOT EXISTS 该用户带 `vi_` 前缀且 payload.cardId 相同的 inbox 行，并排除封禁 / 已退会账号；每次最多 500 人，已邀约的下一次自然排除，所以一晚超过 500 人也会逐次发完） |
| `memories`（0001，0025 加列） | id、user_id、star、title、created_at；#51 的 kind（chat / scene / confession / promise）、scene_id、still | 回忆卡。聊天每 3 条、场景结局、告白的「是」、兑现的约定各生成一张；聊天卡标题由模型概括，不截取原话。`still` 预留给场景截图在回忆存储里的 key；0025 把可精确识别的旧卡回填为对应类型 |
| `messages`（0001） | n（自增，保序）、id、owner_id、star、role（user / assistant）、text | 聊天历史，按 (owner_id, star, n) 建索引取最近 N 条。她的消息、称呼提问、礼物反应也以 assistant 消息写入 |
| `chat_memory`（0003） | (owner_id, star) 主键、facts（JSON）、summary、greeting_day / lang / text | 长期记忆：称呼、生日、喜好、职业等短事实 + 滚动摘要，由 agent 分批更新（到期的轮次与离开 / 安静时）、API 保存；v1.1 的 facts 另有 `her_wishes`（他知道的她的偏好，只由 API 写）、`favorite_ways`（他喜欢的相处方式）。同表缓存当天的陪伴首页问候语。`pending` / `pending_at`（0028，2026-09-29 降本）：记忆分批更新，还没进记忆的轮次（他和她的，`{id, role, text}` 的 JSON 数组，最多 40 条）与最新一条的时间；每轮随 `unsaved` 交给 agent，进了记忆就按 id 移除 |
| `affinity`（0001） | (user_id, star) 主键、xp | 累计亲密度；每 40 xp 一级（只作展示）。v1.1 起关系阶段按它判定门槛，不再按级发免费抽 |
| `draws`（0001） | n、id、owner_id、pool_id、serial_id、card_ids（JSON）、tiers（JSON）、cost、seed | 每次抽卡、序列码兑换与碎片兑换（`pool_id = 'exchange'`）的种子与结果，纠纷可复现 |
| `audit`（0001，0004 加索引） | n、id、actor_id、action、target、meta（JSON） | 管理操作与敏感操作留痕（`card.upsert`、`serial.batch`、`serial.void`、`user.grant`、`pickup.create` / `pickup.update`、`account.delete`、`memories.export`、`chat.blocked` 等）；`(action, n)` 索引供审核队列 |

## v1.1

| 表（迁移，issue） | 关键字段 | 说明 |
|---|---|---|
| `inbox`（0006，#49） | id、user_id、star、kind（message / promise_due / wakeup / event）、payload（JSON，`text` = 她的话，可带 `sceneId`）、due_at、delivered_at、read_at | 她主动发来的一切：她的消息、约定到期、叫醒、节点与天气消息、告白邀请、抽到变体卡当晚的邀约（id `vi_<hash(user, card)>`，每人每卡一条，#76）。任务提前写好 `due_at`，tick 的 `inbox.deliver` 用一条条件更新投递，同一行只投递一次；只显示已投递的。部分索引只覆盖未投递行。退会时删除 |
| `job_runs`（0006，#49） | job 主键、started_at、finished_at、ok、error、result（JSON）、last_ok_at、runs | 每个 tick 任务一行。开始任务是一次条件 upsert，两次重叠的 tick 不会同时跑同一任务；崩溃未收尾的任务 10 分钟租约后可再跑 |
| `relationship`（0007，#54） | (user_id, star) 主键、stage、stage_since / stage_day、days_together、last_day、confessed_at、anniversary、lover_xp、reward_rank、rev | 与每位艺人的关系阶段。相处天数每个 JST 日只加一次（条件 upsert）；阶段变化以 `rev` 为条件，免费抽与之同一事务写入，`reward_rank` 保证不重复发；老用户由 0007 按原等级折算。`last_day` 另有索引供她的消息选人（0019），`stage = 'confession_ready'` 的部分索引供告白邀请（0018）。退会时删除 |
| `events`（0008，#52） | n、user_id（可为空）、name、props（JSON，`json_valid`）、day（JST）、created_at | 服务端写入的产品事件，供 admin「指標」页；props 只放 id 与枚举（`EVENT_PROPS`），不含聊天文本；保留 180 天按天删除（tick 的 `events.purge`）；退会后 `user_id` 置空 |
| `push_subscriptions`（0009，#50） | endpoint 主键、user_id、keys（JSON p256dh / auth）、tz、created_at、failed_at | 一行一个开了通知的浏览器；同一浏览器换账号登录时行随之转移。推送服务回 404/410 即删除，其他失败记 `failed_at`。退会时删除 |
| `scene_runs`（0010，#64） | id、user_id、star、scene_id、step、seq、state（JSON `RunState`）、rewarded、started_at / updated_at / ended_at、outcome | 一次场景运行。`seq` 计已接受的回答，每次变更都以它为条件；奖励与运行变更同一事务；每人最多一个进行中的运行（部分唯一索引）。退会时删除 |
| `weather`（0011，#62） | city_key 主键、lat / lon、fetched_at、tried_at、error、data（JSON `WeatherData`） | 天气点：她的城市（`tokyo`、`nagano`…，未确认的家乡退回东京）与用户城市的 0.1° 方格（`ll:25.1,121.5`）。失败只记 error、保留上次数据；超过 3 小时标记 stale；无人再选的方格由下一次 tick 删除。不含个人数据 |
| `weather_first_snow`（0011，#62） | (city_key, winter) 主键、day | 初雪：每个点每个寒候年（8 月–次年 7 月，以结束年命名）只记一次 |
| `user_cities`（0011，#62） | user_id 主键、name、lat / lon（取整到 0.1°）、updated_at | 用户自选城市，只到城市级别，只用于天气；可清除，退会时删除（`docs/compliance-jp.md` §7.1） |
| `card_affection`（0012，0027 加列，#75 #76） | (user_id, card_id) 主键、xp、level（到达过的最高级 1–10）、kokoro、home_pinned、updated_at | 变体好感。第一次得到变体 xp（或第一次固定主页）时建行，没有行 = 1 级。`home_pinned` = 他把她的主页固定为这身（10 级起，`PUT /v1/cards/:id/home-pin`）。哪些卡是变体是配置（`VARIANT_CARDS`），不是列。退会时删除 |
| `alarms`（0014，#57） | user_id 主键、star、time_local（`HH:MM`）、days（星期位掩码，127 = 每天）、enabled、tz、last_day、snoozes、ring_token、created_at / updated_at | 叫醒闹钟，每人一个。`last_day` 的条件写入保证每个本地日最多响一次；`users.tz` 有值时优先于 `tz`。退会时删除（`docs/compliance-jp.md` §7.2） |
| `promises`（0015，#59） | id、user_id、star、text、due_at、kind（wakeup / message / scene / free）、status（open / kept / missed）、source（chat / proposal / scene）、made_at、kept_at、source_msg_id、scene_id、lang、notified_at、missed_at、mentioned_at | 约定（`docs/requirements.md` §11.4）。每位艺人最多 1 条 open（部分唯一索引 `idx_promises_open`）；状态变更都是单条条件语句；到期的 inbox 行 id 为 `inb_<promiseId>`，只写一次。退会时删除 |
| `scene_offers`（0016，#65） | id、user_id、star、scene_id、source（proposed / time）、status（open / accepted / declined）、created_at、expires_at、answered_at | 她的提议与「此刻」的场景提供；接受它的开始把来源记进 `scene.trigger`，这些行也承载 `TRIGGER_RULES` 的每日上限、间隔与「また今度」冷却。退会时删除 |
| `confessions`（0018，#55） | (user_id, star) 主键、tries、last_answer（accept / not_yet / decline）、answered_days / answered_on、invited_round / invited_inbox、reached_round / reached_on | 告白的轮次与他的回答（条件写入，不重复计数、不重复发消息）。退会时删除 |
| `confession_voice`（0018，0025 加 `audio_key`，#55 #51） | memory_id 主键、user_id、star、transcript、audio_type、audio（base64）、audio_key、consented_at、created_at | 他的「是」的回忆与可选录音，只给本人读取。`audio_key` = 录音在回忆存储（R2 `MEMORY`）的 key `<user_id>/confession/<memory_id>/<随机>`；为空而 `audio` 有值 = 仍是 D1 内 base64（未绑定桶时的做法），下次读取或 tick 时迁入。退会时删除（`docs/compliance-jp.md` §7.3） |
| `her_messages`（0019，#58） | (user_id, day, kind) 主键、star、inbox_id、due_at、status（planned / writing / sent / skipped）、tried_at、sent_at、source（model / fallback）、reason、created_at | 她的消息，`day` 是他的本地日，一天每种一条。状态变更都是单条条件语句，模型每条最多调用一次；发送与 inbox 行同一事务；保留 30 天。退会时删除 |
| `her_message_prefs`（0019，#58） | user_id 主键、mode（normal / less / off）、updated_at | 「我的」里的频率设置；没有行 = normal。退会时删除 |
| `gifts`（0020，#77） | id、user_id、star、gift_id、card_id、price、xp、taste（liked / plain / disliked）、day（JST）、created_at | 送出的礼物（`docs/requirements.md` §14.3）。与扣点数、亲密度 xp 同一批次写入，插入语句本身检查每日上限与余额；按 (user_id, day) 建索引。退会时删除 |
| `call_names`（0021，#56） | (user_id, star) 主键、stage（new / familiar / lover）、asked、last_answer（accepted / declined）、answered_at | 他答应的称呼阶段与她问到的最高阶段；回答以 `asked` 为条件 upsert，两个标签页同时回答只记一次。退会时删除 |
| `look_praise`（0021，#56） | (user_id, star, look) 主键、count、last_at | 他夸过她哪种样子（outfit / face / 变体卡 id）几次，不存原话（`docs/compliance-jp.md` §7.4）。退会时删除 |
| `call_name_prefs`（0021，#56） | user_id 主键、name、updated_at | 「呼び方」：他希望五位怎么叫他。退会时删除 |
| `memory_exports`（0025，#51） | (user_id, day) 主键、created_at | 他的导出，每个 JST 日一行（主键保证一天一次）；一周后由 tick 删除；退会时删除 |
| `voice_ledger`（0026，#74 #73） | (user_id, request_id) 主键、day（JST）、kind（tts / input / extend）、seconds、points、nonce、created_at | 语音分钟账本（`docs/requirements.md` §13.6）：她的实时语音秒数、他在场景里的语音输入秒数、用点数买的延长。今日余额 = 当天各行之和，JST 0:00 自然重置；按 (user_id, day) 建索引。`request_id` 主键保证同一请求只计一次；延长的扣点与插入同一批次，只在本次写入的行（`nonce`）存在时扣点，重复提交不重复扣。退会时删除 |
| `memory_purges`（0025，#51） | user_id 主键、requested_at、tried_at | 退会时与删除同一事务写入：回忆存储里 `<user_id>/` 下的文件待删；全部删完才删这一行，失败由 tick 每小时重试 |

## 迁移与索引要点

- `serials.code_hash` 唯一索引，核销用 `UPDATE … WHERE id = ? AND redeemed_at IS NULL` 保证并发下只成功一次。
- `messages` 按 (owner_id, star, n) 建索引，取最近 N 条；`n` 保证同一时刻的消息与回复顺序不乱。
- `draws` 按 (owner_id, n) 与 serial_id 建索引，用于客服查询与兑换记录。
- 部分唯一索引承载业务约束：每人一个进行中的场景（`idx_scene_runs_active`）、每位艺人一条未完成约定（`idx_promises_open`）。
- 只看「还在等待」的行的部分索引：`idx_inbox_due`、`idx_promises_due`、`idx_her_messages_due`，表再大也保持很小。

## 退会（`users.anonymise`）

一个事务内：用户行抹去邮箱、LINE id、昵称、生日与时区并封禁（行保留，兑换过的码与抽卡记录仍可审计）；删除 messages、chat_memory、memories、inbox、push_subscriptions、scene_runs、scene_offers、card_affection、user_cities、relationship、promises、alarms、confessions、confession_voice、her_messages、her_message_prefs、gifts、voice_ledger、call_names、look_praise、call_name_prefs、memory_exports；events 的 `user_id` 置空；写入 `memory_purges`，随后删除回忆存储里该用户的文件。`owned`、`affinity`、`draws`、`serials`、`audit` 保留在匿名化后的账号下。
