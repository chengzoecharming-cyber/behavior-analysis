import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Banner,
  Button,
  Card,
  Modal,
  Select,
  Table,
  Tag,
  Toast,
  Typography,
} from "@douyinfe/semi-ui";
import { IconEyeOpened, IconRefresh } from "@douyinfe/semi-icons";
import {
  AuthUser,
  OrgTreeNode,
  UserReconcileResult,
  fetchCurrentUser,
  fetchDingTalkOrgTree,
  fetchManagedUsers,
  syncUsers,
  updateUserRole,
} from "../api";

const { Title, Text } = Typography;

const roleColor: Record<string, "amber" | "blue" | "grey"> = {
  admin: "amber",
  manager: "blue",
  staff: "grey",
};

/** business_date 是 date 类型，pg 返回 ISO 字符串，截取日期部分展示 */
function formatDate(value?: string | null): string {
  if (!value) return "-";
  return value.slice(0, 10);
}

/** 未分配部门的分组名（department 为空时） */
const UNGROUPED = "未分配";
/** 无子部门时的分组名（与控制台级联选择器的「直属」节点一致） */
const DIRECT_GROUP = "直属";

/**
 * users.department 是「部门-子部门」短横线格式（可能只有部门没有子部门，
 * 也可能是逗号分隔的多部门，与后端口径一致取第一个）。
 */
function parseDepartment(dept: string | null): { dept: string; subDept: string } {
  const primary = (dept || "").split(",")[0].trim();
  if (!primary) return { dept: UNGROUPED, subDept: DIRECT_GROUP };
  const idx = primary.indexOf("-");
  if (idx === -1) return { dept: primary, subDept: DIRECT_GROUP };
  return { dept: primary.slice(0, idx), subDept: primary.slice(idx + 1) || DIRECT_GROUP };
}

/**
 * 角色展示文案：admin→管理员、manager→Leader（按 department 深度提示管辖范围）、staff→员工。
 * 范围口径：department='销售部' → 部门 LD（看全部门含子部门）；
 * department='销售部-华南一部' → 区级 LD（只看该子部门）。
 */
function roleLabel(user: AuthUser): string {
  if (user.role === "admin") return "管理员";
  if (user.role === "staff") return "员工";
  const { dept, subDept } = parseDepartment(user.department);
  if (subDept !== DIRECT_GROUP) return `Leader（${subDept}）`;
  if (dept !== UNGROUPED) return "Leader（部门）";
  return "Leader";
}

interface SubGroup {
  subDept: string;
  members: AuthUser[];
}

interface DeptGroup {
  dept: string;
  subs: SubGroup[];
  count: number;
}

export default function UsersPage() {
  const navigate = useNavigate();
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [orgTree, setOrgTree] = useState<OrgTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [preview, setPreview] = useState<UserReconcileResult | null>(null);

  const isAdmin = currentUser?.role === "admin";

  const load = async () => {
    setLoading(true);
    try {
      const list = await fetchManagedUsers();
      setUsers(list);
    } catch (err: any) {
      Toast.error(err.response?.data?.error || err.message || "加载用户列表失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const me = await fetchCurrentUser();
        setCurrentUser(me);
      } catch {
        // 忽略，列表接口仍会按权限返回
      }
      await load();
    })();
    // 钉钉组织树只用于分组排序（与控制台级联选择器层级一致），失败时退化为按拼音排序
    fetchDingTalkOrgTree()
      .then(setOrgTree)
      .catch(() => setOrgTree([]));
  }, []);

  const handleRoleChange = async (user: AuthUser, role: AuthUser["role"]) => {
    try {
      await updateUserRole(user.id, role);
      Toast.success(`已将 ${user.user_name} 的角色改为「${roleLabel({ ...user, role })}」`);
      setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, role } : u)));
    } catch (err: any) {
      Toast.error(err.response?.data?.error || err.message || "更新角色失败");
    }
  };

  // 查看成员轨迹：跳控制台并预选该成员（ConsolePage 支持 ?user=<user_id>）
  const handleViewConsole = (user: AuthUser) => {
    navigate(`/console?user=${encodeURIComponent(user.user_id)}`);
  };

  // 从钉钉同步：先 dryRun 预览，确认后真正执行
  const handleSyncClick = async () => {
    setPreviewing(true);
    try {
      const result = await syncUsers(true);
      setPreview(result);
    } catch (err: any) {
      Toast.error(err.response?.data?.error || err.message || "同步预览失败");
    } finally {
      setPreviewing(false);
    }
  };

  const handleSyncConfirm = async () => {
    setSyncing(true);
    try {
      const result = await syncUsers(false);
      setPreview(null);
      Toast.success(
        `同步完成：新增 ${result.added.length} 人，更新 ${result.updated} 人，标离职 ${result.resigned.length} 人`
      );
      await load();
    } catch (err: any) {
      Toast.error(err.response?.data?.error || err.message || "同步执行失败");
    } finally {
      setSyncing(false);
    }
  };

  const resignedStyle = (record: AuthUser): React.CSSProperties =>
    record.is_resigned ? { color: "var(--semi-color-text-2)" } : {};

  const columns = [
    {
      title: "姓名",
      dataIndex: "user_name",
      render: (name: string, record: AuthUser) => (
        <span style={resignedStyle(record)}>{name}</span>
      ),
    },
    {
      title: "角色",
      dataIndex: "role",
      render: (role: AuthUser["role"], record: AuthUser) =>
        isAdmin ? (
          <Select
            size="small"
            value={role}
            style={{ width: 110 }}
            onChange={(value) => handleRoleChange(record, value as AuthUser["role"])}
            optionList={[
              { value: "admin", label: "管理员" },
              { value: "manager", label: "Leader" },
              { value: "staff", label: "员工" },
            ]}
          />
        ) : (
          <Tag color={roleColor[role]}>{roleLabel(record)}</Tag>
        ),
    },
    {
      title: "在职状态",
      dataIndex: "is_resigned",
      render: (resigned: boolean) =>
        resigned ? <Tag>已离职</Tag> : <Tag color="green">在职</Tag>,
    },
    {
      title: "最近签到日期",
      dataIndex: "last_visit_date",
      render: (value: string | null) => formatDate(value),
    },
    {
      title: "操作",
      dataIndex: "actions",
      render: (_: unknown, record: AuthUser) => (
        // 查看该成员的控制台轨迹
        <Button
          size="small"
          theme="borderless"
          type="tertiary"
          icon={<IconEyeOpened />}
          onClick={() => handleViewConsole(record)}
        />
      ),
    },
  ];

  // 钉钉组织树的部门/子部门顺序（与控制台级联选择器一致），树外名称退化为拼音排序
  const { deptOrder, subOrder } = useMemo(() => {
    const deptOrder = new Map<string, number>();
    const subOrder = new Map<string, number>();
    orgTree.forEach((dept, i) => {
      deptOrder.set(dept.name, i);
      (dept.children || []).forEach((sub, j) => {
        subOrder.set(`${dept.name}-${sub.name}`, j);
      });
    });
    return { deptOrder, subOrder };
  }, [orgTree]);

  // 部门展示顺序（用户指定）：销售部 → 供应链管理部 → 产品部 →（其他部门）→ 未分配 → 总部（显示为 TEST）
  const DEPT_ORDER = ["销售部", "供应链管理部", "产品部"];
  const deptRank = (dept: string): number => {
    const i = DEPT_ORDER.indexOf(dept);
    if (i !== -1) return i;
    if (dept === UNGROUPED) return 98;
    if (dept === "总部") return 99;
    return 50; // 其他部门排在三大部门之后、未分配之前
  };

  // 两级分组「部门 → 子部门」，与控制台级联选择器层级一致：
  // 子部门顺序按钉钉组织树，无子部门的归入「直属」排最后
  const groupedUsers = useMemo<DeptGroup[]>(() => {
    const deptMap = new Map<string, Map<string, AuthUser[]>>();
    for (const u of users) {
      const { dept, subDept } = parseDepartment(u.department);
      if (!deptMap.has(dept)) deptMap.set(dept, new Map());
      const subMap = deptMap.get(dept)!;
      if (!subMap.has(subDept)) subMap.set(subDept, []);
      subMap.get(subDept)!.push(u);
    }

    const orderedDepts = Array.from(deptMap.keys()).sort((a, b) => {
      const ra = deptRank(a);
      const rb = deptRank(b);
      if (ra !== rb) return ra - rb;
      // 同档位内按钉钉组织树顺序，树外名称退化为拼音排序
      const ia = deptOrder.get(a);
      const ib = deptOrder.get(b);
      if (ia !== undefined && ib !== undefined) return ia - ib;
      if (ia !== undefined) return -1;
      if (ib !== undefined) return 1;
      return a.localeCompare(b, "zh-CN");
    });

    return orderedDepts.map((dept) => {
      const subMap = deptMap.get(dept)!;
      const orderedSubs = Array.from(subMap.keys()).sort((a, b) => {
        if (a === DIRECT_GROUP) return 1;
        if (b === DIRECT_GROUP) return -1;
        const ia = subOrder.get(`${dept}-${a}`);
        const ib = subOrder.get(`${dept}-${b}`);
        if (ia !== undefined && ib !== undefined) return ia - ib;
        if (ia !== undefined) return -1;
        if (ib !== undefined) return 1;
        return a.localeCompare(b, "zh-CN");
      });
      const subs = orderedSubs.map((subDept) => ({
        subDept,
        members: subMap.get(subDept)!,
      }));
      return {
        dept,
        subs,
        count: subs.reduce((n, g) => n + g.members.length, 0),
      };
    });
  }, [users, deptOrder, subOrder]);

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-4 flex items-center justify-between">
        <Title heading={4} style={{ margin: 0 }}>
          用户管理
        </Title>
        {isAdmin && (
          <Button
            theme="solid"
            icon={<IconRefresh />}
            loading={previewing}
            onClick={handleSyncClick}
            style={{ backgroundColor: "#EBECED", color: "#0f1419" }}
          >
            从钉钉同步
          </Button>
        )}
      </div>

      <Banner
        fullMode={false}
        type="info"
        closeIcon={null}
        style={{ marginBottom: 16 }}
        description="名单来自外勤签到数据，每日凌晨 3 点自动与钉钉通讯录对账；新纳入的用户默认为「员工」角色，角色只能由管理员手工调整。"
      />

      <div className="flex flex-col gap-4">
        {groupedUsers.map((group) => (
          <Card
            key={group.dept}
            title={
              <span className="flex items-center gap-2">
                <Text strong style={{ fontSize: 16 }}>
                  {/* 「总部」分组里是系统内置账号，对外显示为 TEST */}
                  {group.dept === "总部" ? "TEST" : group.dept}
                </Text>
                <Text type="tertiary" size="small">
                  {group.count} 人
                </Text>
              </span>
            }
          >
            {group.subs.map((sub, subIdx) => (
              <div key={sub.subDept} style={{ marginTop: subIdx === 0 ? 0 : 36 }}>
                {/* 只有「直属」一个分组时不重复展示子标题 */}
                {(group.subs.length > 1 || sub.subDept !== DIRECT_GROUP) && (
                  <div className="mb-1 flex items-center gap-2 pl-2">
                    <Text style={{ fontSize: 15, fontWeight: 600 }}>
                      {sub.subDept}
                    </Text>
                    <Text type="tertiary" size="small">
                      {sub.members.length} 人
                    </Text>
                  </div>
                )}
                <Table
                  rowKey="id"
                  size="small"
                  loading={loading}
                  dataSource={sub.members}
                  columns={columns}
                  pagination={false}
                />
              </div>
            ))}
          </Card>
        ))}
      </div>

      <Modal
        title="同步预览"
        visible={preview !== null}
        onOk={handleSyncConfirm}
        onCancel={() => setPreview(null)}
        okText="确认执行"
        cancelText="取消"
        confirmLoading={syncing}
      >
        {preview && (
          <div className="flex flex-col gap-3">
            {!preview.contactsSynced && (
              <Banner
                fullMode={false}
                type="warning"
                closeIcon={null}
                description="本次未能同步钉钉通讯录，不会标记离职人员"
              />
            )}
            <div>
              <Text strong>新增 {preview.added.length} 人</Text>
              {preview.added.length > 0 && (
                <div className="mt-1 max-h-32 overflow-y-auto text-sm text-stone-600">
                  {preview.added.join("、")}
                </div>
              )}
            </div>
            <div>
              <Text strong>更新姓名/部门 {preview.updated} 人</Text>
            </div>
            <div>
              <Text strong>标记离职 {preview.resigned.length} 人</Text>
              {preview.resigned.length > 0 && (
                <div className="mt-1 max-h-32 overflow-y-auto text-sm text-stone-600">
                  {preview.resigned.join("、")}
                </div>
              )}
            </div>
            {preview.skippedRecentActive.length > 0 && (
              <div>
                <Text strong>跳过标记（近 30 天有签到，需人工复核）{preview.skippedRecentActive.length} 人</Text>
                <div className="mt-1 max-h-32 overflow-y-auto text-sm text-stone-600">
                  {preview.skippedRecentActive.join("、")}
                </div>
              </div>
            )}
            {preview.restored.length > 0 && (
              <div>
                <Text strong>恢复在职 {preview.restored.length} 人</Text>
                <div className="mt-1 text-sm text-stone-600">
                  {preview.restored.join("、")}
                </div>
              </div>
            )}
            {preview.invalidated.length > 0 && (
              <div>
                <Text strong>移出名单（部门白名单外）{preview.invalidated.length} 人</Text>
                <div className="mt-1 max-h-32 overflow-y-auto text-sm text-stone-600">
                  {preview.invalidated.join("、")}
                </div>
              </div>
            )}
            <Text type="tertiary" size="small">
              确认后将按以上结果写入用户表；已有用户的角色不会被修改。
            </Text>
          </div>
        )}
      </Modal>
    </div>
  );
}
