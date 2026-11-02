# 工作循环：需求 → 研发 → 测试 → 验收 → 上线

所有工作都在 GitHub 上走同一个循环，状态用标签表示，里程碑是「v1.0 内测」「v1.0 正式」和「v1.1 一起生活」。

v1.1 的分支从 `release/v1.1` 拉出、PR 也合回 `release/v1.1`，不进 main；测试站默认跟随 main，验收 v1.1 时对 `release/v1.1` 手动运行 Deploy test（`docs/ROADMAP.md`「在测试站体验 v1.1」）。

| 阶段 | 标签 | 谁 | 进入下一阶段的条件 |
|---|---|---|---|
| 需求 | `需求` | 产品负责人 / Claude | issue 写清「为什么、做什么、验收标准」（模板：需求） |
| 研发 | `研发` | Claude（含并行 agent） | 在分支上实现，PR 关联 issue（`Closes #n`），PR 模板里的自检全部勾选 |
| 测试 | `测试` | Mac runner + Claude | PR 上的 `ci` 检查全绿（Mac 自托管 runner 跑 `scripts/ci-local.sh`：私有素材检查、gitleaks、lint、typecheck、单元、API 双存储、媒体、agent、build、e2e）；`ci` 不绿不合并；涉及界面的改动附手机 + 桌面截图 |
| 验收 | `验收` | Claude 在浏览器按用户视角走查；内测期间由产品负责人复核 | 合并 main、`ci` 通过后自动部署到 v1.jstarcards.ai（commit 上会有 `deploy/v1` 状态），issue 里的每条验收标准在那里实测通过，记录截图 |
| 上线 | `已验收` | 产品负责人点头后 Claude 执行 | 给已在 v1 验收过的 commit 打 `v*` tag：正式站原样复用 v1 的镜像和 web 构建（不重新构建，没上过 v1 的 commit 会被拒），冒烟测试通过后自动生成 GitHub Release（部署清单、SBOM、校验和），关闭 issue。回滚：Deploy 工作流填 `rollback_to` |

- 阻塞在负责人（key、权限、内容授权）的 issue 加 `阻塞-需负责人`，写清需要什么。
- 工作流标签：`流:工程` `流:内容` `流:AI聊天` `流:沉浸体验` `流:合规运营`。
- AI 生成花费逐笔记在 `docs/SPEND.md`。
- CI 跑在这台 Mac 的自托管 runner 上（标签 `jstar-mac`，不占 Actions 分钟；手动启动：`~/actions-runner/run.sh`，没启动时任务排队）。GitHub 托管机器只用来构建容器镜像。Free 版不能设分支保护，所以闸门放在部署：`ci` 没绿的 commit 不部署。
- 推送前可以先本地跑 `npm run ci:local`，和 PR 上的 `ci` 检查是同一个脚本。
- 环境：v1.0 在 v1.jstarcards.ai 验收，v1.1 在 test.jstarcards.ai 预览（手动触发），正式站 jstarcards.ai 只在负责人同意后打 tag 更新。
- 决策依据：Claude Docs「JSTAR 正式产品：待你处理与决策」。
