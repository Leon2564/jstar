# 协作约定

- 分支：`main` 保护，功能走 `feat/*`、修复走 `fix/*`，PR 必须过 CI。
- 提交信息：`feat(web): …` / `fix(api): …` / `docs: …`。
- 代码注释写「为什么」，不写「做了什么」；业务规则的注释要指向 `docs/` 下对应文件。
- 任何涉及金额、概率、内容尺度、个人数据的改动，PR 里必须写明对应的合规条款（见 `docs/compliance-jp.md`）。
- 新增用户可见文案一律先加到 `apps/web/src/i18n/ja.ts`，四种语言同步补齐，CI 会校验键集合一致。
- 新增接口先改 `packages/shared/src/contracts.ts`，再改服务端与前端。
