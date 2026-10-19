import { getApprovalInstances, getApprovalDetail } from '../src/services/dingtalk';

async function main() {
  const code = 'PROC-C20D9C1D-0D64-4F44-88FC-72103F36D29D';
  const res = await getApprovalInstances(Date.now() - 3*86400000, Date.now(), 0, 20, code);
  console.log('实例数:', res.list.length);
  const d = await getApprovalDetail(res.list[0]);
  console.log('最新实例创建时间:', d.create_time, '| 状态:', d.status);
  const types = new Map<string, string[]>();
  for (const c of d.form_component_values || []) {
    if (!types.has(c.component_type)) types.set(c.component_type, []);
    types.get(c.component_type)!.push(c.name);
  }
  console.log('\n组件类型统计:');
  for (const [t, names] of types) console.log(`${t} (${names.length}): ${names.join('、')}`);
}
main().catch(e => { console.error(e.message); process.exit(1); });
