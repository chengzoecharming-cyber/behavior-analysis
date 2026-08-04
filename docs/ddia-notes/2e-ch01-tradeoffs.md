# 第 1 章精读（第二版）：数据系统架构中的权衡

> 版本说明：本文基于 **DDIA 第二版（Early Release）** 第 1 章「数据系统架构中的权衡」（Trade-offs in Data Systems Architecture）。
> 注意它与第一版第 1 章「可靠、可扩展、可维护」是完全不同的内容（第一版那章的主题在第二版移至第 2 章，见 [`2e-ch02-nonfunctional-requirements.md`](2e-ch02-nonfunctional-requirements.md)）。
> 在线阅读：<https://ddia.vonng.com/ch1/>

## 一、书中在说什么

第二版开场：**没有完美的方案，只有权衡（trade-off）**。第 1 章给出数据工程领域最重要的几组"坐标系"：

### 1. 事务型 vs 分析型系统（OLTP vs OLAP）

- **事务型系统（OLTP, Online Transaction Processing）**：直接服务用户、**产生数据**的系统。特点：按 key 点查询（point query）、低延迟单条读写、交互式操作。
- **分析型系统（OLAP, Online Analytical Processing）**：把事务型系统的数据复制一份用于分析——管理层报表、商业智能（BI, Business Intelligence）、数据科学。特点：扫描大量记录做聚合（count/sum/avg）、写入以**批量导入（ETL）**为主、用户是内部分析师而非最终用户。

两者分离的理由：数据孤岛（silo）难以联合查询；分析查询太重会拖垮在线服务；数据布局（layout）需求不同；安全合规上不该让分析师直接碰生产库。

### 2. ETL、数据仓库与寿司原则

- **ETL（Extract-Transform-Load，提取-转换-加载）**：把数据从事务型系统搬进分析系统的管道。变体 **ELT**（先加载再转换）。数据源是外部 SaaS 时，需要专门的**数据连接器（data connector）**，如 Fivetran、Airbyte。
- **数据仓库（Data Warehouse）**：关系模型的分析库，适合 BI。
- **数据湖（Data Lake）**：不限格式的原始数据存储，适合数据科学。背后信条是**寿司原则（Sushi Principle）："原始数据更好"（Raw data is better）**——数据越原始留存，未来可重做的空间越大。
- 分析结果回流到事务系统叫**反向 ETL（Reverse ETL）**，产出称**数据产品（Data Product）**。

### 3. 记录系统 vs 派生数据

- **记录系统（System of Record）/ 真相来源（Source of Truth）**：数据的权威（canonical）版本，新数据首先写入这里，每个事实只记一次。**其他系统与它不一致时，以它为准。**
- **派生数据（Derived Data）**：对已有数据加工转换的结果——缓存（cache）、索引（index）、物化视图（materialized view）、报表、训练出的模型都算。特点：**冗余但可重建**，是读性能的关键。
- 难点不在区分，而在于：**记录系统变化后，如何同步更新派生数据**——这通常是应用自己的责任，数据库帮不上忙。

### 4. 云 vs 自托管；分布式 vs 单节点

- **自托管（self-hosted）**：自己部署运维（含在云 VM 上自建，即 IaaS）。运维责任包括容量规划（capacity planning）——**"监控可用磁盘空间，并在用完之前添加磁盘"**。
- **云原生（cloud-native）**：存储与计算分离（storage-compute separation）、多租户（multi-tenancy）、按量计费。
- **分布式（distributed）vs 单节点（single-node）**：书中态度明确——**单机做得下就不要分布式**，更简单更便宜。

## 二、项目对照

| 概念 | 本项目 |
|---|---|
| OLTP | 钉钉审批后台——员工打卡产生数据，我们系统的上游 |
| OLAP | 本项目整体：批量导入 + 聚合统计 + 管理决策报表 |
| ETL / 数据连接器 | `backend/src/services/dingtalk.ts` 同步 = 手写的钉钉专用连接器：Extract（listids + detail API）→ Transform（`parseApprovalInstance` + `normalization.ts`）→ Load（`visits`） |
| 数仓分层 | RAW（`raw_approvals`/`raw_visits`）→ NORMALIZED（`visits`）→ DERIVED（`routes`/`stops`/缓存） |
| 寿司原则 | `raw_approvals` 原样保存钉钉 JSON，解析逻辑出错时可重放修复 |
| 记录系统 | `visits`（一切不一致以它为准） |
| 派生数据 | `routes`、`stops`、`risk_summary_cache`、日/周/月报 |
| 自托管（IaaS） | 阿里云 VM + Docker + 自建 PostgreSQL |
| 单节点 | 单机 PostgreSQL——按书的标准是正确选择 |

## 三、我们踩过的坑（2026-08-03 事故对照）

1. **自托管的容量规划责任没履行**：书上写明自托管运维要"监控磁盘空间并提前扩容"，我们缺磁盘监控与日志上限 → 39GB 日志写满磁盘 → Postgres PANIC。
2. **ETL 管道断裂无观测**：同步失败十余小时告警静默。ETL 是分析系统的生命线，管道必须自己盯着（见第 2 章的可观测性部分）。
3. **把派生数据当记录系统依赖**：报告直接读 `routes` 表并假设"肯定算好了"。修复方向 = 读派生数据前校验它与记录系统是否同步（`ensureFreshRoutes`、缓存新鲜度校验）。

## 四、设计新功能时的检查点

1. 新功能的数据**记录系统**在哪？若它就是新事实源，写入必须幂等（idempotent）+ 事务（transaction）。
2. 产出是不是**派生数据**？是：重建路径是什么？谁发现它旧了？
3. 数据是否**原样留存**（寿司原则）？转换永远可以重做，原始数据丢了就没了。
4. 属于 OLTP 侧还是 OLAP 侧？会不会让分析查询拖垮在线服务？
5. 部署方式对应的**运维责任清单**接得住吗？

## 练习题（附参考答案要点）

1. 为什么说「钉钉审批 + 本系统」合起来是完整数据架构？——钉钉审批是 OLTP（数据产生地），本系统是 OLAP（分析消费地），中间靠 ETL（同步）连接。
2. 寿司原则体现在哪张表？——`raw_approvals`（未经解析的原始 JSON）；`visits` 已加工不算。
3. 报告里程与线上不一致时以谁为准？——两者都是派生数据，裁判是记录系统 `visits`；正确说法是"以 visits 重算为准"，线上更准只是因为它的派生时间更新。
