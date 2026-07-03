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

function getExportConfig(): DingTalkFileSendConfig {
  return {
    chatId: process.env.DINGTALK_EXPORT_CHAT_ID || "",
    robotWebhook: process.env.DINGTALK_EXPORT_ROBOT_WEBHOOK || undefined,
    robotSecret: process.env.DINGTALK_EXPORT_ROBOT_SECRET || undefined,
  };
}

export function isExportConfigured(): boolean {
  return !!getExportConfig().chatId;
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
 * 计算自定义机器人加签（当配置了 DINGTALK_EXPORT_ROBOT_SECRET 时）。
 */
function buildRobotSignedUrl(
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
