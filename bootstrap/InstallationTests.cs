using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using System.Windows.Forms;
using VoxBootstrap;

public static class InstallationTests {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly List<string> Keys = new List<string>();
    sealed class Quiet : IProgress<Status> { public void Report(Status status) { } }
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static void Reject(Action action, string message) { bool rejected = false; try { action(); } catch { rejected = true; } Check(rejected, message); }
    static void Put(string file, string text) { Directory.CreateDirectory(Path.GetDirectoryName(file)); File.WriteAllText(file, text); }
    static Manifest Manifest() { return new Manifest { appVersion = "2.0.2", entry = "VoxCPM Studio.exe", files = new[] { new Asset { name = "VoxCPM Studio.exe" }, new Asset { name = "resources/app/main.js" } } }; }
    static string Key() { string key = Installer.UninstallKey + ".Test." + Guid.NewGuid().ToString("N"); Keys.Add(key); return key; }
    static InstallState Begin(string root, string key) { var state = Installer.Begin(root, Manifest(), false, key); state.registryKey = key; Installer.SaveState(state); return state; }
    static string Report(string root, string session, bool ready = true) {
        string path = Path.Combine(root, "data/cache/install", session + ".json");
        Put(path, Json.Serialize(new { session = session, root = Installer.Canonical(root), ok = ready, status = ready ? "ready" : "error", error = "安装失败测试" })); return path;
    }
    static void ForeignShortcut(string file, string target) {
        object shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell")), link = null;
        try {
            link = shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { file });
            link.GetType().InvokeMember("TargetPath", BindingFlags.SetProperty, null, link, new object[] { target });
            link.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
        } finally { if (link != null) Marshal.FinalReleaseComObject(link); Marshal.FinalReleaseComObject(shell); }
    }
    static void Junction(string link, string target) {
        var start = new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -Command \"New-Item -ItemType Junction -Path $env:VOXCPM_TEST_LINK -Target $env:VOXCPM_TEST_TARGET | Out-Null\"") { UseShellExecute = false, CreateNoWindow = true };
        start.EnvironmentVariables["VOXCPM_TEST_LINK"] = link; start.EnvironmentVariables["VOXCPM_TEST_TARGET"] = target;
        using (var child = Process.Start(start)) { child.WaitForExit(30000); Check(child.ExitCode == 0, "创建测试目录连接失败"); }
    }
    [STAThread] public static int Main() {
        string fixtureBase = Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "fixtures");
        string fixtures = Path.Combine(fixtureBase, Guid.NewGuid().ToString("N")); Directory.CreateDirectory(fixtures);
        int passed = 0; Action<string, Action> test = (name, action) => { action(); passed++; Console.WriteLine("PASS " + name); };
        try {
            test("自动选址优先非 C 盘、容量排序及不可写目录避让", () => {
                var drives = new[] {
                    new InstallDrive { root = @"C:\", ready = true, free = Installer.RequiredSpace * 8 },
                    new InstallDrive { root = @"D:\", ready = true, free = Installer.RequiredSpace * 2 },
                    new InstallDrive { root = @"E:\", ready = true, free = Installer.RequiredSpace * 3 }
                };
                Check(Installer.SelectAutomaticRoot(drives, @"C:\Users\test\AppData\Local\Programs\VoxCPMStudio", p => true) == @"E:\VoxCPMStudio", "没有选择空间最大的非 C 分区");
                Check(Installer.SelectAutomaticRoot(drives, @"C:\Users\test\AppData\Local\Programs\VoxCPMStudio", p => p.StartsWith(@"D:\")) == @"D:\VoxCPMStudio", "未跳过不可写分区");
                Reject(() => Installer.SelectAutomaticRoot(drives, @"C:\test", p => false), "所有目录不可写却通过");
            });
            test("其他分区空间不足/不可用时明确提示，不能回退 C 盘", () => {
                var drives = new[] {
                    new InstallDrive { root = @"C:\", ready = true, free = Installer.RequiredSpace * 8 },
                    new InstallDrive { root = @"D:\", ready = true, free = Installer.RequiredSpace - 1 },
                    new InstallDrive { root = @"E:\", ready = true, free = 0 }
                };
                string message = ""; int probes = 0;
                try { Installer.SelectAutomaticRoot(drives, @"C:\test", p => { probes++; return true; }); } catch (IOException error) { message = error.Message; }
                Check(message.Contains("其他分区空间均不足") && message.Contains("D盘") && message.Contains("重新检测") && probes == 0, "空间不足提示或无 C 回退策略错误");
                drives[1].ready = drives[2].ready = false;
                Reject(() => Installer.SelectAutomaticRoot(drives, @"C:\test", p => true), "离线分区被误判为仅 C 盘");
                Reject(() => Installer.ValidateDestinationCapacity(@"C:\VoxCPMStudio", drives), "手动输入 C 盘绕过策略");
                drives[1].ready = true;
                Reject(() => Installer.ValidateDestinationCapacity(@"D:\VoxCPMStudio", drives), "手动选择空间不足的分区通过");
            });
            test("仅 C 盘时使用可写用户目录且严格检查容量阈值", () => {
                string root = @"C:\Users\test\AppData\Local\Programs\VoxCPMStudio";
                var drives = new[] { new InstallDrive { root = @"C:\", ready = true, free = Installer.RequiredSpace } };
                Check(Installer.SelectAutomaticRoot(drives, root, p => p == root) == root, "仅 C 盘选择错误");
                Installer.ValidateDestinationCapacity(root, drives);
                Reject(() => Installer.SelectAutomaticRoot(drives, root, p => false), "不可写用户目录通过");
                drives[0].free--; Reject(() => Installer.SelectAutomaticRoot(drives, root, p => true), "容量边界错误");
            });
            test("空间不足时安装界面仍可用，释放空间后重新检测恢复安装", () => {
                int attempts = 0;
                using (var form = new Launcher(Manifest(), false, false, () => {
                    if (++attempts == 1) throw new IOException("其他分区空间均不足。\n至少需要 25 GiB；D盘 1 GiB。请释放空间后重新检测。");
                    return @"G:\VoxCPMStudio";
                })) {
                    form.ShowInTaskbar = false; form.Opacity = 0; form.Show(); Application.DoEvents();
                    var run = (SoftButton)form.Controls["install"]; var detect = (SoftButton)form.Controls["detect"];
                    Check(!run.Enabled && detect.Enabled && form.Controls["destination"].Text == "", "错误状态未阻止安装或不能重新检测");
                    Check(form.AccessibleDescription.Contains("空间均不足"), "没有显示不足原因");
                    detect.PerformClick(); Check(attempts == 2 && run.Enabled && form.Controls["destination"].Text == @"G:\VoxCPMStudio", "重新检测未恢复");
                    form.Controls["destination"].Text = ""; Check(!run.Enabled, "空路径允许安装"); form.Close();
                }
            });
            test("磁盘卡片点击安装到专用文件夹，禁用分区不能被选中", () => {
                var drives = new[] {
                    new InstallDrive { root = @"C:\", ready = true, free = Installer.RequiredSpace * 8 },
                    new InstallDrive { root = @"D:\", ready = true, free = Installer.RequiredSpace * 2 },
                    new InstallDrive { root = @"E:\", ready = true, free = Installer.RequiredSpace * 3 },
                    new InstallDrive { root = @"G:\", ready = true, free = 100 }
                };
                using (var form = new Launcher(Manifest(), true, false, () => @"D:\VoxCPMStudio", () => drives)) {
                    form.ShowInTaskbar = false; form.Opacity = 0; form.Show(); Application.DoEvents();
                    var panel = (DiskStrip)form.Controls["local-disks"];
                    var d = (DiskCard)panel.Controls["drive-D"]; var e = (DiskCard)panel.Controls["drive-E"];
                    var c = (DiskCard)panel.Controls["drive-C"]; var g = (DiskCard)panel.Controls["drive-G"];
                    Check(!c.Enabled && !g.Enabled && d.Selected, "不可选磁盘状态错误");
                    Check(!panel.HasOverflow && !panel.VerticalScroll.Visible, "四张卡片产生了多余滚动条");
                    e.Choose(); Check(form.Controls["destination"].Text == @"E:\VoxCPMStudio" && e.Selected && !d.Selected, "点击卡片未使用专用目录或选中状态未切换");
                    Check(e.IsAnimating, "选择未触发动画");
                    e.AdvanceAnimation(.25); double intermediate = e.IconScale;
                    Check(intermediate > 1 && intermediate < 1.17, "图标没有平滑放大");
                    e.AdvanceAnimation(1); Check(Math.Abs(e.IconScale-1.17)<.0001 && !e.IsAnimating, "缩放动画没有正确结束");
                    Check((e.AccessibilityObject.State & AccessibleStates.Checked) != 0, "辅助功能没有选中状态");
                    c.Choose(); g.Choose(); Check(form.Controls["destination"].Text == @"E:\VoxCPMStudio", "禁用分区仍可被选择");
                    d.Choose(); e.AdvanceAnimation(1); Check(e.IconScale == 1, "切换后旧图标未恢复");
                    form.Close();
                }
            });
            test("所有贝塞尔缓动保持边界、连续单调，密集分区可横向浏览", () => {
                Check(BezierMotion.Ease(0) == 0 && BezierMotion.Ease(1) == 1, "缓动端点错误");
                double previous = 0;
                for (int i=1;i<=100;i++) { double value = BezierMotion.Ease(i/100.0); Check(value >= previous && value <= 1, "缓动越界或回跳"); previous=value; }
                var drives = new[] { "C", "D", "E", "F", "G", "H" }.Select(letter => new InstallDrive { root=letter+@":\", ready=true, free=Installer.RequiredSpace*2 }).ToArray();
                using (var form = new Launcher(Manifest(), true, false, () => @"D:\VoxCPMStudio", () => drives)) {
                    form.ShowInTaskbar=false; form.Opacity=0; form.Show(); Application.DoEvents();
                    var panel=(DiskStrip)form.Controls["local-disks"];
                    Check(panel.Controls.Count==6 && panel.HasOverflow && !panel.VerticalScroll.Visible && !panel.HorizontalScroll.Visible, "出现了原生横/纵滚动条");
                    panel.ScrollToOffset(200); panel.AdvanceScrollAnimation(.3); Check(panel.ScrollOffset>0 && panel.ScrollOffset<200,"横向贝塞尔滚动未生效");
                    panel.AdvanceScrollAnimation(1); Check(panel.ScrollOffset==200 && panel.Controls[0].Left==-200,"横向偏移错误");
                    panel.ScrollToOffset(100000,false); Check(panel.Controls[5].Right==panel.ClientSize.Width,"末尾卡片不能完整显示或滚动越界");
                    panel.ScrollToOffset(-100,false); Check(panel.ScrollOffset==0,"横向滚动越过起点"); form.Close();
                }
            });
            test("禁止系统/个人根目录和非专用目录", () => {
                foreach (string path in new[] { Path.GetPathRoot(fixtures), Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), Environment.GetFolderPath(Environment.SpecialFolder.Windows), Path.GetTempPath() }) Reject(() => Installer.ValidateRoot(path), "危险目录通过");
                string root = Path.Combine(fixtures, "foreign"); Put(Path.Combine(root, "user.txt"), "保留"); Reject(() => Begin(root, Key()), "已有用户文件被接管"); Check(File.ReadAllText(Path.Combine(root, "user.txt")) == "保留", "用户文件被改变");
            });
            test("安装目录独占锁及准备期间不登记应用", () => {
                string root = Path.Combine(fixtures, "lease"), key = Key();
                using (var lease = Installer.AcquireRoot(root)) {
                    var state = Installer.Begin(root, Manifest(), false, key, true);
                    Check(state.state == "preparing", "状态错误"); Reject(() => Installer.AcquireRoot(root), "并发安装未拦截");
                    using (var entry = Registry.CurrentUser.OpenSubKey(key)) Check(entry == null, "提前登记安装完成");
                }
            });
            test("必须取得正确会话的就绪报告才能创建快捷方式和注册", () => {
                string root = Path.Combine(fixtures, "not-ready"), key = Key(); Begin(root, key);
                Put(Path.Combine(root, "VoxCPM Studio.exe"), "app"); Put(Path.Combine(root, "uninstall.exe"), "uninstaller");
                var paths = new IntegrationPaths { desktop = Path.Combine(fixtures, "desktop-not-ready"), startMenu = Path.Combine(fixtures, "menu-not-ready"), registryKey = key };
                Reject(() => Installer.Complete(root, Manifest(), true, true, paths), "没有就绪报告却登记成功");
                string session = Guid.NewGuid().ToString("N"), report = Report(root, session);
                Reject(() => Installer.RequireReady(root, report, Guid.NewGuid().ToString("N")), "错误会话通过");
                Report(root, session, false); Reject(() => Installer.RequireReady(root, report, session), "失败报告通过");
                using (var entry = Registry.CurrentUser.OpenSubKey(key)) Check(entry == null, "失败后仍登记应用");
            });
            test("真实快捷方式/注册、保护同名快捷方式、卸载保留个人数据", () => {
                string root = Path.Combine(fixtures, "complete"), key = Key(); var state = Begin(root, key);
                Put(Path.Combine(root, "VoxCPM Studio.exe"), "app"); Put(Path.Combine(root, "uninstall.exe"), "uninstaller");
                Put(Path.Combine(root, "resources/app/main.js"), "app"); Put(Path.Combine(root, "runtime/python.exe"), "runtime"); Put(Path.Combine(root, "models/model.bin"), "model");
                Put(Path.Combine(root, "data/voices/voice.wav"), "personal"); Put(Path.Combine(root, "data/cache/download.part"), "cache");
                var paths = new IntegrationPaths { desktop = Path.Combine(fixtures, "desktop"), startMenu = Path.Combine(fixtures, "menu"), registryKey = key }; Directory.CreateDirectory(paths.desktop);
                string foreign = Path.Combine(paths.desktop, "VoxCPM Studio.lnk"), foreignTarget = Path.Combine(fixtures, "other.exe"); Put(foreignTarget, "other"); ForeignShortcut(foreign, foreignTarget);
                string session = Guid.NewGuid().ToString("N"), report = Report(root, session);
                Installer.Complete(root, Manifest(), true, true, paths, report, session); state = Installer.ReadState(root);
                Check(state.state == "complete" && state.shortcuts.Length == 3, "安装集成未完成");
                Check(Installer.ShortcutTarget(foreign) == foreignTarget, "覆盖了用户原有同名快捷方式");
                Check(state.shortcuts.Any(p => Path.GetFileName(p) == "VoxCPM Studio (2).lnk"), "没有避让同名快捷方式");
                using (var entry = Registry.CurrentUser.OpenSubKey(key)) { Check(Convert.ToString(entry.GetValue("InstallLocation")) == root, "注册位置错误"); Check(Convert.ToString(entry.GetValue("UninstallString")).Contains("uninstall.exe"), "卸载入口缺失"); }
                Installer.Remove(root, state.id, false);
                Check(File.Exists(Path.Combine(root, "data/voices/voice.wav")), "误删个人数据"); Check(!Directory.Exists(Path.Combine(root, "models")) && !Directory.Exists(Path.Combine(root, "runtime")), "未清理依赖和模型");
                Check(!Directory.Exists(Path.Combine(root, "data/cache")), "未清理缓存"); Check(File.Exists(foreign), "误删用户同名快捷方式");
                Check(state.shortcuts.All(p => !File.Exists(p)), "自身快捷方式未删除");
                using (var entry = Registry.CurrentUser.OpenSubKey(key)) Check(entry == null, "应用列表入口未删除");
                string oldId = state.id; state = Begin(root, key); Check(state.id != oldId, "重装沿用已卸载标识"); Reject(() => Installer.Remove(root, oldId, true), "旧卸载会话能删除新安装");
            });
            test("默认卸载不穿越目录连接，可选清除也不删除外部目标", () => {
                string outside = Path.Combine(fixtures, "outside"); Put(Path.Combine(outside, "cache/keep.txt"), "outside");
                string root = Path.Combine(fixtures, "junction"), key = Key(); var state = Begin(root, key);
                Junction(Path.Combine(root, "resources"), outside); Junction(Path.Combine(root, "data"), outside);
                Installer.Remove(root, state.id, false); Check(File.Exists(Path.Combine(outside, "cache/keep.txt")), "默认卸载穿越了连接"); Check(Directory.Exists(Path.Combine(root, "data")), "默认卸载不应移除数据连接");
                state = Begin(root, key); Installer.Remove(root, state.id, true);
                Check(!Directory.Exists(Path.Combine(root, "data")), "未移除数据连接"); Check(File.Exists(Path.Combine(outside, "cache/keep.txt")), "删除了连接的外部目标");
            });
            test("卸载遇到占用文件时保留登记和卸载程序以便重试", () => {
                string root = Path.Combine(fixtures, "busy"), key = Key(); var state = Begin(root, key);
                Put(Path.Combine(root, "VoxCPM Studio.exe"), "app"); Put(Path.Combine(root, "uninstall.exe"), "uninstaller"); Put(Path.Combine(root, "runtime/held.dll"), "locked");
                var paths = new IntegrationPaths { desktop = Path.Combine(fixtures, "busy-desktop"), startMenu = Path.Combine(fixtures, "busy-menu"), registryKey = key };
                string session = Guid.NewGuid().ToString("N"), report = Report(root, session); Installer.Complete(root, Manifest(), true, false, paths, report, session);
                using (var hold = new FileStream(Path.Combine(root, "runtime/held.dll"), FileMode.Open, FileAccess.ReadWrite, FileShare.None)) {
                    Reject(() => Installer.Remove(root, state.id, false), "占用文件应使卸载暂停");
                    using (var entry = Registry.CurrentUser.OpenSubKey(key)) Check(entry != null, "失败后卸载入口丢失");
                    Check(File.Exists(Path.Combine(root, "uninstall.exe")), "失败后卸载程序丢失");
                }
                Installer.Remove(root, state.id, false);
                using (var entry = Registry.CurrentUser.OpenSubKey(key)) Check(entry == null, "重试卸载未完成");
            });
            test("可选清除个人数据及伪造归属/注册路径拒绝", () => {
                string root = Path.Combine(fixtures, "purge"), key = Key(); var state = Begin(root, key); Put(Path.Combine(root, "data/user.txt"), "personal");
                Reject(() => Installer.Remove(root, Guid.NewGuid().ToString("N"), true), "错误归属通过");
                state.registryKey = "Software"; Installer.SaveState(state); Reject(() => Installer.Remove(root, state.id, true), "危险注册表路径通过");
                Check(File.Exists(Path.Combine(root, "data/user.txt")), "拒绝后仍删除数据"); state.registryKey = key; Installer.SaveState(state); Installer.Remove(root, state.id, true); Check(!Directory.Exists(Path.Combine(root, "data")), "可选清除没有生效");
            });
            test("就绪等待支持成功、失败和取消", () => {
                string root = Path.Combine(fixtures, "report"), key = Key(); Begin(root, key); string session = Guid.NewGuid().ToString("N"), report = Report(root, session);
                Installer.WaitForReady(root, report, session, null, CancellationToken.None, new Quiet()).GetAwaiter().GetResult();
                Report(root, session, false); Reject(() => Installer.WaitForReady(root, report, session, null, CancellationToken.None, new Quiet()).GetAwaiter().GetResult(), "失败报告通过");
                File.Delete(report); var cancellation = new CancellationTokenSource(); cancellation.Cancel(); Reject(() => Installer.WaitForReady(root, report, session, null, cancellation.Token, new Quiet()).GetAwaiter().GetResult(), "取消未生效");
            });
            Console.WriteLine(passed + " installation integration tests passed"); return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        finally {
            foreach (string key in Keys) Registry.CurrentUser.DeleteSubKeyTree(key, false);
            if (Installer.SamePath(Path.GetDirectoryName(fixtures), fixtureBase) && System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(fixtures), @"^[a-f0-9]{32}$")) Installer.DeleteOwnedTree(fixtures);
        }
    }
}
