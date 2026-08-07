# 格式兼容边界

| 输入 | 当前能力 | 语义策略 |
|---|---|---|
| ODB++ 目录/TGZ | 独立基础 parser：matrix、feature、component、net/testpoint、单位与属性诊断 | 源数据存在时显式；不完整时缺失或推断 |
| Gerber X2/X3 + Drill | 图形、文件/对象属性、component layer、钻孔 | 按属性标记显式语义 |
| Gerber + IPC-356 | 合并网络、器件和测试点关系 | 标记 `SUPPLEMENTED`；冲突生成 `DATA_CONFLICT` |
| 纯 Gerber X1 | 准确图形解析路径与基础 DFM | NET/器件/测试点通常 `MISSING`，相关规则 `NOT_APPLICABLE` |
| `.gbrjob` | 文件清单与 layer function 辅助 | 只补充 Job 明确声明的元数据 |

解析器包含 aperture、圆弧、region、极性、step-repeat、坐标格式、单位和属性生命周期的测试路径，但当前仓库尚未提交 Ucamco 全套官方 fixture，也没有 ODB++ 官方认证。发布流程必须在合法取得的本地测试数据上运行：

```bash
UCAMCO_FIXTURES=/absolute/path/to/ucamco-tests cargo test -p circuit-inspector-core --test ucamco -- --ignored --nocapture
```

测试失败必须作为兼容阻断，不能通过“推断”掩盖。官方测试文件请从 [Ucamco Gerber 下载页](https://www.ucamco.com/en/guest/downloads/gerber-format) 获取，并遵循其许可条款。
