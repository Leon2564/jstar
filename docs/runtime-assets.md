# JSTAR 运行资源包

当前 Web 端运行资源统一位于 `apps/web/public`，代码与资源使用同一版本提交。大体积文件通过 Git LFS 存储，克隆后必须执行 `git lfs pull` 才能取得完整二进制内容。

## 当前资源清单

| 资源包 | 路径 | 文件数 | 当前体积 |
|---|---|---:|---:|
| 主视觉、直播、PV 与海报 | `apps/web/public/media` | 1,570 | 2,844.93 MiB |
| 卡牌图鉴与卡面 | `apps/web/public/cards` | 531 | 104.98 MiB |
| 人物语音 | `apps/web/public/voice` | 849 | 22.02 MiB |
| 页面音频 | `apps/web/public/audio` | 7 | 7.38 MiB |
| 礼物素材 | `apps/web/public/gifts` | 20 | 0.12 MiB |
| PWA 图标 | `apps/web/public/icons` | 5 | 0.01 MiB |
| Public 根文件 | `apps/web/public` | 3 | 0.00 MiB |
| **合计** |  | **2,985** | **约 2.91 GiB** |

其中 922 个文件、约 2.76 GiB 由 Git LFS 管理。

## 完整下载

```bash
git lfs install
git clone https://github.com/Leon2564/jstar.git
cd jstar
git lfs pull
```

更新已有工作区时：

```bash
git pull
git lfs pull
```

可用下面的命令确认 LFS 对象完整：

```bash
git lfs fsck
```

资源保持在应用直接读取的运行路径中，不额外复制一份压缩包，避免仓库重复占用空间和出现两个版本。
