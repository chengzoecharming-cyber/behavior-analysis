# DDIA 学习笔记：销售外勤行为分析系统对照版

> 本目录记录阅读《Designing Data-Intensive Applications》（中文译名《数据密集型应用系统设计》）的读书笔记，并始终把书中概念映射到当前项目——销售外勤行为分析系统——的真实代码与架构上。

## 目录

| 文件 | 说明 | 当前状态 |
|---|---|---|
| [`README.md`](README.md) | 学习索引、约定、阅读顺序 | 本文件 |
| [`data-engineering-cheatsheet.md`](data-engineering-cheatsheet.md) | 数据工程名词速查：ETL/ELT、checkSum、Superset、数据仓库分层、Medallion Architecture 等 | 已完成 |
| [`ch01-reliable-scalable-maintainable.md`](ch01-reliable-scalable-maintainable.md) | 第 1 章：可靠性、可扩展性、可维护性 | 已完成 |
| [`data-observability-plan.md`](data-observability-plan.md) | 数据质量监控落地方案：四层护栏（导入断言/同步对账/指标基线/血缘重算） | 方案已定稿 |
| [`data-observability-progress.md`](data-observability-progress.md) | 上述方案的落地进展日志：已完成里程碑、设计决策、踩坑记录、未来方向 | 持续更新 |
| [`data-quality-integration-guide.md`](data-quality-integration-guide.md) | `dataQuality/` 模块接入业务流程的代码示例 | 示例参考 |

## 阅读顺序建议

1. 先读 [`data-engineering-cheatsheet.md`](data-engineering-cheatsheet.md)，建立术语表。
2. 再读 [`ch01-reliable-scalable-maintainable.md`](ch01-reliable-scalable-maintainable.md)，理解全书总纲如何落地到本项目。
3. 后续章节会逐步补充到本目录，每章独立成文，但交叉引用会保持链接。

## 配合学习：CMU 15-445 数据库系统导论

DDIA 是「自顶向下」讲架构权衡，CMU 15-445（Andy Pavlo）是「自底向上」讲数据库内部如何工作。两者在多个概念上交汇，从不同方向理解同一件事。考虑到工业设计背景、时间有限，本课程**选择性观看**，只取与本项目痛点直接相关的讲次。

| 优先级 | 15-445 讲次 | 对应 DDIA | 对应本项目 |
|---|---|---|---|
| ★★★ | L1 Relational Model | 第 2 章 | `visits` / `stops` / `routes` 表为什么这样设计 |
| ★★★ | L2 Modern SQL | 第 2 章 | `riskSummaryService.ts` 里的聚合查询 |
| ★★★ | L7 Tree Indexes (B+Tree) | 第 3 章 | 为什么 `visits(user_id, business_date)` 需要索引、慢查询排查 |
| ★★☆ | L3-L5 Database Storage / Buffer Pool | 第 3 章 | PostgreSQL 数据页、缓存命中与内存配置 |
| ★★☆ | L9-L10 Sorting / Joins | 第 3 章 | 多表 join 与聚合为什么慢，如何读 `EXPLAIN` |
| ★★★ | L14-L15 Concurrency Control | 第 7 章 | Excel 导入写 `raw_visits` + `visits` 的原子性、钉钉同步并发 |
| ★★☆ | L16 Logging & Recovery | 第 3、10 章 | 为什么 recompute 脚本安全/不安全，WAL 概念 |
| 跳过 | L6 Hash Tables、L8 Index Concurrency、L11-L13 查询优化与执行细节、L17+ 分布式 | 第 5-9 章替代 | 本项目单机 PostgreSQL 暂不需要 |

- 每讲看完后沉淀一篇笔记，命名为 `cmu15445-lXX-主题.md`，交叉引用对应 DDIA 章节笔记。
- 视频在 YouTube（CMUDB 频道），每讲约 80 分钟；★ 标记的讲次合计约 10 讲。
- 课程里的 C++ 实现细节、Bustub 实验作业不做，只取概念。

## 约定

- **书中概念**：优先给出中文通行译名，并保留英文原词。
- **项目对照**：每个概念都指向当前项目中的真实文件、函数或表结构。
- **路径规则**：文件路径以仓库根目录为起点，如 [`backend/src/db.ts`](../../backend/src/db.ts)。
- **Mermaid 图**：数据流图用 Mermaid 语法书写，可在支持 Mermaid 的 Markdown 渲染器中查看。
- **面向读者**：非计算机科班出身的工程师、产品经理、数据分析师。解释不会过度简化，但会尽量避免黑话。

## 为什么把笔记放在项目里

把学习笔记和代码放在一起有两个好处：

1. **可验证**：每一个抽象概念都能在项目里找到对应实现，避免“读完书还是不知道怎么做”。
2. **可维护**：当项目架构变化时，同步更新笔记即可保持知识的准确性。

## 快速链接

- 项目总览：[`README.md`](../../README.md)
- 部署说明：[`DEPLOY.md`](../../DEPLOY.md)
- 开发计划：[`PLAN.md`](../../PLAN.md)
- 项目规范：[`AGENTS.md`](../../AGENTS.md)
