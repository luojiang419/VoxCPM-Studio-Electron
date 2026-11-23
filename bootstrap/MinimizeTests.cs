using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using VoxBootstrap;
using VoxStandaloneUpdater;

public static class MinimizeTests {
    static int passed;
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static void Pump(int milliseconds) {
        var watch = System.Diagnostics.Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < milliseconds) { Application.DoEvents(); Thread.Sleep(5); }
    }
    static void Cycle(Form form, string name, Action progress, string output) {
        form.Show(); Pump(40);
        Size expected = form.ClientSize;
        var button = form.Controls.OfType<SoftButton>().Single(b => b.Glyph == ButtonGlyph.Minimize);
        for (int i = 0; i < 3; i++) {
            if (i == 1) form.WindowState = FormWindowState.Minimized; else button.PerformClick();
            Pump(40);
            Check(form.WindowState == FormWindowState.Minimized, name + " 未最小化");
            progress(); Pump(30);
            form.WindowState = FormWindowState.Normal; Pump(40);
            Check(form.ClientSize == expected, name + " 恢复后尺寸变化");
            Check(button.Bounds.Width > 0 && form.Region != null, name + " 恢复后布局丢失");
            form.Refresh();
        }
        if (name.Contains("working")) using (var bitmap = new Bitmap(form.ClientSize.Width, form.ClientSize.Height)) {
            form.DrawToBitmap(bitmap, form.ClientRectangle);
            bitmap.Save(Path.Combine(output, name + ".png"));
        }
        passed++; Console.WriteLine("PASS " + name + " 最小化/进度更新/恢复");
    }
    static void DownloadWhileMinimized(Launcher form, string output) {
        var bytes = new byte[512 * 1024]; new Random(17).NextBytes(bytes);
        string sha;
        using (var hash = SHA256.Create()) sha = BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
        var server = new TcpListener(IPAddress.Loopback, 0); server.Start();
        var send = Task.Run(() => {
            using (var client = server.AcceptTcpClient()) using (var stream = client.GetStream()) {
                var reader = new StreamReader(stream);
                while (!String.IsNullOrEmpty(reader.ReadLine())) { }
                byte[] header = System.Text.Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: " + bytes.Length + "\r\nConnection: close\r\n\r\n");
                stream.Write(header, 0, header.Length);
                for (int i = 0; i < bytes.Length; i += 4096) { stream.Write(bytes, i, 4096); stream.Flush(); Thread.Sleep(5); }
            }
        });
        try {
            form.Show(); form.SetPreview("working", 0); Pump(40);
            long received = 0; int callbacks = 0;
            var progress = new Progress<Status>(s => { received = s.done; callbacks++; form.SetPreparationProgress(s, 1); });
            var asset = new Asset { name = "download.bin", size = bytes.Length, sha256 = sha,
                urls = new[] { "http://127.0.0.1:" + ((IPEndPoint)server.LocalEndpoint).Port + "/asset" } };
            string cache = Path.Combine(output, "download"); Directory.CreateDirectory(cache);
            var download = Task.Run(() => Core.Download(asset, cache, CancellationToken.None, progress, true));
            form.Controls.OfType<SoftButton>().Single(b => b.Glyph == ButtonGlyph.Minimize).PerformClick();
            int before = callbacks; Pump(400);
            Check(form.WindowState == FormWindowState.Minimized && received > 0 && callbacks > before, "最小化时下载或进度停止");
            var deadline = DateTime.UtcNow.AddSeconds(10);
            while (!download.IsCompleted && DateTime.UtcNow < deadline) Pump(20);
            Check(download.IsCompleted, "最小化时下载未能结束"); download.GetAwaiter().GetResult(); send.GetAwaiter().GetResult();
            Check(Core.Verified(Path.Combine(cache, asset.name), asset), "下载结果校验失败");
            form.WindowState = FormWindowState.Normal; Pump(40); form.Refresh();
            passed++; Console.WriteLine("PASS 最小化期间真实下载、UI进度继续且SHA256通过");
        } finally { server.Stop(); }
    }
    [STAThread] public static int Main(string[] args) {
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        string output = Path.GetFullPath(args[0]); Directory.CreateDirectory(output);
        try {
            var manifest = new Manifest();
            Func<string> root = () => Path.Combine(output, "preview-root");
            Func<InstallDrive[]> drives = () => new[] { new InstallDrive { root = Path.GetPathRoot(output), ready = true, free = Installer.RequiredSpace * 4 } };
            foreach (bool dark in new[] { false, true }) foreach (string state in new[] { "idle", "working", "downloading", "paused", "ready" }) {
                using (var form = new Launcher(manifest, true, dark, root, drives)) {
                    form.SetPreview(state, .35);
                    Cycle(form, "installer-" + state + (dark ? "-dark" : "-light"),
                        () => form.SetPreparationProgress(new Status { text = "后台安装仍在继续", done = 35, total = 100 }, 1), output);
                }
            }
            foreach (bool dark in new[] { false, true }) foreach (bool repair in new[] { false, true }) {
                using (var form = new UpdateForm(output, true, dark, repair)) {
                    form.SetPreview("working", 95);
                    Cycle(form, (repair ? "repair" : "updater") + "-working" + (dark ? "-dark" : "-light"), () => form.SetPreview("working", 96), output);
                    form.SetPreview("complete", 100); form.Close();
                }
            }
            using (var form = new Launcher(manifest, true, false, root, drives)) DownloadWhileMinimized(form, output);
            Console.WriteLine(passed + " minimize tests passed"); return 0;
        } catch (Exception error) {
            File.WriteAllText(Path.Combine(output, "failure.txt"), error.ToString()); Console.Error.WriteLine(error); return 1;
        }
    }
}
