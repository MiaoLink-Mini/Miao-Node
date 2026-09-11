# 应用层 Agent 插件实施计划

## 范围与边界

在现有小程序 → Go Gateway → 主机 Node 架构中补齐真实 Agent 接入。这里的插件是 **Node Daemon 的应用层适配器**，不是修改 Codex/Claude 的全局配置，也不是把模型执行塞进 Gateway。以已有界面、`WeAgent-Backend/contracts/protocol.schema.json` 为主契约，辅助参考根目录 `backend-design.md`。

Node 独立使用 Node.js 24：适合 Claude 官方 TypeScript SDK、Pi 扩展及两个标准输入输出协议。Gateway 继续使用 Go，不增加模型 SDK 依赖。项目目录由本机配置白名单选择；手机只能使用公开项目 ID，不能传入任意主机路径或命令。

## 原生接入方案

| 插件 | 原生接口 | 会话/取消 | 交互 |
| --- | --- | --- | --- |
| Codex | App Server JSON-RPC / stdio | thread/start、turn/start、turn/interrupt | 原生 command/file approval 和 requestUserInput |
| Pi | `--mode rpc` JSONL | prompt、abort | 显式加载随附扩展，工具确认、提问；不安装全局扩展 |
| Claude Code | 官方 `@anthropic-ai/claude-agent-sdk` | 流式 query、interrupt | canUseTool、AskUserQuestion |

共同输出：用户/助手消息、工具状态、结束状态及可实际映射的 plan/usage/diff。能力按适配器实现声明，不能因为名称相同而虚构支持。终端 ANSI、隐藏推理、认证信息不进入移动端事件。手机 `/help` 等是本项目快捷操作，不透传成 shell 或原生 CLI 指令。

## 实施顺序与验收

1. **契约与基础设施**：严格校验 weagent/1；无 shell 的子进程；有界 LF JSONL；SQLite FULL 同步持久化 journal/spool；独占状态目录。
2. **三种插件**：原生握手、流式消息、取消、审批/提问及错误映射。确认回执必须有原生接收证据，超时/进程退出不伪装成功。
3. **Node 控制面**：Ed25519 配对和 challenge/prove、WS epoch、inventory/heartbeat、operation 去重、连续 sourceSequence、提交 ACK 后清理及重连重放。
4. **恢复策略**：不自动重放不确定原生命令；重启使旧进程会话只读关闭。磁盘满/协议失配时停止接受新任务，而不是丢弃请求或重置身份。
5. **验收**：独立原生协议 fixture 回放、持久化重启/去重/配额测试、真实已安装 CLI 的无模型握手；Gateway 实际 HTTP/WS 集成。明确区分 fixture 与真实付费模型测试。

第一版不实现 PTY 屏幕抓取、不自动接管已有交互式终端、不跨进程恢复 native pending permission、不提供远程插件安装/任意 shell。队列只有在持久化、取消和重启边界都受测时才开放，否则能力为 false。

## 参考与兼容性

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)：以本机 CLI 生成的 JSON Schema 校核参数。
- [Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)、[Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)：以安装包附带文档校核。
- [Claude streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)、[user input](https://code.claude.com/docs/en/agent-sdk/user-input)：SDK 类型与运行时为准。

本机检查版本：Codex 0.153.4、Pi 0.85.0、Claude Code 2.1.220。SDK/package 版本在 lockfile 固定；CLI 升级后先运行 probe 和回放测试，不默默使用危险的协议回退。

## 本轮实施结果

- [x] 独立 `WeAgent-Node` 包、内置插件 registry、白名单配置与 doctor。
- [x] Codex / Pi / Claude 三种原生适配器及 Pi managed extension。
- [x] SQLite journal/spool、身份配对、WS control plane、取消/审批/提问、严格协议验证。
- [x] 重连和独立进程重启去重、native-accepted 崩溃窗口验收。
- [x] Gateway 未启动创建操作的同步边界修复：失败且没有 Node source 的预留会话不再永久阻止设备上线；已有原生 source / 不确定操作仍需对账。
- [x] 28 项自动测试、3 个真实无模型握手、真实 Gateway/PostgreSQL 集成。
- [x] 首版范围与未验证环境写入 [verification.md](verification.md)。

Claude 最终采用 SDK 自带 **2.1.263** CLI（SDK **0.3.263**），不依赖也不升级全局安装的 2.1.220。队列/steer 保持 false；后续另行实现与验收，不将未完成能力宣传为可用。
