# 性能验收

正式 V1 只在下列真实机器门禁全部通过后成立：

- macOS：Apple M1、16 GB；Windows：8 核、16 GB、DX11 级集成显卡。
- 4K 视口平移/缩放 P95 ≤ 16.7 ms；搜索与问题聚焦 ≤ 100 ms。
- 2 GB TGZ / 2000 万图元冷载进入增量视图 P95 ≤ 10 s；缓存重开 P95 ≤ 2 s。
- 全量 DFT + 基础 DFM P95 ≤ 30 s；峰值 RSS ≤ 8 GB，禁用交换空间依赖。
- MCP 在 0.5 s 内发送第一条进度通知。

`scripts/generate-benchmark-design.mjs` 流式生成默认 2000 万 aperture flashes。`scripts/benchmark-import.mjs` 输出 core 响应耗时、缓存命中、图元数和诊断。GUI 验收还需要在 Electron DevTools Performance/Memory 或平台 GPU 工具中记录：

```text
platform, cpu, ram, gpu, display, fixture_hash, cold_ms, warm_ms,
pan_p95_ms, zoom_p95_ms, focus_p95_ms, analysis_p95_ms, peak_rss_mb,
cache_hit_rate, parser_throughput_mb_s, result
```

当前工程没有伪造这些数字。`benchmarks/results/` 应只接受真实平台采样结果；未运行的门禁必须显示为 `NOT_RUN`，不能显示 PASS。
