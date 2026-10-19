import { getAccessToken } from '../src/services/dingtalk';

const CODE = 'PROC-C20D9C1D-0D64-4F44-88FC-72103F36D29D';
const OPERATOR = process.env.DINGTALK_OPERATOR_USERID || '271322273930671357';

async function main() {
  const token = await getAccessToken();
  const r = await fetch(`https://oapi.dingtalk.com/topapi/processinstance/create?access_token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      process_code: CODE, originator_user_id: OPERATOR, dept_id: 924338537,
      form_component_values: [
        { name: '功能', value: '新建客户' },
        { name: '客户类型', value: '国内企业客户' },
        { name: '公司名称', value: '格式测试公司K' },
        { name: '法定代表人', value: '测试法人' },
        { name: '公司地址', value: '深圳市南山区测试路1号' },
        { name: '客户刀具柜安装地址', value: '深圳市南山区测试路1号' },
        { name: '客户所属区域', value: '广东' },
        { name: '标签 - 产品类型意向', value: '刀具柜' },
        { name: '标签 - 客户类型', value: '国内终端客户' },
        { name: '标签 - 意向', value: '中' },
        { name: '客户跟进状态', value: '初步接触/拜访' },
        { name: '客户获取渠道', value: '飞鱼CRM' },
        { name: '负责人', value: '271322273930671357' },
        { name: '客户联系人姓名', value: '测试联系人' },
        { name: '客户手机号', value: '13800138000' },
        { name: '是否关键决策人', value: '否' },
      ],
    }),
    signal: AbortSignal.timeout(15000),
  });
  const d: any = await r.json();
  console.log('全必填 =>', d.errcode, d.errmsg, d.process_instance_id || '');
}
main().catch(e => { console.error(e.message); process.exit(1); });
