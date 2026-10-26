# Today provider plugin for magpie (scaffold v0.1.0)

把 Today App 内置的 **DeepSeek V4.1 Flash / GLM 5.3** 做成 magpie 原生供应商，
**不需要**再跑 today-proxy 那个 Python 服务。协议移植自
[Main8986/today-proxy](https://github.com/Main8986/today-proxy) 的 core.py /
server.py；登录流程照搬社区 autoclaw 插件的短信两步模式。

## 它是怎么工作的

```
magpie agent 请求 (OpenAI 格式)
  -> 插件 fetch: 模型名映射 + 拼平消息
  -> PUT /v1/pricing/model-option (需要时切模型)
  -> POST /v1/messages (拿 threadId)
  -> 轮询 GET /v1/conversations/messages 直到 assistant 消息 completed
  -> 回 OpenAI 格式 (非流式 JSON；流式则把全文切片成 SSE 块)
```

鉴权是两层：短信登录拿 **session token**（长期有效，存在 magpie 账号里）；
每次请求前用它现换 **JWT**（115 秒有效期），过期自动重换，不用你管。

## 安装

### 从 GitHub 安装（推荐）

magpie 插件页 → 添加插件 → 填：

```
github:wabxn514/magpie-today-plugin
```

（简写 `wabxn514/magpie-today-plugin` 也行。仓库必须是公开的，
否则 magpie 克隆不了。）

想让它出现在 magpie 插件市场的未审核区，给仓库打上
`magpie-plugin` 这个 topic 即可。

### 从本机文件夹安装

magpie 插件页 → 添加插件 → 填这个文件夹的路径。

## 登录与使用

1. 供应商列表出现 **Today** 后点登录；
2. 填 11 位手机号 → 收短信 → 填验证码 → 完成；
3. 模型选 `deepseek` 或 `glm-5.3` 即可使用。

## 已知限制（和 today-proxy 一样，不是 bug）

- **上游没有工具调用**：`tool_call: false`，走这条线的 agent 只能纯聊天，
  Codex 的 agentic 任务会受限。
- **上游没有 token 流式**：插件等全文回来再切片成 SSE 块，首字出现前
  会等一整段，和 today-proxy 的表现一致。
- **用量是字符数**：上游不返回 token 用量，usage 按回复字符数计，
  和 today-proxy 保持一致。
- **模型名**：插件提供的模型是 `deepseek` / `glm-5.3` 两个短名，
  不会自动并进 `deepseek-v4.1-flash` / `GLM-5.3-Flash` 的自动组，
  想参与故障转移请手动建组。

## 还没实测的部分（需要你跑一遍）

- 短信登录全流程已跑通，但 v0.1.0 有个 bug：回调只回了 access 没回
  refresh，宿主不落盘，magpie 报“已登录，但无法列出它”；v0.1.1 已修
  （session token 同时填 access 和 refresh），更新插件后需重新登录一次；
- `setModel` 的 PUT 在 Today 上游是否每次都接受；
- `usage` 的窗口字段在 magpie 额度卡上的显示效果；
- 长回复（180 秒超时）与 abort（agent 中途取消）时的行为。

## 文件

- `index.mjs`：插件全部逻辑（登录 / 额度 / 请求翻译）。
- `package.json`：包名与入口；发布到 npm 前可改名。
