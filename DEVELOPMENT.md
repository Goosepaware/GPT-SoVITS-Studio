# GPT-SoVITS-Studio (v5turbo)

给 GPT-SoVITS 整合包做的便携桌面工作台。只保留两个核心工作流：

- **语音合成**：5–10 秒参考声音 + 参考文本 → 任意台词，支持 v5turbo。
- **语音转文字**：只保留 SenseVoice（中 / 英 / 日 / 韩 / 粤），更轻、更快。

同时补上原 WebUI 缺少的东西：模型加载阶段、分段进度、当前加载了哪些模型、每个引擎的显存占用、一键卸载、切换引擎自动释放显存、退出/崩溃自动结束 worker。

近期改进：

- 下拉菜单改为应用内渲染，四套主题下文字都清晰。
- 新增「黑白 Mono」主题：去色、直角矩形、1px 线条，无阴影 / 渐变 / 毛玻璃；默认黑白 + 跟随系统，彩色与黑白都支持深色、浅色和跟随系统。
- 页面常驻不卸载，切换页面后文本、参数、音色选择都不会丢。
- 最近生成改为单行列表：左侧文本，右侧直接显示波形和播放按钮，不再有底部播放栏。
- 最近生成支持批量选择、批量删除和批量导出。
- 输出文件按合成文本命名，只取前 15 个字符并加省略号；同一文本重复生成自动加“（1）”“（2）”。
- 采样步数改为 4 / 8 / 16 / 32 四档滑块。
- 随机种子为 -1 时也会记录实际种子，结果卡和最近生成都支持“复用种子”；种子输入旁有随机按钮，一键设回 -1。
- 语音转文字结果支持“发送到生成参考”，直接带回音频和文本。
- 音色保存为单个 `.v5t` 文件（参考音频 + 文本 + 参考语言 + 时长），所有音色放在同一目录，可直接分享、导入，并可一键打开音色库目录。
- 移除 Fun-ASR，只保留 SenseVoice，模型卡也不再显示。
- 高级参数带 v5turbo 官方默认值，并支持一键恢复默认。
- 生成结果可“放弃”或“放弃并重试”。

## 技术栈

- Electron + React + TypeScript + Vite + framer-motion
- 两个独立 Python worker（`tts_worker.py` / `asr_worker.py`），通过 stdin/stdout JSONL 通信
- 直接调用整合包里的 `GPT_SoVITS.TTS_infer_pack.TTS`，不经过 Gradio、不开放本地端口
- 复用整合包 `runtime\python.exe`，不额外安装 Python 环境

## 目录

```text
GPT-SoVITS-Studio/     （仓库根目录）
  src/                 Electron main / preload / React renderer
  python/              tts_worker.py, asr_worker.py, engine_common.py, timing.py
  scripts/             开发、打包、精简引擎脚本
  resources/           图标
  data/                开发时配置、输出、日志（运行时生成）
  release/             便携版输出目录
  out/                 electron-vite 构建产物
```

## 开发

```powershell
# 在仓库根目录执行
npm install
npm run dev
```

开发时默认自动寻找同级的 `GPT-SoVITS-v5-*` 整合包；也可以在「设置」里手动指定。

常用命令：

```powershell
npm run typecheck
npm run build
node scripts/probe-worker.mjs tts     # 直接测试 TTS worker
node scripts/probe-worker.mjs asr     # 直接测试 ASR worker
```

> 仓库不包含引擎、模型、个人数据以及本地端到端测试脚本；这些内容由本地环境生成。

## 主题

「设置 → 外观」提供两套风格，每套都支持深色 / 浅色 / 跟随系统：

- **黑白 Mono**：默认主题。去色、直角矩形、1px 线条，无阴影 / 渐变 / 毛玻璃；跟随系统时深色为黑底白线，浅色为白底黑线。
- **彩色**：原有的紫青渐变风格，深色为默认。

初始主题为黑白 + 跟随系统；旧配置升级后也会切到该默认。主题点击后立即预览，保存设置后持久化。

## 字幕时间轴

合成改为逐句生成：`tts_worker.py` 先用 `pre_seg_text` 切句，再以 `cut0` 逐句调用 `run()`，
因此每句的真实起止位置可以从音频样本数直接算出，不依赖语音识别。

- 每句输出都会去掉首尾静音，句间按 `fragmentInterval` 补静音，时间轴因此是精确的。
- 静音 / 异常时长的句子会换种子重试（默认 2 次），仍异常则记录在 `flags` 里。
- 生成结果旁会写 `xxx.timing.json`（每句 text / start / end / voicedStart / paused / seed / retries / flags）。
- `src/main/subtitles.ts` 把时间轴转成 SRT / ASS / VTT / LRC / TXT / JSON：长句按标点或字数拆分并吸附到换气停顿，
  过短的相邻句合并，默认去掉句末标点，支持整体偏移与 ASS 字体设置。
- 配置在 `AppConfig.subtitle`，界面在「设置 → 字幕」；自动输出由主进程在合成后直接写文件。

## MCP

`src/main/mcp/` 三个文件：

- `server.ts`：精简 MCP（Streamable HTTP，JSON-RPC 2.0，POST /mcp），只监听 127.0.0.1，Bearer token 鉴权，
  拒绝浏览器跨域来源。工具错误作为 `isError` 结果返回，不中断服务。
  - 鉴权只认 `Authorization: Bearer <token>` 请求头（已移除 `?token=` 查询参数），常量时间比较。
  - 每次 `initialize` 生成新的 `mcp-session-id`；带未知会话头的请求返回 404，缺省会话头仍兼容。
  - 写入策略：白名单为空时可读任意路径，但只能写入输出目录 / 数据目录；写其他目录需加入白名单。
    禁止写系统/安装目录和可执行扩展名，输出不得覆盖输入。
  - `job_cancel` 只对走 TTS worker 的任务（synthesize / synthesize_script / preview_segments）生效。
  - 超时：ffprobe 30 秒；烧录/封装/配音混音 = 时长×3+600 秒（未知时 2 小时）。
  - 协议版本协商 `2025-06-18` / `2025-03-26` / `2024-11-05`，未知版本回退到最新。
  - `tools/call` 带 `params._meta.progressToken` 且 `Accept: text/event-stream` 时改用 SSE 回复，
    任务状态变化时推送 `notifications/progress`，最后发结果；普通请求仍返回 JSON。
  - `notifications/cancelled {requestId}` 会取消该请求启动的 job。
  - 对象结果同时放在 `content[0].text` 和 `structuredContent`。
- `tools.ts`：21 个工具 + 3 个 prompts。耗时工具走 job：`wait` 秒内没完成就返回 jobId，
  用 `job_status` 轮询、`job_cancel` 取消。
- `clients.ts`：生成 `data/mcp/gsv-mcp.js`（stdio 桥接，用本程序的 exe + `ELECTRON_RUN_AS_NODE`），
  以及 9 家客户端的配置写入 / 片段 / 提示词。

要点：

- 界面与 agent 的合成、识别都走 `gpuQueue`，界面任务优先；agent 任务会自动加载模型（底模）。
- 关闭窗口后如果 MCP 在运行，进程留在托盘继续服务；`--headless` 启动则不建窗口。
- 桥接发现服务没开时，会用 `--headless` 拉起程序（dev 下靠 `GSV_APP` 传 app 路径）。
- 日志在 `data/logs/mcp.log`；设置页显示实时活动。

本地测试脚本（不提交）：

```powershell
node --experimental-strip-types scripts/test-subtitles.ts   # 字幕六种格式
node --experimental-strip-types scripts/test-clients.mjs    # 客户端配置写入（沙箱 HOME）
node scripts/test-mcp.mjs                                   # HTTP 协议 + 真实合成
node scripts/test-mcp-stream.mjs                            # 协议协商 / SSE 进度 / 取消
node scripts/test-stdio.mjs                                 # stdio 桥接 + 自动拉起
node scripts/test-mcp-p2.mjs                                # 分段编辑 / 说话人 / 混音（真实推理）
& node_modules\\.bin\\esbuild.cmd scripts/test-segment-edit.mjs --bundle --platform=node --format=esm --outfile=$env:TEMP\\seg-test.mjs
node $env:TEMP\\seg-test.mjs                                # 分段替换 / 撤销单元测试
```

## 分段编辑

时间轴升级到 v2（`tts_worker.py` 写、`segmentEdit.ts` 读）：

- `source` 保存音色 / 参考音频 / 参考文本 / 语言 / 模型 / 参数，重新生成时直接用；
  临时参考音频会复制到 `data/refs/<hash>.wav`，避免 `data/temp` 被清理后失效。
- `gain` 是整段峰值缩放系数，新片段按同样系数处理；`gap` 是句间静音。
- 每句带 `seed`、`flags`、`params`（单句改过参数时）、`edited`。

重新生成流程：

1. `preview_segments`：worker 只生成选中的句子，写到 `data/temp/preview/<editId>/`，
   支持 `seed` / `params` / `texts` / `count`（1–8 个候选），不碰完整音频。
2. `commitSegments`（主进程，纯 Node）：读 PCM16 WAV，替换 `[start,end)`，后面句子整体平移，
   可按前后句 RMS 匹配响度；第一次替换前备份 `.orig.*`，每次替换前备份 `.prev.*`。
3. `revertEdits`：`last` 撤销一步，`original` 还原并删除备份。
4. 替换后写回 `edited` / `editCount`，历史记录同步，自动输出字幕会重新生成。

## 托盘与关闭行为

- 托盘常驻，右键菜单每次按当前状态重建（`refreshTray` 每 5 秒也刷一次）：TTS/ASR 状态、显存、
  卸载 TTS / ASR / 全部、MCP 开关、打开输出目录、退出。
- 卸载走 `unloadEngines()`，与界面按钮、MCP `unload_models` 共用一条路径。
- 窗口关闭交给 `mainWindow.on('close')`：`config.closeAction` 为 `ask` 时发 `window:close-request`，
  渲染层弹 `CloseDialog`，选择通过 `window:close-choice` 回传；`tray` 直接 `hideToTray()`，`quit` 直接退出。
- `hideToTray()` 前先等 220ms，让弹窗的退出动画跑完（窗口隐藏后 rAF 暂停，动画会卡在中间）。

## 说话人分离与译制

- `python/diarize.py`：FSMN-VAD 切段 → 4–6 秒窗口 → CAM++ 嵌入 → 平均连接 AHC 聚类
  （`numSpeakers` 指定人数，否则按余弦距离阈值判断）→ 短段并入邻居 → 合并相邻同人段。
- `asr_worker.py` 的 `diarize` 命令：加载 VAD / CAM++，逐句调用 SenseVoice 识别。
  注意：funasr 的模型注册依赖 `distutils`，运行时必须先 `import setuptools`，否则 CAMPPlus 注册失败。
- CAM++ 模型放在 `engine/models/asr/campplus`（`campplus_cn_common.bin` + `config.yaml` +
  `configuration.json`），来自 ModelScope `iic/speech_campplus_sv_zh-cn_16k-common`。
- `src/main/dub.ts`：`extractAudio` / `cutClip` / `atempo` / `fitLine` / `mixDub`，全部走引擎自带的 ffmpeg。
  时长适配顺序：默认语速 → 0.85–1.15 重生成 → atempo ±10% → 标 `overflow`。
- 混音 `bgm`：`replace`（分离出的伴奏 + 配音，推荐）、`keep`（原声+配音）、`duck`（配音时压低原声）、
  `remove`（只留配音）。输出 `.mp4/.mkv` 时复制原视频流。
- **混音在 Node 里按采样点完成**，ffmpeg 只负责把原片/背景轨/每段配音解码成 48k 立体声 PCM16，
  最后再封装一次。原因：自带 ffmpeg 的 `amix` 遇到多个带 `adelay` 偏移的输入会死锁
  （2 段以上必然卡住），换成滤镜方案无论怎么调参数都不可靠。`duck` 用逐采样增益包络
  （20ms 起、300ms 放、约 -9dB）模拟侧链；峰值超 0.995 时整体归一化。
- 相邻配音行不会重叠：超出下一行起始位置的音频会被截断并加 30ms 淡出。
- `synthesize_script` 重跑部分行时按 `id` 合并进已有 manifest，不会把其它行清掉；
  `overflow` 报的是行号而不是本次调用的下标。
- ffmpeg 调用默认 20 分钟超时，整片处理按时长放宽（见 MCP 一节）（`media.ts run()`），超时会 taskkill 并把命令行写进错误信息。

## 人声 / 背景分离

- 模型：UVR MDX-Net ONNX，下载自 HF `seanghay/uvr_models`（`Kim_Vocal_2.onnx` 人声优先，
  `UVR-MDX-NET-Inst_HQ_3.onnx` 伴奏优先），约 64MB，存在 `engine/models/separation/`。
  设置里的 `hfSource` 决定走 `huggingface.co` 还是 `hf-mirror.com`；下载支持断点续传（`.part`）。
- `python/separate.py`：一次性进程（跑完即退出，显存随之释放），STFT 分块推理 + iSTFT。
  `dim_f` / `dim_t` 直接从 ONNX 输入形状读出，`n_fft = (dim_f-1)*2`，避免手填参数出错。
  主输出是模型预测的那一路，另一路用“原音 - 主输出”得到，所以两条轨相加等于原音。
- `src/main/separation.ts`：模型表、下载、缓存（按源文件 + 模型哈希）、CPU/GPU 回退（CUDA → DML → CPU）。
- 界面「音频处理」页：选模型 → 拖入视频/音频 → 分离 → 两条轨试听/导出。
- MCP：`separate_audio` 工具；`diarize` / `voice_from_span` 支持 `useVocals`；
  `mix_dub` 支持 `bgm:"replace"` + `bedPath`，也支持直接读 `synthesize_script` 的 `manifestPath`。

## 双语字幕与烧录

- `python/separate.py` 之后的一切都在主进程做。`src/main/burn.ts`：
  - `buildAss`：`Primary`（译文）在上、`Secondary`（原文）在下，都在画面底部；字号按视频实际高度换算
    （主行 5.2%、副行 3.5%），360p 预览和 1080p 导出的观感一致。`secondaryOnTop` 可换回原文在上，
    `layout:'split'` 把原文放到画面顶部。
  - `splitLongCues`：按标点把长句切成 ≤`subtitle.maxChars` 的短句，**两种语言用同一组时间分数切**，
    英文切点会吸附到词边界，所以每条字幕都带对应的一小段原文，不会丢词或重复。
  - `parseSubtitleFile`：读 srt / vtt（剥标签、合并 YouTube 滚动重复行），供 `import_subtitle` 用。
  - `alignSentences`：AI 切好的句子按字符回填时间。先做去标点/大小写的精确匹配；
    不中时用首尾各 4 字符锚定，容忍 ASR 错误（`patta pixel` → `PetaPixel`）；
    仍不中的标 `matched:false` 并记入 `unmatched`。
- 烧录编码器：自带 ffmpeg 的 NVENC 太旧（新驱动下报 `unsupported param`），也没有 libx264，
  所以按 `h264_mf`（MediaFoundation）→ `libx264` → `mpeg4` 依次尝试；码率按分辨率给
  （1080p 12M / 720p 6M / 更低 3M）。软字幕走 `-c:s ass`（mkv）或 `mov_text`（mp4）。

## AI 切句与合成参数

- `build_script`：AI 提交逐字原文切好的句子，服务端算时间，避免 AI 自己编时间戳。
- 带 `start/end` 的译制行在 `synthesize_script` 里默认 `cut0`（不再行内二次切句），
  行内停顿由 `fragmentInterval` 控制。
- Agent 默认采样步数 8（界面仍默认 4），可按调用或按行覆盖；`list_history` 会带 `params`。

## 模型下载

便携包可以不含大模型（`scripts/prepare-engine.ps1 -SlimModels`），缺的部分在应用内下载。

- `src/main/packs.ts`：模型包清单 + 下载器。每个包记录 HF 仓库、仓库内路径、目标路径、大小、sha256。
  - 走 HF 的包：`tts-core`（lj1995/GPT-SoVITS）、`g2pw`（iqt-voice/G2PWModel）、
    `asr-sensevoice`（FunAudioLLM/SenseVoiceSmall）、`asr-vad`（funasr/fsmn-vad）、`asr-spk`（funasr/campplus）
  - 只有官方地址的：`langdetect`（fastText `lid.176.bin`）
  - 每个文件先试当前源（设置里的 `hfSource`），失败自动换另一个域名；FSMN-VAD / CAM++ 标 `bundled`，
    随包附带，下载入口只用于修复被删的目录
- 下载：`<file>.part` 断点续传 + Range，大小校验 + 64 位 sha256 校验，成功后原子改名；
  进度经 `packs:progress` 推给界面，MCP 侧计入 job 进度
- 启动：`validation.valid` 只看运行环境和代码；模型缺失时进 `MissingModels` 引导页，
  可以「稍后再说」直接进应用（TTS/ASR 会提示缺模型）
- MCP：`list_models` 返回 `packs`，`download_models {packs?}` 下载缺的包（GB 级，先问用户）

## 构建便携版

完整构建（复制约 10.5GB 的精简引擎，原整合包不动）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-portable.ps1 -Force
```

只更新应用代码、保留 `engine` 和 `data`（推荐日常迭代）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update-release.ps1
```

输出：

```text
release/GPT-SoVITS-Studio/
  GPT-SoVITS-Studio.exe
  resources/app/          Electron 应用
  resources/python/       Python worker
  engine/                 runtime + v5turbo 底模 + SenseVoice
  data/                   config / outputs / voices / logs
  README.txt
```

精简引擎脚本是 `scripts/prepare-engine.ps1`，只复制 v5turbo 需要的底模、代码和 ASR 模型，删除 UVR5、旧版底模、旧 ASR 模型等。

## 构建安装器

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-installer.ps1
```

流程：构建应用 → 压缩 payload（排除 `data`，仅保留示例音色 `smart_falcon.v5t`）→ 编译黑白浅色安装器。

输出：

```text
release/installer/
  GPT-SoVITS-Studio-Setup.exe       安装器 UI
  GPT-SoVITS-Studio-Portable.7z     压缩后的程序 + 模型
  安装说明.txt
  SHA256.txt
```

由于 Windows exe 受 PE 4GB 限制，安装包采用「安装器 + 压缩包」两文件形式，两个文件需要放在同一目录。安装器支持图形界面和静默安装（`/S /DIR=... /NOSHORTCUT`）。

## 音色库与分享

所有音色都是 `data/voices` 下的单个 `.v5t` 文件，文件名就是保存时的音色名：

```text
data/voices/
  smart_falcon.v5t
  旁白 · 温柔女声.v5t
```

每个 `.v5t` 内含：

- 原始参考音频（保存时已标准化）
- 音色名称
- 参考文本
- 参考语言
- 音频时长

播放时会把音频解到 `data/cache/voices` 作为缓存，缓存可随时删除，不影响 `.v5t` 文件。

合成页「音色库」下方提供：

- **打开音色库文件夹**：直接在资源管理器打开 `data/voices`。
- **导入 .v5t**：选择一个或多个 `.v5t` 文件。
- **导出 .v5t**：把当前音色另存为一份可分享的 `.v5t` 副本。

旧版本按文件夹保存的音色，会在首次启动时自动迁移成 `.v5t`，原 `voices.json` 会备份为 `data/voices-legacy-*.json`。

## 显存策略

本机是 8GB RTX 5070 Laptop，实测：

- TTS v5turbo：约 4.4GB 显存，加载约 14 秒，首次生成含加速编译。
- SenseVoice：约 2.1GB 显存，加载约 2 秒，首次识别会预热。

TTS + SenseVoice 在 8GB 显卡上也很紧。因此默认：

- 切换引擎时自动卸载另一个。
- 空闲 15 分钟自动释放（可在设置里改）。
- 「卸载」= 结束 worker 进程，CUDA 上下文和显存由系统回收。
- 退出应用 / 窗口崩溃：worker 通过 stdin EOF 和父进程 watchdog 自行结束。
- 模型页可看到 torch 显存和全局显存；8GB 建议只常驻一个引擎。

## 添加训练好的权重

把文件放进：

- `GPT_weights_v5turbo/*.ckpt`
- `SoVITS_weights_v5turbo/*.pth`

然后在「模型与显存」页点「刷新模型列表」，合成页即可选择。默认底模是：

- GPT：`GPT_SoVITS/pretrained_models/s1v3.ckpt`
- SoVITS：`GPT_SoVITS/pretrained_models/gsv-v5-pretrained/s2Gv5turbo.pth`

## 已知限制

- 便携版第一次启动可能被 Windows Defender 扫描新复制的 runtime，耗时 1–3 分钟；之后会快很多。
- SenseVoice 结果可能不带标点，可在结果表直接编辑。
- SenseVoice 首次识别会预热约 10–20 秒，之后通常不到 1 秒。
- 未签名 exe 可能触发 SmartScreen；自用可放行，公开分发再考虑签名。
- Electron 运行时约 250MB，相对 10.5GB 引擎可忽略。
