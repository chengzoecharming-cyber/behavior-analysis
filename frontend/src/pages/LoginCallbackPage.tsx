import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Banner, Button, Card, Spin, Typography } from "@douyinfe/semi-ui";
import { dingtalkCallback } from "../api";

const { Text } = Typography;

/** 钉钉扫码登录回调页：authCode + state 换 session token 后跳首页 */
export default function LoginCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState("");

  useEffect(() => {
    const authCode = searchParams.get("authCode");
    const state = searchParams.get("state");

    if (!authCode || !state) {
      setError("缺少登录参数，请重新扫码");
      return;
    }

    (async () => {
      try {
        const { token } = await dingtalkCallback(authCode, state);
        localStorage.setItem("auth_token", token);
        // 清掉旧的伪登录标识
        localStorage.removeItem("user_id");
        navigate("/", { replace: true });
        window.location.reload();
      } catch (err: any) {
        setError(err.response?.data?.error || "钉钉登录失败，请重试");
      }
    })();
    // 只在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="login-dark flex h-screen w-full items-center justify-center bg-[#F6F8FC]">
      <Card
        shadows="hover"
        style={{ width: 400, maxWidth: "calc(100% - 2rem)", padding: 8 }}
      >
        <div className="flex flex-col items-center">
          {error ? (
            <>
              <Banner
                fullMode={false}
                type="danger"
                closeIcon={null}
                description={error}
              />
              <Button
                theme="solid"
                type="primary"
                style={{ marginTop: 24 }}
                onClick={() => navigate("/login", { replace: true })}
              >
                返回登录
              </Button>
            </>
          ) : (
            <>
              <Spin size="large" />
              <Text type="tertiary" style={{ marginTop: 16 }}>
                正在完成钉钉登录...
              </Text>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
