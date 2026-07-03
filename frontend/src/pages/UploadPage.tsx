import { useState } from "react";
import { Upload, Table, Alert, Space, Typography, Steps, Tag } from "antd";
import { InboxOutlined } from "@ant-design/icons";
import { previewExcel, uploadExcel, PreviewRow, GeocodeFailure } from "../api";

const { Dragger } = Upload;
const { Title } = Typography;
const { Step } = Steps;

export function UploadPanel() {
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [isDingTalk, setIsDingTalk] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<{
    success: boolean;
    rawInserted: number;
    normalizedInserted: number;
    totalDistanceKm: number;
    geocodeFailures?: GeocodeFailure[];
    geocodeFailureSamples?: GeocodeFailure[];
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);

  const columns = [
    { title: "员工", dataIndex: "user_name", key: "user_name" },
    { title: "时间", dataIndex: "time", key: "time", width: 160 },
    { title: "客户", dataIndex: "customer_name", key: "customer_name", ellipsis: true },
    { title: "地点", dataIndex: "location_name", key: "location_name", ellipsis: true },
    { title: "出行方式", dataIndex: "trip_type", key: "trip_type", width: 160, ellipsis: true },
    { title: "填报里程", dataIndex: "reported_distance_km", key: "reported_distance_km", width: 100 },
    { title: "纬度", dataIndex: "lat", key: "lat", width: 100, render: (v: number | null) => v ?? "—" },
    { title: "经度", dataIndex: "lng", key: "lng", width: 100, render: (v: number | null) => v ?? "—" },
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
      {/* Steps + Upload Area */}
      <div style={{ marginBottom: 16 }}>
        <Steps size="small" current={file ? (result ? 2 : 1) : 0} style={{ marginBottom: 24 }}>
          <Step title="上传 Excel" description="保留 RAW 原始数据" />
          <Step title="预览解析结果" description="检查字段是否正确" />
          <Step title="标准化入库" description="生成 NORMALIZED visits" />
        </Steps>

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
          <button
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
            disabled={!file || uploading}
            style={{
              backgroundColor: !file || uploading ? "#F3F4F6" : "#EBECED",
              color: "#0f1419",
              border: "none",
              borderRadius: 8,
              padding: "6px 16px",
              fontSize: 14,
              fontWeight: 500,
              cursor: !file || uploading ? "not-allowed" : "pointer",
              opacity: !file || uploading ? 0.6 : 1,
              transition: "background-color 0.2s",
            }}
            onMouseEnter={(e) => {
              if (file && !uploading) e.currentTarget.style.backgroundColor = "#E6E7E8";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = !file || uploading ? "#F3F4F6" : "#EBECED";
            }}
          >
            {uploading ? "导入中..." : "导入数据"}
          </button>
          {file && <span style={{ color: "#72808a", fontSize: 14 }}>已选择：{file.name}</span>}
        </Space>
      </div>

      {/* Preview Table */}
      {preview.length > 0 && (
        <div style={{ padding: 24, backgroundColor: "#fff", borderRadius: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#0f1419", marginBottom: 16 }}>
            <Space>
              <span>解析结果预览（前 10 行）</span>
              {isDingTalk && <Tag color="blue">钉钉审批宽表</Tag>}
            </Space>
          </div>
          <Table
            dataSource={preview.map((r, i) => ({ ...r, key: i }))}
            columns={columns}
            pagination={false}
            size="small"
            scroll={{ x: 800 }}
            loading={previewLoading}
          />
        </div>
      )}

      {/* Result Alerts */}
      {result && (
        <>
          <Alert
            style={{ marginTop: 16, borderRadius: 12 }}
            message="导入成功"
            description={`RAW 层写入 ${result.rawInserted} 条，NORMALIZED 层写入 ${result.normalizedInserted} 条，预估总里程 ${result.totalDistanceKm} km`}
            type="success"
            showIcon
          />
          {result.geocodeFailures && result.geocodeFailures.length > 0 ? (
            <Alert
              style={{ marginTop: 8, borderRadius: 12 }}
              message={`${result.geocodeFailures.length} 个地址未能解析出经纬度`}
              description={
                <>
                  部分示例：
                  {result.geocodeFailureSamples
                    ?.map((f) => `${f.user} - ${f.location}`)
                    .join("；")}
                  。这些记录已导入但无法在地图上显示，可稍后补充坐标。
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

function UploadPage() {
  return (
    <div>
      <Title level={4} style={{ marginBottom: 24, fontWeight: 600, color: "#0f1419" }}>
        Excel 数据导入
      </Title>
      <UploadPanel />
    </div>
  );
}

export default UploadPage;
