# 格式兼容边界

| 输入 | 当前能力 | 语义策略 |
|---|---|---|
| ODB++ 目录/TGZ | 独立基础 parser：matrix、feature、component、net/testpoint、单位与属性诊断 | 源数据存在时显式；不完整时缺失或推断 |
| Gerber X2/X3 + Drill | 图形、文件/对象属性、component layer、钻孔 | 按属性标记显式语义 |
| Gerber + IPC-356 | 合并网络、器件和测试点关系 | 标记 `SUPPLEMENTED`；冲突生成 `DATA_CONFLICT` |
| 纯 Gerber X1 | 准确图形解析路径与基础 DFM | NET/器件/测试点通常 `MISSING`，相关规则 `NOT_APPLICABLE` |
| `.gbrjob` | 文件清单与 layer function 辅助 | 只补充 Job 明确声明的元数据 |
| 原理图 pinout JSON | `connectors[].pins[]`、可选 `design_metrics[]` | 明确字段作为候选证据；确认后为 `EXPLICIT`，可参与正式 WIB 比较 |
| 原理图 CSV/TSV/TXT | `connector`、`pin`、`net_name` 行 | 需确认完整性和版本；不从缺失行推断 pin |
| 文本型原理图 PDF | 仅识别明确的 connector/pin/NET NAME 文本行，并保留页码与 bbox | 始终先作为 `INFERRED` 候选；未经确认只能 `REVIEW` |

当前不解析 Altium、OrCAD、KiCad 等原生原理图数据库，也不把任意 PDF 图形连线自动还原为完整电气网表。扫描 PDF OCR、内部非连接器网络、器件额定值和布局/机械指标若没有受控结构化导出，必须保持 `REVIEW`。

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
