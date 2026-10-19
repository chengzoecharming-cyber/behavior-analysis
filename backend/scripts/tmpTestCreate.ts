import { getAccessToken } from '../src/services/dingtalk';

const CODE = 'PROC-C20D9C1D-0D64-4F44-88FC-72103F36D29D';
const OPERATOR = process.env.DINGTALK_OPERATOR_USERID || '271322273930671357';

async function create(formValues: any[], label: string) {
  const token = await getAccessToken();
  const res = await fetch(`https://oapi.dingtalk.com/topapi/processinstance/create?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      process_code: CODE, originator_user_id: OPERATOR, dept_id: 924338537,
      form_component_values: formValues,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data: any = await res.json();
  console.log(label, '=>', data.errcode, data.errmsg, data.process_instance_id || '');
}

async function main() {
  await create([{ name: '公司名称', value: '格式测试公司B' }], 'B 仅公司名称');
  await create([{ name: '功能', value: '新建客户' }, { name: '公司名称', value: '格式测试公司C' }], 'C +功能');
  await create([
    { name: '功能', value: '新建客户' },
    { name: '客户类型', value: '国内企业客户' },
    { name: '公司名称', value: '格式测试公司D' },
  ], 'D +客户类型');
  await create([
    { name: '功能', value: '新建客户' },
    { name: '客户类型', value: '国内企业客户' },
    { name: '公司名称', value: '格式测试公司E' },
    { name: '负责人', value: '271322273930671357' },
  ], 'E +负责人(userid字符串)');
  await create([
    { name: '功能', value: '新建客户' },
    { name: '客户类型', value: '国内企业客户' },
    { name: '公司名称', value: '格式测试公司F' },
    { name: '负责人', value: '["271322273930671357"]' },
  ], 'F +负责人(JSON数组)');
}
main().catch(e => { console.error(e.message); process.exit(1); });
