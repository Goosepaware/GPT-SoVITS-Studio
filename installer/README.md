# GPT-SoVITS-Studio 安装器

黑白浅色 WinForms 安装器，源码只有一个 `Installer.cs`，用 .NET Framework 自带的
`csc.exe` 编译，不需要 Visual Studio 或额外运行库。

## 构建

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-installer.ps1
```

脚本会压缩 `release\GPT-SoVITS-Studio`（排除 `data`，只保留示例音色
`smart_falcon.v5t`），并把安装器和 payload 输出到 `release\installer\`。

## 文件

- `Installer.cs`：界面、路径校验、解压、快捷方式。
- `app.manifest`：DPI 感知、asInvoker。
- `icon-mono.ico`：安装器黑白图标。

## 静默安装

```text
GPT-SoVITS-Studio-Setup.exe /S /DIR=D:\GPT-SoVITS-Studio /NOSHORTCUT
```

可选参数：`/LAUNCH`、`/PAYLOAD=...`。

## 说明

- 7zr.exe 作为资源嵌入 Setup.exe，安装时释放到 `%TEMP%`。
- 不写注册表；卸载 = 删除安装目录和桌面快捷方式。
- 覆盖安装会备份并恢复已有的 `data\voices\smart_falcon.v5t`，不会覆盖用户的示例音色。
