# 格式兼容边界

| 输入 | 当前能力 | 语义策略 |
|---|---|---|
| ODB++ 目录/TGZ | 选择主 BOARD step；按 matrix 限定 BOARD layer；区分坐标单位与标准 symbol 的 μm/mil 单位；解析 feature/component/net/testpoint 与 drill | `.test_point` 等源属性为显式；TP 位号/封装为候选；可在 Viewer 逐项确认、排除或点选焊盘补充，无需仅为识别测试点重导出 |
| Gerber X2/X3 + Drill | 图形、文件/对象属性、component layer、钻孔 | 按属性标记显式语义 |
| Gerber + IPC-356 | 合并网络、器件和测试点关系 | 标记 `SUPPLEMENTED`；冲突生成 `DATA_CONFLICT` |
| 纯 Gerber X1 | 准确图形解析路径与基础 DFM | NET/器件/测试点通常 `MISSING`，已经批准的数值基准保留，相关测量为 `REVIEW`，不会伪造 PASS/FAIL |
| `.gbrjob` | 文件清单与 layer function 辅助 | 只补充 Job 明确声明的元数据 |
| Allegro `.brd` 17.2/17.4 的 TP 意图 | 调用用户安装的 KiCad 10.x `kicad-cli pcb import --format auto`，保存 JSON 报告、受控 `.kicad_pcb` 和 SHA-256；解析 NET、面别、坐标、pad/via、板框及保留下来的 Probe/Testprep 属性 | 显式 Probe/Testprep 为 `EXPLICIT`；TP 位号/封装/属性启发式为 `INFERRED`；普通 pad/via 不自动成为 TP。BRD 不进入 `import_design`，也不替代 Gerber 制造几何 |
| 原理图 pinout JSON | `connectors[].pins[]` 或 `pins[]`、可选 `design_metrics[]` | 通过兼容适配器进入 `SchematicDocument v2`；完整候选接口仍需确认 |
| 原理图 CSV/TSV/TXT | `connector`、`pin`、`net_name` 行 | 通过兼容适配器进入 v2；不从缺失行推断 pin |
| 矢量/文本原理图 PDF | 逐页提取文字和绘图操作，识别位号、引脚、NET label、正交导线、连接点、元件框和证据 bbox | 构建候选图与接口排名；只有相关路径确认后才能参与确定性裁决 |
| 扫描原理图 PDF | 逐页本地渲染，使用随包分发的英文/数字 OCR 和图像连线检测资源 | OCR、线段和连接点保留置信度；歧义、冲突和缺失模型保持 `REVIEW`，不访问云服务 |

Allegro BRD 专项流程使用的 `.kicad_pcb` 只是受控中间格式，不表示支持 KiCad 原生设计的通用导入。KiCad/Cadence 均不随 CircuitInspector 分发；可用 `CIRCUIT_INSPECTOR_KICAD_CLI` 指定 KiCad 10.x。KiCad 缺失、版本不是 10.x、超时、非零退出、报告不是 JSON 或转换告警都会生成明确错误/诊断，不会回退为猜测。当前实现范围限定为 Allegro 17.2/17.4，但真实 macOS arm64、Windows x64 与匿名化金样兼容声明仍须在实际系统验收通过后发布。

TP CSV 是带 UTF-8 BOM 的 RFC 4180 文件，固定 16 列；只有 `decision` 与 `comment` 可编辑。未知、重复、缺失候选，来源哈希不符或任何不可编辑字段变化都会整体拒绝。含 `REVIEW` 的选择只能保持 `DRAFT`；具名批准会冻结内容哈希。对齐建议不会自动批准；建议不唯一时必须提供三组非共线锚点。输入版本变化会保留旧对象并把依赖分析标为 `STALE`。

只有 `REQUIRED` TP 会成为派生设计中的测试点，但板边、器件、孔、铜、mask、胶层以及其他 REQUIRED TP 仍来自完整 Gerber 数据并参与距离比较。唯一命中使用 Gerber 实际尺寸并标记为 `SUPPLEMENTED`；未命中、多命中、跨面、NET 冲突、缺少 mask/IPC-356 或必要语义保持 `REVIEW`。没有 REQUIRED TP 或没有涉及 `TEST_POINT` 的批准规则时返回 `NOT_APPLICABLE`。这条专项路径不会满足或绕过 ODB++ `confirm_layout_baseline` 门禁。

当前不解析 Altium、OrCAD、KiCad 等原生原理图数据库。任意 PDF 并不天然等同于权威网表：相接线段会合并，交叉线仅在检测到连接点时连通，同作用域 NET label 按名称合并；跨页/层级标签、总线成员、MUX、level shifter 或多芯片端点无法唯一解释时保持 `REVIEW`。自动追踪的 `Ux.pin` 只代表候选图中的实际连通端点；若批准约束或黄金参考没有规定预期芯片/引脚，报告不会额外宣称其符合产品功能意图。

PDF 与同修订结构化映射在连接器引脚上冲突时，两者均不会获得静默优先级。冲突诊断会阻止路径确认，直到用户在 Viewer 中执行带操作人、时间、before/after 和内容哈希的图校正。缓存按源文件 SHA-256 与解析器版本失效；大 PDF 按页处理并只通过受限 IPC 返回页面图像与覆盖层。

闭环 WIB qualification 的结构化 JSON 可在 `design_metrics` 中提供实际设计值：

```json
{
  "connectors": [{ "reference": "P1", "pins": [{ "number": "1", "net": "VDD_3V3" }] }],
  "design_metrics": [{ "id": "CHANNEL_MAX_VOLTAGE", "value": 5, "unit": "V" }]
}
```

单位不自动换算；constraint set 与实际值单位不同会返回 `REVIEW`。产品/硬件/测试/治具/制造工程负责定义并批准要求基准，包括探针家族、针头几何与直径、行程、力、电流/接触电阻、材料/镀层、测试面和 keep-out。治具供应商与工厂负责确认能力、合规选型、偏差和真实工站结果；静态 schematic 不能替代实施验证。

WIB 比较允许映射表留空：软件会按两侧 `NET NAME` 和出现次数生成清单式人工复核，结果保持 `REVIEW`。只有需要证明精确 connector/pin 对应、检测 pin swap，并输出正式 `PASS/FAIL` 时才需要一一映射；软件不会把 NET 名称相同循环论证为接线已经正确。

规则抽取会把单一、明确的测试点直径生成待批准的 `MINIMUM_DIAMETER` 候选，并把同句中的 pogo pitch 与测试点直径分开；测试点到板边、断板边、BGA/CSP、屏蔽结构和 UV 胶边缘的固定 keep-out 也会保留为数值基准。多个备选直径或 `1/2D` 公式不会被丢弃，但在适用条件、D 的定义和测量对象确认前保持人工复核。

执行距离规则时，缺少圆形半径但已绑定 TP/MTP 器件外形的测试点会使用封装外形进行边到边测量。工装孔优先采用 ODB++ `pad_usage=tooling_hole`；缺少该属性时，可用钻孔几何生成带实测值的候选证据，但身份和结论保持 `REVIEW`。UV 胶边缘从明确的 UV 胶层功能或可识别胶层中的线、弧和区域几何测量；通用胶层功能或仅由层名识别时同样保持 `REVIEW`。

解析器包含 aperture、圆弧、region、极性、step-repeat、坐标格式、单位和属性生命周期的测试路径，但当前仓库尚未提交 Ucamco 全套官方 fixture，也没有 ODB++ 官方认证。发布流程必须在合法取得的本地测试数据上运行：

```bash
UCAMCO_FIXTURES=/absolute/path/to/ucamco-tests cargo test -p circuit-inspector-core --test ucamco -- --ignored --nocapture
```

测试失败必须作为兼容阻断，不能通过“推断”掩盖。官方测试文件请从 [Ucamco Gerber 下载页](https://www.ucamco.com/en/guest/downloads/gerber-format) 获取，并遵循其许可条款。
