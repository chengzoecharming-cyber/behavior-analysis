# 第 8 章精读（第二版）：事务（Transactions）

> 版本说明：本文基于 **DDIA 第二版（Early Release）** 第 8 章「事务」。
> 本章风格与前面不同：**先项目、后书**——因为原子性这部分用我们自己的代码讲最清楚。
> 跳过：两阶段提交（2PC）、分布式事务、2PL/SSI 算法细节——均为多节点场景，单机 PostgreSQL 用不上。
> 在线阅读：<https://ddia.vonng.com/ch8/>

## 零、先用项目代码讲清楚：事务是什么

事务（transaction）= 把多个读写操作**打包**：`BEGIN` 和 `COMMIT` 之间的所有操作，**要么全部生效，要么全部撤销（ROLLBACK），不存在"写了一半"**。

项目中的真实代码（`backend/src/services/normalization.ts`，同步入库）：

```ts
const client = await pool.connect();
try {
  await client.query("BEGIN");                        // 打包开始
  const rawResult = await client.query("INSERT INTO raw_visits ...");
  const visitResult = await client.query("INSERT INTO visits ... ON CONFLICT DO NOTHING RETURNING id");
  if (visitResult.rows.length === 0) {
    await client.query("ROLLBACK");                   // 出问题：全部撤销
    continue;
  }
  await client.query("COMMIT");                       // 两步都成：一起生效
} finally {
  client.release();
}
```

**判断要不要用事务的标准**：一次操作要写 ≥2 个地方，且「只写一半」会造成脏数据 → 打包。单条 SQL 不需要（自带原子性）。

## 一、ACID 四个字母

### A — 原子性（Atomicity），更准确叫可中止性（abortability）

出错时把已写了一半的东西**全部扔掉**，应用可以放心重试。项目中三处应用：

| 位置 | 打包内容 | 防的"半成品" |
|---|---|---|
| `normalization.ts` | `raw_visits` + `visits` 两条 INSERT | raw 孤儿行（visits 失败但 raw 已写） |
| `routeService.ts` | 重算 routes：DELETE 全部旧路线 + INSERT 新路线（先算后换） | 高德半路失败 → 当天路线清零 |
| `riskSummaryService.ts` / `stopDetection.ts` | 缓存刷新：DELETE 旧行 + INSERT 新行 | 读者在刷新中途读到空缓存 |

### C — 一致性（Consistency）：把"规矩"交给数据库守

数据必须永远成立的规定叫**不变式（invariant）**。C 主要是应用的责任——**除非把规矩告诉数据库**：唯一约束（UNIQUE）、外键（FOREIGN KEY）、检查约束（CHECK）。

项目应用：`visits` 的部分唯一索引 `(approval_id, user_id, sequence)`——「同一审批单序号不重复」以前靠应用层"先查再插"守（守不住），现在交给数据库守（100%）。**数据库是唯一不会睡着的检查员。**

### I — 隔离性（Isolation）：并发互不干扰

- **丢失更新（lost update）**：「先查再插」这类读-改-写竞态——A 查（没有）→ B 查（没有）→ A 写 → B 写 → 重复数据。应用层检查永远堵不上这条缝，只能靠约束或锁。
- **脏读防护（read committed，PostgreSQL 默认隔离级别）**：别人只能读到**已提交**的数据。事务打包的第二个好处：写入中途读者要么看到全旧、要么看到全新，看不到"删完未插"的空表。
- **MVCC（多版本并发控制，Multi-Version Concurrency Control）**：每行保留多个版本，"读不阻塞写，写不阻塞读"。日常体验：同步任务写 visits 与你打开控制台查询同时进行，互不卡。

### D — 持久性（Durability）：提交了就不丢

- 实现机制：**WAL（预写日志，Write-Ahead Log）**——先写"我要改什么"到磁盘日志，再刷数据文件；崩溃后**回放（recovery）** WAL 恢复。
- 2026-08-03 事故亲历：应用日志刷爆磁盘（39GB）→ Postgres 写不了 WAL/checkpoint → PANIC → 重启进入 `recovery mode`（回放 WAL）→ 回放也需要磁盘空间，空间为 0 → 永远卡住。
- 书中忠告：完美的持久性不存在，只有「写磁盘 + 复制 + 定期备份」层层降险。**本项目生产库尚无备份策略，建议加每日 `pg_dump` 定时备份。**

## 二、我们踩过的坑（2026-08-03 排查对照）

1. **无事务的半成品残留**：raw+visits 两条裸 INSERT，坏数据让 raw_visits 每 3 小时膨胀一行孤儿。
2. **一致性寄托在应用层**：「先查再插」并发必漏，线上清出 9 组重复 visits。
3. **DELETE+INSERT 裸奔**：routes 与缓存刷新无事务，失败清零、读者读空窗。

## 三、设计新功能时的检查点

1. 这次写入涉及几个对象？>1 且半成品不可接受 → 放事务（`BEGIN`/`COMMIT`）。
2. 有什么"必须永远成立的规矩"？能写成约束就交给数据库，别靠应用层"先查再插"。
3. 有没有读-改-写模式（先 SELECT 再决定 INSERT/UPDATE）？→ 想并发下会怎样。
4. 重试安全吗？（事务中止后重试安全；无幂等键时"实际成功但响应丢失"的重试会写两遍——配合幂等键使用）

## 练习题（附参考答案要点）

1. 「先查再插」为什么并发必漏？——A、B 的"查"都发生在对方的"写"之前，都认为自己可以写。
2. visits 唯一索引对应哪个字母？——C（不变式交给数据库执行）。
3. recovery mode 在干嘛？——回放 WAL，把数据库恢复到最后一致状态；那晚它因磁盘满无法完成回放。

## 统计补给站（Math Corner）

本章无新增统计概念。复习两个贯穿全书的词：

- **竞态条件（race condition）**：结果取决于"谁先谁后"的时序，时序不巧才出错——所以并发 bug 难复现、难测试。
- **回滚（rollback）/ 中止（abort）**：事务失败时撤销全部已做写入，数据库回到事务开始前。重试（retry）只有在中止后才安全——这是"事务 + 幂等键"组合被称为数据管道安全带的原因。
