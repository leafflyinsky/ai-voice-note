# AI 语音对话笔记工具

一个桌面应用：像打电话一样和 AI 实时语音讨论想法，讨论完一键整理成 Markdown 笔记，保存到本地。

- 实时语音对话（说话 → AI 语音回复，可随时打断）
- 支持文字输入，与语音混用同一上下文
- 一键整理对话为结构化 Markdown 笔记（标题 / 核心要点 / 待办 / 总结）
- 用户自带阿里云百炼 API Key，开发者不承担模型成本

## 直接使用（免安装）

从 **Release** 下载 `AI语音对话笔记-x.y.z-win.zip`，解压后双击 `AI语音对话笔记.exe` 即可运行（Windows x64，无需安装 Node 或任何依赖）。

> 需自行准备阿里云百炼 API Key（[bailian.console.aliyun.com](https://bailian.console.aliyun.com/)，`sk-` 开头）。

## 从源码开发

1. 安装 Node.js LTS（https://nodejs.org/）
2. `npm install`
3. `npm run dev` 启动开发模式
4. `npm run typecheck` 类型检查
5. `npm run build` 构建到 `out/`
6. `npm run pack` 打包绿色免安装版到 `release/`

## 技术要点

- Electron + React + TypeScript + electron-vite
- 实时语音：`ws` 连接 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus`
  - WebSocket 连接放主进程（浏览器 WebSocket 不能自定义请求头），通过 IPC + `window.api` 桥接
  - 音频输入 16kHz 单声道 PCM，输出 24kHz 单声道 PCM（AudioWorklet 采集/播放）
  - `server_vad` 轮次检测，用户开口即打断 AI 播放
  - 文字输入：`conversation.item.create` + `response.create`，`modalities` 需含 `audio`
- 笔记整理：主进程 `fetch` 调 `qwen-max` 生成 Markdown，`dialog.showSaveDialog` 保存

## 常见问题

- 回声大 / 误打断：先换耳机测试（官方也建议用耳机，避免回声触发打断）
- 连不上：确认 API Key 有实时语音对话权限；确认请求头带了 `OpenAI-Beta: realtime=v1`
- 打字不回复：确认 `response.create` 的 `modalities` 包含 `audio`（纯 `['text']` 会被服务端静默忽略）
