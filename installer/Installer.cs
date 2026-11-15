using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("GPT-SoVITS-Studio Setup")]
[assembly: AssemblyProduct("GPT-SoVITS-Studio")]
[assembly: AssemblyDescription("GPT-SoVITS-Studio installer")]
[assembly: AssemblyCompany("GPT-SoVITS-Studio")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace GptSovitsStudioSetup
{
    internal static class Theme
    {
        public static readonly Color Bg = Color.FromArgb(243, 243, 243);
        public static readonly Color Surface = Color.White;
        public static readonly Color Text = Color.FromArgb(10, 10, 10);
        public static readonly Color Muted = Color.FromArgb(92, 92, 92);
        public static readonly Color Faint = Color.FromArgb(138, 138, 138);
        public static readonly Color Border = Color.FromArgb(207, 207, 207);
        public static readonly Color BorderStrong = Color.FromArgb(150, 150, 150);
        public static readonly Color Hover = Color.FromArgb(236, 236, 236);

        public static Font Font(float size, FontStyle style)
        {
            return new Font("Segoe UI", size, style, GraphicsUnit.Point);
        }

        public static Font Font(float size)
        {
            return Font(size, FontStyle.Regular);
        }
    }

    internal sealed class SetupOptions
    {
        public string InstallDir;
        public bool CreateShortcut;
        public bool Launch;
        public bool Silent;
        public string PayloadPath;

        public SetupOptions()
        {
            CreateShortcut = true;
            Launch = false;
            Silent = false;
        }
    }

    internal sealed class InstallProgress
    {
        public int Percent;
        public string Stage;

        public InstallProgress(int percent, string stage)
        {
            Percent = percent;
            Stage = stage;
        }
    }

    internal sealed class InstallResult
    {
        public bool ShortcutCreated;
        public string InstallDir;
        public string AppExe;
    }

    internal sealed class InstallerException : Exception
    {
        public InstallerException(string message) : base(message) { }
    }

    internal static class Logger
    {
        private static readonly object Sync = new object();

        public static string LogPath
        {
            get
            {
                return Path.Combine(Path.GetTempPath(), "GPT-SoVITS-Studio-Setup.log");
            }
        }

        public static void Write(string message)
        {
            try
            {
                lock (Sync)
                {
                    File.AppendAllText(LogPath, string.Format("[{0:yyyy-MM-dd HH:mm:ss}] {1}\r\n", DateTime.Now, message), Encoding.UTF8);
                }
            }
            catch
            {
            }
        }
    }

    internal static class InstallerEngine
    {
        public const string AppName = "GPT-SoVITS-Studio";
        public const string AppExe = "GPT-SoVITS-Studio.exe";
        public const string PayloadName = "GPT-SoVITS-Studio-Portable.7z";
        private const string ExampleVoiceRel = "data\\voices\\smart_falcon.v5t";
        private const long RequiredBytes = 12L * 1024L * 1024L * 1024L;

        public static string DefaultInstallDir()
        {
            if (Directory.Exists("D:\\"))
            {
                return "D:\\GPT-SoVITS-Studio";
            }
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", AppName);
        }

        public static string ResolvePayload(SetupOptions options)
        {
            if (!string.IsNullOrEmpty(options.PayloadPath))
            {
                return Path.GetFullPath(options.PayloadPath);
            }
            return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, PayloadName);
        }

        public static InstallResult Run(SetupOptions options, Action<InstallProgress> report, Func<bool> cancelled)
        {
            string payload = ResolvePayload(options);
            if (!File.Exists(payload))
            {
                throw new InstallerException("找不到安装包：\r\n" + payload + "\r\n\r\n请确认 " + PayloadName + " 与安装器在同一个文件夹。");
            }

            string target = Path.GetFullPath(options.InstallDir.Trim());
            string trimmed = target.TrimEnd('\\');
            if (trimmed.Length <= 2 || !trimmed.Contains(":\\"))
            {
                throw new InstallerException("请不要直接安装到磁盘根目录，请选择一个子文件夹。");
            }

            EnsureAppNotRunning();
            Directory.CreateDirectory(target);
            CheckWritable(target);
            CheckFreeSpace(target, payload);

            if (report != null)
            {
                report(new InstallProgress(4, "准备安装"));
            }
            Logger.Write("Install target: " + target);
            Logger.Write("Payload: " + payload);

            string examplePath = Path.Combine(target, ExampleVoiceRel);
            string backup = null;
            if (File.Exists(examplePath))
            {
                backup = Path.Combine(Path.GetTempPath(), "gsv-example-" + Guid.NewGuid().ToString("N") + ".v5t");
                try
                {
                    File.Copy(examplePath, backup, true);
                }
                catch
                {
                    backup = null;
                }
            }

            InstallResult result = new InstallResult();
            result.InstallDir = target;
            result.AppExe = Path.Combine(target, AppExe);

            try
            {
                ExtractPayload(target, payload, report, cancelled);
                try
                {
                    Directory.CreateDirectory(Path.Combine(target, "data"));
                    Directory.CreateDirectory(Path.Combine(target, "data", "voices"));
                }
                catch
                {
                }

                if (backup != null)
                {
                    try
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(examplePath));
                        File.Copy(backup, examplePath, true);
                    }
                    catch
                    {
                    }
                }

                if (report != null)
                {
                    report(new InstallProgress(94, "创建桌面快捷方式"));
                }
                if (options.CreateShortcut)
                {
                    result.ShortcutCreated = CreateShortcut(result.AppExe, target);
                }
                if (report != null)
                {
                    report(new InstallProgress(100, "安装完成"));
                }
            }
            finally
            {
                if (backup != null)
                {
                    try { File.Delete(backup); } catch { }
                }
            }

            return result;
        }

        public static void LaunchApp(string exe, string workingDir)
        {
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = exe;
            info.WorkingDirectory = workingDir;
            info.UseShellExecute = true;
            Process.Start(info);
        }

        private static void EnsureAppNotRunning()
        {
            string[] names = new string[] { AppName, "GPT-SoVITS Studio" };
            foreach (string name in names)
            {
                Process[] processes = Process.GetProcessesByName(name);
                foreach (Process process in processes)
                {
                    try
                    {
                        if (process.Id != Process.GetCurrentProcess().Id)
                        {
                            throw new InstallerException("GPT-SoVITS-Studio 正在运行，请先关闭软件再安装。");
                        }
                    }
                    finally
                    {
                        process.Dispose();
                    }
                }
            }
        }

        private static void CheckWritable(string target)
        {
            string probe = Path.Combine(target, ".gsv-write-test");
            try
            {
                File.WriteAllText(probe, "ok", Encoding.ASCII);
                File.Delete(probe);
            }
            catch
            {
                throw new InstallerException("目标文件夹不可写：\r\n" + target + "\r\n\r\n请换一个位置，或以管理员身份运行安装器。");
            }
        }

        private static void CheckFreeSpace(string target, string payload)
        {
            try
            {
                string root = Path.GetPathRoot(target);
                DriveInfo drive = new DriveInfo(root);
                long free = drive.AvailableFreeSpace;
                long required = RequiredBytes;
                try
                {
                    long payloadSize = new FileInfo(payload).Length;
                    required = Math.Max(required, payloadSize + 1024L * 1024L * 1024L);
                }
                catch
                {
                }
                if (free < required)
                {
                    throw new InstallerException(string.Format(
                        "目标磁盘空间不足。\r\n\r\n需要约 {0:0.0} GB，当前可用 {1:0.0} GB。",
                        required / 1073741824.0, free / 1073741824.0));
                }
            }
            catch (InstallerException)
            {
                throw;
            }
            catch
            {
                // Network paths and unusual drives: continue and let extraction report errors.
            }
        }

        private static void ExtractPayload(string target, string payload, Action<InstallProgress> report, Func<bool> cancelled)
        {
            string sevenZip = ExtractSevenZip();
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = sevenZip;
            info.Arguments = string.Format("x -y -bsp1 -bso1 -bse1 -o\"{0}\" \"{1}\"", target, payload);
            info.WorkingDirectory = Path.GetDirectoryName(sevenZip);
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.StandardOutputEncoding = Encoding.Default;
            info.StandardErrorEncoding = Encoding.Default;

            StringBuilder errors = new StringBuilder();
            Process process = new Process();
            process.StartInfo = info;
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args)
            {
                if (args.Data != null)
                {
                    errors.AppendLine(args.Data);
                }
            };

            Logger.Write("Starting 7zr: " + info.Arguments);
            process.Start();
            process.BeginErrorReadLine();

            StringBuilder tail = new StringBuilder();
            char[] buffer = new char[512];
            int lastPercent = -1;
            int exitCode = -1;
            try
            {
                while (true)
                {
                    if (cancelled != null && cancelled())
                    {
                        try { process.Kill(); } catch { }
                        throw new OperationCanceledException();
                    }

                    int read = process.StandardOutput.Read(buffer, 0, buffer.Length);
                    if (read <= 0)
                    {
                        break;
                    }
                    tail.Append(new string(buffer, 0, read));
                    if (tail.Length > 8192)
                    {
                        tail.Remove(0, tail.Length - 8192);
                    }

                    MatchCollection matches = Regex.Matches(tail.ToString(), "(\\d{1,3})%");
                    if (matches.Count > 0)
                    {
                        int percent = 0;
                        if (int.TryParse(matches[matches.Count - 1].Groups[1].Value, out percent))
                        {
                            if (percent != lastPercent)
                            {
                                lastPercent = percent;
                                int mapped = 5 + (percent * 86) / 100;
                                if (report != null)
                                {
                                    report(new InstallProgress(mapped, "正在解压程序与模型"));
                                }
                            }
                        }
                    }
                }

                process.WaitForExit();
                exitCode = process.ExitCode;
            }
            finally
            {
                if (!process.HasExited)
                {
                    try { process.Kill(); } catch { }
                }
                process.Dispose();
            }

            if (exitCode != 0 && exitCode != 1)
            {
                string detail = errors.ToString();
                if (detail.Length > 2000)
                {
                    detail = detail.Substring(detail.Length - 2000);
                }
                Logger.Write("7zr exit code: " + exitCode + "\r\n" + detail);
                throw new InstallerException("解压安装包失败（7zr 退出码 " + exitCode + "）。\r\n\r\n" + detail);
            }
            Logger.Write("7zr finished with code " + exitCode);
        }

        private static string ExtractSevenZip()
        {
            string folder = Path.Combine(Path.GetTempPath(), "GPT-SoVITS-Studio-Setup");
            Directory.CreateDirectory(folder);
            string file = Path.Combine(folder, "7zr.exe");
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream stream = assembly.GetManifestResourceStream("SevenZip"))
            {
                if (stream == null)
                {
                    throw new InstallerException("安装器缺少内置的解压组件。");
                }
                if (!File.Exists(file) || new FileInfo(file).Length != stream.Length)
                {
                    using (FileStream output = new FileStream(file, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        stream.CopyTo(output);
                    }
                }
            }
            return file;
        }

        private static bool CreateShortcut(string exe, string target)
        {
            try
            {
                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                string linkPath = Path.Combine(desktop, AppName + ".lnk");
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType == null)
                {
                    throw new Exception("WScript.Shell unavailable");
                }
                object shell = Activator.CreateInstance(shellType);
                object shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { linkPath });
                Type shortcutType = shortcut.GetType();
                string icon = Path.Combine(target, "resources", "icon.ico");
                if (!File.Exists(icon))
                {
                    icon = exe;
                }
                shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { exe });
                shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { target });
                shortcutType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { icon + ",0" });
                shortcutType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { AppName });
                shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
                Marshal.FinalReleaseComObject(shortcut);
                Marshal.FinalReleaseComObject(shell);
                Logger.Write("Shortcut created: " + linkPath);
                return true;
            }
            catch (Exception ex)
            {
                Logger.Write("Shortcut failed: " + ex.Message);
                return false;
            }
        }
    }

    internal sealed class FlatButton : Button
    {
        private bool primary;

        public bool Primary
        {
            get { return primary; }
            set
            {
                primary = value;
                ApplyStyle();
            }
        }

        public FlatButton()
        {
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 1;
            UseVisualStyleBackColor = false;
            Font = Theme.Font(9.5f, FontStyle.Bold);
            Cursor = Cursors.Hand;
            TabStop = true;
            ApplyStyle();
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            base.OnMouseEnter(e);
            if (Enabled)
            {
                if (primary)
                {
                    BackColor = Theme.Surface;
                    ForeColor = Theme.Text;
                }
                else
                {
                    BackColor = Theme.Hover;
                }
            }
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            ApplyStyle();
        }

        protected override void OnEnabledChanged(EventArgs e)
        {
            base.OnEnabledChanged(e);
            ApplyStyle();
        }

        private void ApplyStyle()
        {
            if (primary)
            {
                BackColor = Enabled ? Theme.Text : Color.FromArgb(150, 150, 150);
                ForeColor = Color.White;
                FlatAppearance.BorderColor = Enabled ? Theme.Text : Color.FromArgb(150, 150, 150);
            }
            else
            {
                BackColor = Theme.Surface;
                ForeColor = Theme.Text;
                FlatAppearance.BorderColor = Theme.BorderStrong;
            }
        }
    }

    internal sealed class LinkButton : Button
    {
        public LinkButton()
        {
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            BackColor = Theme.Surface;
            ForeColor = Theme.Muted;
            Font = Theme.Font(9f);
            Cursor = Cursors.Hand;
            TabStop = false;
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            base.OnMouseEnter(e);
            ForeColor = Theme.Text;
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            ForeColor = Theme.Muted;
        }
    }

    internal sealed class MonoCheckBox : Control
    {
        private bool isChecked;

        public bool Checked
        {
            get { return isChecked; }
            set
            {
                isChecked = value;
                Invalidate();
            }
        }

        public MonoCheckBox()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
            Font = Theme.Font(9.5f);
            ForeColor = Theme.Text;
            BackColor = Color.Transparent;
            Cursor = Cursors.Hand;
            TabStop = true;
            Height = 26;
        }

        protected override void OnClick(EventArgs e)
        {
            Checked = !Checked;
            base.OnClick(e);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Space)
            {
                Checked = !Checked;
                e.Handled = true;
            }
            base.OnKeyDown(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.None;
            Rectangle box = new Rectangle(0, (Height - 15) / 2, 15, 15);
            using (Pen pen = new Pen(Theme.BorderStrong))
            {
                g.DrawRectangle(pen, box);
            }
            if (Checked)
            {
                using (SolidBrush brush = new SolidBrush(Theme.Text))
                {
                    g.FillRectangle(brush, box);
                }
                using (Pen pen = new Pen(Color.White, 2f))
                {
                    g.DrawLine(pen, box.Left + 3, box.Top + 8, box.Left + 6, box.Top + 11);
                    g.DrawLine(pen, box.Left + 6, box.Top + 11, box.Left + 12, box.Top + 4);
                }
            }
            Rectangle textRect = new Rectangle(24, 0, Math.Max(0, Width - 24), Height);
            TextRenderer.DrawText(g, Text, Font, textRect, ForeColor, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPrefix);
        }
    }

    internal sealed class MonoProgressBar : Control
    {
        private int value;

        public int Value
        {
            get { return value; }
            set
            {
                this.value = Math.Max(0, Math.Min(100, value));
                Invalidate();
            }
        }

        public MonoProgressBar()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
            Height = 10;
            BackColor = Theme.Surface;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            Rectangle rect = new Rectangle(0, 0, Width - 1, Height - 1);
            using (SolidBrush brush = new SolidBrush(Theme.Surface))
            {
                g.FillRectangle(brush, rect);
            }
            using (Pen pen = new Pen(Theme.BorderStrong))
            {
                g.DrawRectangle(pen, rect);
            }
            int innerWidth = Math.Max(0, Width - 4);
            int fill = innerWidth * value / 100;
            if (fill > 0)
            {
                using (SolidBrush brush = new SolidBrush(Theme.Text))
                {
                    g.FillRectangle(brush, 2, 2, fill, Height - 4);
                }
            }
        }
    }

    internal sealed class LogoBox : Control
    {
        public LogoBox()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
            Size = new Size(46, 46);
            BackColor = Color.Transparent;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.None;
            using (Pen pen = new Pen(Theme.Text))
            {
                g.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
            }
            int[] heights = new int[] { 10, 18, 26, 16, 8 };
            int startX = 10;
            for (int i = 0; i < heights.Length; i++)
            {
                int h = heights[i];
                int x = startX + i * 6;
                int y = (Height - h) / 2;
                using (SolidBrush brush = new SolidBrush(Theme.Text))
                {
                    g.FillRectangle(brush, x, y, 3, h);
                }
            }
        }
    }

    internal sealed class CheckMarkBox : Control
    {
        public CheckMarkBox()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
            Size = new Size(46, 46);
            BackColor = Color.Transparent;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.None;
            using (Pen pen = new Pen(Theme.Text))
            {
                g.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
            }
            using (Pen pen = new Pen(Theme.Text, 3f))
            {
                g.DrawLine(pen, 11, 24, 19, 32);
                g.DrawLine(pen, 19, 32, 35, 13);
            }
        }
    }

    internal sealed class SetupForm : Form
    {
        private readonly SetupOptions options;
        private readonly string payload;
        private readonly TextBox pathBox;
        private readonly Label freeLabel;
        private readonly Label errorLabel;
        private readonly MonoCheckBox shortcutCheck;
        private readonly FlatButton installButton;
        private readonly FlatButton cancelButton;
        private readonly Panel installPage;
        private readonly Panel progressPage;
        private readonly Panel finishPage;
        private readonly Label stageLabel;
        private readonly Label percentLabel;
        private readonly MonoProgressBar progressBar;
        private readonly FlatButton progressCancelButton;
        private readonly Label finishPathLabel;
        private readonly Label finishNoteLabel;
        private readonly MonoCheckBox launchCheck;
        private readonly FlatButton finishButton;
        private volatile bool cancelRequested;
        private bool installing;

        public SetupForm(SetupOptions options)
        {
            this.options = options;
            payload = InstallerEngine.ResolvePayload(options);
            Text = "GPT-SoVITS-Studio 安装程序";
            ClientSize = new Size(780, 540);
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Theme.Bg;
            Font = Theme.Font(9.5f);
            AutoScaleMode = AutoScaleMode.None;
            Logger.Write("SetupForm client size: " + ClientSize.Width + "x" + ClientSize.Height);
            DoubleBuffered = true;
            try
            {
                Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch
            {
            }

            Panel titleBar = BuildTitleBar();

            installPage = new Panel();
            installPage.Dock = DockStyle.Fill;
            installPage.BackColor = Color.Transparent;
            Controls.Add(installPage);

            progressPage = new Panel();
            progressPage.Dock = DockStyle.Fill;
            progressPage.BackColor = Color.Transparent;
            progressPage.Visible = false;
            Controls.Add(progressPage);

            finishPage = new Panel();
            finishPage.Dock = DockStyle.Fill;
            finishPage.BackColor = Color.Transparent;
            finishPage.Visible = false;
            Controls.Add(finishPage);

            Controls.Add(titleBar);
            titleBar.BringToFront();

            // Header.
            LogoBox logo = new LogoBox();
            logo.Location = new Point(36, 28);
            installPage.Controls.Add(logo);

            Label title = new Label();
            title.Text = "GPT-SoVITS-Studio";
            title.Font = Theme.Font(19f, FontStyle.Bold);
            title.ForeColor = Theme.Text;
            title.BackColor = Color.Transparent;
            title.AutoSize = true;
            title.Location = new Point(96, 26);
            installPage.Controls.Add(title);

            Label subtitle = new Label();
            subtitle.Text = "v5turbo · 本地语音合成 / 语音识别";
            subtitle.Font = Theme.Font(9.5f);
            subtitle.ForeColor = Theme.Muted;
            subtitle.BackColor = Color.Transparent;
            subtitle.AutoSize = true;
            subtitle.Location = new Point(99, 66);
            installPage.Controls.Add(subtitle);

            Panel divider = new Panel();
            divider.Location = new Point(36, 104);
            divider.Size = new Size(708, 1);
            divider.BackColor = Theme.Border;
            installPage.Controls.Add(divider);

            Label pathTitle = new Label();
            pathTitle.Text = "安装位置";
            pathTitle.Font = Theme.Font(9f, FontStyle.Bold);
            pathTitle.ForeColor = Theme.Text;
            pathTitle.AutoSize = true;
            pathTitle.Location = new Point(36, 126);
            installPage.Controls.Add(pathTitle);

            pathBox = new TextBox();
            pathBox.Text = options.InstallDir;
            pathBox.Font = Theme.Font(10f);
            pathBox.ForeColor = Theme.Text;
            pathBox.BackColor = Theme.Surface;
            pathBox.BorderStyle = BorderStyle.FixedSingle;
            pathBox.AutoSize = false;
            pathBox.Location = new Point(36, 150);
            pathBox.Size = new Size(588, 32);
            pathBox.TextChanged += delegate { UpdateFreeSpace(); };
            installPage.Controls.Add(pathBox);

            FlatButton browseButton = new FlatButton();
            browseButton.Text = "浏览";
            browseButton.Location = new Point(636, 149);
            browseButton.Size = new Size(108, 34);
            browseButton.Click += delegate { BrowseFolder(); };
            installPage.Controls.Add(browseButton);

            freeLabel = new Label();
            freeLabel.Text = "";
            freeLabel.Font = Theme.Font(8.8f);
            freeLabel.ForeColor = Theme.Faint;
            freeLabel.AutoSize = true;
            freeLabel.Location = new Point(38, 190);
            installPage.Controls.Add(freeLabel);

            Panel note = new Panel();
            note.Location = new Point(36, 220);
            note.Size = new Size(708, 92);
            note.BackColor = Theme.Surface;
            note.Paint += delegate(object sender, PaintEventArgs e)
            {
                using (Pen pen = new Pen(Theme.Border))
                {
                    e.Graphics.DrawRectangle(pen, 0, 0, note.Width - 1, note.Height - 1);
                }
            };
            installPage.Controls.Add(note);

            Label noteText = new Label();
            noteText.Text = "将安装程序、v5turbo 模型与 SenseVoice 识别模型。\r\n安装包不包含历史记录、日志和其他个人音色；示例音色 smart_falcon 会保留。\r\n覆盖安装时，已有 data 目录不会被删除。";
            noteText.Font = Theme.Font(9f);
            noteText.ForeColor = Theme.Muted;
            noteText.Location = new Point(14, 12);
            noteText.Size = new Size(680, 68);
            noteText.AutoSize = false;
            note.Controls.Add(noteText);

            shortcutCheck = new MonoCheckBox();
            shortcutCheck.Text = "创建桌面快捷方式";
            shortcutCheck.Checked = options.CreateShortcut;
            shortcutCheck.Location = new Point(36, 330);
            shortcutCheck.Size = new Size(300, 26);
            installPage.Controls.Add(shortcutCheck);

            errorLabel = new Label();
            errorLabel.Text = "";
            errorLabel.Font = Theme.Font(9f, FontStyle.Bold);
            errorLabel.ForeColor = Theme.Text;
            errorLabel.AutoSize = false;
            errorLabel.Location = new Point(36, 372);
            errorLabel.Size = new Size(708, 44);
            installPage.Controls.Add(errorLabel);

            Label payloadLabel = new Label();
            payloadLabel.Text = "安装包：" + Path.GetFileName(payload);
            payloadLabel.Font = Theme.Font(8.5f);
            payloadLabel.ForeColor = Theme.Faint;
            payloadLabel.AutoSize = true;
            payloadLabel.Location = new Point(36, 460);
            installPage.Controls.Add(payloadLabel);

            installButton = new FlatButton();
            installButton.Text = "安装";
            installButton.Primary = true;
            installButton.Location = new Point(624, 448);
            installButton.Size = new Size(120, 38);
            installButton.Click += delegate { StartInstall(); };
            installPage.Controls.Add(installButton);

            cancelButton = new FlatButton();
            cancelButton.Text = "取消";
            cancelButton.Location = new Point(508, 448);
            cancelButton.Size = new Size(104, 38);
            cancelButton.Click += delegate { Close(); };
            installPage.Controls.Add(cancelButton);

            // Progress page.
            Label progressTitle = new Label();
            progressTitle.Text = "正在安装 GPT-SoVITS-Studio";
            progressTitle.Font = Theme.Font(17f, FontStyle.Bold);
            progressTitle.ForeColor = Theme.Text;
            progressTitle.AutoSize = true;
            progressTitle.Location = new Point(36, 44);
            progressPage.Controls.Add(progressTitle);

            stageLabel = new Label();
            stageLabel.Text = "准备安装…";
            stageLabel.Font = Theme.Font(10.5f);
            stageLabel.ForeColor = Theme.Muted;
            stageLabel.AutoSize = true;
            stageLabel.Location = new Point(36, 92);
            progressPage.Controls.Add(stageLabel);

            progressBar = new MonoProgressBar();
            progressBar.Location = new Point(36, 128);
            progressBar.Size = new Size(708, 10);
            progressPage.Controls.Add(progressBar);

            percentLabel = new Label();
            percentLabel.Text = "0%";
            percentLabel.Font = Theme.Font(9f);
            percentLabel.ForeColor = Theme.Text;
            percentLabel.AutoSize = true;
            percentLabel.Location = new Point(36, 150);
            progressPage.Controls.Add(percentLabel);

            Label progressNote = new Label();
            progressNote.Text = "正在解压 10.9GB 内容，首次安装可能需要几分钟。\r\n请保持窗口打开，不要关闭软件。";
            progressNote.Font = Theme.Font(9.5f);
            progressNote.ForeColor = Theme.Faint;
            progressNote.AutoSize = true;
            progressNote.Location = new Point(36, 184);
            progressPage.Controls.Add(progressNote);

            progressCancelButton = new FlatButton();
            progressCancelButton.Text = "取消安装";
            progressCancelButton.Location = new Point(624, 448);
            progressCancelButton.Size = new Size(120, 38);
            progressCancelButton.Click += delegate
            {
                cancelRequested = true;
                progressCancelButton.Enabled = false;
                stageLabel.Text = "正在取消…";
            };
            progressPage.Controls.Add(progressCancelButton);

            // Finish page.
            CheckMarkBox check = new CheckMarkBox();
            check.Location = new Point(36, 36);
            finishPage.Controls.Add(check);

            Label finishTitle = new Label();
            finishTitle.Text = "安装完成";
            finishTitle.Font = Theme.Font(19f, FontStyle.Bold);
            finishTitle.ForeColor = Theme.Text;
            finishTitle.AutoSize = true;
            finishTitle.Location = new Point(98, 36);
            finishPage.Controls.Add(finishTitle);

            finishPathLabel = new Label();
            finishPathLabel.Text = "";
            finishPathLabel.Font = Theme.Font(9.5f);
            finishPathLabel.ForeColor = Theme.Muted;
            finishPathLabel.AutoSize = false;
            finishPathLabel.Location = new Point(100, 74);
            finishPathLabel.Size = new Size(640, 24);
            finishPage.Controls.Add(finishPathLabel);

            finishNoteLabel = new Label();
            finishNoteLabel.Text = "";
            finishNoteLabel.Font = Theme.Font(9f);
            finishNoteLabel.ForeColor = Theme.Faint;
            finishNoteLabel.AutoSize = false;
            finishNoteLabel.Location = new Point(36, 138);
            finishNoteLabel.Size = new Size(708, 48);
            finishPage.Controls.Add(finishNoteLabel);

            launchCheck = new MonoCheckBox();
            launchCheck.Text = "立即启动 GPT-SoVITS-Studio";
            launchCheck.Checked = true;
            launchCheck.Location = new Point(36, 208);
            launchCheck.Size = new Size(320, 26);
            finishPage.Controls.Add(launchCheck);

            finishButton = new FlatButton();
            finishButton.Text = "完成";
            finishButton.Primary = true;
            finishButton.Location = new Point(624, 448);
            finishButton.Size = new Size(120, 38);
            finishButton.Click += delegate
            {
                if (launchCheck.Checked)
                {
                    try
                    {
                        InstallerEngine.LaunchApp(Path.Combine(options.InstallDir, InstallerEngine.AppExe), options.InstallDir);
                    }
                    catch (Exception ex)
                    {
                        MessageBox.Show(this, "启动失败：" + ex.Message, "GPT-SoVITS-Studio", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    }
                }
                Close();
            };
            finishPage.Controls.Add(finishButton);

            UpdateFreeSpace();
            if (!File.Exists(payload))
            {
                errorLabel.Text = "未找到安装包：" + InstallerEngine.PayloadName + "。\r\n请将安装器与压缩包放在同一个文件夹。";
                installButton.Enabled = false;
            }
        }

        private Panel BuildTitleBar()
        {
            Panel bar = new Panel();
            bar.Dock = DockStyle.Top;
            bar.Height = 42;
            bar.BackColor = Theme.Surface;
            bar.Paint += delegate(object sender, PaintEventArgs e)
            {
                using (Pen pen = new Pen(Theme.Border))
                {
                    e.Graphics.DrawLine(pen, 0, bar.Height - 1, bar.Width, bar.Height - 1);
                }
            };
            bar.MouseDown += delegate(object sender, MouseEventArgs e) { DragWindow(); };

            Label brand = new Label();
            brand.Text = "GPT-SoVITS-Studio 安装程序";
            brand.Font = Theme.Font(9f, FontStyle.Bold);
            brand.ForeColor = Theme.Text;
            brand.AutoSize = true;
            brand.Location = new Point(16, 13);
            brand.MouseDown += delegate(object sender, MouseEventArgs e) { DragWindow(); };
            bar.Controls.Add(brand);

            LinkButton minimize = new LinkButton();
            minimize.Text = "–";
            minimize.Font = Theme.Font(12f);
            minimize.Size = new Size(40, 42);
            minimize.Location = new Point(ClientSize.Width - 88, 0);
            minimize.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            minimize.Click += delegate { WindowState = FormWindowState.Minimized; };
            bar.Controls.Add(minimize);

            LinkButton close = new LinkButton();
            close.Text = "×";
            close.Font = Theme.Font(13f);
            close.Size = new Size(40, 42);
            close.Location = new Point(ClientSize.Width - 44, 0);
            close.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            close.Click += delegate { Close(); };
            bar.Controls.Add(close);

            bar.Resize += delegate
            {
                minimize.Location = new Point(bar.Width - 88, 0);
                close.Location = new Point(bar.Width - 44, 0);
            };

            return bar;
        }

        private void DragWindow()
        {
            ReleaseCapture();
            SendMessage(Handle, 0xA1, (IntPtr)0x2, IntPtr.Zero);
        }

        private void BrowseFolder()
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "选择 GPT-SoVITS-Studio 安装位置";
                dialog.ShowNewFolderButton = true;
                string current = pathBox.Text.Trim();
                if (Directory.Exists(current))
                {
                    dialog.SelectedPath = current;
                }
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    string chosen = dialog.SelectedPath;
                    pathBox.Text = string.Equals(Path.GetFileName(chosen), InstallerEngine.AppName, StringComparison.OrdinalIgnoreCase)
                        ? chosen
                        : Path.Combine(chosen, InstallerEngine.AppName);
                    errorLabel.Text = "";
                }
            }
        }

        private void UpdateFreeSpace()
        {
            try
            {
                string target = pathBox.Text.Trim();
                string root = Path.GetPathRoot(Path.GetFullPath(target));
                if (!string.IsNullOrEmpty(root))
                {
                    DriveInfo drive = new DriveInfo(root);
                    freeLabel.Text = string.Format("解压后约 10.9 GB · 目标磁盘可用 {0:0.0} GB", drive.AvailableFreeSpace / 1073741824.0);
                    return;
                }
            }
            catch
            {
            }
            freeLabel.Text = "解压后约 10.9 GB";
        }

        private void StartInstall()
        {
            if (installing)
            {
                return;
            }
            string target;
            try
            {
                target = Path.GetFullPath(pathBox.Text.Trim());
            }
            catch (Exception ex)
            {
                errorLabel.Text = "安装路径无效：" + ex.Message;
                return;
            }

            if (Directory.Exists(target) && Directory.GetFileSystemEntries(target).Length > 0)
            {
                DialogResult confirm = MessageBox.Show(this,
                    "目标文件夹不是空的。\r\n\r\n安装会覆盖程序与模型文件，但不会删除已有 data 目录。\r\n是否继续？",
                    "GPT-SoVITS-Studio", MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
                if (confirm != DialogResult.OK)
                {
                    return;
                }
            }

            options.InstallDir = target;
            options.CreateShortcut = shortcutCheck.Checked;
            errorLabel.Text = "";
            installing = true;
            installButton.Enabled = false;
            cancelButton.Enabled = false;
            installPage.Visible = false;
            progressPage.Visible = true;
            progressBar.Value = 0;
            percentLabel.Text = "0%";
            stageLabel.Text = "准备安装…";

            Action<InstallProgress> report = delegate(InstallProgress progress)
            {
                if (IsDisposed)
                {
                    return;
                }
                BeginInvoke((MethodInvoker)delegate
                {
                    progressBar.Value = progress.Percent;
                    percentLabel.Text = progress.Percent + "%";
                    if (!string.IsNullOrEmpty(progress.Stage))
                    {
                        stageLabel.Text = progress.Stage;
                    }
                });
            };

            Func<bool> cancelled = delegate { return cancelRequested; };

            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    InstallResult result = InstallerEngine.Run(options, report, cancelled);
                    BeginInvoke((MethodInvoker)delegate
                    {
                        installing = false;
                        progressPage.Visible = false;
                        finishPage.Visible = true;
                        finishPathLabel.Text = "已安装到 " + result.InstallDir;
                        finishNoteLabel.Text = result.ShortcutCreated
                            ? "桌面快捷方式已创建。你可以随时删除整个安装目录来卸载。"
                            : "安装已完成，但桌面快捷方式创建失败。你仍可从安装目录运行 GPT-SoVITS-Studio.exe。";
                        options.InstallDir = result.InstallDir;
                    });
                }
                catch (OperationCanceledException)
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        installing = false;
                        progressPage.Visible = false;
                        installPage.Visible = true;
                        installButton.Enabled = true;
                        cancelButton.Enabled = true;
                        errorLabel.Text = "已取消安装。目标目录中可能包含部分已解压文件。";
                    });
                }
                catch (Exception ex)
                {
                    Logger.Write("Install failed: " + ex);
                    BeginInvoke((MethodInvoker)delegate
                    {
                        installing = false;
                        progressPage.Visible = false;
                        installPage.Visible = true;
                        installButton.Enabled = true;
                        cancelButton.Enabled = true;
                        errorLabel.Text = ex.Message;
                    });
                }
            });
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (installing)
            {
                MessageBox.Show(this, "安装正在进行。请先点击「取消安装」，等待取消完成后再关闭窗口。", "GPT-SoVITS-Studio", MessageBoxButtons.OK, MessageBoxIcon.Information);
                e.Cancel = true;
                return;
            }
            base.OnFormClosing(e);
        }

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            try { SetProcessDPIAware(); } catch { }
            bool silent = HasArg(args, "/S") || HasArg(args, "/SILENT");
            bool noShortcut = HasArg(args, "/NOSHORTCUT");
            bool launch = HasArg(args, "/LAUNCH");
            string dir = GetArgValue(args, "/DIR=");
            string payload = GetArgValue(args, "/PAYLOAD=");

            SetupOptions options = new SetupOptions();
            options.InstallDir = string.IsNullOrEmpty(dir) ? InstallerEngine.DefaultInstallDir() : dir;
            options.CreateShortcut = !noShortcut;
            options.Launch = launch;
            options.Silent = silent;
            if (!string.IsNullOrEmpty(payload))
            {
                options.PayloadPath = payload;
            }

            Logger.Write("Setup started. Silent=" + silent + " Dir=" + options.InstallDir);

            if (silent)
            {
                try
                {
                    InstallResult result = InstallerEngine.Run(options, null, null);
                    if (options.Launch)
                    {
                        InstallerEngine.LaunchApp(result.AppExe, result.InstallDir);
                    }
                    Logger.Write("Silent install complete.");
                    return 0;
                }
                catch (Exception ex)
                {
                    Logger.Write("Silent install failed: " + ex);
                    return 1;
                }
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                Application.Run(new SetupForm(options));
                return 0;
            }
            catch (Exception ex)
            {
                Logger.Write("Fatal: " + ex);
                MessageBox.Show(ex.Message, "GPT-SoVITS-Studio 安装程序", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        private static bool HasArg(string[] args, string value)
        {
            foreach (string arg in args)
            {
                if (string.Equals(arg, value, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }

        private static string GetArgValue(string[] args, string prefix)
        {
            foreach (string arg in args)
            {
                if (arg.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                {
                    return arg.Substring(prefix.Length).Trim('"');
                }
            }
            return null;
        }

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();
    }
}
