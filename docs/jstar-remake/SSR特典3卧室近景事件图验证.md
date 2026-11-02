# SSR特典3｜卧室近景事件图验证

## 基线

- 标准状态：`S-SSR3-BEDROOM-CLOSE`，对应 `20261102-164737.jpg`。
- 所有片段均为8秒、16:9、固定镜头、单镜到底、无对白和无音轨。
- 每条严格使用同一张参考图作为首帧和尾帧，7–8秒保持标准尾帧。
- 所有节点均为原子节点，可在自由随机池中任意组合。

## 节点

| ID | 动作 | 入口 | 出口 | 提示词状态 | 视频状态 |
| --- | --- | --- | --- | --- | --- |
| `SSR3-01` | 玩发梢待机 | `S-SSR3-BEDROOM-CLOSE` | `S-SSR3-BEDROOM-CLOSE` | ready | not_provided |
| `SSR3-02` | 指尖绕发微笑 | `S-SSR3-BEDROOM-CLOSE` | `S-SSR3-BEDROOM-CLOSE` | ready | not_provided |
| `SSR3-03` | 拿起花瓣端详 | `S-SSR3-BEDROOM-CLOSE` | `S-SSR3-BEDROOM-CLOSE` | ready | not_provided |
| `SSR3-04` | 害羞双臂交叉遮胸 | `S-SSR3-BEDROOM-CLOSE` | `S-SSR3-BEDROOM-CLOSE` | ready | not_provided |
| `SSR3-05` | 轻扶墨镜俏皮眨眼 | `S-SSR3-BEDROOM-CLOSE` | `S-SSR3-BEDROOM-CLOSE` | ready | not_provided |
| `SSR3-06` | 拨发到肩后 | `S-SSR3-BEDROOM-CLOSE` | `S-SSR3-BEDROOM-CLOSE` | ready | not_provided |
| `SSR3-07` | 花瓣贴近脸颊 | `S-SSR3-BEDROOM-CLOSE` | `S-SSR3-BEDROOM-CLOSE` | ready | not_provided |
| `SSR3-08` | 指尖轻触唇边 | `S-SSR3-BEDROOM-CLOSE` | `S-SSR3-BEDROOM-CLOSE` | ready | not_provided |
| `SSR3-09` | 轻调肩带后回望 | `S-SSR3-BEDROOM-CLOSE` | `S-SSR3-BEDROOM-CLOSE` | ready | not_provided |
| `SSR3-10` | 双手拢发再放下 | `S-SSR3-BEDROOM-CLOSE` | `S-SSR3-BEDROOM-CLOSE` | ready | not_provided |
| `SSR3-11` | 假装吃惊后玩发回眸 | `S-SSR3-BEDROOM-CLOSE` | `S-SSR3-BEDROOM-CLOSE` | ready | not_provided |

## 组合检查

- 节点数：11。
- 合法有序相邻边：121，包含同节点连续播放。
- 所有单手动作均保持画面左侧支撑手承重；双臂动作先把重心转移到臀部和大腿，复位时支撑手先落床承重。
- 花瓣、头发、墨镜和肩带均在动作结束后回到标准状态；床面衣物和小物件保持原位。
- 每条均持续保留头发、窗帘、床单边缘、少量花瓣、粉紫灯光、背景光斑和人物光影变化。
- 任意相邻片段之间，人物位置、姿态、手位、服装、墨镜、床铺、道具、镜头和光线状态连续。
- 验证结论：11条提示词可作为自由随机池使用，文本状态为 `ready`；实际视频尚未提供，视频状态为 `not_provided`。
