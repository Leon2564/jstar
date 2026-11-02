# luckcards — 幸运卡印前工具（方案 1・通用二维码）

实体卡背面印一个**全批次相同**的二维码（指向 `https://jstarcards.ai/lucky`）和一串**逐张不同**的 12 位数字。
二维码随底卡胶印，只有数字走可变数据印刷；用户扫码进入兑换页后手动输入数字。

数据库只存 `HMAC-SHA256(secret, code)`，拖库也拿不到可用的码。

## 目录

```
tools/luckcards/
├─ config/pool.S1.json        卡池配置：女優、档位、掉率、每档设计数
├─ db/schema.sql              Cloudflare D1 表结构（早期设计，主项目 API 用的是 apps/api/prisma）
├─ scripts/
│  ├─ code-gen/               验证码生成（generate）、自检（verify）、Luhn 校验位
│  ├─ pool/                   卡池配额展开（build）、抽卡模型对照（simulate）
│  └─ qr/                     通用二维码（generic + optimize_png）、打样确认表（proof-sheet）
└─ out/                       ⚠️ 敏感产物，已 gitignore，见下
```

### out/（不进 git）

| 路径 | 内容 |
|---|---|
| `code-hmac.secret` | HMAC 密钥。**丢失 = 所有已发码作废**，务必离线备份 |
| `qr-generic/` | 通用二维码 M / Q（推荐）/ H，SVG + 1-bit PNG（30mm@300dpi），各批次共用 |
| `pool/S1-designs.csv` | S1 设计清单与发行量配额 |
| `<批次>/print/codes-<批次>-PLAINTEXT.csv` | 明文码，交印厂。`serial` 为 VDP 合并键 |
| `<批次>/db/codes-<批次>-hashed.csv` | 哈希，导入 D1 |
| `<批次>/manifest-<批次>.json` | 生成时间与上面两个 CSV 的 sha256 |
| `<批次>/proof-sheet.html` | 1:1 打样确认表，A4 打印实扫 |
| `deliver/<批次>-scheme1-generic-qr.zip` | 交印厂的完整包（二维码 + 码表 + 打样表 + 说明） |

### 批次

| 批次 | 数量 | 说明 |
|---|---|---|
| 2026A | 38,400 | 首批，= S1 卡池 `codes` |
| 2026B | 10,000 | 加印 / 备用，与 2026A 已跨批次排重 |

## 常用命令

在本目录下执行（依赖已随根目录 `npm install` 装好）；在仓库根目录可用 `npm run <命令> -w @jstar/luckcards -- …`。

```bash

# 交付前自检：格式、Luhn、唯一性、哈希与明文一致
npm run codes:verify -- out/2026A/print/codes-2026A-PLAINTEXT.csv out/2026A/db/codes-2026A-hashed.csv out/code-hmac.secret

# 加印新批次 —— 必须 --exclude 所有已发批次做排重
npm run codes:gen -- --count 10000 --batch 2026C --out out/2026C \
  --exclude out/2026A/print/codes-2026A-PLAINTEXT.csv,out/2026B/print/codes-2026B-PLAINTEXT.csv

# 新批次的打样表（默认用 Q 版通用二维码）
npm run proof -- out/2026C/print/codes-2026C-PLAINTEXT.csv > out/2026C/proof-sheet.html

# 卡池
npm run pool:build
npm run pool:simulate

# 重出通用二维码（需要 python3 + Pillow）
npm run qr:generic
```

## 注意

- 明文 CSV 里的 `qr_url` 列（`/r/<码>`）是早期"逐张唯一二维码"方案留下的，方案 1 不使用；保留是为了与 manifest 的 sha256 对得上。
- 明文码表是可直接兑换的凭证：不走邮件、IM、公共网盘；印制完成后要求印厂销毁副本。
