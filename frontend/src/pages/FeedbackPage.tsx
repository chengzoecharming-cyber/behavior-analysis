import { useEffect, useState } from "react";
import {
  Button,
  Card,
  DatePicker,
  TextArea,
  Table,
  Tag,
  Typography,
  Modal,
  Radio,
  Toast,
  Space,
} from "@douyinfe/semi-ui";
import dayjs from "dayjs";
import {
  fetchCurrentUser,
  fetchFeedbackList,
  createFeedback,
  reviewFeedback,
  AuthUser,
  FeedbackItem,
} from "../api";

const { Title, Text } = Typography;

const statusMap: Record<string, { label: string; color: string }> = {
  pending: { label: "待审批", color: "orange" },
  approved: { label: "已通过", color: "green" },
  denied: { label: "已拒绝", color: "red" },
};

// 小红书红
const xhsRed = "#ff2442";

export default function FeedbackPage() {
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [range, setRange] = useState<Date[]>([
    dayjs.tz().subtract(1, "day").toDate(),
    dayjs.tz().toDate(),
  ]);
  const [description, setDescription] = useState("");

  const [reviewItem, setReviewItem] = useState<FeedbackItem | null>(null);
  const [reviewStatus, setReviewStatus] = useState<"approved" | "denied">("approved");
  const [reviewNote, setReviewNote] = useState("");
  const [reviewing, setReviewing] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [user, list] = await Promise.all([
        fetchCurrentUser(),
        fetchFeedbackList(),
      ]);
      setCurrentUser(user);
      setItems(list);
    } catch (err: any) {
      Toast.error(err.response?.data?.error || "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openSubmitModal = () => {
    setRange([dayjs.tz().subtract(1, "day").toDate(), dayjs.tz().toDate()]);
    setDescription("");
    setModalVisible(true);
  };

  const handleSubmit = async () => {
    if (range.length < 2 || !description.trim()) {
      Toast.warning("请选择日期范围并填写申诉说明");
      return;
    }
    setSubmitting(true);
    try {
      await createFeedback({
        start_date: dayjs.tz(range[0]).format("YYYY-MM-DD"),
        end_date: dayjs.tz(range[1]).format("YYYY-MM-DD"),
        description: description.trim(),
      });
      Toast.success("提交成功");
      setModalVisible(false);
      setDescription("");
      load();
    } catch (err: any) {
      Toast.error(err.response?.data?.error || "提交失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleReview = async () => {
    if (!reviewItem) return;
    setReviewing(true);
    try {
      await reviewFeedback(reviewItem.id, {
        status: reviewStatus,
        review_note: reviewNote.trim(),
      });
      Toast.success("审批完成");
      setReviewItem(null);
      setReviewNote("");
      load();
    } catch (err: any) {
      Toast.error(err.response?.data?.error || "审批失败");
    } finally {
      setReviewing(false);
    }
  };

  const canReview =
    currentUser?.role === "admin" || currentUser?.role === "manager";

  const columns = [
    {
      title: "提交人",
      dataIndex: "submitter_name",
      render: (_text: any, record: FeedbackItem) =>
        record.submitter_name || record.user_id,
    },
    {
      title: "申诉日期范围",
      render: (_text: any, record: FeedbackItem) =>
        `${dayjs.tz(record.start_date).format("YYYY-MM-DD")} ~ ${dayjs.tz(
          record.end_date
        ).format("YYYY-MM-DD")}`,
    },
    {
      title: "说明",
      dataIndex: "description",
      ellipsis: true,
    },
    {
      title: "状态",
      dataIndex: "status",
      render: (status: string) => (
        <Tag color={statusMap[status]?.color as any}>{statusMap[status]?.label}</Tag>
      ),
    },
    {
      title: "审批人",
      dataIndex: "reviewer_id",
      render: (reviewer: string | null) => reviewer || "-",
    },
    {
      title: "审批备注",
      dataIndex: "review_note",
      ellipsis: true,
      render: (note: string | null) => note || "-",
    },
    {
      title: "操作",
      render: (_text: any, record: FeedbackItem) => (
        <Space>
          {canReview && record.status === "pending" && (
            <Button
              theme="solid"
              type="primary"
              size="small"
              onClick={() => {
                setReviewItem(record);
                setReviewStatus("approved");
                setReviewNote("");
              }}
            >
              审批
            </Button>
          )}
          {!canReview && record.status === "pending" && (
            <Text type="tertiary">待审批</Text>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div
        style={{
          marginBottom: 24,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div>
          <Title heading={2} style={{ marginBottom: 8, fontWeight: 600, color: "#0f1419" }}>
            反馈与申诉
          </Title>
          <Text type="tertiary">
            对系统判定结果有异议？可提交日期区间申诉；审批通过后该区间内的异常将不再展示。
          </Text>
        </div>
        <Button
          theme="solid"
          style={{ backgroundColor: xhsRed, borderColor: xhsRed }}
          onClick={openSubmitModal}
        >
          申诉
        </Button>
      </div>

      <Card
        title="申诉记录"
        style={{ borderRadius: 12 }}
        bodyStyle={{ padding: 0 }}
      >
        <Table
          rowKey="id"
          columns={columns}
          dataSource={items}
          loading={loading}
          pagination={{ pageSize: 10 }}
          style={{ padding: 16 }}
        />
      </Card>

      {/* 提交申诉弹窗 */}
      <Modal
        title="提交申诉"
        visible={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={handleSubmit}
        confirmLoading={submitting}
        okText="提交"
        cancelText="取消"
      >
        <Space vertical align="start" style={{ width: "100%" }}>
          <div style={{ width: "100%" }}>
            <Text strong>申诉日期范围</Text>
            <div style={{ marginTop: 8 }}>
              <DatePicker
                type="dateRange"
                value={range}
                onChange={(dates) => setRange(dates as Date[])}
                style={{ width: "100%", maxWidth: 360 }}
              />
            </div>
          </div>
          <div style={{ width: "100%" }}>
            <Text strong>申诉说明</Text>
            <div style={{ marginTop: 8 }}>
              <TextArea
                value={description}
                onChange={(value: string) => setDescription(value)}
                placeholder="请说明申诉原因，例如：当天客户会议室无 GPS 信号、拜访地点偏远高德未覆盖等"
                rows={4}
                maxLength={500}
                showClear
              />
            </div>
          </div>
        </Space>
      </Modal>

      {/* 审批弹窗 */}
      <Modal
        title="审批申诉"
        visible={!!reviewItem}
        onCancel={() => setReviewItem(null)}
        onOk={handleReview}
        confirmLoading={reviewing}
        okText="确认"
        cancelText="取消"
      >
        {reviewItem && (
          <Space vertical align="start" style={{ width: "100%" }}>
            <div>
              <Text type="tertiary">申诉人：</Text>
              <Text strong>
                {reviewItem.submitter_name || reviewItem.user_id}
              </Text>
            </div>
            <div>
              <Text type="tertiary">日期范围：</Text>
              <Text>
                {dayjs.tz(reviewItem.start_date).format("YYYY-MM-DD")} ~{" "}
                {dayjs.tz(reviewItem.end_date).format("YYYY-MM-DD")}
              </Text>
            </div>
            <div>
              <Text type="tertiary">说明：</Text>
              <Text>{reviewItem.description}</Text>
            </div>
            <div style={{ width: "100%" }}>
              <Text strong>审批结果</Text>
              <Radio.Group
                type="button"
                value={reviewStatus}
                onChange={(e) => setReviewStatus(e.target.value)}
                style={{ marginTop: 8, display: "block" }}
              >
                <Radio value="approved">通过（豁免该区间异常）</Radio>
                <Radio value="denied">拒绝</Radio>
              </Radio.Group>
            </div>
            <div style={{ width: "100%" }}>
              <Text strong>审批备注</Text>
              <TextArea
                value={reviewNote}
                onChange={(value: string) => setReviewNote(value)}
                placeholder="选填"
                rows={3}
                style={{ marginTop: 8 }}
              />
            </div>
          </Space>
        )}
      </Modal>
    </div>
  );
}
