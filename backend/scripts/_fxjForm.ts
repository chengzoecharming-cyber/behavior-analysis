import { getAccessToken } from "../src/services/dingtalk";

async function main() {
  const token = await getAccessToken();
  const pc = "PROC-C476D116-FBD1-4125-8741-9725B7DDD604";
  const fs = require("fs");
  const r = await fetch(`https://api.dingtalk.com/v1.0/workflow/forms/schemas/processCodes?processCode=${pc}`, {
    headers: { "x-acs-dingtalk-access-token": token },
  });
  const j: any = await r.json();
  fs.writeFileSync("/tmp/tj/fxj-form.json", JSON.stringify(j, null, 1));
  const items = j?.result?.schemaContent?.items || [];
  console.log("name:", j?.result?.name, "| items:", items.length);
  for (const it of items) {
    console.log(`- [${it.componentName}] ${it.props?.label} required=${it.props?.required}`);
  }
}
main();
