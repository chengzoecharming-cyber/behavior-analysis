/** 临时：枚举操作人可见的审批模板，找历史「用车」类模板。只读。 */
import dotenv from "dotenv";
dotenv.config();
import { getDingTalkConfig } from "../src/services/dingtalk";

async function main() {
  const cfg = getDingTalkConfig();
  const t: any = await (await fetch(`https://oapi.dingtalk.com/gettoken?appkey=${cfg.appKey}&appsecret=${cfg.appSecret}`)).json();
  const token = t.access_token;
  const r: any = await (await fetch(`https://oapi.dingtalk.com/topapi/process/listbyuserid?access_token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userid: process.env.DINGTALK_OPERATOR_USERID, offset: 0, size: 100 }),
  })).json();
  if (r.errcode !== 0) {
    console.log("失败:", r.errcode, r.errmsg);
    return;
  }
  const list = r.result?.process_list || [];
  console.log("可见模板共", list.length, "个");
  for (const p of list) {
    console.log(`${p.name || ""} | ${p.process_code} | ${p.create_time ? new Date(Number(p.create_time)).toISOString().slice(0, 10) : "?"}`);
  }
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
