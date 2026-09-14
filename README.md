# Agent Runtime Dashboard

本地 macOS 开发者工具：让可用的 Agent CLI 自己报告项目与端口，再由仪表盘按规范化文件路径去重，并用本机运行时信息核对哪些项目正在运行。

[English README](README.en.md)

## 功能

- 启动时为每个可调用的 Agent CLI 建立一次只读发现会话。
- 展示 Agent 报告的项目路径、运行状态、已知端口和端口 URL。
- 通过当前进程的 cwd、父进程和 LISTEN socket 核对运行中的项目。
- 将无法安全归属到项目的监听端口单独列出，不静默丢弃。
- 从项目自身的 `package.json` 启动 `dev`、`start` 或 `serve` 脚本。
- 一键打开已知的本地网页；浏览器不能提交任意 shell 命令。

## 工作方式

项目发现的权威来源是 Agent CLI 会话，而不是递归扫描磁盘：

1. Dashboard 检查支持的 CLI 是否存在于当前 `PATH`。
2. 每个可用 CLI 收到只读提示，使用它自己的项目/会话索引和运行时证据返回结构化 JSON。
3. Dashboard 以规范化绝对路径合并重复项目和重复端口。
4. 本机只负责核对当前 LISTEN socket 与进程 cwd，不把任意目录猜成项目。

当前内置调用适配器为 `codex`、`claude` 和 `opencode`。只有实际安装、可执行且当前权限可见的 CLI 才会被调用；不存在通用协议可以凭空询问所有未知 Agent。没有 CLI、没有权限或 Agent 自身索引未暴露的项目，不能被诚实地声称为“已发现”。

## 运行

```bash
npm install
npm run dev
```

打开 <http://127.0.0.1:5173>。

API 服务运行在 `127.0.0.1:4317`。也可以使用生产模式：

```bash
npm run build
npm start
```

## macOS App

无需手动启动终端服务，可以构建一个可双击打开的本机 `.app`：

```bash
npm run app:macos
open "release/Agent Runtime Dashboard.app"
```

App 会自动启动打包在内部的 Node 服务，在 `WKWebView` 中显示仪表盘，并在退出时清理服务。它仍会使用一个仅绑定 `127.0.0.1` 的动态临时端口，但用户不需要手动查找或启动端口。该构建包含当前机器架构的 Node 运行时，是未签名、未公证的本地开发版本。

## 配置

`config/settings.json` 可添加明确的项目配置：

```json
{
  "scanRoots": ["~"],
  "preferredAgent": "auto",
  "projects": []
}
```

`scanRoots` 只用于 Agent 的工作根目录提示和界面显示，不会触发本地递归项目扫描。`projects` 可用于补充 Agent 无法返回、但你明确知道的项目。

## 检查

```bash
npm run build
npm run check
```

## 许可证

当前仓库未声明许可证。
