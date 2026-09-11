# 远端原生能力：分阶段计划与实现

更新：2026-09-06。本文件是当前能力边界；不是把 `/` 面板包装成任意原生命令执行。

## 阶段 1：模型与压缩（已实现调用链）

`小程序 /model 或 /compact → 确认面板 → POST /v1/sessions/{id}/native → Gateway outbox → Node journal → 原生 API → 回执 / 时间线`。

| 功能 | Codex 0.153.4 | Pi 0.85.0 | Claude SDK 0.3.263 / CLI 2.1.263 |
| --- | --- | --- | --- |
| 主机模型目录 | `model/list`，有界分页 | `get_available_models` | `supportedModels()` |
| 下一轮模型 | Node 暂存；下一次 `turn/start.model` 应用 | `set_model`，等待原生回复 | `setModel()`，等待 SDK 回复 |
| 压缩上下文 | `thread/compact/start`；独立 Gateway turn；等待原生 turn 终态 | `compact`；独立 Gateway turn；原生响应后完成 | 未开放，不注入 `/compact` 文本冒充支持 |

Codex 模型设置回执 `applied:false` 明确表示 **尚未应用原生配置**；Pi / Claude 为 `applied:true`。全部作用域是当前托管会话的后续输入，不改写主机全局配置文件。目录不等于付费调用、账号额度或第三方模型可用性的保证。

### 一致性与边界

- `models` / `compact` 是可选 capability；旧 Node 不上报时视为不支持。前端按会话 capability 显示 `/model`、`/compact`，不依赖品牌推测。
- 新增 `NativeAction` / `NativeControl` / `NativeModel` / `NativeResult`，Go / TS / 微信 JS 从同一 canonical schema 生成。只允许 `models`、`set_model`、`compact`；不接受 method、shell、cwd、配置路径、文件路径或附件。
- Gateway 先检查用户归属、在线同步、托管模式、历史有效、空闲状态、预期 turn、capability revision，再生成 durable command。原生操作与发送/取消/回答共享未决操作互斥。
- Node 在原生调用前落盘执行意图；重复 operation 只返回原 journal，断线不会重新执行。设置模型的结果不明时关闭本项目托管的该会话，保留 unknown，不声称设置失败或自动重试。
- 每次设置重新读取当前目录，只允许目录中的模型；响应仅含模型 ID / 显示名，不透传 provider、认证、endpoint 等对象。最多展示 100 项；Codex 最多取 5 页，并标记截断。
- 压缩预留新的 Gateway turn。Codex 的 `started` 仅表示原生受理，完成由对应原生 turn 通知确认；旧 turn 的迟到完成不能结束新压缩。Pi 等待 `compact` 回复；超时不重发，异常时关闭管理会话并保留不确定回执。
- 压缩不删除 Gateway 事件历史，不恢复或撤销磁盘修改。前端需二次确认，并告知上下文损失及可能的模型费用。

### 验证证据

- 本轮检查：前端 93 项、Node 38 项、后端 JS 契约/数据库/接入 102 项通过；`go test -count=1 -timeout 180s ./...` 使用原生 PostgreSQL 通过，`go vet ./...` 与生成契约漂移检查通过。
- 真实无 prompt 探测：Codex 返回 6 项、Pi 46 项、Claude 5 项；Pi / Claude 模型设置原生确认，Codex 下一轮暂存确认。目录数量只代表本次本机探测，不写死在业务代码中。
- 独立原生协议 fixture 覆盖三种模型列表与设置、Codex 下一次发送带入模型、Pi / Codex 压缩、旧完成事件、busy/capability/未知结果与去重。
- 完整小程序 JS 页面动作 → Go → PostgreSQL 18 → 独立 Node：3 种模型页、2 种压缩、原有审批/问题/取消/重连全部通过；89 次 HTTP、4 次顺序连接，原生 prompt 仍为 9 次 fixture。
- Native WXML 编译器通过 24 个模板。
- 未用真实付费模型执行生成或压缩；未验收真机 WSS、压缩后的模型输出质量。协议 fixture 通过不等于这些范围已通过。

## 部署与回滚

先备份数据库、升级 Gateway（包含 `00002_native_control.sql`），同步前端 schema，再更新 Node。旧 Node 仍可使用基础能力；旧 Gateway 的严格 schema 不能接收新版 Node capabilities。Node 重启仍关闭旧托管会话，不自动接管原生历史。

迁移只扩展 `operations.kind` 与 `audit_entries.action` 的 CHECK 约束；不改初始迁移。Down 不删除数据：已有 native 回执或审计时必须拒绝降级，由迁移事务回滚。fixture 已验证 Up、无新记录的 Down、带 native 记录的 Down 拒绝且保留 journal。不要为降级删除审计或操作记录。

本轮测试使用独立 `18081` 与随机数据库，没有替换现有 `18080` Gateway 或主机 Agent。现有旧进程 / Fake Node 不会凭前端编译自动获得新能力。

## 后续阶段（尚未开放）

1. **项目文件只读浏览**：先固化会话 projectId 与真实根路径；目录分页、文件大小/编码限制、符号链接/Windows junction 越界检测；只返回授权项目的相对路径和短期资源 ID，不接受任意主机绝对路径。
2. **附件输入**：先做有配额、有过期清理的上传/资源协议、Node 内容校验与同会话授权，再按原生模型输入能力开放图片。不能把 base64 塞进当前 4000 字任务或借用 diff 接口读取任意文件。
3. **会话级配置**：在模型之外逐项实现 reasoning / effort 等已验证字段与读回；不开放任意 JSON、主机全局 config.toml / settings.json 或权限提升。
4. **原生历史导入与恢复**：先实现授权项目内只读、分页历史目录，区分原生 ID 与 Gateway ID；再做显式恢复/分支、在用检测和独占管理。不得同时接管仍由交互 CLI 使用的会话；进程重启不能自动重放任务。
5. **Claude 压缩**：核实所用 SDK 的独立控制及完成证据之后再上报 capability，不能仅因交互 CLI 存在 `/compact` 就宣称支持。

## 接口依据

- [Codex App Server](https://developers.openai.com/codex/app-server)：模型目录、turn 模型覆盖与异步压缩。另核对本机 CLI 生成的 `ModelListResponse`、`TurnStartParams`、`ThreadCompactStartParams` schema。
- Pi：本机安装包的 `docs/rpc.md`、`dist/modes/rpc/rpc-mode.js`、`dist/core/agent-session.js`。RPC 调用 `setModel(model)` 不传 persist，模型与 thinking 默认值不会写入全局设置。
- Claude：锁定版本安装包的 `sdk.d.ts` 中 `Query.supportedModels` / `Query.setModel`，并做无 prompt 实际调用。官网 TypeScript 页面在本轮抓取因页面体积超限失败，以安装包类型和本机探测为验证依据。
