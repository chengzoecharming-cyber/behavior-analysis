import { getAccessToken } from '../src/services/dingtalk';

const CODE = 'PROC-64D773D6-7A73-45CD-85CE-0D733E35EC4A';
const OPERATOR = process.env.DINGTALK_OPERATOR_USERID || '271322273930671357';

async function main() {
  const token = await getAccessToken();
  const r = await fetch(`https://oapi.dingtalk.com/topapi/processinstance/create?access_token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      process_code: CODE, originator_user_id: OPERATOR, dept_id: 924338537,
      form_component_values: [{ name: '公司名称', value: '格式测试-副本' }],
    }),
    signal: AbortSignal.timeout(15000),
  });
  const d: any = await r.json();
  console.log('副本表单 =>', d.errcode, d.errmsg, d.process_instance_id || '');
}
main().catch(e => { console.error(e.message); process.exit(1); });
