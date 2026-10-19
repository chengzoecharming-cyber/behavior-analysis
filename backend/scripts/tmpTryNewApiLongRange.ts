/** 临时：测试新版 instanceIds/query 能否查 2024-10（OA高级版支持5年）。只读。 */
import dotenv from "dotenv";
dotenv.config();
import { getDingTalkConfig } from "../src/services/dingtalk";

async function main() {
  const cfg = getDingTalkConfig();
  const t: any = await (await fetch(`https://oapi.dingtalk.com/gettoken?appkey=${cfg.appKey}&appsecret=${cfg.appSecret}`)).json();

  const r: any = await (await fetch("https://api.dingtalk.com/v1.0/workflow/processes/instanceIds/query", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": t.access_token },
    body: JSON.stringify({
      processCode: cfg.processCode,
      startTime: Math.floor(new Date("2026-10-01T00:00:00+08:00").getTime()),
      endTime: Math.floor(new Date("2026-10-15T23:59:59+08:00").getTime()),
      nextToken: 0,
      maxResults: 20,
    }),
  })).json();
  console.log(JSON.stringify(r).slice(0, 2000));
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
