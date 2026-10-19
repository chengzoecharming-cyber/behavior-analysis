import { getAccessToken } from '../src/services/dingtalk';

const CODE = 'PROC-C20D9C1D-0D64-4F44-88FC-72103F36D29D';
const OPERATOR = process.env.DINGTALK_OPERATOR_USERID || '271322273930671357';

async function create(vals: any[], label: string) {
  const token = await getAccessToken();
  const res = await fetch(`https://api.dingtalk.com/v1.0/workflow/instances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify({
      processCode: CODE, originatorUserId: OPERATOR, deptId: 924338537,
      formComponentValues: vals,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data: any = await res.json();
  console.log(label, '=>', res.status, JSON.stringify(data).slice(0, 250));
}

async function main() {
  await create([
    { name: '功能', value: '新建客户' },
    { name: '客户类型', value: '国内企业客户' },
    { name: '公司名称', value: '格式测试公司H' },
    { name: '负责人', value: '271322273930671357' },
  ], 'H 基础四项');
}
main().catch(e => { console.error(e.message); process.exit(1); });
