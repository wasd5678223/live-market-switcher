# 卖场调度台

本地 Electron 调度程序：从抖音直播伴侣窗口识别数字弹幕，按频次选择下一段视频，并通过 OBS WebSocket 控制双媒体源无缝切换。

## 运行

```powershell
npm install
npm run build
npm start
```

程序会连接项目内的便携 OBS，创建 `自动卖场` 场景并启动虚拟摄像头。进入调度台后点击“开始捕获”，保持直播伴侣窗口不要最小化。

## 配置

- `config/catalog.json`：商品编号与标准化视频的映射。
- `config/app.json`：互动消息裁剪区域、OCR 间隔和下一条锁定时间。
- `media/`：本机生成的视频，不纳入 Git。

替换素材时运行：

```powershell
.\scripts\normalize-media.ps1 -InputFiles 'D:\video\1.mp4','D:\video\2.mp4','D:\video\3.mp4'
```

第一版将 OBS 媒体源静音，只验证画面调度与切换。弹幕频次保存在内存中，重启后清空。

## 验证

```powershell
npm test
npm run typecheck
npm run build
```
