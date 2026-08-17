import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getAccessToken } from "./dingtalk";

const DINGTALK_API_BASE = "https://oapi.dingtalk.com";

export interface DingTalkFileSendConfig {
  chatId: string;
  robotWebhook?: string;
  robotSecret?: string;
}

export interface DingTalkWorkNotificationConfig {
  agentId: string;
}

export function getExportConfig(): DingTalkFileSendConfig {
  return {
    chatId: process.env.DINGTALK_EXPORT_CHAT_ID || "",
    robotWebhook: process.env.DINGTALK_EXPORT_ROBOT_WEBHOOK || undefined,
    robotSecret: process.env.DINGTALK_EXPORT_ROBOT_SECRET || undefined,
  };
}

export function getWorkNotificationConfig(): DingTalkWorkNotificationConfig {
  return {
    agentId: process.env.DINGTALK_AGENT_ID || "",
  };
}

export function isExportConfigured(): boolean {
  return !!getExportConfig().chatId;
}

export function isWorkNotificationConfigured(): boolean {
  return !!getWorkNotificationConfig().agentId;
}

/**
 * 上传文件到钉钉媒体空间，返回 media_id。
 */
export async function uploadMediaToDingTalk(
  filePath: string,
  fileName?: string
): Promise<string> {
  const accessToken = await getAccessToken();
  const name = fileName || path.basename(filePath);
  const buffer = fs.readFileSync(filePath);

  const formData = new FormData();
  formData.append("media", new Blob([buffer]), name);

  const url = `${DINGTALK_API_BASE}/media/upload?access_token=${encodeURIComponent(
    accessToken
  )}&type=file`;

  const res = await fetch(url, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`钉钉 media/upload HTTP 错误: ${res.status} ${res.statusText}`);
  }

  const data: any = await res.json();
  if (data.errcode !== 0) {
    throw new Error(`钉钉 media/upload 失败: ${data.errmsg} (${data.errcode})`);
  }

  if (!data.media_id) {
    throw new Error("钉钉 media/upload 未返回 media_id");
  }

  return data.media_id;
}

/**
 * 以应用身份发送文件到指定群聊。
 */
export async function sendFileToDingTalkChat(
  mediaId: string,
  fileName: string
): Promise<void> {
  const { chatId } = getExportConfig();
  if (!chatId) {
    throw new Error("未配置 DINGTALK_EXPORT_CHAT_ID");
  }

  const accessToken = await getAccessToken();
  const url = `${DINGTALK_API_BASE}/chat/send?access_token=${encodeURIComponent(accessToken)}`;

  const body = {
    chatid: chatId,
    msg: {
      msgtype: "file",
      file: {
        media_id: mediaId,
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`钉钉 chat/send HTTP 错误: ${res.status} ${res.statusText}`);
  }

  const data: any = await res.json();
  if (data.errcode !== 0) {
    throw new Error(`钉钉 chat/send 失败: ${data.errmsg} (${data.errcode})`);
  }
}

/**
 * 以应用身份发送 Markdown 消息到指定群聊（走 /chat/send，无自定义机器人关键词限制）。
 */
export async function sendMarkdownToDingTalkChat(
  title: string,
  text: string
): Promise<void> {
  const { chatId } = getExportConfig();
  if (!chatId) {
    throw new Error("未配置 DINGTALK_EXPORT_CHAT_ID");
  }

  const accessToken = await getAccessToken();
  const url = `${DINGTALK_API_BASE}/chat/send?access_token=${encodeURIComponent(accessToken)}`;

  const body = {
    chatid: chatId,
    msg: {
      msgtype: "markdown",
      markdown: { title, text },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`钉钉 chat/send HTTP 错误: ${res.status} ${res.statusText}`);
  }

  const data: any = await res.json();
  if (data.errcode !== 0) {
    throw new Error(`钉钉 chat/send 失败: ${data.errmsg} (${data.errcode})`);
  }
}

/**
 * 以应用身份发送工作通知（ corpconversation/asyncsend_v2 ）到指定用户。
 */
async function sendWorkNotificationToUsers(
  userIds: string[],
  msg: { msgtype: string; [key: string]: any }
): Promise<void> {
  const { agentId } = getWorkNotificationConfig();
  if (!agentId) {
    throw new Error("未配置 DINGTALK_AGENT_ID");
  }

  const accessToken = await getAccessToken();
  const url = `${DINGTALK_API_BASE}/topapi/message/corpconversation/asyncsend_v2?access_token=${encodeURIComponent(
    accessToken
  )}`;

  const body = {
    agent_id: agentId,
    userid_list: userIds.join(","),
    msg,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`钉钉工作通知 HTTP 错误: ${res.status} ${res.statusText}`);
  }

  const data: any = await res.json();
  if (data.errcode !== 0) {
    throw new Error(`钉钉工作通知发送失败: ${data.errmsg} (${data.errcode})`);
  }
  console.log(`[DingTalk WorkNotification] task_id=${data.task_id}, request_id=${data.request_id}, userIds=${userIds.join(",")}`);
}

/**
 * 以应用身份发送文件类型工作通知到指定用户。
 */
export async function sendWorkNotificationFile(
  userIds: string[],
  mediaId: string
): Promise<void> {
  if (userIds.length === 0) {
    throw new Error("接收用户列表为空");
  }
  await sendWorkNotificationToUsers(userIds, {
    msgtype: "file",
    file: { media_id: mediaId },
  });
}

/**
 * 以应用身份发送 Markdown 类型工作通知到指定用户。
 */
export async function sendWorkNotificationMarkdown(
  userIds: string[],
  title: string,
  text: string
): Promise<void> {
  if (userIds.length === 0) {
    throw new Error("接收用户列表为空");
  }
  await sendWorkNotificationToUsers(userIds, {
    msgtype: "markdown",
    markdown: { title, text },
  });
}

/**
 * 以应用机器人身份发送 Markdown 单聊消息（/v1.0/robot/oToMessages/batchSend）。
 * 消息以机器人 1 对 1 会话出现在消息列表，比「工作通知」会话更显眼。
 * robotCode 默认取 DINGTALK_APP_KEY（企业内部应用的机器人 code 即 AppKey），
 * 也可用 DINGTALK_ROBOT_CODE 覆盖。部分接收人无效/被过滤只告警不抛错。
 */
export async function sendRobotMarkdownToUsers(
  userIds: string[],
  title: string,
  text: string
): Promise<void> {
  if (userIds.length === 0) {
    throw new Error("接收用户列表为空");
  }
  const robotCode = process.env.DINGTALK_ROBOT_CODE || process.env.DINGTALK_APP_KEY;
  if (!robotCode) {
    throw new Error("未配置 DINGTALK_APP_KEY（机器人单聊 robotCode）");
  }

  const accessToken = await getAccessToken();
  const res = await fetch(`${DINGTALK_API_BASE}/v1.0/robot/oToMessages/batchSend`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acs-dingtalk-access-token": accessToken,
    },
    body: JSON.stringify({
      robotCode,
      userIds,
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify({ title, text }),
    }),
  });

  if (!res.ok) {
    throw new Error(`机器人单聊 HTTP 错误: ${res.status} ${res.statusText}`);
  }
  const data: any = await res.json();
  if (data.code) {
    throw new Error(`机器人单聊发送失败: ${data.message} (${data.code})`);
  }
  const invalid: string[] = data.invalidStaffIdList || [];
  const filtered: string[] = data.filteredStaffIdList || [];
  if (invalid.length > 0 || filtered.length > 0) {
    console.warn(
      `[DingTalk RobotDM] 部分接收人未送达: invalid=${invalid.join(",")} filtered=${filtered.join(",")}`
    );
  }
  if (invalid.length + filtered.length >= userIds.length) {
    throw new Error("机器人单聊全部接收人未送达");
  }
}

/**
 * 报告推送统一入口：优先走机器人单聊（更显眼），失败回退工作通知。
 */
export async function sendReportMessageToUsers(
  userIds: string[],
  title: string,
  text: string
): Promise<void> {
  try {
    await sendRobotMarkdownToUsers(userIds, title, text);
  } catch (err: any) {
    console.warn(
      `[DingTalk RobotDM] 机器人单聊失败，回退工作通知: ${err?.message || err}`
    );
    await sendWorkNotificationMarkdown(userIds, title, text);
  }
}

/**
 * 计算自定义机器人加签（当配置了 DINGTALK_EXPORT_ROBOT_SECRET 时）。
 */
export function buildRobotSignedUrl(
  webhook: string,
  secret: string | undefined
): string {
  if (!secret) return webhook;

  const timestamp = String(Date.now());
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto
    .createHmac("sha256", secret)
    .update(stringToSign, "utf8")
    .digest("base64");

  const url = new URL(webhook);
  url.searchParams.set("timestamp", timestamp);
  url.searchParams.set("sign", sign);
  return url.toString();
}

/**
 * 可选：通过自定义机器人 webhook 发送 Markdown 摘要。
 */
export async function sendReportSummaryByRobot(
  summary: string
): Promise<void> {
  const { robotWebhook, robotSecret } = getExportConfig();
  if (!robotWebhook) return;

  const url = buildRobotSignedUrl(robotWebhook, robotSecret);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msgtype: "markdown",
      markdown: { title: "外勤行为报告", text: summary },
    }),
  });

  if (!res.ok) {
    console.warn("机器人摘要发送失败:", res.status, res.statusText);
  }

  const data: any = await res.json().catch(() => null);
  if (data && data.errcode !== 0) {
    console.warn("机器人摘要发送失败:", data.errmsg, `(${data.errcode})`);
  }
}
