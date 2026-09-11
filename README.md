# 喵连 Node

<p align="center"><img src="docs/assets/product-icon.png" width="128" height="128" alt="喵连" /></p>

产品名称已更新为 **喵连**。GitHub 仓库名、协议标识和本地兼容目录保持不变，无需重新配对。

[![CI](https://github.com/GoLink-Mini/GoLink-Node/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/GoLink-Mini/GoLink-Node/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**把自己的开发设备接入 GoLink，在微信中与本机 Agent 协作。**

喵连 Node 是运行在开发设备上的 Node.js 守护进程，连接 喵连 Gateway，并适配 **Codex、Pi、Claude Code**。它管理本机 Agent 通道、会话、命令回执和待确认事件，而不是把项目与 Agent 执行环境迁移到云端。

## 项目组成

| 组件 | 职责 |
| --- | --- |
| [GoLink-Frontend](https://github.com/GoLink-Mini/GoLink-Frontend) | 微信小程序、设备与会话界面 |
| [GoLink-Backend](https://github.com/GoLink-Mini/GoLink-Backend) | Go Gateway、认证、配对、协议与 PostgreSQL 持久化 |
| **[GoLink-Node](https://github.com/GoLink-Mini/GoLink-Node)** | 开发设备守护进程，以及原生 Agent 适配 |

```text
微信小程序  ←→  Go Gateway  ←→  喵连 Node
                                  ├── Codex App Server
                                  ├── Pi RPC / 随附扩展
                                  └── Claude Code Agent SDK
```

对外统一协议保留名称 **`weagent/1`**。Node 直接读取后端仓库的公共 schema，不维护另一份宽松替代协议。

## 开始之前

需要 Node.js **`>=24.1.0`**、npm、可访问的 Gateway，以及准备启用的本机 Agent 环境。Node 使用 `node:sqlite`，不能按前端或后端测试工具的较低 Node.js 版本运行。

Agent 的安装与登录需要在开发设备上完成。发现可执行文件不代表认证成功；协议握手成功也不代表真实模型任务已验收。不要把个人模型凭据、微信 AppSecret 或访问令牌写入仓库。

## 源码运行

### 1. 获取关联仓库

当前协议、示例项目与联调脚本仍使用 `WeAgent-*` 本地目录名。按以下布局克隆，避免自行改写协议路径：

```bash
git clone https://github.com/GoLink-Mini/GoLink-Backend.git WeAgent-Backend
git clone https://github.com/GoLink-Mini/GoLink-Frontend.git WeAgent-Frontend
git clone https://github.com/GoLink-Mini/GoLink-Node.git WeAgent-Node
cd WeAgent-Node
npm ci --ignore-scripts --no-audit --no-fund
```

```text
workspace/
├── WeAgent-Backend/
│   └── contracts/
│       ├── protocol.schema.json
│       └── workspace-operations.json
├── WeAgent-Frontend/
└── WeAgent-Node/
```

后端 schema 是 Node 的代码依赖；前端目录出现在随附示例配置中。改用自己的项目时，应显式修改项目白名单，而不是保留不存在的示例路径。

### 2. 创建本机配置

仅首次将 [`config.example.json`](config.example.json) 复制为 `config.local.json`，不要覆盖已有配置：

```bash
# Linux / macOS：已有文件时拒绝覆盖
if [ -e config.local.json ]; then
  printf '%s\n' 'config.local.json 已存在，请编辑现有配置。'
else
  cp config.example.json config.local.json
fi
```

```powershell
# Windows PowerShell
if (Test-Path -LiteralPath config.local.json) {
  Write-Host 'config.local.json 已存在，请编辑现有配置。'
} else {
  Copy-Item -LiteralPath config.example.json -Destination config.local.json
}
```

核对以下真实配置项：

| 配置 | 用途 |
| --- | --- |
| `gateway` | Gateway 地址；示例为 `https://agent.000.moe` |
| `name` | 设备显示名称 |
| `stateDir` | 身份、命令 journal 与事件持久化目录 |
| `maxSessions` | 活动会话限制；示例为 `8` |
| `projects` | 项目白名单，每项包含 `id`、`name`、`path` 等字段 |
| `plugins` | 按 `type` 和 `enabled` 选择适配器；示例包含 `codex`、`pi`、`claude` |

示例启用了三个适配器。应按实际安装情况配置，项目路径也应指向明确授权的目录。公网 Gateway 使用 HTTPS / WSS；HTTP 只用于允许的本机回环地址。预置地址不是服务可用性的保证。

### 3. 诊断、启动与配对

```bash
npm run doctor
npm start
```

需要指定其他配置文件时，使用 CLI 已提供的参数，例如：

```bash
node src/cli.mjs start --config config.local.json
```

首次启动后，按终端提供的短期配对信息在小程序中核对设备并确认配对。设备是否可用应以 Gateway / 小程序状态为准，而不能只看本机进程是否还活着。

需要单独验证已安装 Agent 的原生通道时可执行：

```bash
npm run probe
```

`probe` 用于原生握手，不发送模型任务；它需要真实本机 Agent 环境，不属于自动化 CI。`doctor` 中的 `ready` 也不能代替登录与握手验证。

## 适配与操作语义

Node 提供 Codex、Pi、Claude Code 适配层；可用操作受本机配置、Agent 版本、会话状态和服务端能力描述共同约束。客户端应依据返回的能力显示入口，不能只根据品牌名称启用某项操作。

消息、审批、问题、模型控制、历史与工作区相关操作应以协议和实际回执为准。不要沿用早期能力表把新增功能写成「永不支持」，也不要把规划文档当成全部能力已交付。

收到命令、原生接收命令、模型任务完成是不同阶段。连接恢复主要用于事件补交和状态对账；进程重启不等于恢复全部原生执行，结果不确定时不能自动重发任务。

## 状态与安全

Node 的状态包含设备身份、去重记录、会话信息与未确认事件。默认源码配置的状态目录是 `.runtime/state`；`config.local.json` 与 `.runtime/` 不应提交。

- **不要删除状态修复离线**：不应通过删除数据库、锁文件或重新配对来掩盖握手、协议或同步错误。
- **先停止再备份或更新**：完整保留实际 `stateDir`，不要只复制正在写入的 SQLite 主文件。
- **项目白名单不是系统沙箱**：被批准的 Agent 工具仍可能拥有宿主用户权限。只运行可信配置并认真核对审批内容。
- **保护私有内容**：不要上传配对日志、数据库、认证文件或未经脱敏的诊断输出。

配对、撤销和原生任务会影响真实设备。示例、单元测试与协议 fixture 不应连接生产设备执行验证。

## 安装器与分发边界

仓库保留 `install.sh`、`install.ps1`、`install-files.json` 和分发脚本。它们不是独立仓库改名后已经重新验证的在线发行服务。

`scripts/build-install-manifest.mjs` 从工作区根目录读取 **`release-files.json`**，再按审查过的文件清单生成安装清单。当前三个独立仓库的根目录均不包含这份发布清单；安装清单中的精确路径与 SHA-256 也不能未经审查就刷新。

在完整发行布局和校验来源恢复、审查前，本文以**源码运行**为入口，不提供未经验证的一键在线安装命令。源码安装器的单元测试使用隔离 fixture，不等于发行包已经构建并通过完整性验证。不要为了安装成功而绕过校验、自动删除状态或伪造发布清单。

## 测试与联调

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

测试覆盖守护进程、状态、适配器、安装器与管理操作。相关原生通道测试使用 fixture，不需要付费模型调用。

已有完整 Windows 开发环境时，可以运行仓库原生联调脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-integration.ps1
```

该脚本需要相邻 `WeAgent-Backend`、Go、原生 PostgreSQL 和正确的 `POSTGRES_BIN`，创建专用数据库并启动实际 Gateway，再运行独立 Node fixture。不要拿它操作生产数据库。

Linux CI 直接编排同一 Gateway、迁移入口及 `scripts/integration.mjs`，不会把 Windows 专用 PowerShell 数据库脚本直接搬到 Linux 运行。

## 持续集成

工作流位于 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。

| 作业 | 内容 |
| --- | --- |
| 单元回归 | Linux、Windows、macOS 的 Node.js 24；Linux 另测最低声明版本 `24.1.0` |
| Gateway 集成 | Linux、PostgreSQL 18、实际 Go Gateway 与独立 Node 原生协议 fixture |

测试作业检出准确命名的相邻仓库，使用锁文件安装依赖，不执行依赖生命周期脚本。Go 工具链从后端 `go.mod` 读取；数据库和 HMAC 密钥仅供当前隔离作业使用。Gateway 子进程由本次运行记录的 PID 清理，不按进程名称批量结束。

后端与前端默认固定到工作流记录的提交，手动运行可分别设置 `backend_ref`、`frontend_ref`；实际版本写入运行摘要。同步升级协议或样例项目时，一并审查这些引用。

Actions 使用完整提交 SHA、只读权限、无持久检出凭据，并设置作业超时与过时运行取消。工作流不运行真实 Agent 登录、不执行 `probe`、不发起模型任务、不发布安装包，也不上传设备状态或凭据。

## 目录与文档

| 路径 | 内容 |
| --- | --- |
| `src/cli.mjs` | CLI 入口 |
| `src/config.mjs` | 本机配置加载与校验 |
| `src/daemon.mjs` | Gateway 连接、命令与事件处理 |
| `src/plugins/` | Agent 适配器 |
| `src/protocol.mjs` | 后端公共 schema 的读取与验证 |
| `src/state.mjs` | 本机持久化状态 |
| `plugins/pi/` | 随附 Pi 扩展 |
| `scripts/` | 安装、分发、诊断与集成脚本 |
| `tests/` | 单元测试及隔离原生协议 fixture |

[适配设计](docs/plugin-plan.md) ·
[原生控制记录](docs/native-controls-plan.md) ·
[验证记录](docs/verification.md) ·
[Gateway Node 契约](https://github.com/GoLink-Mini/GoLink-Backend/blob/main/docs/node-contract.md)

历史记录只说明对应版本与环境的验证结果。提交修改时，请同时说明测试系统、Node.js 版本、后端提交和是否使用真实 Agent。

## 许可证

[MIT License](LICENSE)。
