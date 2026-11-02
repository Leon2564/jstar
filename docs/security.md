# 安全

## 信任边界

客户端的一切输入都不可信，包括：积分余额、持有卡、试聊剩余次数、抽卡结果、序列码是否用过。这些全部由 `apps/api` 判定。

## 已实现

- **会话**：Bearer JWT（HS256），过期校验，禁用用户直接失效。
- **权限**：`requireUser` / `requireAdmin`；管理接口对普通用户返回 403（有测试覆盖）。
- **校验**：所有请求体走 zod，越界返回 400。
- **限流**：全局 120 次/分钟，验证码、序列码、聊天、抽卡另有更严的独立限流。`TRUST_PROXY` 默认关闭，只有在反向代理会覆盖 `X-Forwarded-For` 时才打开，否则客户端可伪造 IP 绕过限流。
- **生产启动检查**：`NODE_ENV=production` 时，`JWT_SECRET` / `SERIAL_HMAC_KEY` / `AGENT_API_KEY` 仍是开发默认值，或开着 `DEMO_MODE`，API 直接拒绝启动；`DB=d1` 时 `SERIAL_HMAC_KEY` 是开发默认值也拒绝启动（否则所有实体卡码都会被判为不存在）。均有测试覆盖。
- **钱与次数的原子性**：扣点数、扣免费抽、占用聊天次数、占用试聊次数都是仓储层的单步条件操作，处理函数里没有「先读再写」；并发两次十连只会成功一次（有测试覆盖）。
- **序列码爆破**：设备失败 5 次、IP 失败 20 次锁定 10 分钟（服务端判定，浏览器只是镜像显示）。
- **序列码**：数据库只存 `HMAC-SHA256(SERIAL_HMAC_KEY, 码)`，明文在生成时返回一次；库被拖走也拿不到可用码。
- **抽卡可复现**：每次抽卡保存种子与结果。
- **审计**：卡牌、Pickup 排期、序列码批次与作废、补填、退会、导出都记录操作人（`audit` 表）。
- **XSS**：前端不使用 `dangerouslySetInnerHTML`，恶意输入按纯文本渲染（有端到端测试）。
- **开放重定向**：`next` 参数白名单校验，四种绕过写法都有测试。
- **本地存储篡改**：加载时逐字段校验并夹紧，非法卡 ID、负数积分直接丢弃。
- **CSP**：生产由 nginx 下发（`infra/nginx/web.conf`），`frame-ancestors` 必须走响应头。
- **响应头**：nosniff、Referrer-Policy、COOP、Permissions-Policy。

## 数据恢复（D1 Time Travel，#51）

D1 自动保留 30 天内任意时点（Workers Paid），不需要另做备份任务。恢复是**整库原地回滚**：该时点之后的写入全部丢失，所以先在测试库 `jstar-test` 演练，正式库只在确认过时点后执行。

1. 定时点：出事前的 UTC 时刻（Workers 日志里的 `{"event":"tick"}` 与请求日志可帮助定位）。
2. 查书签：`npx wrangler d1 time-travel info jstar --timestamp=2026-11-02T03:00:00Z -c infra/cloudflare/wrangler.jsonc`，记下返回的 bookmark 与当前 bookmark（后者用于撤销这次恢复）。
3. 停写：把 cron（`triggers.crons`）暂时注释掉重新部署，或在低峰执行，避免 tick 在恢复中途写入。
4. 恢复：`npx wrangler d1 time-travel restore jstar --bookmark=<bookmark> -c infra/cloudflare/wrangler.jsonc`（测试库：`jstar-test` + `-c infra/cloudflare/wrangler.test.jsonc`）。
5. 核对：`npx wrangler d1 execute jstar --remote -c infra/cloudflare/wrangler.jsonc --command "SELECT count(*) FROM users; SELECT max(created_at) FROM memories;"`，再打开网站走一遍登录与「思い出」页。
6. 撤销（恢复错了时）：用第 2 步记下的「当前 bookmark」再 restore 一次。
7. 恢复 cron，并在事故记录里写明时点、原因与丢失的写入范围。

R2（回忆存储）不随 D1 回滚：回滚后 D1 里指向已删除录音的 `audio_key` 读取时返回 404（按「没有录音」处理），反过来 D1 已不再引用的 R2 对象留在该用户前缀下，退会时一并删除。

### 演练记录（#51 验收）

**2026-10-01 16:58 UTC（10/02 01:58 JST），测试库 `jstar-test`，wrangler 4.138.0，结果：通过。** 只动了测试库；正式库 `jstar`、`jstar-nest` 与 v1 站未碰。测试站当晚有 QA，所以没有停 cron，整次演练压在十几秒内（书签序号表明 A→B 之间只有演练自己的写入）。

```sh
set -a; . ./.env.cloudflare.local; set +a   # CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
C=infra/cloudflare/wrangler.test.jsonc
# 0. 核心表计数（D1 不接受十几项的 UNION ALL，用一行子查询）
wrangler d1 execute jstar-test --remote -c $C --json --command "SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM memories) AS memories, …"
wrangler d1 time-travel info jstar-test -c $C                            # 1. 书签 A
wrangler d1 execute jstar-test --remote -c $C --command "CREATE TABLE IF NOT EXISTS _drill_51 (id INTEGER PRIMARY KEY, note TEXT, at TEXT); INSERT INTO _drill_51 (note, at) VALUES ('time-travel drill #51', datetime('now'));"   # 2. 标记行
wrangler d1 time-travel info jstar-test -c $C                            # 3. 书签 B
wrangler d1 time-travel restore jstar-test --bookmark=<A> --json -c $C   # 4. 恢复到 A（非交互执行须加 --json，否则确认提示默认 N，什么也不做）
wrangler d1 execute jstar-test --remote -c $C --command "SELECT count(*) FROM sqlite_master WHERE name='_drill_51'"   # 5. 应为 0，再重跑第 0 步
```

| 步骤 | 时刻（UTC） | 结果 |
|---|---|---|
| 恢复前计数 | 16:58:38 | users 76 · memories 60 · messages 462 · cards 150 · owned 20 · promises 89 · scene_runs 1028 · serials 5 · draws 15 · relationship 79 · confessions 4 · inbox 691 · her_messages 238 · job_runs 13 |
| 书签 A | 16:58:40 | `00000536-00000004-000050f7-ca5e1f360a47154f8794cd905bf11dc4` |
| 标记行 | 16:58:42 | `_drill_51` 第 1 行 |
| 书签 B | 16:58:42 | `00000536-00000006-000050f7-e0e13366377ae6810e852197c66c35c0` |
| 恢复到 A | 16:58:44 | 返回 `bookmark` = A，`previous_bookmark` = `00000536-ffffffff-000050f7-98bbe7e1637715e686f3bc2513ec015c`（撤销用） |
| 核对 | 16:58:48–50 | `_drill_51` 不存在；14 张核心表计数与恢复前完全一致 |

从计数到核对共 12 秒，restore 本身约 4 秒，返回后立即可读。同一分钟内先跑过一次（16:58:00–12，书签 A `00000535-0000003c-000050f7-b9b2a34f77b9646e986d953acafe3d18`）：标记同样消失，但计数查询因 D1「too many terms in compound SELECT」报错没取到，于是改成子查询写法重做了上面这次。教训：非交互执行 restore 要加 `--json`；正式库恢复前仍按第 3 步停 cron。

## 上线前要补

1. Redis 承载序列码锁定与限流计数（现在是进程内 Map，多实例会被绕过）。
2. 演示模式下任何人都能用固定验证码登录任意邮箱（包括演示管理员）：演示环境不要公开到公网，或加一层访问密码。
3. 支付走 webhook 验签；现在不开售，`/v1/shop/*` 一律 404 `shop_closed`（开放后非演示模式 501）。
4. 邮箱等个人数据不再留在浏览器 localStorage；会话改用 httpOnly cookie + CSRF token。
5. 日志脱敏：验证码、邮箱、序列码在生产日志中必须打码。
6. 依赖扫描与密钥扫描接入 CI。
