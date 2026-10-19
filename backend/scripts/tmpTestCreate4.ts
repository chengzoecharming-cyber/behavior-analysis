import { getAccessToken } from '../src/services/dingtalk';

const CODE = 'PROC-5EC4BEC5-E53C-4B42-A9D1-B882E5F65A2A';
const OPERATOR = process.env.DINGTALK_OPERATOR_USERID || '271322273930671357';

async function main() {
  const token = await getAccessToken();
  // 老接口
  const r1 = await fetch(`https://oapi.dingtalk.com/topapi/processinstance/create?access_token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      process_code: CODE, originator_user_id: OPERATOR, dept_id: 924338537,
      form_component_values: [{ name: '备注', value: '老接口测试' }],
    }),
    signal: AbortSignal.timeout(15000),
  });
  const d1: any = await r1.json();
  console.log('老接口 =>', d1.errcode, d1.errmsg, d1.process_instance_id || '');

  // 新接口
  const r2 = await fetch(`https://api.dingtalk.com/v1.0/workflow/instances`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify({
      processCode: CODE, originatorUserId: OPERATOR, deptId: 924338537,
      formComponentValues: [{ name: '备注', value: '新接口测试' }],
    }),
    signal: AbortSignal.timeout(15000),
  });
  const d2: any = await r2.json();
  console.log('新接口 =>', r2.status, JSON.stringify(d2).slice(0, 200));
}
main().catch(e => { console.error(e.message); process.exit(1); });
