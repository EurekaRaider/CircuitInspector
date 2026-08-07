# 本地安全模型

- 默认无网络请求；设计、规范、缓存、规则和证据保留在本地缓存目录。
- `.zip`/`.tgz` 流式解包拒绝绝对路径、`..`、符号/硬链接逃逸，并限制 200,000 条目、16 GiB 总展开体积和 4 GiB 单文件。
- cache ID、analysis ID 和 evidence 文件名经过单路径段约束；Viewer 只允许打开本地 evidence 根目录下的文件。
- Electron 启用 `contextIsolation` 与 renderer sandbox，禁用 `nodeIntegration`；preload 只暴露窄 IPC API。
- MCP stdout 只写 JSON-RPC；原生 core 的诊断转发到 stderr。
- 规范抽取只创建 DRAFT。审批记录包含审批人、时间和规则内容 SHA-256；core 拒绝执行未审批包。
- `SemanticCoverage` 是裁决的一部分。缺失或推断语义不能被提升为正式 FAIL/PASS。

内部构建目前不签名或公证。部署时应通过企业软件分发、文件哈希和 SBOM 验证产物来源。
