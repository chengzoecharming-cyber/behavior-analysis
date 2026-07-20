import fs from "fs";
import path from "path";
import { getAccessToken } from "./dingtalk";

const DINGTALK_API_BASE = "https://api.dingtalk.com";

interface ApiResponse<T = any> {
  errcode?: number;
  errmsg?: string;
  result?: T;
  [key: string]: any;
}

async function httpGet<T = any>(
  url: string,
  params?: Record<string, string>
): Promise<T> {
  const accessToken = await getAccessToken();
  const query = params ? new URLSearchParams(params).toString() : "";
  const fullUrl = query ? `${url}?${query}` : url;
  const res = await fetch(fullUrl, {
    headers: {
      "x-acs-dingtalk-access-token": accessToken,
      "Content-Type": "application/json",
    },
  });
  const data = (await res.json()) as ApiResponse;
  if (data.errcode !== undefined && data.errcode !== 0) {
    throw new Error(`DingTalk API error: ${data.errmsg} (${data.errcode})`);
  }
  return data.result ?? data;
}

async function httpPost<T = any>(url: string, body: any): Promise<T> {
  const accessToken = await getAccessToken();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-acs-dingtalk-access-token": accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as ApiResponse;
  if (data.errcode !== undefined && data.errcode !== 0) {
    throw new Error(`DingTalk API error: ${data.errmsg} (${data.errcode})`);
  }
  return data.result ?? data;
}

interface DriveSpace {
  spaceId: string;
  spaceName: string;
  permissionMode?: string;
}

/**
 * 获取钉盘空间列表，查找同名空间；不存在则创建。
 */
export async function getOrCreateSpace(spaceName: string, unionId: string): Promise<DriveSpace> {
  // 新版服务端 API：获取空间列表
  const listRes = await httpGet<any>(
    `${DINGTALK_API_BASE}/v1.0/drive/spaces`,
    { unionId, spaceType: "org", maxResults: "20" }
  );
  console.log("[DingTalk Drive] spaces response:", JSON.stringify(listRes, null, 2));
  const list: DriveSpace[] = Array.isArray(listRes) ? listRes : listRes?.spaces || listRes?.list || [];

  const existing = list.find((s) => s.spaceName === spaceName);
  if (existing) {
    console.log(`[DingTalk Drive] found existing space: ${existing.spaceId}`);
    return existing;
  }

  // 创建空间
  const created = await httpPost<DriveSpace>(
    `${DINGTALK_API_BASE}/v1.0/drive/spaces`,
    {
      unionId,
      name: spaceName,
      spaceType: "org", // 企业空间
      permissionMode: "acl",
    }
  );
  console.log(`[DingTalk Drive] created space: ${created.spaceId}`);
  return created;
}

interface DriveNode {
  dentryUuid?: string;
  fileId?: string;
  name?: string;
  type?: "folder" | "file";
}

/**
 * 在指定空间下获取或创建文件夹。
 */
export async function getOrCreateFolder(
  spaceId: string,
  parentId: string,
  folderName: string,
  unionId: string
): Promise<string> {
  // 查询 parentId 下的子文件/文件夹列表
  const childrenRes = await httpGet<any>(
    `${DINGTALK_API_BASE}/v1.0/drive/spaces/${spaceId}/files`,
    { unionId, parentId }
  );
  console.log("[DingTalk Drive] files response:", JSON.stringify(childrenRes, null, 2));
  const children: DriveNode[] = Array.isArray(childrenRes) ? childrenRes : childrenRes?.files || childrenRes?.list || [];

  const existing = children.find(
    (c) => c.name === folderName && c.type === "folder"
  );
  if (existing?.fileId || existing?.dentryUuid) {
    const id = existing.fileId || existing.dentryUuid!;
    console.log(`[DingTalk Drive] found existing folder: ${id}`);
    return id;
  }

  // 创建文件夹
  const created = await httpPost<DriveNode>(
    `${DINGTALK_API_BASE}/v1.0/drive/spaces/${spaceId}/files`,
    {
      parentId,
      name: folderName,
      type: "folder",
    }
  );
  const id = created.fileId || created.dentryUuid;
  if (!id) {
    throw new Error("创建文件夹失败：未返回 fileId/dentryUuid");
  }
  console.log(`[DingTalk Drive] created folder: ${id}`);
  return id;
}

interface UploadInfo {
  resourceUrls?: string[];
  headers?: Record<string, string>;
}

/**
 * 上传本地文件到钉盘。
 * 返回云盘 fileId。
 */
export async function uploadFileToDrive(
  spaceId: string,
  parentId: string,
  localFilePath: string,
  fileName?: string
): Promise<string> {
  const name = fileName || path.basename(localFilePath);
  const buffer = fs.readFileSync(localFilePath);
  const size = buffer.length;

  // 1. 获取文件上传信息
  const uploadInfo = await httpPost<UploadInfo>(
    `${DINGTALK_API_BASE}/v1.0/drive/spaces/${spaceId}/files/uploadInfos`,
    {
      fileName: name,
      fileSize: size,
    }
  );

  if (!uploadInfo.resourceUrls || uploadInfo.resourceUrls.length === 0) {
    throw new Error("未获取到文件上传 URL");
  }

  const uploadUrl = uploadInfo.resourceUrls[0];
  const headers = uploadInfo.headers || {};

  // 2. 上传文件到存储服务器
  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers,
    body: buffer,
  });
  if (!uploadRes.ok) {
    throw new Error(`文件上传到存储服务器失败: ${uploadRes.status} ${uploadRes.statusText}`);
  }

  // 3. 提交文件到钉盘
  const submitted = await httpPost<DriveNode>(
    `${DINGTALK_API_BASE}/v1.0/drive/spaces/${spaceId}/files`,
    {
      parentId,
      name,
      type: "file",
      size,
      uploadInfo: {
        resourceUrl: uploadUrl,
      },
    }
  );

  const fileId = submitted.fileId || submitted.dentryUuid;
  if (!fileId) {
    throw new Error("提交文件到钉盘失败：未返回 fileId/dentryUuid");
  }
  console.log(`[DingTalk Drive] uploaded file: ${fileId}`);
  return fileId;
}

/**
 * 给指定用户添加文件/文件夹权限。
 */
export async function addDrivePermission(
  spaceId: string,
  fileId: string,
  userId: string,
  role: "manager" | "editor" | "viewer" = "viewer"
): Promise<void> {
  await httpPost(
    `${DINGTALK_API_BASE}/v1.0/drive/spaces/${spaceId}/files/${fileId}/permissions`,
    {
      members: [
        {
          memberType: "user",
          memberId: userId,
          role,
        },
      ],
    }
  );
  console.log(`[DingTalk Drive] added permission ${role} for ${userId} on ${fileId}`);
}
