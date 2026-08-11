<!--
用途：供大模型把受控 PDF 规则文档整理为 CircuitInspector 可抽取的 Markdown 规则源文件。

给生成模型的强制要求：
1. 完整阅读输入 PDF 后再输出；只转换 PDF 中实际存在的要求，不补充行业经验值或常识阈值。
2. 输出必须保留本文档的章节结构，但必须删除本说明注释以及所有未填写的占位内容。
3. 每条自动几何候选规则只能有一条规范性约束句；该句必须独占一个段落，并且只出现一个不同的数值阈值。
4. 规范性约束句以 [SOURCE ...] 开头，记录 PDF 文件名、从一开始计数的页码和原文条款号。
5. 不改变原文的对象、比较符、阈值、单位、适用条件或例外。允许统一空白、全半角和明显的 OCR 标点，但不得改写技术含义。
6. PDF 没有明确给出的字段填写 UNKNOWN；不得猜测 revision、applicability、severity、factory、tester 或 authority。
7. 多个候选阈值、相对公式或非可执行测试点指导进入“可由抽取器识别的复核候选”；其他范围、条件、OCR、表格或来源问题进入“不进入自动规则包的要求和不安全候选”。不得自行选值。
8. 探针角度、器件高度、阻焊开窗、板面可达性、夹具支撑、夹具压点、测试机能力、JTAG、烧录、FCT、节拍、良率和产线验证不得写成自动几何规则。
9. 不得写入 APPROVED、批准人、批准时间或批准哈希。该 Markdown 只能生成 DRAFT，最终批准必须在 CircuitInspector Viewer 中完成。
10. 最终只输出填充完成的 Markdown，不附加解释、分析过程或 Markdown 代码围栏。
-->

# <规则源文档标题>

## 1. 受控来源

- `rule_source_schema`: `CIRCUITINSPECTOR_RULE_SOURCE_V1`
- `source_pdf`: `<PDF 文件名>`
- `source_sha256`: `<已由工具提供的 SHA-256；否则填写 UNKNOWN>`
- `document_id`: `<PDF 中明确记录的文档编号；否则填写 UNKNOWN>`
- `document_revision`: `<PDF 中明确记录的版本；否则填写 UNKNOWN>`
- `document_title`: `<PDF 标题>`
- `effective_date`: `<PDF 中明确记录的生效日期；否则填写 UNKNOWN>`
- `project`: `<明确适用的项目；否则填写 UNKNOWN>`
- `product_revisions`: `<明确适用的产品版本；否则填写 UNKNOWN>`
- `factory`: `<明确适用的工厂或产线；否则填写 UNKNOWN>`
- `tester_or_fixture`: `<明确适用的测试机或夹具；否则填写 UNKNOWN>`
- `authority_tier`: `<PROJECT_FACTORY_TESTER | FORMAL_STANDARD | VENDOR_GUIDANCE | ENGINEERING_HEURISTIC | UNKNOWN>`
- `conversion_model`: `<模型名称和版本>`
- `conversion_time`: `<ISO 8601 时间>`
- `conversion_status`: `DRAFT_SOURCE`

### 1.1 适用范围原文

<忠实概括 PDF 明确给出的适用产品、版本、工厂、产线、测试机、夹具和排除范围。没有明确说明时填写 UNKNOWN。此处不得补充数值型工程要求。>

### 1.2 术语与测量定义

<记录 PDF 对测量对象、边缘、中心、直径、间距、层、网络关系、板面及公差的明确定义。没有定义时填写 UNKNOWN。此处不得自行创建定义。>

## 2. 自动几何候选规则

<!--
本节只允许当前 CircuitInspector Core 可执行的候选：
- MINIMUM_DISTANCE
- MINIMUM_WIDTH
- MINIMUM_ANNULAR_RING
- MINIMUM_DIAMETER

每条规则复制下面的完整规则卡。规范性约束句必须紧跟标题、独占一个段落，并且阈值与单位只在该句中出现一次。
不要在元数据中重复“数值 + mm/mil/um”等原始单位组合；归一化阈值由抽取器生成，并由人在 Viewer 中核对。

在不改变 PDF 技术含义的前提下，优先使用下列规范句式，以兼容当前抽取器：
- 测试点边缘间距不得低于 <阈值> <单位>。
- 测试点间距按中心到中心测量，不得低于 <阈值> <单位>。
- 测试点到板边的边缘距离不得低于 <阈值> <单位>。
- 测试点到工装孔的边缘距离不得低于 <阈值> <单位>。
- 测试点到器件的距离不得低于 <阈值> <单位>。
- 测试点到 BGA/CSP 外形的边缘距离不得低于 <阈值> <单位>。
- 测试点到屏蔽罩或屏蔽围栏的边缘距离不得低于 <阈值> <单位>。
- 测试点到 UV 胶边缘的距离不得低于 <阈值> <单位>。
- 测试点应采用不小于 <阈值> <单位> 直径。
- 导线宽度不得低于 <阈值> <单位>。
- 最小环宽不得低于 <阈值> <单位>。
- 铜到板边的边缘距离不得低于 <阈值> <单位>。
- 孔到铜的边缘距离不得低于 <阈值> <单位>。
-->

### <稳定规则 ID> <规则标题>

[SOURCE pdf="<PDF 文件名>" page="<页码>" clause="<条款号或 UNKNOWN>"] <一条完整规范性约束句：明确对象、目标、测量定义、比较关系、唯一阈值和原始单位。>

- `verification_mode`: `AUTOMATED_GEOMETRY`
- `kind`: `<MINIMUM_DISTANCE | MINIMUM_WIDTH | MINIMUM_ANNULAR_RING | MINIMUM_DIAMETER>`
- `source`: `<TEST_POINT | COMPONENT | COPPER | BOARD_EDGE | DRILL | TOOLING_HOLE | PANEL_TAB | BGA_CSP | SHIELD_FENCE | UV_GLUE>`
- `target`: `<上述对象之一；单对象规则填写 NONE>`
- `metric`: `<CENTER_TO_CENTER | EDGE_TO_EDGE | BODY_TO_PAD | NONE>`
- `layer_functions`: `<PDF 明确限定的层功能；没有限定时填写 ANY>`
- `net_relation`: `<SAME_NET | DIFFERENT_NET | ANY | UNKNOWN>`
- `applicability`: `<该条规则明确适用的产品、版本、工厂、测试机和条件；继承全文时填写 DOCUMENT_SCOPE>`
- `source_severity`: `<PDF 中的原始严重度文字；没有明确给出时填写 UNCONFIRMED>`
- `source_fidelity`: `<EXACT_TEXT | OCR_NORMALIZED | TABLE_RECONSTRUCTED>`
- `review_note`: `<没有疑点时填写 NONE；否则移入第 3 节>`

<!-- 按上述结构继续添加规则卡。删除未使用的规则卡占位内容。 -->

## 3. 待人工复核候选

<!--
本节只保留当前抽取器能够明确转换为 review_item 的三类原文：
1. 同一要求含多个不同候选阈值；
2. 测试点要求使用相对直径公式；
3. 测试点尺寸或设备指导包含数值，但没有可执行的间距要求。

不得拆分条件、平均阈值、选择更严格值或选择更宽松值。含多个数值时，必须把相关数值保留在同一个原文段落中。
其他 OCR 不确定、适用范围不清、条件分支、来源冲突和不支持对象不得放在本节，统一放入第 4 节。
-->

### <复核项 ID> <复核项标题>

[SOURCE pdf="<PDF 文件名>" page="<页码>" clause="<条款号或 UNKNOWN>"] <忠实保留产生歧义、冲突、相对公式或条件分支的原文要求。>

- `status`: `REVIEW`
- `verification_mode`: `<AUTOMATED_GEOMETRY | DOCUMENT_BACKED | MANUAL_FACTORY_CONFIRMATION>`
- `reason`: `<AMBIGUOUS_THRESHOLD | RELATIVE_THRESHOLD | NON_EXECUTABLE_GUIDANCE>`
- `missing_decision`: `<需要由谁确认什么>`
- `source_fidelity`: `<EXACT_TEXT | OCR_NORMALIZED | TABLE_RECONSTRUCTED | OCR_UNCERTAIN>`
- `do_not_assume`: `<明确列出禁止模型补全或选择的内容>`

<!-- 按上述结构继续添加复核项。没有复核项时写“NONE”。 -->

## 4. 不进入自动规则包的要求和不安全候选

<!--
记录两类内容：
1. 当前 Core 不能自动验证的 DFT/DFM 要求；
2. 看似属于几何规则，但存在 OCR 不确定、范围不清、条件分支、来源冲突、表格关系不清或不支持对象的候选。

为避免旧版自然语言抽取器误生成几何规则，本节不得重复连续的“数值 + 原始单位”。需要保留数值标记时，使用 VALUE=<原文数值>; UNIT=<原文单位> 分字段记录，并以 PDF 原文为最终证据。
-->

### <人工项 ID> <要求主题>

- `source`: `[SOURCE pdf="<PDF 文件名>" page="<页码>" clause="<条款号或 UNKNOWN>"]`
- `verification_mode`: `<AUTOMATED_GEOMETRY | DOCUMENT_BACKED | MANUAL_FACTORY_CONFIRMATION>`
- `status`: `REVIEW`
- `requirement_summary`: `<不带新阈值的忠实摘要>`
- `reason`: `<CONFLICTING_REQUIREMENTS | OCR_UNCERTAIN | SCOPE_UNCLEAR | CONDITIONAL_REQUIREMENT | TABLE_RELATION_UNCLEAR | UNSUPPORTED_TARGET | NON_AUTOMATED_REQUIREMENT>`
- `source_value_tokens`: `<需要保留时使用 VALUE=<原文数值>; UNIT=<原文单位>；否则填写 NONE>`
- `required_evidence`: `<关闭该 REVIEW 所需的受控文件、实测记录或工厂验证>`
- `owner`: `<PDF 明确指定的责任人；否则填写 UNKNOWN>`

<!-- 按上述结构继续添加人工项。没有人工项时写“NONE”。 -->

## 5. 转换完整性与冲突清单

- `pages_processed`: `<已处理的 PDF 页码范围>`
- `pages_unreadable`: `<无法读取或 OCR 不可靠的页码；没有则填写 NONE>`
- `tables_reconstructed`: `<重建过的表格位置；没有则填写 NONE>`
- `cross_page_dependencies`: `<跨页标题、脚注、表头或条件；没有则填写 NONE>`
- `conflicts_found`: `<冲突条款的复核项 ID；没有则填写 NONE>`
- `omitted_passages`: `<未转换内容及原因；没有则填写 NONE>`
- `model_assumptions`: `NONE`

## 6. 生成后自检

- [ ] 每条自动几何规则均能定位到 PDF 文件、页码和条款。
- [ ] 每条自动几何规则的规范性约束句均独占一个段落。
- [ ] 每条自动几何规则只包含一个不同的数值阈值。
- [ ] 对象、目标、测量定义、比较符、阈值和单位均来自 PDF。
- [ ] 未明确的适用范围、严重度和责任人均为 UNKNOWN 或 UNCONFIRMED。
- [ ] 只有抽取器可识别的多阈值、相对公式和非可执行测试点指导进入第 3 节。
- [ ] 冲突、OCR 不确定、范围不清、条件分支和不支持对象均进入第 4 节。
- [ ] 非几何、夹具、测试机、JTAG、烧录和 FCT 要求均进入第 4 节。
- [ ] 没有添加经验阈值、通用标准值、推测、公差或默认条件。
- [ ] 文档状态保持 DRAFT_SOURCE，未写入任何批准记录。
