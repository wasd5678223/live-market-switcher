# 无缝切源直播卖场 · Live Market Switcher

Windows 本地直播视频调度台：捕获「直播伴侣」窗口的互动消息区域，用 OCR 识别商品编号，根据观众投票挑选下一段视频，通过 OBS WebSocket 控制 A/B 两个媒体源交替播放，再由 OBS 虚拟摄像头输出画面。

适合学习 Electron、OCR 去重、异步播放协调和 OBS 媒体源控制。「无缝」指双源预热与保留末帧的切换策略；当前没有承诺任意硬件、素材都能达到零黑帧或零延迟。

## 已实现与当前边界

- 本地窗口捕获和 OCR，预览中可拖动、缩放互动消息裁剪区域。
- 商品编号识别、消息去重、计票与排序展示。
- 当前视频结束前锁定下一条，提前准备备用源，结束后交换 A/B 源。
- 缺失素材在加载时禁用，预热失败的素材在本次会话中跳过。
- OBS 连接状态、播放状态、OCR 扫描状态和日志；可手动输入数字验证调度。

两个 OBS 媒体源当前均静音，仅调度画面。没有购物车、支付、平台弹幕接口或云端 OCR，不自动登录、开播。OCR 受字体、缩放、裁剪范围和窗口清晰度影响，不等同于平台完整弹幕数据。

## 工作流程

```mermaid
flowchart LR
    A[直播伴侣窗口] --> B[裁剪与本地 OCR]
    B --> C[去重与编号解析]
    C --> D[计票排序]
    D --> E[候选预热与截止锁定]
    E --> F[OBS A/B 媒体源]
    F --> G[OBS 虚拟摄像头]
```

OCR 在 Electron 渲染进程运行；主进程负责调度、配置与 OBS 控制。通过 preload 的 IPC 接口通信，启用 `contextIsolation`，关闭 `nodeIntegration`。

## 运行前准备

1. Windows x64、Node.js 22.12 或更高版本、npm。本次检查使用 Node.js 25.8.0。
2. 从 [OBS 官网](https://obsproject.com/)取得支持 WebSocket 5 的 Windows 便携包，解压到根目录的 `obs-studio/`。代码固定使用项目内的便携版本，不自动查找系统安装版。
3. 命令行可调用 FFmpeg，用于素材标准化。
4. 至少两段有权使用的视频，以及窗口标题包含「直播伴侣」的程序；捕获期间保持窗口打开且不要最小化。

先手动启动便携 OBS，在「工具 → WebSocket 服务器设置」中启用并保存端口和密码。程序使用这两个路径：

```text
obs-studio/bin/64bit/obs64.exe
obs-studio/config/obs-studio/plugin_config/obs-websocket/config.json
```

OBS 程序、WebSocket 密码和用户视频均不在仓库中。如果虚拟摄像头不可用，需先按 OBS 的安装方式注册虚拟摄像头。

## 快速开始

```powershell
git clone https://github.com/wasd5678223/live-market-switcher.git
cd live-market-switcher
npm ci
.\scripts\normalize-media.ps1 -InputFiles 'D:\video\1.mp4','D:\video\2.mp4','D:\video\3.mp4'
npm run build
npm start
```

标准化脚本按输入顺序生成 `media/1.mp4` 等文件，目标为 1280×720、30 FPS、H.264/yuv420p；素材包含音轨时按 AAC/48 kHz 处理，以黑边填充不同画面比例。它会覆盖同编号的输出，运行前确认素材路径与输出目录。

修改 `config/catalog.json`，让编号与实际文件对应：

```json
[
  { "code": "1", "videoPath": "media/1.mp4", "enabled": true },
  { "code": "2", "videoPath": "media/2.mp4", "enabled": true },
  { "code": "3", "videoPath": "media/3.mp4", "enabled": true }
]
```

应用会连接或启动便携 OBS，创建「自动卖场」场景与两个播放器，尝试启动虚拟摄像头。在直播软件中选择 OBS 虚拟摄像头作为画面输入。先手动发送 `1`、`2`、`3` 验证调度，再点击「开始捕获」，将裁剪框放到互动消息区域。

## 配置与调度规则

| 配置 | 含义 |
| --- | --- |
| `config/catalog.json` | 商品编号、相对项目根目录的视频路径、启用状态 |
| `crop.x/y/width/height` | `config/app.json` 中的归一化裁剪矩形，界面调整后写回 |
| `ocrIntervalMs` | OCR 扫描间隔，渲染端实际下限 750 ms |
| `lockAheadMs` | 视频剩余时间进入该阈值时锁定下一条，默认 2000 ms |

- 同一条消息内，同一商品号只计一次；OCR 另经过行级去重。
- 候选排除当前商品，按票数、最近出现时间、目录顺序排序。
- 没有其他商品的有效票时按目录轮换。
- 锁定时消费获选商品的已有票；其他票保留，新消息参与后续轮次。
- 排名与去重数据只在内存中保存，重启清空。
- 备用源先启动、定位开头并停止以保留首帧；正式切换时重新启动，确认播放后置顶。当前源保留末帧，避免先清空再换素材。

## 代码入口

| 文件 | 职责 |
| --- | --- |
| `src/main/main.ts` | Electron 窗口、捕获与 IPC |
| `src/renderer/app.ts` | 界面、裁剪框、OCR 和扫描循环 |
| `src/shared/digit-parser.ts` | 商品编号解析 |
| `src/main/domain/ocr-row-deduper.ts` | OCR 行级去重 |
| `src/main/domain/danmaku-scheduler.ts` | 计票、排序、轮换和消费 |
| `src/main/domain/playback-coordinator.ts` | 预热、锁定和播放结束协调 |
| `src/main/obs/obs-controller.ts` | OBS 连接、双源及虚拟摄像头 |
| `scripts/copy-ocr-assets.mjs` | 从依赖复制本地 OCR worker/WASM |

## 开发与验证

```powershell
npm run dev
npm test
npm run typecheck
npm run build
```

2026-10-14 发布检查：3 个测试文件、10 个测试通过，类型检查和构建通过。测试覆盖调度、播放协调、OCR 去重；本次没有重新验收真实直播、OBS 虚拟摄像头或长时间运行。

## 常见问题

| 现象 | 检查方向 |
| --- | --- |
| 至少需要两个有效视频 | 检查 `enabled`、文件路径和素材是否存在 |
| OBS 配置文件不存在 | 先启动项目内的便携 OBS，在 WebSocket 设置中保存一次 |
| OBS 无法连接 | 检查端口/密码，启用后重启；避免已有系统 OBS 进程占用 |
| 找不到直播伴侣 | 保持窗口打开，标题包含「直播伴侣」 |
| OCR 扫描但不计票 | 调整裁剪框，排除昵称、时间和观看人数等数字 |
| 切换卡顿 | 先标准化素材，再检查解码负载；当前策略不保证所有环境无黑帧 |

## 许可证

项目自有代码采用 [MIT License](LICENSE)。OCR 模型及其他依赖保留各自许可证，见 [第三方说明](THIRD_PARTY_NOTICES.md)。不分发 OBS、FFmpeg、平台客户端或用户素材。
