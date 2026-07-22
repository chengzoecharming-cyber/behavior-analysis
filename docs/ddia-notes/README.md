# DDIA 学习笔记：销售外勤行为分析系统对照版

> 本目录记录阅读《Designing Data-Intensive Applications》（中文译名《数据密集型应用系统设计》）的读书笔记，并始终把书中概念映射到当前项目——销售外勤行为分析系统——的真实代码与架构上。

## 目录

| 文件 | 说明 | 当前状态 |
|---|---|---|
| [`README.md`](README.md) | 学习索引、约定、阅读顺序 | 本文件 |
| [`data-engineering-cheatsheet.md`](data-engineering-cheatsheet.md) | 数据工程名词速查：ETL/ELT、checkSum、Superset、数据仓库分层、Medallion Architecture 等 | 已完成 |
| [`ch01-reliable-scalable-maintainable.md`](ch01-reliable-scalable-maintainable.md) | 第 1 章：可靠性、可扩展性、可维护性 | 已完成 |

## 阅读顺序建议

1. 先读 [`data-engineering-cheatsheet.md`](data-engineering-cheatsheet.md)，建立术语表。
2. 再读 [`ch01-reliable-scalable-maintainable.md`](ch01-reliable-scalable-maintainable.md)，理解全书总纲如何落地到本项目。
3. 后续章节会逐步补充到本目录，每章独立成文，但交叉引用会保持链接。

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
