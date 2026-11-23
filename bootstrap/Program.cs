using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace VoxBootstrap {
    public sealed class Asset { public string name; public long size; public string sha256; public string[] urls; }
    public sealed class ComponentChoice { public string id, label; public long size; public int minMemoryMB; public Asset[] files; }
    public sealed class Manifest { public int protocol; public int componentProtocol; public ComponentChoice[] components; public long musicRuntimeSize, musicArchiveSize; public string musicRuntimeVersion; public string releaseId; public string appVersion; public string appReleaseId; public string entry; public Asset package; public Asset[] files; }
    public sealed class Status { public string text; public long done; public long total; }

    public static class Core {
        public static string SafePath(string root, string relative) {
            if (String.IsNullOrEmpty(relative) || relative.Contains("\\") || relative.Contains(":")) throw new IOException("资源路径无效");
            foreach (string part in relative.Split('/'))
                if (part.Length == 0 || part == "." || part == ".." || part.TrimEnd(' ', '.') != part || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                    throw new IOException("资源路径无效：" + relative);
            string basePath = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string result = Path.GetFullPath(Path.Combine(basePath, relative.Replace('/', Path.DirectorySeparatorChar)));
            if (!result.StartsWith(basePath, StringComparison.OrdinalIgnoreCase)) throw new IOException("资源路径越界");
            return result;
        }
        public static string Hash(string file) {
            using (var stream = File.OpenRead(file)) using (var hash = SHA256.Create())
                return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }
        public static bool Verified(string file, Asset asset) {
            return File.Exists(file) && new FileInfo(file).Length == asset.size && Hash(file) == asset.sha256;
        }
        public static void Validate(Manifest manifest) {
            if (manifest.protocol != 1 || manifest.files == null || manifest.files.Length == 0 ||
                !System.Text.RegularExpressions.Regex.IsMatch(manifest.releaseId ?? "", @"^\d{14}$")) throw new IOException("启动器清单无效");
            SafePath(Path.GetTempPath(), manifest.entry);
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (Asset asset in manifest.files.Concat(new[] { manifest.package })) {
                SafePath(Path.GetTempPath(), asset.name);
                if (asset.size < 0 || !System.Text.RegularExpressions.Regex.IsMatch(asset.sha256 ?? "", "^[a-f0-9]{64}$")) throw new IOException("清单校验信息无效");
            }
            foreach (Asset file in manifest.files) {
                if (!names.Add(file.name) || new[] { "data/", "models/", "runtime/" }.Any(p => file.name.StartsWith(p, StringComparison.OrdinalIgnoreCase)))
                    throw new IOException("桌面资源清单包含重复项或用户数据路径");
            }
            if (!names.Contains(manifest.entry) || manifest.package.urls == null || manifest.package.urls.Length == 0 ||
                manifest.package.urls.Any(u => new Uri(u).Scheme != "https")) throw new IOException("启动器下载地址无效");
        }
        public static void Download(Asset asset, string directory, CancellationToken token, IProgress<Status> progress, bool allowHttp = false) {
            Directory.CreateDirectory(directory);
            string target = SafePath(directory, asset.name), part = target + ".part";
            token.ThrowIfCancellationRequested();
            if (Verified(target, asset)) return;
            if (Verified(part, asset)) { token.ThrowIfCancellationRequested(); ReplaceFile(part, target); return; }
            Exception last = null;
            foreach (string url in asset.urls) for (int attempt = 0; attempt < 2; attempt++) {
                token.ThrowIfCancellationRequested();
                try {
                    if (new Uri(url).Scheme != "https" && !allowHttp) throw new IOException("下载地址必须使用 HTTPS");
                    long offset = File.Exists(part) ? new FileInfo(part).Length : 0;
                    if (offset >= asset.size) { File.Delete(part); offset = 0; }
                    var request = (HttpWebRequest)WebRequest.Create(url);
                    request.Timeout = 30000; request.ReadWriteTimeout = 60000; request.UserAgent = "VoxCPM-Studio-Bootstrap";
                    if (offset > 0) request.AddRange(offset);
                    using (token.Register(() => request.Abort()))
                    using (var response = (HttpWebResponse)request.GetResponse()) {
                        if (response.StatusCode == HttpStatusCode.PartialContent) {
                            if (response.Headers["Content-Range"] != "bytes " + offset + "-" + (asset.size - 1) + "/" + asset.size)
                                throw new IOException("服务器续传范围与清单不一致");
                        } else if (response.StatusCode == HttpStatusCode.OK) offset = 0;
                        else throw new IOException("下载返回 HTTP " + (int)response.StatusCode);
                        if (response.ContentLength >= 0 && response.ContentLength != asset.size - offset) throw new IOException("下载大小与清单不一致");
                        using (var input = response.GetResponseStream())
                        using (var output = new FileStream(part, offset > 0 ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.Read)) {
                            byte[] buffer = new byte[256 * 1024]; long done = offset; int count;
                            var timer = Stopwatch.StartNew();
                            while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
                                token.ThrowIfCancellationRequested(); done += count;
                                if (done > asset.size) throw new IOException("下载超过清单大小限制");
                                output.Write(buffer, 0, count);
                                if (timer.ElapsedMilliseconds >= 150) { progress.Report(new Status { text = "正在从魔搭补齐桌面环境", done = done, total = asset.size }); timer.Restart(); }
                            }
                            output.Flush(true);
                        }
                    }
                    token.ThrowIfCancellationRequested();
                    if (!Verified(part, asset)) {
                        if (File.Exists(part) && new FileInfo(part).Length >= asset.size) File.Delete(part);
                        throw new IOException("下载不完整或 SHA-256 校验失败，可继续重试");
                    }
                    ReplaceFile(part, target); return;
                } catch (Exception error) { token.ThrowIfCancellationRequested(); last = error; }
            }
            throw new IOException("魔搭资源下载未完成，已保留下载分片。" + (last == null ? "" : last.Message), last);
        }
        public static void ReplaceFile(string source, string target) {
            if (File.Exists(target)) File.Replace(source, target, null); else File.Move(source, target);
        }
        public static bool DesktopReady(string root, Manifest manifest, CancellationToken token) {
            // 应用自身通过签名更新器升级；原生启动器不能用旧内置包覆盖已经安装的新版。
            string configPath = SafePath(root, "resources/app/update-config.json");
            string packagePath = SafePath(root, "resources/app/package.json");
            if (!String.IsNullOrEmpty(manifest.appReleaseId) && File.Exists(configPath) && File.Exists(packagePath)) {
                var json = new JavaScriptSerializer();
                var config = json.DeserializeObject(File.ReadAllText(configPath)) as Dictionary<string, object>;
                var package = json.DeserializeObject(File.ReadAllText(packagePath)) as Dictionary<string, object>;
                object release, version;
                Version current, original;
                if (config != null && package != null && config.TryGetValue("releaseId", out release) && package.TryGetValue("version", out version) &&
                    System.Text.RegularExpressions.Regex.IsMatch(Convert.ToString(release), @"^\d{14}$") &&
                    Version.TryParse(Convert.ToString(version), out current) && Version.TryParse(manifest.appVersion, out original) &&
                    current >= original && String.CompareOrdinal(Convert.ToString(release), manifest.appReleaseId) > 0) {
                    Asset executable = manifest.files.First(a => a.name == manifest.entry);
                    if (!Verified(SafePath(root, manifest.entry), executable) ||
                        new[] { "resources/app/main.js", "resources/app/preload.js", "resources/app/dist/index.html" }.Any(n => !File.Exists(SafePath(root, n))))
                        throw new IOException("已安装新版工作台的桌面文件不完整，请修复应用更新；已保留新版和用户数据。");
                    return true;
                }
            }
            foreach (Asset file in manifest.files) { token.ThrowIfCancellationRequested(); if (!Verified(SafePath(root, file.name), file)) return false; }
            return true;
        }
        public static void Extract(string archive, string staging, Manifest manifest, CancellationToken token) {
            var expected = manifest.files.ToDictionary(a => a.name, StringComparer.OrdinalIgnoreCase);
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            using (var zip = ZipFile.OpenRead(archive)) {
                foreach (var entry in zip.Entries) {
                    token.ThrowIfCancellationRequested();
                    int slash = entry.FullName.IndexOf('/');
                    if (slash <= 0 || slash == entry.FullName.Length - 1) throw new IOException("桌面压缩包条目无效");
                    string relative = entry.FullName.Substring(slash + 1);
                    string target = SafePath(staging, relative);
                    Asset asset;
                    if (!expected.TryGetValue(relative, out asset) || !seen.Add(relative) || entry.Length != asset.size ||
                        (((entry.ExternalAttributes >> 16) & 0xf000) == 0xa000)) throw new IOException("压缩包文件与内置清单不一致");
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (var input = entry.Open()) using (var output = File.Create(target)) {
                        byte[] buffer = new byte[256 * 1024]; int count; long done = 0;
                        while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
                            token.ThrowIfCancellationRequested(); done += count;
                            if (done > asset.size) throw new IOException("解压大小超过清单");
                            output.Write(buffer, 0, count);
                        }
                    }
                    if (!Verified(target, asset)) throw new IOException("解压文件 SHA-256 校验失败");
                }
            }
            if (seen.Count != expected.Count) throw new IOException("桌面压缩包缺少必要文件");
        }
        public static string Prepare(string root, Manifest manifest, CancellationToken token, IProgress<Status> progress) {
            Validate(manifest); Directory.CreateDirectory(root);
            progress.Report(new Status { text = "正在校验桌面环境" });
            if (!DesktopReady(root, manifest, token)) {
                string executable = SafePath(root, manifest.entry);
                foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(manifest.entry))) {
                    try { if (String.Equals(process.MainModule.FileName, executable, StringComparison.OrdinalIgnoreCase)) throw new IOException("请先关闭工作台，再恢复桌面环境。"); }
                    catch (System.ComponentModel.Win32Exception) { }
                    finally { process.Dispose(); }
                }
                string cache = Path.Combine(root, "data", "cache", "bootstrap");
#if UNIFIED
                string payload=VoxLegacyRepair.Program.PreparePayload(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"VoxCPMStudioRepair","packages"));
                Directory.CreateDirectory(cache);
                string embedded=Path.Combine(payload,"desktop.zip"), cached=SafePath(cache,manifest.package.name);
                if(!Verified(embedded,manifest.package)) throw new IOException("内置安装包校验失败");
                if(!Verified(cached,manifest.package)) File.Copy(embedded,cached,true);
#else
                Download(manifest.package, cache, token, progress);
#endif
                string staging = Path.Combine(root, ".desktop-staging-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(staging);
                try {
                    progress.Report(new Status { text = "正在校验并展开桌面环境" });
                    Extract(SafePath(cache, manifest.package.name), staging, manifest, token);
                    foreach (Asset file in manifest.files) {
                        token.ThrowIfCancellationRequested();
                        string target = SafePath(root, file.name); Directory.CreateDirectory(Path.GetDirectoryName(target));
                        ReplaceFile(SafePath(staging, file.name), target);
                    }
                } finally {
                    // 仅删除本次创建、位于安装目录内的解压暂存目录。
                    if (Path.GetDirectoryName(staging) == Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) &&
                        Path.GetFileName(staging).StartsWith(".desktop-staging-", StringComparison.Ordinal) && Directory.Exists(staging)) Directory.Delete(staging, true);
                }
                if (!DesktopReady(root, manifest, token)) throw new IOException("桌面环境复检失败，请重试");
            }
            token.ThrowIfCancellationRequested();
            return SafePath(root, manifest.entry);
        }
    }

    public sealed class Launcher : Form {
        readonly SoftButton run = new SoftButton { Primary = true }, pause = new SoftButton(), close = new SoftButton(), minimize = new SoftButton();
        readonly SoftButton browse = new SoftButton(), detect = new SoftButton(), theme = new SoftButton();
        readonly Func<string> rootDetector;
        readonly Func<InstallDrive[]> driveSurvey;
        readonly DiskStrip diskPanel;
        readonly ToolTip driveTips = new ToolTip();
        InstallDrive[] drives = new InstallDrive[0];
        Bitmap diskIcon;
        readonly TextBox installPath = new TextBox();
        readonly GlowSwitch desktopShortcut = new GlowSwitch(), startMenuShortcut = new GlowSwitch();
        Bitmap brandMark;
        readonly Manifest manifest;
        readonly bool preview;
        bool dark;
        public bool IsDark { get { return dark; } }
        readonly System.Windows.Forms.Timer animation = new System.Windows.Forms.Timer { Interval = 16 };
        readonly Stopwatch animationClock = new Stopwatch();
        double demoStart;
        CancellationTokenSource cancellation;
        string view = "idle", statusTitle = "一切准备，交给我们。", statusDetail = "选好位置后开始，自动补齐应用、依赖和模型。";
        double fraction, pulse;
        long downloaded, total;
        int installPhase;
        string completedRoot;
        bool destinationBlocked;
        public static GraphicsPath Round(RectangleF r, float radius) { return StudioTheme.Round(r, radius); }
        Color Paper { get { return StudioTheme.Paper(dark); } }
        Color Ink { get { return StudioTheme.Ink(dark); } }
        Color Muted { get { return StudioTheme.Muted(dark); } }
        Color Accent { get { return StudioTheme.Accent(dark); } }
        public Launcher(Manifest value, bool demonstration = false, bool? darkMode = null, Func<string> detectRoot = null, Func<InstallDrive[]> survey = null) {
            manifest = value; preview = demonstration; dark = darkMode ?? false;
            diskPanel=new DiskStrip(dark) { Name="local-disks", TabIndex=0 };
            rootDetector = detectRoot ?? (() => Installer.DefaultRoot(!preview));
            driveSurvey = survey ?? Installer.SurveyDrives;
            Text = "JVOX Studio配音系统" + (preview ? " · 安装演示" : " 安装程序"); ClientSize = new Size(720, 830);
            AutoScaleMode = AutoScaleMode.None; Font = new Font("Microsoft YaHei UI", 10); BackColor = Paper;
            StartPosition = FormStartPosition.CenterScreen; FormBorderStyle = FormBorderStyle.None; DoubleBuffered = true;
            AccessibleName = "JVOX Studio配音系统 启动器"; MaximizeBox = false;
            run.Text = "安装并运行  →"; run.AccessibleName = "安装并准备工作台"; run.TabIndex = 3;
            pause.Text = "暂停"; pause.AccessibleName = "暂停准备"; pause.Visible = false; pause.TabIndex = 1;
            close.Text = "×"; close.Name="close"; close.Glyph=ButtonGlyph.Close; close.AccessibleName = "关闭启动器"; close.TabIndex = 3;
            minimize.Text = "−"; minimize.Name="minimize"; minimize.Glyph=ButtonGlyph.Minimize; minimize.AccessibleName = "最小化"; minimize.TabIndex = 2;
            theme.Name="theme"; theme.Glyph=dark?ButtonGlyph.Sun:ButtonGlyph.Moon; theme.AccessibleName=dark?"切换浅色主题":"切换深色主题"; theme.TabIndex=5;
            driveTips.SetToolTip(theme,theme.AccessibleName);
            theme.Click+=(sender,args)=>ApplyTheme(!dark);
            foreach (var button in new[] { run, pause, close, minimize, browse, detect, theme }) { button.Dark = dark; button.BackColor = Paper; Controls.Add(button); }
            run.Name = "install"; detect.Name = "detect"; installPath.Name = "destination";
            installPath.BorderStyle = BorderStyle.None; installPath.BackColor = Paper; installPath.ForeColor = Ink;
            installPath.AccessibleName = "安装目录"; installPath.TabIndex = 0;
            browse.Text = "更改"; browse.AccessibleName = "选择安装目录"; browse.TabIndex = 1;
            detect.Text = "重新检测"; detect.AccessibleName = "重新检测分区空间和权限"; detect.TabIndex = 4;
            detect.Click += (sender, args) => DetectDestination();
            installPath.TextChanged += (sender, args) => {
                if (cancellation != null || completedRoot != null) return;
                if (!String.IsNullOrWhiteSpace(installPath.Text)) { destinationBlocked = false; SetPreview("idle", 0); }
                run.Enabled = !String.IsNullOrWhiteSpace(installPath.Text);
                SyncDriveSelection();
            };
            desktopShortcut.Name="desktop-shortcut"; desktopShortcut.Text = "创建桌面快捷方式"; desktopShortcut.Dark=dark; desktopShortcut.Checked = true; desktopShortcut.BackColor = Paper; desktopShortcut.TabIndex = 2;
            startMenuShortcut.Name="start-menu-shortcut"; startMenuShortcut.Text = "添加到开始菜单"; startMenuShortcut.Dark=dark; startMenuShortcut.Checked = true; startMenuShortcut.BackColor = Paper; startMenuShortcut.TabIndex = 2;
            Controls.AddRange(new Control[] { installPath, desktopShortcut, startMenuShortcut });
            diskPanel.BackColor = Paper; Controls.Add(diskPanel);
            browse.Click += (sender, args) => {
                using (var picker = new FolderBrowserDialog { Description = "选择安装位置，将在其中创建专用 JVOXStudio 文件夹", ShowNewFolderButton = true }) {
                    if (Directory.Exists(installPath.Text)) picker.SelectedPath = installPath.Text;
                    if (picker.ShowDialog(this) == DialogResult.OK) installPath.Text = Path.GetFileName(picker.SelectedPath).Equals("JVOXStudio", StringComparison.OrdinalIgnoreCase) ? picker.SelectedPath : Path.Combine(picker.SelectedPath, "JVOXStudio");
                }
            };
            try {
                using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("app-mark.png")) if (stream != null) using (var image = Image.FromStream(stream)) brandMark = new Bitmap(image);
                using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("installer.ico")) if (stream != null) Icon = new Icon(stream);
                using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("disk-local.png")) if (stream != null) using (var image = Image.FromStream(stream)) diskIcon = new Bitmap(image);
            } catch { }
            run.Click += async (sender, args) => {
                if (preview) StartDemo();
                else if (completedRoot != null) { OpenWorkspace(completedRoot); Close(); }
                else try { await Start(); } catch (Exception error) { MessageBox.Show(this,error.Message,"组件选择未完成",MessageBoxButtons.OK,MessageBoxIcon.Warning); }
            };
            pause.Click += (sender, args) => { if (preview) SetPreview("paused", fraction); else if (cancellation != null) cancellation.Cancel(); };
            close.Click += (sender, args) => Close(); minimize.Click += (sender, args) => WindowState = FormWindowState.Minimized;
            AcceptButton = run; CancelButton = pause;
            animation.Tick += (sender, args) => {
                double time = animationClock.Elapsed.TotalSeconds;
                double phase = (time % 2.8) / 1.4; pulse = BezierMotion.Ease(phase < 1 ? phase : 2-phase);
                if (preview && view == "downloading") {
                    fraction = demoStart + (1-demoStart)*BezierMotion.Ease(time / 8); downloaded = (long)(fraction * 111063687); total = 111063687;
                    installPhase = fraction > .55 ? 1 : 0;
                    if (time >= 8) SetPreview("ready", 1);
                }
                Invalidate();
            };
            FormClosing += (sender, args) => { animation.Stop(); if (cancellation != null) cancellation.Cancel(); };
            Resize += (sender, args) => LayoutButtons(); LayoutButtons(); DetectDestination();
        }
        void ApplyTheme(bool value) {
            dark=value; BackColor=Paper;
            foreach(var button in new[] { run,pause,close,minimize,browse,detect,theme }) { button.Dark=dark; button.BackColor=Paper; button.Invalidate(); }
            theme.Glyph=dark?ButtonGlyph.Sun:ButtonGlyph.Moon; theme.AccessibleName=dark?"切换浅色主题":"切换深色主题";
            driveTips.SetToolTip(theme,theme.AccessibleName);
            installPath.BackColor=Paper; installPath.ForeColor=Ink;
            desktopShortcut.Dark=dark; desktopShortcut.BackColor=Paper; desktopShortcut.Invalidate();
            startMenuShortcut.Dark=dark; startMenuShortcut.BackColor=Paper; startMenuShortcut.Invalidate();
            diskPanel.SetTheme(dark);
            Invalidate();
        }
        void DetectDestination() {
            drives = driveSurvey();
            try { installPath.Text = rootDetector(); destinationBlocked = false; SetPreview("idle", 0); }
            catch (Exception error) {
                installPath.Clear(); destinationBlocked = true; view = "error"; fraction = 0; total = 0;
                string[] lines = error.Message.Split(new[] { '\n' }, 2);
                statusTitle = lines[0]; statusDetail = lines.Length > 1 ? lines[1] : "请调整安装位置或分区条件后重新检测。";
                run.Enabled = false; pause.Visible = false; animation.Stop();
                AccessibleDescription = error.Message; Invalidate();
            }
            BuildDriveCards();
        }
        void BuildDriveCards() {
            diskPanel.SuspendLayout();
            while (diskPanel.Controls.Count > 0) { var old = diskPanel.Controls[0]; diskPanel.Controls.RemoveAt(0); old.Dispose(); }
            int width = drives.Length > 4 ? 150 : (636 - Math.Max(0, drives.Length-1)*12) / Math.Max(1, drives.Length);
            foreach (var drive in drives) {
                string problem = Installer.DriveProblem(drive, drives);
                bool current = false;
                try { current = !String.IsNullOrWhiteSpace(installPath.Text) && String.Equals(Path.GetPathRoot(installPath.Text), drive.root, StringComparison.OrdinalIgnoreCase) && File.Exists(Path.Combine(installPath.Text, Installer.Marker)) && Installer.ReadState(installPath.Text).state != "uninstalled"; } catch { }
                string space = drive.ready ? (drive.free / 1073741824.0).ToString("0.#") + " GiB 可用" : "暂不可用";
                string detail = current ? "继续安装 · " + space : problem == null ? space : !drive.ready ? "暂不可用" : drive.root.StartsWith("C:", StringComparison.OrdinalIgnoreCase) && drives.Length > 1 ? "系统盘 · 优先其他分区" : "空间不足 · " + space;
                string resumableRoot = current ? installPath.Text : null;
                var card = new DiskCard(drive, diskIcon, dark, detail) { Size = new Size(width,132), Margin = new Padding(0,0,drive == drives.Last() ? 0 : 12,0), Enabled = current || problem == null };
                string folderHint = drive.root.StartsWith("C:",StringComparison.OrdinalIgnoreCase) ? "点击选择，应用将安装到无需提权的用户目录" : "点击选择，应用将安装到 Program Files\\JVOXStudio";
                driveTips.SetToolTip(card, drive.root + "\n" + space + "\n" + (current ? "继续当前安装" : problem ?? folderHint));
                card.Click += (sender, args) => {
                    try {
                        installPath.Text = resumableRoot ?? Installer.RootOnDrive(card.Drive, drives, !preview);
                        destinationBlocked = false; SetPreview("idle",0); SyncDriveSelection();
                    } catch (Exception error) {
                        view = "error"; statusTitle = "这个磁盘暂时无法安装。"; statusDetail = error.Message;
                        AccessibleDescription = statusTitle + statusDetail; Invalidate();
                    }
                };
                diskPanel.Controls.Add(card);
            }
            diskPanel.ResumeLayout(); SyncDriveSelection();
        }
        void SyncDriveSelection() {
            string root = null;
            try { if (!String.IsNullOrWhiteSpace(installPath.Text)) root = Path.GetPathRoot(Path.GetFullPath(installPath.Text)); } catch { }
            foreach (DiskCard card in diskPanel.Controls) {
                bool selected = String.Equals(root,card.Drive.root,StringComparison.OrdinalIgnoreCase);
                if (card.Selected != selected) card.SetSelected(selected);
            }
        }
        protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ClassStyle |= 0x20000; return p; } }
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool ReleaseCapture();
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
        protected override void OnMouseDown(MouseEventArgs e) {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Left && e.Y < Height * .16 && e.X < Width * .82) { ReleaseCapture(); SendMessage(Handle, 0xA1, new IntPtr(2), IntPtr.Zero); }
        }
        void LayoutButtons() {
            // 最小化会产生零尺寸 Resize；保留上次布局，恢复窗口时再更新。
            if (WindowState == FormWindowState.Minimized || ClientSize.Width <= 0 || ClientSize.Height <= 0) return;
            float sx = ClientSize.Width / 720f, sy = ClientSize.Height / 830f;
            run.SetBounds((int)(498 * sx), (int)(764 * sy), (int)(180 * sx), (int)(46 * sy));
            pause.SetBounds((int)(392 * sx), (int)(764 * sy), (int)(92 * sx), (int)(46 * sy));
            detect.SetBounds((int)(44 * sx), (int)(764 * sy), (int)(120 * sx), (int)(46 * sy));
            diskPanel.SetBounds((int)(42*sx),(int)(262*sy),(int)(636*sx),(int)(150*sy));
            installPath.SetBounds((int)(59 * sx), (int)(444 * sy), (int)(507 * sx), (int)(23 * sy));
            browse.SetBounds((int)(588 * sx), (int)(436 * sy), (int)(80 * sx), (int)(35 * sy));
            desktopShortcut.SetBounds((int)(42 * sx), (int)(482 * sy), (int)(256 * sx), (int)(46 * sy));
            startMenuShortcut.SetBounds((int)(310 * sx), (int)(482 * sy), (int)(256 * sx), (int)(46 * sy));
            close.SetBounds((int)(666 * sx), (int)(27 * sy), (int)(28 * sx), (int)(28 * sy));
            minimize.SetBounds((int)(630 * sx), (int)(27 * sy), (int)(28 * sx), (int)(28 * sy));
            theme.SetBounds((int)(594 * sx), (int)(27 * sy), (int)(28 * sx), (int)(28 * sy));
            using (var shape = Round(new RectangleF(0, 0, ClientSize.Width, ClientSize.Height), 22)) { var old = Region; Region = new Region(shape); if (old != null) old.Dispose(); }
            Invalidate();
        }
        void TextAt(Graphics g, string text, float size, Color color, float x, float y, float width, bool bold = false) {
            using (var font = new Font("Microsoft YaHei UI", size, bold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel))
            using (var brush = new SolidBrush(color)) g.DrawString(text, font, brush, new RectangleF(x, y, width, size * 2.7f));
        }
        protected override void OnPaint(PaintEventArgs e) {
            base.OnPaint(e);
            if (WindowState == FormWindowState.Minimized || ClientSize.Width <= 0 || ClientSize.Height <= 0) return;
            var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            g.ScaleTransform(ClientSize.Width / 720f, ClientSize.Height / 830f);
            using (var shape = Round(new RectangleF(0.5f, .5f, 719, 829), 22)) using (var border = new Pen(StudioTheme.Border(dark))) g.DrawPath(border, shape);
            if (brandMark != null) g.DrawImage(brandMark, new Rectangle(36, 28, 50, 50));
            else TextAt(g, "V", 28, Accent, 48, 36, 32, true);
            TextAt(g, "JVOX", 14, Ink, 92, 35, 160, true); TextAt(g, "Studio配音系统", 10, Muted, 93, 57, 140);
            TextAt(g, "本地 AI 配音工作台", 11, Muted, 438, 43, 140);
            TextAt(g, "好声音，从这里开始。", 31, Ink, 40, 133, 420);
            TextAt(g, "选择安装位置，剩下的交给我们。", 14, Muted, 43, 183, 400);
            // 波形用向量绘制，不携带图片或网页运行时。
            using (var pen = new Pen(dark ? Color.FromArgb(48, 52, 46) : Color.FromArgb(234, 232, 221), 1)) { g.DrawEllipse(pen, 470, 109, 150, 150); g.DrawEllipse(pen, 493, 132, 104, 104); }
            for (int i = 0; i < 37; i++) {
                double envelope = Math.Pow(Math.Sin((i + 1) * Math.PI / 38), 1.8);
                float h = (float)(8 + envelope * (20 + 42 * Math.Abs(Math.Sin(i * .69)) * ((view == "working" || view == "downloading") ? .6 + pulse*.4 : 1)));
                float x = 444 + i * 5.7f;
                using (var pen = new Pen(i > 14 && i < 24 ? Accent : (dark ? Color.FromArgb(115, 120, 108) : Color.FromArgb(181, 186, 171)), 2.8f)) { pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round; g.DrawLine(pen, x, 184 - h / 2, x, 184 + h / 2); }
            }
            TextAt(g, "安装位置", 12, Muted, 43, 240, 130);
            TextAt(g, "非 C 盘优先 · 至少 25 GiB", 11, Muted, 480, 242, 210);
            TextAt(g, "安装到专用应用文件夹", 11, Muted, 44, 411, 400);
            using (var shape = Round(new RectangleF(42, 430, 636, 48), 12)) using (var pen = new Pen(dark ? Color.FromArgb(65, 70, 60) : Color.FromArgb(218, 222, 209))) g.DrawPath(pen, shape);
            g.TranslateTransform(0, 280);
            using (var shape = Round(new RectangleF(42, 268, 636, 144), 18)) using (var brush = new SolidBrush(StudioTheme.Card(dark))) g.FillPath(brush, shape);
            var textLayout=PreparationTextLayout.Measure(g,statusTitle,destinationBlocked || view=="error");
            DrawStatusText(g,statusTitle,textLayout.TitleSize,Ink,textLayout.Title,true);
            string amount = destinationBlocked ? "需处理" : total > 0 ? Math.Round(fraction * 100) + "%" : (view == "idle" ? "等待开始" : view == "ready" ? "已就绪" : view == "paused" ? "已暂停" : "准备中");
            DrawStatusText(g,amount,12,Muted,textLayout.Percent,false);
            if (destinationBlocked || view == "error") {
                DrawStatusText(g,statusDetail,12,Muted,textLayout.Detail,false);
            } else {
            DrawStatusText(g,statusDetail,12,Muted,textLayout.Detail,false);
            using (var shape = Round(textLayout.Bar, 2.5f)) using (var brush = new SolidBrush(StudioTheme.Track(dark))) g.FillPath(brush, shape);
            float filled = (float)(594 * fraction);
            if (filled > 2) using (var shape = Round(new RectangleF(textLayout.Bar.X,textLayout.Bar.Y,filled,5), 2.5f)) using (var brush = new SolidBrush(Accent)) g.FillPath(brush, shape);
            if (total == 0 && view == "working") using (var brush = new SolidBrush(Accent)) g.FillRectangle(brush,textLayout.Bar.X+(float)(pulse*464),textLayout.Bar.Y,130,5);
            DrawStatusText(g,total > 0 ? String.Format("{0:F1} MB / {1:F1} MB", downloaded / 1048576.0, total / 1048576.0) : "首次联网准备 · 已有资源自动复用",10,Muted,textLayout.Footnote,false);
            }
            string[] steps = { "安装应用", "准备环境", "完成安装" };
            for (int i = 0; i < 3; i++) {
                int x = 44 + i * 211; bool active = i == installPhase;
                using (var brush = new SolidBrush(active ? Accent : (dark ? Color.FromArgb(58, 62, 53) : Color.FromArgb(232, 234, 225)))) g.FillEllipse(brush, x, 422, 20, 20);
                TextAt(g, i < installPhase ? "✓" : (i + 1).ToString(), 10, active ? Paper : Muted, x + 5, 425, 20);
                TextAt(g, steps[i], 11, active ? Ink : Muted, x + 29, 424, 125);
                if (i < 2) using (var pen = new Pen(dark ? Color.FromArgb(55, 60, 49) : Color.FromArgb(226, 229, 217))) g.DrawLine(pen, x + 126, 432, x + 190, 432);
            }
            using (var brush = new SolidBrush(Accent)) g.FillEllipse(brush, 44, 455, 5, 5);
            TextAt(g, preview ? "安装演示 · 不会下载或修改系统" : "当前用户安装 · 无需管理员权限", 11, Muted, 56, 449, 325);
        }
        static void DrawStatusText(Graphics graphics,string text,float size,Color color,RectangleF bounds,bool bold) {
            var state=graphics.Save(); graphics.SetClip(bounds);
            using(var font=new Font("Microsoft YaHei UI",size,bold?FontStyle.Bold:FontStyle.Regular,GraphicsUnit.Pixel))
            using(var brush=new SolidBrush(color))
            using(var format=new StringFormat { Trimming=StringTrimming.EllipsisWord,FormatFlags=StringFormatFlags.LineLimit })
                graphics.DrawString(text,font,brush,bounds,format);
            graphics.Restore(state);
        }
        public void SetPreparationProgress(Status status,int phase) {
            installPhase=phase; statusTitle=status.text;
            statusDetail=phase==0?"正在安装应用，下载内容会自动保存。":"正在补齐依赖和模型，完成后自动登记安装。";
            downloaded=status.done; total=status.total;
            if(total>0) fraction=Math.Max(0,Math.Min(1,(double)downloaded/total));
            AccessibleDescription=statusTitle+statusDetail; Invalidate();
        }
        public void SetPreview(string state, double value) {
            view = state; fraction = Math.Max(0, Math.Min(1, value)); downloaded = (long)(fraction * 111063687); total = state == "idle" ? 0 : 111063687;
            if (state == "idle") { installPhase = 0; statusTitle = "一切准备，交给我们。"; statusDetail = "选好位置后开始，自动补齐应用、依赖和模型。"; run.Text = "安装并运行  →"; }
            else if (state == "paused") { statusTitle = "稍作停留，进度还在。"; statusDetail = "已保留下载内容，随时可以继续。"; run.Text = "继续准备  →"; }
            else if (state == "ready") { installPhase = 2; statusTitle = "安装完成，开始创作。"; statusDetail = "已准备运行环境，并按你的选择创建快捷方式。"; run.Text = preview ? "重新演示  ↻" : "开始创作  →"; }
            else { statusTitle = "正在准备你的创作空间。"; statusDetail = "从魔搭补齐桌面环境，完成后自动打开工作台。"; run.Text = "正在准备…"; }
            run.Enabled = state != "downloading" && state != "working"; pause.Visible = state == "downloading" || state == "working";
            if (state == "downloading" || state == "working") { animationClock.Restart(); animation.Start(); } else { animation.Stop(); animationClock.Stop(); }
            AccessibleDescription = statusTitle + statusDetail; Invalidate();
        }
        void StartDemo() { if (view == "ready") fraction = 0; demoStart = fraction; installPhase = fraction > .55 ? 1 : 0; SetPreview("downloading", fraction); }
        static void OpenWorkspace(string root) {
            var start = new ProcessStartInfo(Brand.ExecutablePath(root), "--voxcpm-run --voxcpm-show") { WorkingDirectory = root, UseShellExecute = false };
            start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE"); start.EnvironmentVariables["VOXCPM_DATA_ROOT"] = Path.Combine(root, "data"); Process.Start(start);
        }
        async Task Start() {
#if UNIFIED
            if(VoxLegacyRepair.Program.NeedsMaintenance(installPath.Text.Trim())) {
                string maintenanceRoot=installPath.Text.Trim(); Hide();
                try { VoxLegacyRepair.Program.Maintain(maintenanceRoot); } finally { Close(); }
                return;
            }
#endif
            ComponentSelection selection = null;
            if (manifest.componentProtocol >= 2) {
                int memory = await Task.Run(() => ComponentPicker.GpuMemory());
                using (var picker = new ComponentPicker(manifest, installPath.Text.Trim(), memory, dark)) {
                    if (picker.ShowDialog(this) != DialogResult.OK) return;
                    selection = picker.Selection;
                }
            }
            SetPreview("working", fraction); total = 0; cancellation = new CancellationTokenSource();
            string root = installPath.Text.Trim(); Process child = null; FileStream lease = null; bool complete = false, owned = false;
            installPath.Enabled = browse.Enabled = detect.Enabled = diskPanel.Enabled = desktopShortcut.Enabled = startMenuShortcut.Enabled = false;
            var reporter = new Progress<Status>(status => {
                if (IsDisposed) return;
                SetPreparationProgress(status,installPhase);
            });
            try {
                root = Installer.Canonical(root); installPath.Text = root;
                Installer.ValidateDestinationCapacity(root);
                if (selection != null) ComponentPicker.ValidateCapacity(root, selection, manifest);
                lease = Installer.AcquireRoot(root);
                Installer.Begin(root, manifest, lockHeld: true);
                if (selection != null) ComponentPicker.Save(root, selection);
                owned = true;
                await Task.Run(() => Installer.InstallUninstaller(root));
                await Task.Run(() => Core.Prepare(root, manifest, cancellation.Token, reporter));
                Installer.ExtractResource("app.ico", Path.Combine(root, "voxcpm.ico"));
                Installer.ExtractResource("installer.ico", Path.Combine(root, "voxcpm-installer.ico"));
                installPhase = 1; fraction = 0; total = 0; Invalidate();
                string session = Guid.NewGuid().ToString("N"), report = Path.Combine(root, "data", "cache", "install", session + ".json");
                Directory.CreateDirectory(Path.GetDirectoryName(report));
                child = Installer.StartPreparation(root, report, session);
                await Installer.WaitForReady(root, report, session, child, cancellation.Token, reporter, manifest.componentProtocol >= 2);
                Installer.Complete(root, manifest, desktopShortcut.Checked, startMenuShortcut.Checked, readyReport: report, session: session);
                complete = true; completedRoot = root; SetPreview("ready", 1); run.Enabled = false; await Task.Delay(350, cancellation.Token);
                cancellation.Token.ThrowIfCancellationRequested();
                OpenWorkspace(root); Close();
            } catch (OperationCanceledException) { if (!IsDisposed) SetPreview("paused", fraction); }
            catch (Exception error) {
                if (!IsDisposed) { view = "error"; statusTitle = "暂时未能完成准备。"; statusDetail = error.Message; animation.Stop(); run.Text = "重试  →"; Invalidate(); }
                if (owned) try { File.AppendAllText(Path.Combine(root, "bootstrap.log"), DateTimeOffset.Now + " " + error + Environment.NewLine); } catch { }
            } finally {
                if (!complete) Installer.StopChild(child);
                if (child != null) child.Dispose();
                if (lease != null) lease.Dispose();
                cancellation.Dispose(); cancellation = null;
                if (!IsDisposed) { run.Enabled = !String.IsNullOrWhiteSpace(installPath.Text); pause.Visible = false; installPath.Enabled = browse.Enabled = detect.Enabled = diskPanel.Enabled = desktopShortcut.Enabled = startMenuShortcut.Enabled = !complete; }
            }
        }
        protected override void Dispose(bool disposing) { if (disposing) { animation.Dispose(); driveTips.Dispose(); if (brandMark != null) brandMark.Dispose(); if (diskIcon != null) diskIcon.Dispose(); } base.Dispose(disposing); }
    }
    public static class Program {
        [STAThread] public static void Main(string[] args) {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            try {
                if (Installer.RouteUninstall(args)) return;
                Manifest manifest;
                using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("bootstrap-manifest.json"))
                using (var reader = new StreamReader(stream)) manifest = new JavaScriptSerializer().Deserialize<Manifest>(reader.ReadToEnd());
                Core.Validate(manifest);
#if UNIFIED
                string specified=null, report=null; bool exit=args.Contains("--exit-on-complete");
                for(int i=0;i<args.Length;i++) {
                    if(args[i]=="--root" && i+1<args.Length) specified=args[++i];
                    else if(args[i]=="--report" && i+1<args.Length) report=args[++i];
                    else if(args[i]!="--exit-on-complete" && args[i]!="--demo") throw new ArgumentException("不支持的参数："+args[i]);
                }
                string existing=specified ?? VoxLegacyRepair.Program.UnifiedRoot();
                if(!args.Contains("--demo") && VoxLegacyRepair.Program.NeedsMaintenance(existing)) {
                    using(var maintenanceMutex=new Mutex(false,"Local\\VoxCPMStudioLegacyRepair")) {
                        bool owns=false; try { try {owns=maintenanceMutex.WaitOne(0);} catch(AbandonedMutexException){owns=true;}
                            if(!owns) throw new IOException("另一个检查或修复正在运行，请查看已有窗口。");
                            VoxLegacyRepair.Program.Maintain(existing,report,exit);
                        } finally {if(owns) maintenanceMutex.ReleaseMutex();}
                    }
                    return;
                }
#endif
                string identity;
                using (var hash = SHA256.Create()) identity = BitConverter.ToString(hash.ComputeHash(System.Text.Encoding.UTF8.GetBytes(AppDomain.CurrentDomain.BaseDirectory.ToUpperInvariant()))).Replace("-", "");
                using (var mutex = new Mutex(false, "Local\\VoxCPM-Bootstrap-" + identity)) {
                    if (!mutex.WaitOne(0)) { MessageBox.Show("启动器已在运行，请查看已有窗口。", "JVOX Studio配音系统"); return; }
                    bool demo = args.Contains("--demo");
#if DEMO
                    demo = true;
#endif
                    try { Application.Run(new Launcher(manifest, demo
#if UNIFIED
                        ,detectRoot: specified==null ? (Func<string>)null : (() => specified)
#endif
                        )); } finally { mutex.ReleaseMutex(); }
                }
            } catch (Exception error) { MessageBox.Show(error.Message, "JVOX Studio配音系统 启动未完成", MessageBoxButtons.OK, MessageBoxIcon.Error); Environment.ExitCode = 1; }
        }
    }
}
