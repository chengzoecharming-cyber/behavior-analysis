import "dotenv/config";

async function main() {
  const res = await fetch(process.env.CRM_MCP_URL || "https://dingcrm.eapps.dingtalkcloud.com/open/mcp/v1/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${process.env.CRM_MCP_TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  const rpc = JSON.parse(dataLine!.slice(5).trim());
  const tools = rpc.result?.tools ?? [];
  for (const t of tools) {
    console.log(`\n=== ${t.name}`);
    console.log((t.description || "").slice(0, 400));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
