# config/models.json — 所有模型的唯一出处

产品和素材流程里用到的每个模型都登记在 `models.json` 里，代码统一从这里读取。每一项都写明了四件事：

- `model`：用哪个模型；
- `via`：怎么调用（`openrouter`、`byteplus-ark`、`byteplus-voice`、`dashscope-intl`、`fish-audio` 或 `local`）；
- `use`：拿来做什么；
- `chosen`：凭哪次评测选的。

**这里只放模型名，不放 key。** key 放在仓库根目录的 `.env.*.local` 和 GitHub / Worker secrets 里。

| 分组 | 技术点 | 谁读取 | 改完怎么生效 |
|---|---|---|---|
| `chat.*` | 陪伴聊天主力 / 备用、内容安全、长期记忆 | `infra/cloudflare/src/index.ts` 通过环境变量交给 agent 容器 | 按正常发布流程：先上 v1 验收，负责人同意后才能上正式站。部署后要重启容器（`/v1/ops/restart`，见 .github/workflows/deploy.yml）。`apps/agent/app/config.py` 里的本地默认值也要同步改，有测试盯着两边一致 |
| `image.cardArt` | 150 张 AI 卡面（负责人 2026-09-27：生图一律 gpt-image-2，不用 Nano Banana） | `tools/media/src/cards.ts` | 下次运行 `npm run media:cards` 时生效；也可以临时加 `--model <候选>` |
| `image.keyframe` | 视频首尾关键帧 | `tools/media/src/keyframes.ts` | 下次生成时生效；环境变量 `OPENROUTER_IMAGE_MODEL` 可临时覆盖 |
| `judge.*` | 像不像本人、细节说明、同一人连续性 | `tools/media/src/judge.ts`、`continuity.ts` | 下次评审时生效；`JUDGE_MODEL` / `JUDGE_DETAIL_MODEL` 可临时覆盖。换评审模型前要重新校准（`judge.ts calibrate`） |
| `video.tiers` | Seedance 各档位，以及档位对应的接入点变量 | `tools/media/src/manifest.ts` | 每条镜头在 manifest 里选档位；接入点 ID 放在 `.env.seedance` |
| `music.*` | 场景音乐（Lyria 3 Pro 成曲 / Clip 比稿，#82） | `tools/audio/lyria.py`（`pro` / `clip` 读这里） | 下次生成时生效；成品是 `apps/web/public/audio/` 里的文件，换模型要重新生成并重跑 `tools/audio/check.py` |
| `voice.*` | 声音克隆 TTS、转写质检、音色相似度 | `tools/voice/common.py` | 模型权重放在 `.voice/models/<model>`，用 `tools/voice/fetch_hf.sh` 下载 |

换模型的规矩：先评测，再改这里，走 PR 并跑通 `npm run ci:local`。线上模型（`chat.*`）的改动必须先在 v1 上验收。
