# 格式兼容边界

| 输入 | 当前能力 | 语义策略 |
|---|---|---|
| ODB++ 目录/TGZ | 独立基础 parser：matrix、feature、component、net/testpoint、单位与属性诊断 | 源数据存在时显式；不完整时缺失或推断 |
| Gerber X2/X3 + Drill | 图形、文件/对象属性、component layer、钻孔 | 按属性标记显式语义 |
| Gerber + IPC-356 | 合并网络、器件和测试点关系 | 标记 `SUPPLEMENTED`；冲突生成 `DATA_CONFLICT` |
| 纯 Gerber X1 | 准确图形解析路径与基础 DFM | NET/器件/测试点通常 `MISSING`，相关规则 `NOT_APPLICABLE` |
| `.gbrjob` | 文件清单与 layer function 辅助 | 只补充 Job 明确声明的元数据 |
| 原理图 pinout JSON | `connectors[].pins[]` 或 `pins[]`、可选 `design_metrics[]` | 通过兼容适配器进入 `SchematicDocument v2`；完整候选接口仍需确认 |
| 原理图 CSV/TSV/TXT | `connector`、`pin`、`net_name` 行 | 通过兼容适配器进入 v2；不从缺失行推断 pin |
| 矢量/文本原理图 PDF | 逐页提取文字和绘图操作，识别位号、引脚、NET label、正交导线、连接点、元件框和证据 bbox | 构建候选图与接口排名；只有相关路径确认后才能参与确定性裁决 |
| 扫描原理图 PDF | 逐页本地渲染，使用随包分发的英文/数字 OCR 和图像连线检测资源 | OCR、线段和连接点保留置信度；歧义、冲突和缺失模型保持 `REVIEW`，不访问云服务 |

当前不解析 Altium、OrCAD、KiCad 等原生原理图数据库。任意 PDF 并不天然等同于权威网表：相接线段会合并，交叉线仅在检测到连接点时连通，同作用域 NET label 按名称合并；跨页/层级标签、总线成员、MUX、level shifter 或多芯片端点无法唯一解释时保持 `REVIEW`。自动追踪的 `Ux.pin` 只代表候选图中的实际连通端点；若批准约束或黄金参考没有规定预期芯片/引脚，报告不会额外宣称其符合产品功能意图。

PDF 与同修订结构化映射在连接器引脚上冲突时，两者均不会获得静默优先级。冲突诊断会阻止路径确认，直到用户在 Viewer 中执行带操作人、时间、before/after 和内容哈希的图校正。缓存按源文件 SHA-256 与解析器版本失效；大 PDF 按页处理并只通过受限 IPC 返回页面图像与覆盖层。

闭环 WIB qualification 的结构化 JSON 可在 `design_metrics` 中提供实际设计值：

```json
{
  "connectors": [{ "reference": "P1", "pins": [{ "number": "1", "net": "VDD_3V3" }] }],
  "design_metrics": [{ "id": "CHANNEL_MAX_VOLTAGE", "value": 5, "unit": "V" }]
}
```

单位不自动换算；constraint set 与实际值单位不同会返回 `REVIEW`。工厂、fixture、机械、量测系统或节拍能力即使在原理图中有文字，也必须以相应的真实验证证据关闭，不能由静态 schematic 自动给出 PASS。

解析器包含 aperture、圆弧、region、极性、step-repeat、坐标格式、单位和属性生命周期的测试路径，但当前仓库尚未提交 Ucamco 全套官方 fixture，也没有 ODB++ 官方认证。发布流程必须在合法取得的本地测试数据上运行：

```bash
UCAMCO_FIXTURES=/absolute/path/to/ucamco-tests cargo test -p circuit-inspector-core --test ucamco -- --ignored --nocapture
```

测试失败必须作为兼容阻断，不能通过“推断”掩盖。官方测试文件请从 [Ucamco Gerber 下载页](https://www.ucamco.com/en/guest/downloads/gerber-format) 获取，并遵循其许可条款。
