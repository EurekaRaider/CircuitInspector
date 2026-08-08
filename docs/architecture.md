# 架构

```mermaid
flowchart LR
  Client["MCP Client / Model"] <-->|"JSON-RPC stdio"| MCP["TypeScript MCP"]
  MCP <-->|"JSONL control"| Core["Rust Core"]
  Viewer["Electron Viewer"] <-->|"IPC + transferable ArrayBuffer"| Core
  Core --> Cache["Versioned local cache"]
  Core --> Evidence["SVG / PNG / HTML evidence"]
  Schematics["Product + WIB schematics"] --> Pinout["Candidate pinout"]
  Pinout --> Confirm["Confirmed pinout + design metrics"]
  Constraints["Approved WIB constraint set"] --> DocAnalysis["Document-backed comparison / qualification"]
  Confirm --> DocAnalysis
  DocAnalysis --> Evidence
  DocAnalysis --> Viewer
  Specs["PDF / DOCX / Markdown"] --> Draft["Draft rules + cited passages"]
  Draft --> Approval["Human approval in Viewer"]
  Approval --> Core
```

Rust core 是制造数据、几何与几何裁决的唯一权威。TypeScript MCP 不重新计算距离；它独立负责原理图 pinout、WIB 接线、制造测试建议和已批准硬约束的文档型分析。Viewer renderer 不读取源文件、不解析 PCB，也不执行全量空间查询。

## 数据路径

1. 归档先经过条目数、展开体积、单文件体积、路径穿越与链接逃逸检查。
2. 解析器把坐标规范化为整数纳米，输出统一 `Design` 和每类语义覆盖。
3. core 按输入内容哈希缓存设计；视口请求写入 `CITL` 二进制 tile，renderer 直接用 `ArrayBuffer` 解码为 GPU 顶点。
4. 规则包只有 `APPROVED` 且带审批内容哈希时才可运行。规则所需的任一对象语义为 `MISSING` 时结果为 `NOT_APPLICABLE`，为 `INFERRED` 时结果为 `REVIEW`。
5. 证据由 core 的确定性几何渲染器输出，模型和 Viewer 引用同一分析 ID 与问题 ID。
6. 原理图 PDF 只生成带页码/bbox 的候选 pinout；只有显式确认后的完整 connector/pin/NET NAME 集合才能支持接线 `PASS`/`FAIL`。
7. 最终 WIB 合格判定同时读取已确认产品 pinout、已确认实际 WIB pinout/结构化 design metrics 和已批准 constraint set。任一硬约束缺少实际证据时为 `REVIEW`；只有全部适用项通过才为 `PASS`。

## 关键边界

- WebGL2/ANGLE 是基线；WebGPU 未作为必需能力。
- Viewer 保持单 Canvas。DOM 只用于工具栏、图层树、规则和问题面板。
- 文档型分析使用独立 DOM 视图呈现接线连线、测试建议、WIB 设计建议、约束矩阵和最终裁决；它不会冒充 PCB 几何标注。
- 当前 tile 是紧凑视口切片，但统一模型和持久化缓存仍为 JSON。2000 万图元门禁失败时，应把 `Design` 几何迁移到 mmap 友好的列式分块格式；MCP 协议和 Viewer tile 格式无需改变。
- Gerber clear polarity 已保留在 tile 中；当前 GPU 基线对 clear 图元使用背景擦除。多层透明合成的严格金标仍属于发布前兼容门禁。
