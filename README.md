# MiniVu

**简体中文** | [English](README_EN.md)

> 一款面向 macOS 的本地截图工作台。截取屏幕、识别文字、整理记录，也可以直接问图。

[下载 MiniVu v1.0.0（Apple Silicon）](https://github.com/xavix-bit/MiniVu/releases/download/v1.0.0/MiniVu_1.0.0_aarch64.dmg)

打开 DMG，将 MiniVu 拖入“应用程序”文件夹。首次启动时，按住 Control 点击 MiniVu，选择“打开”并确认。建议使用 macOS 13 或更高版本。

![MiniVu 截图工作台](docs/images/minivu-workbench.png)

## 从一张截图开始

1. 打开 MiniVu，点击“开始截图”。macOS 可能会在第一次截图时请求屏幕录制权限。
2. 框选需要的屏幕区域。截图会自动保存到工作台，并识别其中的文字。
3. 复制识别结果，或者直接对图片提问。
4. 如果还没有安装问图模型，第一次提问会带你前往模型页面。安装完成后，MiniVu 会回到原截图，并保留刚才输入的问题。

关闭主窗口后，可以保留一个悬浮入口。展开后可快速截图、粘贴图片或打开最近记录；全局快捷键也能从任意应用直接开始截图。

## 工作台

- 搜索最近截图，或固定需要长期保留的内容。
- 放大、缩小、适应窗口、按 1:1 查看，也可以拖动大图浏览细节。
- 在识别文字和图片问答之间切换，未发送的问题不会丢失。
- 安装模型时可查看具体名称、下载大小和内存占用，再选择适合当前 Mac 的版本。
- 截图默认保留 24 小时，也可设为不保留、7 天或永久。固定的截图不会自动删除。

## 隐私

- 截图、识别文字、问题和回答都保存在当前 Mac 上。
- 截图记录存放在应用数据目录，并按所选保留时间自动清理。
- 只有在下载或更新模型、安装可选组件、测试下载源时才会访问网络。
- MiniVu 不会把图片交给云端处理，也没有账号或同步功能。

详细说明见 [本地优先策略](docs/privacy/local-first-policy.md)。

## 开发

```bash
npm install
npm run tauri dev
```

常用检查命令：

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build -- --debug
```

## 主要目录

- 工作台：`src/workbench/`
- 截图库：`src/captures/`
- 悬浮面板：`src/app-shell/QuickPanelShell.tsx`
- 本地截图存储：`src-tauri/src/capture_store.rs`
- macOS 区域截图：`src-tauri/src/screenshot.rs`
- 文字识别与会话：`src/chat/useImageSession.ts`
- 模型客户端：`src/model/modelClient.ts`
- 问图流程：`src-tauri/src/inference/`
- 本地服务生命周期：`src-tauri/src/sidecar/`

## 当前版本

MiniVu v1.0.0 面向 Apple Silicon Mac，包含截图历史、文字识别、单张图片对话、可拖动悬浮入口、固定和搜索等功能。目前不包含账号、同步、云端处理、截图标注或多图对比。
