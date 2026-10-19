# 钉钉文档 Markdown 兼容性测试记录

> 用于沉淀自动生成钉钉文档时发现的客户端兼容性行为，尤其是 Markdown 导入后与文档 JSONML 结构、手机端和电脑端表现不一致的问题。
> 后续遇到类似问题时，在本文追加新的测试条目，记录测试文档、结构化回读结果和真机验收结论，避免只凭单一客户端表现做判断。

## 2026-10-19：日报图片「小图展示、原图预览」

### 背景

自动生成的日报需要让拜访照片在正文中保持 150px 宽的小图，同时允许读者在手机端和电脑端打开原图预览并缩放。

原实现使用：

```markdown
![](https://static.dingtalk.com/media/..._1920_1440.jpg?x-oss-process=image/resize,w_150)
```

该写法把 OSS 缩略图 URL 直接写进图片 `src`。线上文档 JSONML 回读显示：原图文件名尺寸为 `1920×1440`，但 `src` 带 `resize,w_150`，且 `width`、`height` 均为 `null`。因此电脑端预览拿到的也是 150px 缩略图，表现为预览仍是小图、放大后模糊。

### 测试文档

[日报图片预览兼容性测试_2026-10-19](https://alidocs.dingtalk.com/i/nodes/Gl6Pm2Db8DlxG7bohy0qXaX28xLq0Ee4)

### 测试矩阵

| 写法 | 文档结构回读 / 客户端结果 | 结论 |
|---|---|---|
| Markdown + OSS 150px 缩略图 | `src` 为缩略图，`width/height=null`；电脑端预览小且模糊 | 不采用，这是本次问题根因 |
| `<img src="原图" width="150" />` | 原图地址保留，但 `width` 被导入器丢弃，仍为 `null` | 不采用，正文会重新变成大图 |
| **变体 A：`<img src="原图" width="150" height="112" />`** | 原图地址、`width=150`、`height=112` 均保留；用户实测手机端和电脑端预览均正常 | **采用** |
| 变体 B：`<img src="原图" style="width:150px" />` | `style` 没有转化为文档图片宽度，`width=null` | 不采用 |
| 变体 C：`![](原图 =150x)` | 被当作普通文本保留，没有形成有效图片 | 不采用 |
| 变体 D：`![](原图){width=150}` | 图片被转成 `/core/api/resources/img/...` 相对资源地址；用户实测手机端双击提示无权限 | 不采用 |
| 真实日报竖图条目：`<img src="原图" width="150" height="200" />` | 在有序列表和 `<br/>` 混排中，原图地址及 `150×200` 均正确保留 | 通过，可用于正式日报 |

### 正式方案

1. `src` 始终使用**原始图片 URL**，不再把 OSS 缩略图作为正式方案的图片源。
2. 必须**同时声明 `width` 和 `height`**；只声明 `width` 会被钉钉 Markdown 导入器忽略。
3. 根据原图宽高比计算显示高度，避免竖图或横图被拉伸：

```ts
const displayWidth = 150;
const displayHeight = Math.max(
  1,
  Math.round((displayWidth * originalHeight) / originalWidth)
);
```

4. 当前钉钉媒体文件名自带原图尺寸，例如 `_1920_1440.jpg`、`_2520_3360.png`，代码据此计算比例。无法识别尺寸时暂时保留原 OSS 缩略图兜底，避免正文版式失控；该兜底仍可能存在预览模糊问题。
5. 实现位置：`backend/src/services/wikiReportMarkdown.ts` 的 `renderDailyPhoto`。

### 验证记录

- `cd backend && npm run build`：通过。
- 日报 dry run：竖图 `2520×3360` 正确生成 `width="150" height="200"`，且 `src` 不含 OSS resize 参数。
- 测试文档 JSONML 回读：真实日报条目的原图地址、`width=150`、`height=200` 均保留。
- 用户真机验收：变体 A 在手机端、电脑端均正常。

### 后续追加测试时的记录要求

每项兼容性测试至少记录：

- 日期、业务场景和测试文档链接；
- 输入的 Markdown / HTML 写法；
- 文档 JSONML 回读结果，尤其是 `src`、`width`、`height` 和内部资源地址变化；
- 手机端与电脑端分别验收的结果，不用单一端的表现推断另一端；
- 最终采用方案、失败方案和对应代码位置。
