# JSTAR — 授权艺人卡牌 + AI 陪伴平台

一个 monorepo，包含四端：面向用户的 Web、后端 API、管理端、以及 AI 人设（agent）服务。

```
jstarcardsai/
├─ apps/
│  ├─ web/      用户端（React + TypeScript + Vite）四语言、移动优先、桌面适配
│  ├─ api/      后端（Fastify + TypeScript + D1/SQLite）身份、序列码、抽卡、积分、管理接口
│  ├─ admin/    管理端（React + Vite）卡牌、卡池、序列码批次、审计日志
│  └─ agent/    AI 人设服务（Python + FastAPI）人设提示词、记忆、内容边界、模型路由
├─ packages/
│  └─ shared/   四端共用：领域模型、API 契约（zod）、序列码与抽卡逻辑
├─ tools/
│  └─ luckcards/  实体幸运卡印前工具：验证码批次、卡池配额、通用二维码、打样表（产物含密钥，不进 git）
├─ docs/        架构、接口、数据模型、安全、日本合规、多语言、素材规格、测试报告、路线图
└─ infra/       docker-compose、Dockerfile、nginx（含 CSP 头）
```

## 演示（给合作方看的版本）

```bash
npm install
pip install -e "apps/agent[dev]"
npm run demo       # agent :8100 + API :8080（演示模式）+ 用户端 :5173 + 管理端 :5174
```

首页是 3D 沉浸式舞台：生成的夜景视频全屏循环、四芒星粒子、鼠标或陀螺仪视差、滚轮／方向键／滑动整屏切换。视频由 `tools/media` 用 Seedance 生成，设定集和用法见 `docs/asset-bible.md`。

演示模式下：邮箱验证码固定 `123456`；5 个演示幸运卡码见 `packages/shared/src/serial.ts` 的 `DEMO_SERIALS`（例如 `9990-0000-0011`，扫码链接 `http://localhost:5173/r/999000000011`；一个码 6 抽 + 7 天月卡，一码一用）；充值与月卡直接到账；管理端用 `admin@jstar.demo` 登录。
数据在 API 进程内存里，重启即清空。需求与数值见 `docs/requirements.md`。

## 快速开始（开发）

```bash
node -v            # 需要 Node 20+
npm install        # 安装全部 workspace 依赖
cp .env.example .env

# 终端 1：AI 人设服务（默认 stub 后端，无需 GPU）
pip install -e "apps/agent[dev]" && npm run dev:agent      # http://localhost:8100

# 终端 2：后端 API（默认内存存储，无需数据库）
npm run dev:api                                            # http://localhost:8080

# 终端 3：用户端
npm run dev:web                                            # http://localhost:5173

# 终端 4：管理端
npm run dev:admin                                          # http://localhost:5174
```

用户端不设 `VITE_API_BASE` 时运行在**原型模式**（数据留在浏览器里，规则与服务端相同，用于离线演示和端到端测试）。要接后端，在 `apps/web/.env.local` 写：

```
VITE_API_BASE=http://localhost:8080
```

完整依赖（Postgres + Redis + API + agent）用 `npm run docker:up`。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run typecheck` | 全仓 TypeScript 检查 |
| `npm test` | 共用包 + API + 用户端单测 |
| `npm run test:e2e` | 用户端端到端（功能、响应式、多语言、安全、无障碍、性能） |
| `npm run test:agent` | AI 人设服务测试（内容边界） |
| `npm run build` | 全部构建产物 |
| `npm run media:gen -- --dry` | 列出资产镜头表（加 `--category` / `--only` 真正生成，需要 `.env.seedance`） |
| `npm run media:process` | 生成物 → 网页可用的循环视频、海报、多视图，并更新索引 |
| `npm run media:talent -- status` | 五位艺人在 Seedance 真人资产库的核验与资产状态（`add` / `invite` / `confirm` / `upload`） |

## 上线前必须完成的事

按优先级排列，细节见 `docs/ROADMAP.md`：

1. ~~用户端接上 API~~（已完成：设 `VITE_API_BASE` 后积分、抽卡、聊天次数、月卡全部以服务端为准）。
2. ~~持久化~~：生产已用 Cloudflare D1（`apps/api/migrations`）。
3. 接真实支付与 LINE 登录；点数属于日本《资金决済法》的前払式支付手段，见 `docs/compliance-jp.md`。
4. 把 `apps/agent` 的模型后端从 `stub` 切到自托管模型。
5. 素材替换：所有占位槽位都在界面上标了尺寸和内容要求，见 `docs/asset-spec.md`。

## 一句话原则

**随机只发生在实体侧，钱与稀缺只由服务端决定，尺度只在 agent 服务里定义。** 三条边界分别对应合规、风控和品牌，改动都集中在一个地方。
