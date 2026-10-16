import { pool } from "../db";

/**
 * 自建 LLM 拜访总结服务（替代钉钉 DDAIField「AI总结」）。
 *
 * 背景：v2 审批单的钉钉 AI总结字段已失效（为空），visit_note 只剩
 * 「沟通内容：...；存在问题：...」的原始兜底拼接。本服务把这两条原始内容
 * 压缩成一段简洁总结，写回 visit_detail.ai 与 visit_note。
 *
 * 接口为 OpenAI 兼容的 /chat/completions，当前默认 DeepSeek：
 * - LLM_API_KEY  （未配置时所有入口静默跳过，维持原始兜底文本，不报错）
 * - LLM_BASE_URL （默认 https://api.deepseek.com）
 * - LLM_MODEL    （默认 deepseek-chat）
 * - LLM_TIMEOUT_MS（默认 30000）
 * 换其他 OpenAI 兼容服务只需改这三个环境变量。
 */

const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_BASE_URL = (process.env.LLM_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
const LLM_MODEL = process.env.LLM_MODEL || "deepseek-chat";
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 30000);

// 单条总结并发上限，避免打爆 LLM 接口限流
const CONCURRENCY = 3;

export function isLlmConfigured(): boolean {
  return !!LLM_API_KEY;
}

/**
 * 把一条拜访的「沟通内容详情」与「存在问题点」压缩成 1~2 句极简摘要。
 * 硬性约束在 prompt 中：只概括不扩写、长度明显短于原文。
 * 内容为空/过短（如只填「公司办公」「。」）、未配置 key、超时、调用失败
 * 或模型返回拒绝语（「无法生成摘要」等）均返回 null（绝不抛异常，失败保留兜底文本）。
 */
export async function summarizeVisit(
  comm?: string,
  issues?: string,
  accompany?: string
): Promise<string | null> {
  const parts: string[] = [];
  const hasAccompany = !!(accompany && accompany.trim());
  if (hasAccompany) parts.push(`陪同对象：${accompany!.trim()}`);
  if (comm && comm.trim()) parts.push(`沟通内容详情：${comm.trim()}`);
  if (issues && issues.trim()) parts.push(`存在问题点：${issues.trim()}`);
  if (parts.length === 0) return null;
  if (!isLlmConfigured()) return null;

  // 有效内容过短（「公司办公」「交付」「。」之类）不值得总结，
  // 模型也只会返回「信息不足，无法生成摘要」，直接跳过保留兜底文本
  const meaningful = ((comm || "") + (issues || "")).replace(/[\s\p{P}\p{S}]/gu, "");
  if (meaningful.length < 8) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  // 有无陪同对象用两套 prompt：有则要求以陪同信息开头整合成一段；无则绝不提及陪同，
  // 避免模型输出「陪同信息缺失/未提及」这类评论或把沟通对象脑补成陪同人
  const systemPrompt = hasAccompany
    ? "你是销售外勤管理助手。把销售人员拜访客户时填写的「陪同对象」「沟通内容详情」和「存在问题点」（如有）压缩成一段极简的中文摘要。" +
      "硬性要求：1) 只概括、不创作，禁止补充、推测或扩写任何原文没有的信息（如建议、评价、背景）；2) 输出长度必须明显短于原文，一般不超过原文一半，通常 1~2 句；3) 保留关键事实：拜访对象、事项、结论或待办；4) 只输出摘要正文，不要标题、列表、编号、分点或表情；" +
      "5) 摘要必须以陪同信息开头，把陪同人与沟通内容整合成一段直接说明（如「陪同XX，拜访了……」），禁止把陪同与沟通内容分开描述。"
    : "你是销售外勤管理助手。把销售人员拜访客户时填写的「沟通内容详情」和「存在问题点」（如有）压缩成一段极简的中文摘要。" +
      "硬性要求：1) 只概括、不创作，禁止补充、推测或扩写任何原文没有的信息（如建议、评价、背景）；2) 输出长度必须明显短于原文，一般不超过原文一半，通常 1~2 句；3) 保留关键事实：拜访对象、事项、结论或待办；4) 只输出摘要正文，不要标题、列表、编号、分点或表情；" +
      "5) 本次拜访与陪同无关：禁止出现「陪同」「陪伴」字样，也禁止输出「陪同信息缺失」「未提及」之类的评论。";
  try {
    const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0.3,
        max_tokens: 300,
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          { role: "user", content: parts.join("\n") },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[llmSummary] LLM 接口返回 ${res.status} ${res.statusText}`);
      return null;
    }
    const data: any = await res.json();
    const text = (data?.choices?.[0]?.message?.content || "").trim();
    // 模型对过短/无意义输入会返回拒绝语，不能当摘要落库
    if (!text || /信息不足|无法生成|内容为空|请提供/.test(text)) return null;
    // 非陪同拜访的摘要禁止出现陪同字眼（模型违规时丢弃，保留兜底文本）
    if (!hasAccompany && /陪/.test(text)) {
      console.warn(`[llmSummary] 非陪同拜访摘要出现陪同字眼，丢弃: ${text.slice(0, 50)}`);
      return null;
    }
    return text;
  } catch (err: any) {
    console.warn(`[llmSummary] 总结生成失败: ${err?.message || err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从原 visit_note 末尾提取里程备注后缀（形如「 [缺少终点里程读数]」
 * 「 [里程读数异常：...]」，由 parseApprovalInstanceV2 的 mileageNote 追加）。
 * 回写 AI 总结时必须保留这段，提取不到则返回空串。
 */
export function extractMileageNoteSuffix(note?: string | null): string {
  if (!note) return "";
  const matches = note.match(/\s*\[[^\]]*\]/g) || [];
  return matches.filter((m) => /里程|读数/.test(m)).join("");
}

/**
 * 把 AI 总结回写到 visits 行（按 approval_id+user_id+sequence 定位，仅 v2 行）：
 * visit_detail.ai 写入总结；visit_note 替换为「总结 + 原里程备注后缀」。
 */
export async function persistAiSummary(
  row: { approval_id: string; user_id: string; sequence: number; visit_note?: string | null },
  aiText: string
): Promise<void> {
  const suffix = extractMileageNoteSuffix(row.visit_note);
  const newNote = aiText + suffix;
  await pool.query(
    `UPDATE visits
     SET visit_detail = jsonb_set(COALESCE(visit_detail, '{}'::jsonb), '{ai}', to_jsonb($1::text)),
         visit_note = $2
     WHERE approval_id = $3 AND user_id = $4 AND sequence = $5 AND form_version = 'v2'`,
    [aiText, newNote, row.approval_id, row.user_id, row.sequence]
  );
}

interface VisitRowForSummary {
  approval_id: string;
  user_id: string;
  sequence: number;
  visit_note: string | null;
  comm: string;
  issues: string;
  accompany: string;
}

/** 查询指定 user+date 下缺 AI 总结但有原始内容的 v2 行 */
async function findMissingAiRows(
  userId: string,
  businessDate: string
): Promise<VisitRowForSummary[]> {
  const result = await pool.query<VisitRowForSummary>(
    `SELECT approval_id, user_id, sequence, visit_note,
            COALESCE(visit_detail->>'comm', '') AS comm,
            COALESCE(visit_detail->>'issues', '') AS issues,
            COALESCE(visit_detail->>'accompany', '') AS accompany
     FROM visits
     WHERE form_version = 'v2'
       AND user_id = $1 AND business_date = $2
       AND approval_id IS NOT NULL AND sequence IS NOT NULL
       AND (visit_detail IS NULL OR COALESCE(visit_detail->>'ai', '') = '')
       AND (COALESCE(visit_detail->>'comm', '') <> '' OR COALESCE(visit_detail->>'issues', '') <> '')`,
    [userId, businessDate]
  );
  return result.rows;
}

/** 简单并发控制（手写 p-limit，固定并发数） */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * 批量入口：为给定 user+date 集合中缺 AI 总结的 v2 行生成并回写总结。
 * 未配置 LLM_API_KEY 时静默跳过；单条失败只记日志，不影响其他行。
 */
export async function summarizeMissingAiForUserDates(
  pairs: { user_id: string; business_date: string }[]
): Promise<void> {
  if (!isLlmConfigured() || pairs.length === 0) return;

  const rows: VisitRowForSummary[] = [];
  for (const p of pairs) {
    try {
      rows.push(...(await findMissingAiRows(p.user_id, p.business_date)));
    } catch (err) {
      console.warn(
        `[llmSummary] 查询缺 AI 总结行失败: ${p.user_id} @ ${p.business_date}`,
        err
      );
    }
  }
  if (rows.length === 0) return;

  let done = 0;
  let failed = 0;
  await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
    try {
      const aiText = await summarizeVisit(row.comm, row.issues, row.accompany);
      if (!aiText) {
        failed++;
        return;
      }
      await persistAiSummary(row, aiText);
      done++;
    } catch (err) {
      failed++;
      console.warn(
        `[llmSummary] 回写失败: approval=${row.approval_id} user=${row.user_id} seq=${row.sequence}`,
        err
      );
    }
  });
  console.log(`[llmSummary] 本次补全 AI 总结 ${done} 条，失败/跳过 ${failed} 条`);
}
