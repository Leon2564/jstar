# SSR特典2｜温泉近景事件图验证

## 基线

- 标准状态：`S-SSR2-ONSEN-CLOSE`，对应 `20261101-174401.jpg`。
- 所有片段均为8秒、16:9、固定近景、单镜到底。
- 每条从相同标准状态开始，手部动作完成后回到水下初始位置，并在7–8秒保持标准尾帧。
- 所有节点均为原子节点，可在任意两条之间随机组合。

## 节点

| ID | 动作 | 入口 | 出口 | 提示词状态 | 视频状态 |
| --- | --- | --- | --- | --- | --- |
| `SSR2-01` | 指尖拨水待机 | `S-SSR2-ONSEN-CLOSE` | `S-SSR2-ONSEN-CLOSE` | ready | not_provided |
| `SSR2-02` | 轻拨水面后微笑 | `S-SSR2-ONSEN-CLOSE` | `S-SSR2-ONSEN-CLOSE` | ready | not_provided |
| `SSR2-03` | 拾起水面花瓣端详 | `S-SSR2-ONSEN-CLOSE` | `S-SSR2-ONSEN-CLOSE` | ready | not_provided |
| `SSR2-04` | 害羞交叉双臂 | `S-SSR2-ONSEN-CLOSE` | `S-SSR2-ONSEN-CLOSE` | ready | not_provided |
| `SSR2-05` | 双手捧水感受热气 | `S-SSR2-ONSEN-CLOSE` | `S-SSR2-ONSEN-CLOSE` | ready | not_provided |
| `SSR2-06` | 接住飘落花瓣 | `S-SSR2-ONSEN-CLOSE` | `S-SSR2-ONSEN-CLOSE` | ready | not_provided |
| `SSR2-07` | 整理耳边湿发 | `S-SSR2-ONSEN-CLOSE` | `S-SSR2-ONSEN-CLOSE` | ready | not_provided |
| `SSR2-08` | 双手轻握安慰 | `S-SSR2-ONSEN-CLOSE` | `S-SSR2-ONSEN-CLOSE` | ready | not_provided |
| `SSR2-09` | 指尖拨开花瓣再回望 | `S-SSR2-ONSEN-CLOSE` | `S-SSR2-ONSEN-CLOSE` | ready | not_provided |
| `SSR2-10` | 捧水后被逗笑 | `S-SSR2-ONSEN-CLOSE` | `S-SSR2-ONSEN-CLOSE` | ready | not_provided |
| `SSR2-11` | 抚平湿发后温柔回望 | `S-SSR2-ONSEN-CLOSE` | `S-SSR2-ONSEN-CLOSE` | ready | not_provided |

## 组合检查

- 节点数：11。
- 合法有序相邻边：121，包含同节点连续播放。
- 每个节点均从标准姿势进入，在7秒前完成手部退场和身体复位，7–8秒保持相同标准状态。
- 任意前驱与后继之间，人物位置、视线、手位、水线、木板、盘子、食物、饮品、镜头和环境声场均连续。
- 花瓣动作使用单片花瓣，水面接触产生对应涟漪；捧水动作具有连续水滴；整理湿发动作保持发型长度和分缝；交叉双臂动作不遮脸并回到水下。
- 每条均持续保留树枝、雪花、蒸汽、水波、花瓣、木板、水面反光和人物光影变化。
- 验证结论：11条提示词可作为自由随机池使用，文本状态为 `ready`；实际视频尚未提供，视频状态为 `not_provided`。
