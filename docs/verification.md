# 验证记录

## 2026-09-08 连接可靠性与诊断增量

- `npm test`：111 项通过。新增 HTTP 流式大小限制及取消读取、已升级但不发送 `node.ready` 的真实 WebSocket 超时、旧连接同步隔离、短连接递增退避、启动参数校验和版本诊断测试。
- `npm run probe`：Codex 0.153.4、Pi 0.85.1、Claude CLI 2.1.263 均通过真实原生握手和模型目录查询/临时会话模型选择；三者 `modelPromptSent=false`。此结果不代表所有模型调用或全部 72 项功能已验收。
- `doctor --config config.example.json`：三种插件版本检查通过；认证和协议字段仍为 `not_checked`，不会借用独立 probe 的结果误报 doctor 检查范围。
- `scripts/test-integration.ps1 -Port 18082`：真实 Go Gateway + PostgreSQL + 独立 Node 子进程通过；覆盖三适配器的协议 fixture、审批、提问、续聊、取消、历史、幂等、断线重连与 spool ACK、Daemon 重启身份保持，以及原生已接受但 journal 未确认时保持 unknown、不自动重放。
- 集成脚本兼容 GoLink/WeAgent 的既有 PostgreSQL 安装目录，SQL 客户端和数据库生命周期使用同一 `POSTGRES_BIN`；测试结束已删除独立测试数据库并停止本轮启动的数据库/网关进程。
- 安装清单已重建并校验，28 个安装源文件；既有安装/升级/回滚 fixture 包含在上述 111 项测试中。未部署或替换用户正在运行的 Node。

以下保留历史验证基线。

原生能力增量的最新证据与边界见 [native-controls-plan.md](native-controls-plan.md)。以下为首轮 28 项基线；本轮增加模型/压缩测试与真实无 prompt 模型目录/设置探测，并修复 Windows probe 同步清理阻塞 SDK 退出的问题（改为有界异步删除）。

验证日期：2026-09-06，Windows，Node.js 24.1.0。

## 已执行

1. `npm test`：**28 项通过，0 失败、0 跳过**。
   - 三种插件的握手、消息 delta/completed、规范化 timeline、审批、提问、续聊、取消。
   - Gateway JSON Schema 校验每个公开 Node source frame。
   - 命令 fsync 后接收、重复操作/内容冲突、旧 epoch、连续 sourceSequence、ACK 越界、spool/journal 配额回滚。
   - SQLite 重开、丢失数据库禁止重建、独占目录、原生接受与任务结束区分。
   - 审批写入但未确认 → unknown；取消不能当成回答回执；迟到的原生消费证据不重放即可对账。
   - Pi `agent_end` 不误当最终完成；Codex 旧 turn 延迟事件不会写入新 turn；多次 shutdown 等待同一关闭流程。
2. `npm run probe`：**3/3 真实握手通过**，`modelPromptSent=false`。

   | 原生实现 | 版本 | 检查 |
   | --- | --- | --- |
   | Codex CLI | 0.153.4 | initialize / initialized / thread/start |
   | Pi | 0.85.0 | RPC get_state + 随附扩展 ready |
   | Claude SDK 自带 CLI | 2.1.263；SDK 0.3.263 | 流式 query 的 initializationResult |

3. `scripts/test-integration.ps1`：**真实 Go Gateway + PostgreSQL 18.3 + 独立 Node 子进程通过**。
   - Ed25519 enrollment、客户端配对、challenge/prove、Node WS 上线。
   - Codex/Pi 独立原生 JSONL 子进程 fixture；Claude 官方 SDK 接口 fixture。
   - 每种插件：审批拒绝、提问回答、后续发送、取消、HTTP 历史、幂等重试。
   - 强制 WS 断开再连接，spool ACK 后清空；9 次原生 prompt 保持 9 次。
   - 终止并重新启动独立 Daemon，身份不变，旧会话关闭，不自动恢复 native task。
   - native 已接受但终态 journal 未提交时强制进程退出；重启后 Gateway reconciling / Node unknown，调用次数仍为 1。
   - 临时数据库在 finally 删除；仅停止本次记录的 Gateway PID。Gateway 限流未关闭。
4. 集成脚本同时执行 `go test -count=1 -timeout 180s ./...`，使用真实 PostgreSQL 的独立测试数据库。新增 `TestUnstartedCreateDoesNotPermanentlyFenceNode` 覆盖未跨过 journal 边界的 `not_seen` / 明确 `rejected`，以及连续两次重连；这类失败的预留会话不能要求不存在的原生快照。

## 尚未冒充已验证的范围

- 没有发送真实模型 prompt，也未验证付费模型生成、第三方 Provider 认证、真实长时间工具执行、生产 WSS 或微信客户端实机端到端。
- 不自动接管已有交互式 Codex/Pi/Claude 终端；进程崩溃后的 OS 子孙进程隔离还需要平台服务管理（如 Windows Job Object / Linux systemd）独立验证。正常退出路径会关闭本项目创建的原生进程。
- 应用层审批不是 OS 沙箱；没有自动安装全局扩展、自动赋予 session 永久权限或关闭原生权限控制。
- 真实 CLI 升级后需重新执行 probe/回放和授权的真实模型验收。官方接口变更时以实际版本为准，不能把 fixture 通过等同于所有未来版本兼容。
- 首版关闭队列/steer；Pi/Claude 未开启 diff，Pi 未开启 plan。没有自动 journal 历史清理及跨进程原生恢复。
- 没有修改小程序演示 Gateway 选择、现有页面设计及 `WeAgent-Web`。
