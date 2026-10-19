import { getAccessToken } from '../src/services/dingtalk';

const CODE = 'PROC-C20D9C1D-0D64-4F44-88FC-72103F36D29D';
const OPERATOR = process.env.DINGTALK_OPERATOR_USERID || '271322273930671357';
const AGENT = process.env.DINGTALK_AGENT_ID || '';

async function main() {
  const token = await getAccessToken();
  // 老接口 + microapp_agent_id
  const res = await fetch(`https://oapi.dingtalk.com/topapi/processinstance/create?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      process_code: CODE, originator_user_id: OPERATOR, dept_id: 924338537,
      microapp_agent_id: Number(AGENT),
      form_component_values: [
        { name: '功能', value: '新建客户' },
        { name: '客户类型', value: '国内企业客户' },
        { name: '公司名称', value: '格式测试公司I' },
        { name: '负责人', value: '271322273930671357' },
      ],
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data: any = await res.json();
  console.log('老接口+agentId =>', data.errcode, data.errmsg, data.process_instance_id || '');
}
main().catch(e => { console.error(e.message); process.exit(1); });
