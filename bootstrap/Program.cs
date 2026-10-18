using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
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

    public sealed class Launcher : Form {
        readonly Label message = new Label(), detail = new Label();
        readonly ProgressBar progress = new ProgressBar();
        readonly Button run = new Button(), pause = new Button();
        CancellationTokenSource cancellation;
        readonly Manifest manifest;
        public Launcher(Manifest value) {
            manifest = value; Text = "VoxCPM Studio 启动器"; ClientSize = new Size(580, 320);
            Font = new Font("Microsoft YaHei UI", 9); BackColor = Color.White; StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedSingle; MaximizeBox = false;
            var title = new Label { Text = "VoxCPM Studio", Font = new Font(Font.FontFamily, 22, FontStyle.Bold), Left = 30, Top = 27, Width = 520, Height = 44 };
            var subtitle = new Label { Text = "点击运行，自动从魔搭补齐桌面、依赖和模型。", Left = 32, Top = 86, Width = 515, Height = 26, ForeColor = Color.DimGray };
            message.SetBounds(32, 130, 515, 54); message.Text = "首次需要联网。已有资源会校验复用，下载中断后可以继续。";
            progress.SetBounds(32, 190, 515, 8); detail.SetBounds(32, 210, 515, 26); detail.ForeColor = Color.DimGray;
            run.Text = "运行"; run.SetBounds(440, 260, 106, 34); run.FlatStyle = FlatStyle.Flat; run.BackColor = Color.FromArgb(44, 44, 44); run.ForeColor = Color.White;
            pause.Text = "暂停"; pause.SetBounds(322, 260, 106, 34); pause.Visible = false;
            Controls.AddRange(new Control[] { title, subtitle, message, progress, detail, run, pause });
            run.Click += async (sender, args) => await Start();
            pause.Click += (sender, args) => { if (cancellation != null) cancellation.Cancel(); };
            FormClosing += (sender, args) => { if (cancellation != null) cancellation.Cancel(); };
        }
        async Task Start() {
            run.Enabled = false; pause.Visible = true; cancellation = new CancellationTokenSource();
            string root = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "VoxCPMStudio");
            var reporter = new Progress<Status>(status => {
                if (IsDisposed) return;
                message.Text = status.text;
                progress.Style = status.total > 0 ? ProgressBarStyle.Continuous : ProgressBarStyle.Marquee;
                if (status.total > 0) { progress.Value = Math.Min(100, (int)(status.done * 100 / status.total)); detail.Text = String.Format("{0:F1} MB / {1:F1} MB", status.done / 1048576.0, status.total / 1048576.0); }
                else detail.Text = "模型和依赖会在工作台中继续补齐。";
            });
            try {
                string executable = await Task.Run(() => Core.Prepare(root, manifest, cancellation.Token, reporter));
                cancellation.Token.ThrowIfCancellationRequested();
                var start = new ProcessStartInfo(executable, "--voxcpm-run") { WorkingDirectory = root, UseShellExecute = false };
                start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
                Process.Start(start); cancellation.Dispose(); cancellation = null; Close();
            } catch (OperationCanceledException) { message.Text = "已暂停。点击继续运行，可复用已完成的下载。"; }
            catch (Exception error) {
                message.Text = "暂未完成：" + error.Message;
                try { Directory.CreateDirectory(root); File.AppendAllText(Path.Combine(root, "bootstrap.log"), DateTimeOffset.Now + " " + error + Environment.NewLine); } catch { }
            } finally {
                if (cancellation != null) { cancellation.Dispose(); cancellation = null; }
                if (!IsDisposed) { run.Enabled = true; run.Text = "继续运行"; pause.Visible = false; progress.Style = ProgressBarStyle.Continuous; }
            }
        }
    }
    public static class Program {
        [STAThread] public static void Main() {
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
                    try { Application.Run(new Launcher(manifest)); } finally { mutex.ReleaseMutex(); }
                }
            } catch (Exception error) { MessageBox.Show(error.Message, "VoxCPM Studio 启动未完成", MessageBoxButtons.OK, MessageBoxIcon.Error); Environment.ExitCode = 1; }
        }
    }
}
