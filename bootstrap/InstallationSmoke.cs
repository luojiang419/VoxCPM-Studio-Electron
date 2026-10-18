using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using VoxBootstrap;

// 显式运行的本机验收：仅借用指定测试运行时/模型，系统集成始终写隔离位置。
public static class InstallationSmoke {
    sealed class ProgressLog : IProgress<Status> {
        string last;
        public void Report(Status value) { if (last != value.text) { Console.WriteLine(value.text); last = value.text; } }
    }
    delegate bool WindowCallback(IntPtr window, IntPtr extra);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr extra);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    static int Windows(int pid, bool visibleOnly) {
        int count = 0;
        EnumWindows((window, extra) => {
            uint owner; GetWindowThreadProcessId(window, out owner);
            if (owner == pid) {
                var title = new StringBuilder(512); GetWindowText(window, title, title.Capacity);
                if (title.ToString().IndexOf("VoxCPM", StringComparison.OrdinalIgnoreCase) >= 0 && (!visibleOnly || IsWindowVisible(window))) count++;
            }
            return true;
        }, IntPtr.Zero); return count;
    }
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    static void Junction(string link, string target) {
        var start = new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -Command \"New-Item -ItemType Junction -Path $env:VOXCPM_TEST_LINK -Target $env:VOXCPM_TEST_TARGET | Out-Null\"") { UseShellExecute = false, CreateNoWindow = true };
        start.EnvironmentVariables["VOXCPM_TEST_LINK"] = link; start.EnvironmentVariables["VOXCPM_TEST_TARGET"] = target;
        using (var child = Process.Start(start)) { child.WaitForExit(); Check(child.ExitCode == 0, "测试目录连接失败"); }
    }
    [STAThread] public static int Main(string[] args) {
        var json = new JavaScriptSerializer();
        var manifest = json.Deserialize<Manifest>(File.ReadAllText(args[0], Encoding.UTF8));
        string output = Path.GetFullPath(args[5]), root = Path.Combine(output, "fixtures", Guid.NewGuid().ToString("N"), "Program Files", "VoxCPMStudio");
        string key = Installer.UninstallKey + ".Test." + Guid.NewGuid().ToString("N");
        string runtime = Path.GetFullPath(args[3]), models = Path.GetFullPath(args[4]);
        string pth = Path.Combine(runtime, "managed", "py312-cu126", "python312._pth");
        byte[] originalPth = File.ReadAllBytes(pth);
        Process child = null; var progress = new ProgressLog();
        Directory.CreateDirectory(output);
        try {
            Installer.ValidateDestinationCapacity(root);
            var state = Installer.Begin(root, manifest, false, key);
            string cache = Path.Combine(root, "data", "cache", "bootstrap"); Directory.CreateDirectory(cache);
            File.Copy(args[1], Path.Combine(cache, manifest.package.name));
            Core.Prepare(root, manifest, CancellationToken.None, progress);
            File.Copy(args[2], Path.Combine(root, "uninstall.exe"));
            File.Copy(args[6], Path.Combine(root, "voxcpm.ico"));
            Junction(Path.Combine(root, "runtime"), runtime); Junction(Path.Combine(root, "models"), models);
            string session = Guid.NewGuid().ToString("N"), report = Path.Combine(root, "data", "cache", "install", session + ".json");
            Directory.CreateDirectory(Path.GetDirectoryName(report));
            child = Installer.StartPreparation(root, report, session);
            using (var cancel = new CancellationTokenSource(TimeSpan.FromMinutes(8))) Installer.WaitForReady(root, report, session, child, cancel.Token, progress).GetAwaiter().GetResult();
            string ready = File.ReadAllText(report);
            Check(Windows(child.Id, false) > 0 && Windows(child.Id, true) == 0, "准备窗口没有保持隐藏");
            var paths = new IntegrationPaths { desktop = Path.Combine(output, "desktop"), startMenu = Path.Combine(output, "menu"), registryKey = key };
            Installer.Complete(root, manifest, true, true, paths, report, session);
            state = Installer.ReadState(root); Check(state.state == "complete" && state.shortcuts.Length == 3, "真实握手后集成失败");
            var show = new ProcessStartInfo(Path.Combine(root, manifest.entry), "--voxcpm-run --voxcpm-show") { UseShellExecute = false, WorkingDirectory = root };
            show.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE"); show.EnvironmentVariables["VOXCPM_DATA_ROOT"] = Path.Combine(root, "data");
            using (var second = Process.Start(show)) second.WaitForExit(15000);
            var deadline = DateTime.UtcNow.AddSeconds(15);
            while (Windows(child.Id, true) == 0 && DateTime.UtcNow < deadline) Thread.Sleep(200);
            Check(Windows(child.Id, true) > 0, "完成后未展示原工作台窗口");
            foreach (string log in new[] { "runtime-bootstrap.log", "electron_backend.log" }) {
                string source = Path.Combine(root, "data", "cache", log);
                if (File.Exists(source)) File.Copy(source, Path.Combine(output, log), true);
            }
            File.WriteAllText(Path.Combine(output, "ready-report.json"), ready, Encoding.UTF8);
            // taskkill 返回时，子进程的当前目录句柄仍可能尚未释放。等待本轮 API 和桌面进程真正退出。
            var apiPid = System.Text.RegularExpressions.Regex.Match(File.ReadAllText(Path.Combine(output,"electron_backend.log")), @"Started server process \[(\d+)\]");
            Check(apiPid.Success,"没有找到本轮 API 进程记录");
            using (var api = Process.GetProcessById(Int32.Parse(apiPid.Groups[1].Value))) {
                Installer.StopChild(child);
                Check(child.WaitForExit(15000) && api.WaitForExit(15000),"测试进程未完全退出，不能开始卸载验收");
            }
            child.Dispose(); child = null;
            Directory.CreateDirectory(Path.Combine(root, "data", "voices")); File.WriteAllText(Path.Combine(root, "data", "voices", "keep.txt"), "personal");
            Installer.Remove(root, state.id, false);
            Check(File.Exists(Path.Combine(root, "data", "voices", "keep.txt")), "卸载未保留个人数据");
            Check(File.Exists(Path.Combine(runtime, "managed", "py312-cu126", "python.exe")) && Directory.Exists(models), "卸载跨越测试连接");
            using (var entry = Registry.CurrentUser.OpenSubKey(key)) Check(entry == null, "测试卸载入口未清理");
            File.WriteAllText(Path.Combine(output, "result.json"), json.Serialize(new { root, readyReport = json.DeserializeObject(ready), desktopPrepared = true, hiddenUntilReady = true,
                secondInstanceShown = true, shortcutsAndRegistry = true, uninstallPreservedData = true, borrowedRuntimeAndModels = true, testedGpu = "RTX 4070 Ti SUPER / cu126" }), Encoding.UTF8);
            Console.WriteLine("PASS 实际桌面展开、GPU环境复检、API/renderer握手、隐藏窗口展示、隔离系统集成和卸载"); return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        finally {
            if (child != null) { Installer.StopChild(child); child.Dispose(); }
            foreach (string name in new[] { "runtime", "models" }) {
                string link = Path.Combine(root, name);
                if (Directory.Exists(link) && (File.GetAttributes(link) & FileAttributes.ReparsePoint) != 0) Directory.Delete(link);
            }
            File.WriteAllBytes(pth, originalPth);
            Registry.CurrentUser.DeleteSubKeyTree(key, false);
        }
    }
}
