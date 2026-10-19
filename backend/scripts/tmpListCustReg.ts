import { getApprovalInstances, getApprovalDetail } from '../src/services/dingtalk';

async function main() {
  const code = 'PROC-C20D9C1D-0D64-4F44-88FC-72103F36D29D';
  const res = await getApprovalInstances(Date.now() - 3*86400000, Date.now(), 0, 20, code);
  for (const id of res.list) {
    const d = await getApprovalDetail(id);
    console.log(id.slice(0,12), '|', d.status, '|', d.result, '|', d.create_time, '->', d.finish_time);
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
