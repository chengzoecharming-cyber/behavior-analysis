import { useState } from "react";
import { Card, Upload, Button, Table, Alert, Space, Typography, Steps, Tag } from "antd";
import { InboxOutlined } from "@ant-design/icons";
import { previewExcel, uploadExcel, PreviewRow } from "../api";

const { Dragger } = Upload;
const { Title } = Typography;
const { Step } = Steps;

function UploadPage() {
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [isDingTalk, setIsDingTalk] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<{
    success: boolean;
    rawInserted: number;
    normalizedInserted: number;
    totalDistanceKm: number;
    geocodeFailures?: number;
    geocodeFailureSamples?: string[];
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);

  const columns = [
    { title: "员工", dataIndex: "user_name", key: "user_name" },
    { title: "时间", dataIndex: "time", key: "time", width: 160 },
    { title: "客户", dataIndex: "customer_name", key: "customer_name" },
    { title: "地点", dataIndex: "location_name", key: "location_name", ellipsis: true },
    { title: "纬度", dataIndex: "lat", key: "lat", width: 100 },
    { title: "经度", dataIndex: "lng", key: "lng", width: 100 },
  ];

  const handleFileSelect = async (f: File) => {
    setFile(f);
    setResult(null);
    setPreview([]);
    setPreviewLoading(true);
    try {
      const res = await previewExcel(f);
      setPreview(res.preview);
      setIsDingTalk(res.isDingTalk);
    } finally {
      setPreviewLoading(false);
    }
    return false;
  };

  return (
    <div>
      <Title level={4}>Excel 数据导入</Title>

      <Card style={{ marginBottom: 16 }}>
        <Steps size="small" current={file ? (result ? 2 : 1) : 0}>
          <Step title="上传 Excel" description="保留 RAW 原始数据" />
          <Step title="预览解析结果" description="检查字段是否正确" />
          <Step title="标准化入库" description="生成 NORMALIZED visits" />
        </Steps>
      </Card>

      <Card>
        <Dragger
          accept=".xlsx,.xls"
          multiple={false}
          beforeUpload={(f) => handleFileSelect(f as File)}
          showUploadList={false}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">点击或拖拽 Excel 文件到此处</p>
          <p className="ant-upload-hint">
            支持标准格式和钉钉审批导出宽表
          </p>
        </Dragger>

        <Space style={{ marginTop: 16 }}>
          <Button
            type="primary"
            loading={uploading}
            disabled={!file}
            onClick={async () => {
              if (!file) return;
              setUploading(true);
              try {
                const res = await uploadExcel(file);
                setResult(res);
              } finally {
                setUploading(false);
              }
            }}
          >
            导入数据
          </Button>
          {file && <span>已选择：{file.name}</span>}
        </Space>
      </Card>

      {preview.length > 0 && (
        <Card
          title={
            <Space>
              <span>解析结果预览（前 10 行）</span>
              {isDingTalk && <Tag color="blue">钉钉审批宽表</Tag>}
            </Space>
          }
          style={{ marginTop: 16 }}
          loading={previewLoading}
        >
          <Table
            dataSource={preview.map((r, i) => ({ ...r, key: i }))}
            columns={columns}
            pagination={false}
            size="small"
            scroll={{ x: 800 }}
          />
        </Card>
      )}

      {result && (
        <>
          <Alert
            style={{ marginTop: 16 }}
            message="导入成功"
            description={`RAW 层写入 ${result.rawInserted} 条，NORMALIZED 层写入 ${result.normalizedInserted} 条，预估总里程 ${result.totalDistanceKm} km`}
            type="success"
            showIcon
          />
          {result.geocodeFailures ? (
            <Alert
              style={{ marginTop: 8 }}
              message={`${result.geocodeFailures} 个地址未能解析出经纬度`}
              description={
                <>
                  部分示例：{result.geocodeFailureSamples?.join("；")}。
                  这些记录已导入但无法在地图上显示，可稍后补充坐标。
                </>
              }
              type="warning"
              showIcon
            />
          ) : null}
        </>
      )}
    </div>
  );
}

export default UploadPage;
