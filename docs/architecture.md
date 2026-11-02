# 架构

## 四端职责

| 端 | 技术 | 职责 | 绝不负责 |
|---|---|---|---|
| `apps/web` | React 18 + TS + Vite | 展示、交互、四语言、离线原型模式 | 判定积分、抽卡结果、试聊次数 |
| `apps/api` | Fastify + TS + SQL（D1） | 身份、钱包、序列码、抽卡、审计、管理接口；v1.1：关系阶段、场景状态机、收件箱与定时任务、推送、天气、约定、闹钟、礼物、回忆资产、产品事件 | 生成人设回复、判断内容尺度 |
| `apps/admin` | React + Vite | 卡牌、Pickup 排期、序列码批次与查询 / 作废、客服查询与补填、审核队列、审计、「指標」、「Talent world」（只读） | 直接读写数据库 |
| `apps/agent` | FastAPI + Python | 人设提示词、记忆、内容边界、模型路由；v1.1：意图识别（场景、变体服装）、告白判定、她的消息、礼物反应 | 认识用户是谁、扣款、存任何数据 |

共用包 `packages/shared`：契约（`contracts.ts`）、业务数值（`rules.ts`）、世界配置（`world.ts`）、场景脚本与台词、日历、天气规则，web / API / admin 都从这里读；persona 服务读由它生成的 `apps/agent/app/world.json`。

拆成两个服务的原因：**内容边界要能被单独审计和单独改**。经纪公司或律师要看「尺度规则」时，看的是 `apps/agent/app/safety.py` 和 `apps/agent/app/personas/*.yaml`，不需要读业务代码。

## 一次聊天的路径

```
浏览器 ──POST /v1/chat/send/stream──▶ api ──POST /v1/chat/stream──▶ agent ──▶ OpenRouter（主模型 → 备用模型）
   ▲  NDJSON：delta… done              │  (Worker → agent.internal)     │
   └───────────────────────────────────┤                                ├─ 正则预过滤：确定的硬拦截直接结束
                                       │                                ├─ 入站读取（一次调用：安全分类 + 是否擦边 + 意图 / 情绪，带最近几轮上下文）与回复并行，放行前不出字
                                       │                                ├─ 记忆：到期才更新（第 5 条 / 约定或夸奖的线索 / 离开或安静时），回忆卡轮次之间只写标题
                                       │                                └─ 出站检查：正则逐段；LLM 整段只在需要时跑（被标记 / 擦边 / 长回复 / 正则线索），越界替换为人设婉拒
                                       └─ 写消息、保存长期记忆（没进记忆的轮次存 chat_memory.pending）、加亲密度、必要时生成回忆卡、返回
```

- 硬拦截（未成年、非自愿、索要住址/跟踪）在进入模型前就结束，不扣次数。
- 露骨请求、约见面/交换联系方式、越狱不报错，由人设用自己的语气婉拒，关系不中断。
- 被问「是不是本人」必须说明是本人公认的 AI；自伤话题转为关心并给出求助热线（日本 0570-064-556 / いのちの電話，台湾 1925）。
- 模型选型与评测见 `apps/agent/evals/RESULTS.md`；没有 `OPENROUTER_API_KEY` 时 agent 自动退回固定台词（stub），聊天照常可用。
- 非流式的 `/v1/chat/send`、`/v1/chat/trial` 保留，行为一致。
- **每轮成本（2026-09-29 降本，负责人批准）**：除回复外，普通的安全短回合只有 1 次 flash-lite 调用（入站读取）。原来是 4 次（入站分类、意图、记忆、出站检查）。三处改动与评测见 `apps/agent/evals/RESULTS.md`「降本」：
  - 入站分类与意图合并为一次调用（`apps/agent/app/inbound.py`），安全集拦截率、意图命中率与合并前一致；多出的 `borderline` 标记只用来决定是否要出站检查。
  - 记忆分批：他的第 5 条未入记忆的消息、出现约定线索（时间词）或在她的样子可夸时夸了她，才调用记忆模型，一次读完所有未入记忆的轮次；其间的轮次存在 D1 `chat_memory.pending`（迁移 0028），每轮随 `unsaved` 传回，重启不丢。离开聊天页时网页调 `POST /v1/chat/memory/flush`，漏掉的由 tick 任务 `memory.flush` 在安静 10 分钟后补上。访客试聊不存记忆，所以不调用记忆模型。回忆卡轮次若记忆未到期，只做一次写标题的小调用。
  - 出站 LLM 检查只在需要时跑（`engine.py` `outbound_needed`）：入站被标记（含正则软命中）或擦边、入站读取失败、回复长（ja 等 160 字 / en 360 字以上）、或回复碰到本地正则线索（邀约外出、电话、联系方式、床等，`safety.py` `OUTBOUND_CUES`）。正则逐段检查、自伤补热线、身份问题的 AI 说明照旧每轮都有。

## 一次抽卡的路径

客户端只发「抽几次」。服务端校验卡池、扣点数或免费次数、用带种子的随机数抽卡、落库并记录种子，最后返回结果。种子保留是为了纠纷时可复现（见 `compliance-jp.md`）。

## 存储

`apps/api/src/db/types.ts` 定义仓储接口，有两个实现：

- `memory.ts`：测试与本地开发，无需数据库。
- SQL（`src/db/sql.ts`，表结构 `migrations/`）：生产跑在 Cloudflare D1（容器经 Worker 的 `db.internal` 访问），测试在 SQLite 上跑同一套用例。

接口不变，所以换存储不影响业务模块。

## 状态与缓存

- 会话用 Bearer JWT（HS256），TTL 可配。
- 访客的试聊次数与未认领的卡存在设备记录（`devices` 仓储）里，注册时整体转入账号。
- 序列码失败锁定目前放在进程内 Map，多实例部署前要换成 Redis（代码里已标注）。
- 用户端的 localStorage 只是展示缓存：服务端模式下每次加载都会被 `/v1/auth/me`（或访客的 `/v1/device`）覆盖，篡改不会带来任何权益。

## 部署与出网（Cloudflare）

- 一个 Worker（`infra/cloudflare/src/index.ts`）同时服务网页静态文件与 `/v1/*`：正式 `jstar-web`（jstarcards.ai，`wrangler.jsonc`），测试站 `jstar-test`（test.jstarcards.ai，`wrangler.test.jsonc`，演示模式）。API 与 agent 各跑在一个 Container 里；push 到 main 部署测试站（也可对任意分支手动运行 Deploy test），正式环境只在打 `v*` tag 时部署。
- 管理后台 admin.jstarcards.ai 是另一个 Worker（`admin.wrangler.jsonc`，Basic 认证），经 service binding 进正式环境的 `AdminGateway`，是 `/v1/admin/*` 的唯一入口；公网主机上 `/v1/admin/*` 与 `/v1/ops/*` 一律 404。
- **API 容器没有外网**（`enableInternet = false`）。它要访问的一切都经 Worker 按主机名中转，Worker 只放行各自的固定目标：

| 容器里的地址 | Worker 做什么 | 绑定 / 密钥 |
|---|---|---|
| `agent.internal` | 转给 agent 容器 | `AGENT_API_KEY` |
| `db.internal` | 在 D1 上执行 SQL | D1 `DB`（`jstar` / `jstar-test`） |
| `mail.internal` | 发登录验证码邮件 | Email Service `EMAIL`（仅正式环境） |
| `turnstile.internal` | Turnstile siteverify | `TURNSTILE_SECRET`（未设 = 不验证） |
| `push.internal`（#50） | 把已加密的 Web Push 转给推送服务，只放行 FCM / Mozilla / Apple / Windows 的域名 | 无（VAPID 签名在 API 里完成） |
| `weather.internal`（#62） | 只转发 Open-Meteo 的 `GET /v1/forecast`、`/v1/search`、`/v1/get` | 无（免费档无密钥） |
| `asr.internal`（#72） | Workers AI `@cf/openai/whisper-large-v3-turbo` | Workers AI `AI` |
| `memory.internal`（#51） | R2 私有桶的存 / 取 / 删与按用户前缀清空，不能列举 | R2 `MEMORY`（`jstar-memory` / `jstar-test-memory`）+ `AGENT_API_KEY` |

- 对应的绑定不存在时，API 拿不到那个地址，功能自动关闭而不是报错：没有 VAPID 密钥 = 不推送，没有 `AI` = 无服务端识别（`/v1/config.asr=false`），没有 `MEMORY` = 录音存在 D1。agent 容器保留外网（直连 OpenRouter）。

## 定时任务（#49）

Cron Trigger 每 5 分钟（`triggers.crons: */5 * * * *`）调用 API 的 `POST /v1/ops/tick`（带 `AGENT_API_KEY`），结果写进 Workers 日志 `{"event":"tick",…}`。副作用：API 容器因此常驻，不再进入 8 小时休眠。

- `apps/api/src/lib/tick.ts` 依次运行 `apps/api/src/jobs/index.ts` 的 `JOBS`。每个任务先在 `job_runs` 里条件抢占（重叠的 tick 不会同时跑同一个任务，`everyMs` 控制最小间隔，崩溃未收尾的任务 10 分钟租约后可再跑）；整次 tick 上限 25 秒（`TICK_BUDGET_MS`），超时的任务被中止、剩下的留到下一次；一个任务出错只记日志与 `job_runs`，后面的照跑。任务本身必须幂等。
- 写收件的任务排在 `inbox.deliver` 之前，所以同一次 tick 就能投递并推送：

| 顺序 | 任务 | 间隔 | 做什么 |
|---|---|---|---|
| 1 | `promises.due`（#59） | 每次 | 到期的约定写 `promise_due` 收件；超过窗口的标为 missed |
| 2 | `alarm.ring`（#57） | 每次 | 到点的闹钟写 `wakeup` 收件 |
| 3 | `weather.events`（#63） | 约 10 分钟 | 用上次存下的天气写初雪 / 台风 / 雨夜消息 |
| 4 | `calendar.greet`（#61） | 约 15 分钟 | 生日、纪念日、季节第一天的她的消息 |
| 5 | `confession.invite`（#55） | 每次 | 进入 `confession_ready` 的那天，她先发一条告白邀请 |
| 6 | `variant.invite`（#76） | 约 5 分钟 | 他第一次得到她的变体卡的那晚（18:00–05:00 JST），她发一条「新しい服、届いたの」邀约，每人每卡一次 |
| 7 | `her-messages.plan`（#58） | 约 15 分钟 | 为他的本地日排好今天的梦 / 日常 / 邀约 |
| 8 | `her-messages.send`（#58） | 每次 | 调 persona 服务写到期的那条（每条最多一次模型调用），失败用预设台词 |
| 9 | `inbox.deliver`（#49） | 每次 | 投递到期的收件并推送（`app.sendPush`） |
| 10 | `events.purge`（#52） | 约 6 小时 | 删除超过 180 天的产品事件，一次一天 |
| 11 | `memories.assets`（#51） | 约 1 小时 | 退会用户的文件清理重试、旧 base64 录音迁入 R2、保留期（默认关闭）、一周前的导出记录 |
| 12 | `weather.refresh`（#62） | 每次（每个点约 1 小时） | 刷新到期的天气点；放最后，慢的外部服务只占用剩余时间 |

- 新任务 = `src/jobs/` 下一个文件 + `JOBS` 里一行。本地演示模式可以不带密钥手动 `curl -X POST localhost:8080/v1/ops/tick`；测试站与正式环境只能等 cron。

## persona 服务的接口

API 是唯一的调用方（`Authorization: Bearer AGENT_API_KEY`，`apps/agent/app/main.py`）。它不存任何数据：记忆、约定、称呼都由 API 每轮传入，更新由 API 保存。

| 路径 | 用途 |
|---|---|
| `POST /v1/chat`、`/v1/chat/stream` | 一轮聊天（流式为 NDJSON）。除回复外，同一轮并行产出：意图（`directive`：要求的场景、场景内转向、变体服装，#65 #78）、回忆卡标题；记忆到期的轮次还有记忆更新（facts / 摘要 / `favorite_ways`）、听到的约定（#59）、他夸了她哪种样子（`praised`，#56），以及 `memorySaved`（本轮和 `unsaved` 是否都已进记忆）。v1.1 的请求带上关系阶段、称呼、她此刻的作息、天气与今天的节点、未完成的约定、他知道的偏好；降本后另带 `memoryMode`（`batch` 用户 / `off` 访客）与 `unsaved` |
| `POST /v1/memory/flush` | 他离开聊天或对话安静下来时，把还没进记忆的轮次（`unsaved`）一次并入 facts / 摘要；模型失败返回 `saved: false`，API 保留这些轮次下次再试 |
| `POST /v1/greeting` | 陪伴首页的问候 |
| `POST /v1/confession/judge`（#55） | 判定他对告白的回答：accept / not_yet / decline；任何疑问都是 not_yet |
| `POST /v1/scene/judge`（#67–#70） | 五幕小游戏里他的回答：夸奖分级、大喜利打分与点评、讨价还价、弹幕分类；判不出来时按安全默认（泛泛 / 不及格 / 不读原文） |
| `POST /v1/her-message`（#58） | tick 用：她主动写的一句（`HER_MESSAGE_MODEL`，默认同记忆模型）；不合格时返回 null，由 API 用预设台词 |
| `POST /v1/gift`（#77） | 她收到礼物的 1–2 句反应，知道合不合她的口味 |
| `GET /v1/personas`、`GET /healthz` | 人设列表（含 `draft`）与健康检查 |

模型（`infra/cloudflare/src/index.ts`，评测见 `apps/agent/evals/RESULTS.md`）：聊天 `deepseek/deepseek-v4.1-flash@deepseek`，4 秒未开始回答或出错时切到 `qwen/qwen3.7-plus`；安全分类与记忆 `google/gemini-3.1-flash-lite`。全部经 OpenRouter；没有 `OPENROUTER_API_KEY` 时退回固定台词（stub）。

## 回忆存储（#51）

- 他的文件（告白的录音，之后是场景截图）在私有 R2 桶：正式 `jstar-memory`、测试站 `jstar-test-memory`，绑定名都是 `MEMORY`。桶不开公开访问、不绑域名、不设 CORS；**正式桶必须在打包含该绑定的 `v*` tag 之前创建**，否则部署失败（`infra/cloudflare/README.md`）。
- API 只经 `memory.internal` 访问（`apps/api/src/lib/memoryAssets.ts`）：按 key 存 / 取 / 删，key 一律 `<user_id>/…`；退会时按用户前缀清空。用户拿到文件只有两条路：带会话的 API，或他导出文件里 24 小时有效的签名链接。
- 未绑定桶时录音以 base64 存在 D1（`confession_voice.audio`）；绑定后在下一次读取或 tick 时迁入 R2。
- R2 不随 D1 的 Time Travel 回滚，见 `docs/security.md`「数据恢复」。

## Web Push（#50）

- 前端：`apps/web/public/sw.js` 只处理 `push` 与 `notificationclick`，**没有 fetch 处理、不做任何缓存**，API、视频的 Range 请求都照常直连网络。manifest 让网站可安装；iOS 只有「添加到主屏幕」后才能收推送，未安装时「マイ」里显示三步引导。
- 订阅存在 `push_subscriptions`（`0009_push.sql`，一行一个浏览器，endpoint 为键），订阅时上报的时区写入 `users.tz`。
- 发送：`app.sendPush(userId, payload)`（`apps/api/src/lib/push.ts`）用 VAPID 签名并按 RFC 8291 加密，容器没有外网，经 Worker 的 `push.internal` 转发，Worker 只放行 FCM / Mozilla / Apple / Windows 的推送域名。推送服务回 404/410 即删除订阅，其他失败记 `failed_at`。
- 通知内容只有她的名字和一句话（`herPush()`），不含聊天原文；点击打开 `/#/me/home?star=<她>`。
- 没配 `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` 时推送整体关闭：`/v1/config` 不给公钥，前端不出现开关，API 照常运行。

## 天气（#62）

- 数据源 Open-Meteo（免费、无密钥；日本境内默认模型融合气象厅 MSM）。容器没有外网，经 Worker 的 `weather.internal` 转发，Worker 只放行三条 GET 路径到 Open-Meteo 的固定域名。
- tick 的 `weather.refresh`（`apps/api/src/jobs/refreshWeather.ts`，JOBS 最后一个）每次只取到期的点：她的城市（`world.ts` 的 `weatherPoint`，未确认的出生地退回东京）与用户城市的 0.1° 方格，约每小时一次，一次请求最多 50 个点。
- 失败不清数据：只记 error，15 分钟后重试；超过 3 小时未更新 `stale: true`，读取方视为无天气。
- 规则（天气分类、预警阈值、初雪的寒候年、过期判定）在 `packages/shared/src/weather.ts`；接口 `GET /v1/world`。

## 天气进入她的世界（#63）

- 房间：陪伴首页按她城市的真实日出日落调色（`tod-*` 跟随 `sunPhase`，拿不到天气时仍按访客时钟），雨 / 暴风雨 / 雪 / 樱花季 / 午后酷热是 CSS 图层（`apps/web/src/components/weatherRoom.tsx`，独立懒加载 chunk，只在有东西要画时加载），只用 `transform` 动画；纹理是运行时生成的 SVG 小图块。reduced-motion 下不渲染任何动画层，只保留调色、玻璃上的雨滴和静止的雪。雨声由 `audioEngine.ts` 的噪声源合成，只在声音开启时播放。显示天气处都标注 Open-Meteo（CC BY 4.0）。
- 对话：API 从自己存的天气组装 `world`（`apps/api/src/lib/herWorld.ts`）随每轮聊天、场景内自由对话与首页问候发给 persona 服务，从不信任浏览器。出生地未确认时不传城市名，提示词要求她只说「这里」；用户设置了城市时附上他的天气，天气不同则要求她在前几轮里轻轻对比一次；没设置就不提。数据过期（stale）时不传。问候缓存按「日期 + 语言 + 她会先说的天气」区分，下雨后再进房间会重新生成、第一句提到雨。
- 场景：`trigger.weather` 按她城市的真实天空判定（`sceneWeatherOf`：雷雨算雨、雾算阴），天气未知或过期视为不满足；奈々「雨夜朗读」的片段（#80）合入前按发布规则只在测试站开放（`docs/requirements.md` §9.4）。
- 事件：tick 的 `weather.events`（`apps/api/src/jobs/weatherEvents.ts`，排在 `inbox.deliver` 之前，读上一次刷新存下的天气）用 #82 的台词写收件箱：初雪（每个寒候年一次）、台风 / 强风 / 大雨预警（她担心他）、雨夜（入夜后下雨，同一位每 3 天最多一次）。只发给 7 天内进过她房间的用户（`room.entered`），当地 7–23 点，每位每天至多一条、每个用户每天至多两条；行 id 由「用户 + 她 + 事件」派生，重复写入被主键挡掉。台词已审校（#84），正式环境与测试站都发；台词集改回 `draft` 时只在测试站（demo 模式）发。
- 测试站验收：`PUT /v1/world/demo`（仅 demo 模式、需登录）把她城市的天气临时改成指定天空 / 预警 / 初雪，直到下一次整点刷新；首页 `?wx=rain|snow|storm|sakura|hot` 只画图层（原型与测试站）。

## 语音输入（#72）

- 前端 `apps/web/src/lib/voice.ts`：按住麦克风说话、松开发送；短按 = 开关（键盘 Enter / Space 同）；说完静音 1.2 秒自动停、最长 30 秒、8 秒没声音放弃（`packages/shared/src/voice.ts`）。一按下就停掉她的语音和当前台词（场景里其后的台词也跳过，直到轮到他）。识别出的文字走与打字完全相同的聊天 / 场景链路，所以记忆只有一份。
- 识别器按浏览器选：有 `SpeechRecognition`（Chrome、Edge、Safari）就用浏览器自带的，边说边出字；没有（Firefox、部分内置浏览器）或 iOS 关了听写（`service-not-allowed`）时，用 MediaRecorder 录一段交给 `POST /v1/asr`。两者都没有就不显示麦克风，只留文字。
- `POST /v1/asr`（会员、20 次 / 分钟、≤ 1 MB、`audio/webm|ogg|mp4|wav`）：API 容器没有外网，经 Worker 的 `asr.internal` 交给 Workers AI `@cf/openai/whisper-large-v3-turbo`（同一个 Cloudflare 账号，`ai` 绑定，无需新密钥）。音频只在内存里过一遍，不落库、不写日志；识别失败不扣聊天次数。Worker 没有 `AI` 绑定时 `ASR_URL` 为空，`/v1/config.asr=false`，前端不提供录音兜底。
- 麦克风权限只在第一次按下时由浏览器询问；被拒绝时提示并把焦点移到文字框。页面本身不下发 `Permissions-Policy`（默认允许同源用麦克风）；API 的 `microphone=()` 只作用于 API 响应，保留。
- 所有业务数值只在 `packages/shared/src/rules.ts` 定义，API 执行、用户端原型模式照同一份规则模拟。
