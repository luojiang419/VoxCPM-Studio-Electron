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
    public sealed class Manifest { public int protocol; public string releaseId; public string appVersion; public string appReleaseId; public string entry; public Asset package; public Asset[] files; }
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
                Download(manifest.package, cache, token, progress);
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

    public sealed class SoftButton : Button {
        public bool Primary, Dark;
        bool hovering;
        public SoftButton() {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
            FlatStyle = FlatStyle.Flat; FlatAppearance.BorderSize = 0; Cursor = Cursors.Hand;
            Font = new Font("Microsoft YaHei UI", 10); UseVisualStyleBackColor = false;
        }
        protected override void OnMouseEnter(EventArgs e) { hovering = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hovering = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnPaint(PaintEventArgs e) {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Color surface = Primary ? (Dark ? Color.FromArgb(236, 232, 224) : Color.FromArgb(40, 42, 39)) : (Dark ? Color.FromArgb(43, 44, 41) : Color.FromArgb(242, 241, 236));
            if (hovering && Enabled) surface = Primary ? (Dark ? Color.White : Color.FromArgb(66, 67, 61)) : (Dark ? Color.FromArgb(55, 56, 51) : Color.FromArgb(233, 231, 224));
            using (var shape = Launcher.Round(new RectangleF(0, 0, Width - 1, Height - 1), 12)) using (var fill = new SolidBrush(surface)) e.Graphics.FillPath(fill, shape);
            Color ink = Primary ? (Dark ? Color.FromArgb(35, 36, 33) : Color.White) : (Dark ? Color.FromArgb(217, 216, 207) : Color.FromArgb(83, 85, 78));
            if (!Enabled) ink = Color.FromArgb(146, 146, 136);
            TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, ink, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            if (Focused && ShowFocusCues) ControlPaint.DrawFocusRectangle(e.Graphics, Rectangle.Inflate(ClientRectangle, -5, -5), ink, surface);
        }
    }

    public sealed class Launcher : Form {
        readonly SoftButton run = new SoftButton { Primary = true }, pause = new SoftButton(), close = new SoftButton(), minimize = new SoftButton();
        readonly Manifest manifest;
        readonly bool preview, dark;
        readonly System.Windows.Forms.Timer animation = new System.Windows.Forms.Timer { Interval = 70 };
        CancellationTokenSource cancellation;
        string view = "idle", statusTitle = "一切准备，交给我们。", statusDetail = "点击运行，自动从魔搭准备桌面环境。";
        double fraction, pulse;
        long downloaded, total;
        public static GraphicsPath Round(RectangleF r, float radius) {
            var p = new GraphicsPath(); float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
            p.AddArc(r.X, r.Y, d, d, 180, 90); p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90); p.AddArc(r.X, r.Bottom - d, d, d, 90, 90); p.CloseFigure(); return p;
        }
        static bool SystemDark() {
            try { using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")) return key != null && Convert.ToInt32(key.GetValue("AppsUseLightTheme", 1)) == 0; }
            catch { return false; }
        }
        Color Paper { get { return dark ? Color.FromArgb(29, 31, 29) : Color.FromArgb(251, 250, 247); } }
        Color Ink { get { return dark ? Color.FromArgb(235, 233, 225) : Color.FromArgb(40, 43, 39); } }
        Color Muted { get { return dark ? Color.FromArgb(158, 161, 150) : Color.FromArgb(124, 128, 116); } }
        Color Accent { get { return dark ? Color.FromArgb(218, 166, 121) : Color.FromArgb(181, 123, 83); } }
        public Launcher(Manifest value, bool demonstration = false, bool? darkMode = null) {
            manifest = value; preview = demonstration; dark = darkMode ?? SystemDark();
            Text = "VoxCPM Studio" + (preview ? " · 界面演示" : " 启动器"); ClientSize = new Size(720, 540);
            AutoScaleMode = AutoScaleMode.None; Font = new Font("Microsoft YaHei UI", 10); BackColor = Paper;
            StartPosition = FormStartPosition.CenterScreen; FormBorderStyle = FormBorderStyle.None; DoubleBuffered = true;
            AccessibleName = "VoxCPM Studio 启动器"; MaximizeBox = false;
            run.Text = "运行  →"; run.AccessibleName = "运行并准备工作台"; run.TabIndex = 0;
            pause.Text = "暂停"; pause.AccessibleName = "暂停准备"; pause.Visible = false; pause.TabIndex = 1;
            close.Text = "×"; close.AccessibleName = "关闭启动器"; close.TabIndex = 3;
            minimize.Text = "−"; minimize.AccessibleName = "最小化"; minimize.TabIndex = 2;
            foreach (var button in new[] { run, pause, close, minimize }) { button.Dark = dark; button.BackColor = Paper; Controls.Add(button); }
            run.Click += async (sender, args) => { if (preview) StartDemo(); else await Start(); };
            pause.Click += (sender, args) => { if (preview) SetPreview("paused", fraction); else if (cancellation != null) cancellation.Cancel(); };
            close.Click += (sender, args) => Close(); minimize.Click += (sender, args) => WindowState = FormWindowState.Minimized;
            AcceptButton = run; CancelButton = pause;
            animation.Tick += (sender, args) => {
                pulse += .075;
                if (preview && view == "downloading") {
                    fraction = Math.Min(1, fraction + .009); downloaded = (long)(fraction * 111063687); total = 111063687;
                    if (fraction >= 1) SetPreview("ready", 1);
                }
                Invalidate();
            };
            FormClosing += (sender, args) => { animation.Stop(); if (cancellation != null) cancellation.Cancel(); };
            Resize += (sender, args) => LayoutButtons(); LayoutButtons();
        }
        protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ClassStyle |= 0x20000; return p; } }
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool ReleaseCapture();
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
        protected override void OnMouseDown(MouseEventArgs e) {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Left && e.Y < Height * .16 && e.X < Width * .82) { ReleaseCapture(); SendMessage(Handle, 0xA1, new IntPtr(2), IntPtr.Zero); }
        }
        void LayoutButtons() {
            float sx = ClientSize.Width / 720f, sy = ClientSize.Height / 540f;
            run.SetBounds((int)(510 * sx), (int)(472 * sy), (int)(168 * sx), (int)(46 * sy));
            pause.SetBounds((int)(404 * sx), (int)(472 * sy), (int)(92 * sx), (int)(46 * sy));
            close.SetBounds((int)(666 * sx), (int)(27 * sy), (int)(28 * sx), (int)(28 * sy));
            minimize.SetBounds((int)(630 * sx), (int)(27 * sy), (int)(28 * sx), (int)(28 * sy));
            using (var shape = Round(new RectangleF(0, 0, ClientSize.Width, ClientSize.Height), 22)) { var old = Region; Region = new Region(shape); if (old != null) old.Dispose(); }
            Invalidate();
        }
        void TextAt(Graphics g, string text, float size, Color color, float x, float y, float width, bool bold = false) {
            using (var font = new Font("Microsoft YaHei UI", size, bold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel))
            using (var brush = new SolidBrush(color)) g.DrawString(text, font, brush, new RectangleF(x, y, width, size * 2.7f));
        }
        protected override void OnPaint(PaintEventArgs e) {
            base.OnPaint(e); var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            g.ScaleTransform(ClientSize.Width / 720f, ClientSize.Height / 540f);
            using (var shape = Round(new RectangleF(0.5f, .5f, 719, 539), 22)) using (var border = new Pen(dark ? Color.FromArgb(58, 61, 55) : Color.FromArgb(224, 225, 216))) g.DrawPath(border, shape);
            using (var shape = Round(new RectangleF(42, 34, 38, 38), 12)) using (var brush = new SolidBrush(Ink)) g.FillPath(brush, shape);
            TextAt(g, "V", 26, Paper, 49, 36, 30, true);
            using (var brush = new SolidBrush(Accent)) g.FillEllipse(brush, 69, 41, 5, 5);
            TextAt(g, "VOXCPM", 14, Ink, 92, 35, 160, true); TextAt(g, "STUDIO", 10, Muted, 93, 57, 140);
            TextAt(g, "本地 AI 配音工作台", 11, Muted, 475, 43, 150);
            TextAt(g, "好声音，从这里开始。", 31, Ink, 40, 133, 420);
            TextAt(g, "让灵感发声，让准备更简单。", 14, Muted, 43, 183, 400);
            // 波形用向量绘制，不携带图片或网页运行时。
            using (var pen = new Pen(dark ? Color.FromArgb(48, 52, 46) : Color.FromArgb(234, 232, 221), 1)) { g.DrawEllipse(pen, 470, 109, 150, 150); g.DrawEllipse(pen, 493, 132, 104, 104); }
            for (int i = 0; i < 37; i++) {
                double envelope = Math.Pow(Math.Sin((i + 1) * Math.PI / 38), 1.8);
                float h = (float)(8 + envelope * (20 + 42 * Math.Abs(Math.Sin(i * .69 + ((view == "working" || view == "downloading") ? pulse : 0)))));
                float x = 444 + i * 5.7f;
                using (var pen = new Pen(i > 14 && i < 24 ? Accent : (dark ? Color.FromArgb(115, 120, 108) : Color.FromArgb(181, 186, 171)), 2.8f)) { pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round; g.DrawLine(pen, x, 184 - h / 2, x, 184 + h / 2); }
            }
            using (var shape = Round(new RectangleF(42, 268, 636, 128), 18)) using (var brush = new SolidBrush(dark ? Color.FromArgb(38, 41, 36) : Color.FromArgb(242, 242, 235))) g.FillPath(brush, shape);
            TextAt(g, statusTitle, 16, Ink, 62, 289, 455, true);
            string amount = total > 0 ? Math.Round(fraction * 100) + "%" : (view == "idle" ? "等待开始" : view == "ready" ? "已就绪" : view == "paused" ? "已暂停" : "准备中");
            TextAt(g, amount, 12, Muted, 596, 292, 70);
            TextAt(g, statusDetail, 12, Muted, 63, 321, 590);
            using (var shape = Round(new RectangleF(63, 361, 594, 5), 2.5f)) using (var brush = new SolidBrush(dark ? Color.FromArgb(61, 66, 55) : Color.FromArgb(223, 226, 213))) g.FillPath(brush, shape);
            float filled = (float)(594 * fraction);
            if (filled > 2) using (var shape = Round(new RectangleF(63, 361, filled, 5), 2.5f)) using (var brush = new SolidBrush(Accent)) g.FillPath(brush, shape);
            if (total == 0 && view == "working") using (var brush = new SolidBrush(Accent)) g.FillRectangle(brush, 63 + (float)((Math.Sin(pulse) + 1) * 232), 361, 130, 5);
            TextAt(g, total > 0 ? String.Format("{0:F1} MB / {1:F1} MB", downloaded / 1048576.0, total / 1048576.0) : "首次联网准备 · 已有资源自动复用", 10, Muted, 63, 376, 570);
            string[] steps = { "桌面环境", "进入工作台", "准备模型" };
            for (int i = 0; i < 3; i++) {
                int x = 44 + i * 211; bool active = view == "ready" ? i == 1 : i == 0;
                using (var brush = new SolidBrush(active ? Accent : (dark ? Color.FromArgb(58, 62, 53) : Color.FromArgb(232, 234, 225)))) g.FillEllipse(brush, x, 422, 20, 20);
                TextAt(g, i == 0 && view == "ready" ? "✓" : (i + 1).ToString(), 10, active ? Paper : Muted, x + 5, 425, 20);
                TextAt(g, steps[i], 11, active ? Ink : Muted, x + 29, 424, 125);
                if (i < 2) using (var pen = new Pen(dark ? Color.FromArgb(55, 60, 49) : Color.FromArgb(226, 229, 217))) g.DrawLine(pen, x + 126, 432, x + 190, 432);
            }
            using (var brush = new SolidBrush(Accent)) g.FillEllipse(brush, 44, 486, 5, 5);
            TextAt(g, preview ? "界面演示 · 不会下载或安装文件" : "魔搭直连 · 下载可暂停，文件会保留", 11, Muted, 56, 480, 345);
        }
        public void SetPreview(string state, double value) {
            view = state; fraction = Math.Max(0, Math.Min(1, value)); downloaded = (long)(fraction * 111063687); total = state == "idle" ? 0 : 111063687;
            if (state == "idle") { statusTitle = "一切准备，交给我们。"; statusDetail = "点击运行，自动从魔搭准备桌面环境。"; run.Text = "运行  →"; }
            else if (state == "paused") { statusTitle = "稍作停留，进度还在。"; statusDetail = "已保留下载内容，随时可以继续。"; run.Text = "继续准备  →"; }
            else if (state == "ready") { statusTitle = "桌面已准备好。"; statusDetail = "接下来进入工作台，继续准备模型与依赖。"; run.Text = preview ? "重新演示  ↻" : "即将打开  →"; }
            else { statusTitle = "正在准备你的创作空间。"; statusDetail = "从魔搭补齐桌面环境，完成后自动打开工作台。"; run.Text = "正在准备…"; }
            run.Enabled = state != "downloading" && state != "working"; pause.Visible = state == "downloading" || state == "working";
            if (state == "downloading" || state == "working") animation.Start(); else animation.Stop();
            AccessibleDescription = statusTitle + statusDetail; Invalidate();
        }
        void StartDemo() { if (view == "ready") fraction = 0; SetPreview("downloading", fraction); }
        async Task Start() {
            SetPreview("working", fraction); total = 0; cancellation = new CancellationTokenSource();
            string root = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "VoxCPMStudio");
            var reporter = new Progress<Status>(status => {
                if (IsDisposed) return;
                statusTitle = status.text; statusDetail = "完成后自动打开工作台，继续准备模型与依赖。";
                downloaded = status.done; total = status.total;
                if (total > 0) fraction = Math.Max(0, Math.Min(1, (double)downloaded / total));
                AccessibleDescription = statusTitle; Invalidate();
            });
            try {
                string executable = await Task.Run(() => Core.Prepare(root, manifest, cancellation.Token, reporter));
                SetPreview("ready", 1); run.Enabled = false; await Task.Delay(350, cancellation.Token);
                cancellation.Token.ThrowIfCancellationRequested();
                var start = new ProcessStartInfo(executable, "--voxcpm-run") { WorkingDirectory = root, UseShellExecute = false };
                start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE"); Process.Start(start); Close();
            } catch (OperationCanceledException) { if (!IsDisposed) SetPreview("paused", fraction); }
            catch (Exception error) {
                if (!IsDisposed) { view = "error"; statusTitle = "暂时未能完成准备。"; statusDetail = error.Message; animation.Stop(); run.Text = "重试  →"; Invalidate(); }
                try { Directory.CreateDirectory(root); File.AppendAllText(Path.Combine(root, "bootstrap.log"), DateTimeOffset.Now + " " + error + Environment.NewLine); } catch { }
            } finally {
                cancellation.Dispose(); cancellation = null;
                if (!IsDisposed) { run.Enabled = true; pause.Visible = false; }
            }
        }
        protected override void Dispose(bool disposing) { if (disposing) animation.Dispose(); base.Dispose(disposing); }
    }
    public static class Program {
        [STAThread] public static void Main(string[] args) {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            try {
                Manifest manifest;
                using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("bootstrap-manifest.json"))
                using (var reader = new StreamReader(stream)) manifest = new JavaScriptSerializer().Deserialize<Manifest>(reader.ReadToEnd());
                Core.Validate(manifest);
                string identity;
                using (var hash = SHA256.Create()) identity = BitConverter.ToString(hash.ComputeHash(System.Text.Encoding.UTF8.GetBytes(AppDomain.CurrentDomain.BaseDirectory.ToUpperInvariant()))).Replace("-", "");
                using (var mutex = new Mutex(false, "Local\\VoxCPM-Bootstrap-" + identity)) {
                    if (!mutex.WaitOne(0)) { MessageBox.Show("启动器已在运行，请查看已有窗口。", "VoxCPM Studio"); return; }
                    bool demo = args.Contains("--demo");
#if DEMO
                    demo = true;
#endif
                    try { Application.Run(new Launcher(manifest, demo)); } finally { mutex.ReleaseMutex(); }
                }
            } catch (Exception error) { MessageBox.Show(error.Message, "VoxCPM Studio 启动未完成", MessageBoxButtons.OK, MessageBoxIcon.Error); Environment.ExitCode = 1; }
        }
    }
}
