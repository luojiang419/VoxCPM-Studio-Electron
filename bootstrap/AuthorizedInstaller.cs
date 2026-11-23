using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace VoxBootstrap {
    // 与旧无授权安装器隔离产品归属、注册表、快捷方式和默认目录。
    public static class AuthorizedInstaller {
        [STAThread] public static void Main(string[] args) {
            Core.EnableLongPaths();
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            string report = null;
            try {
                if (Installer.RouteUninstall(args)) return;
                string root = null; bool installOnly = false, shortcuts = true;
                for (int i = 0; i < args.Length; i++) {
                    if (args[i] == "--root" && i + 1 < args.Length) root = args[++i];
                    else if (args[i] == "--report" && i + 1 < args.Length) report = args[++i];
                    else if (args[i] == "--install-only") installOnly = true;
                    else if (args[i] == "--no-shortcuts") shortcuts = false;
                    else throw new ArgumentException("不支持的参数：" + args[i]);
                }
                var json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };
                Manifest manifest;
                using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("bootstrap-manifest.json"))
                using (var reader = new StreamReader(stream)) manifest = json.Deserialize<Manifest>(reader.ReadToEnd());
                Core.Validate(manifest);
                if (!installOnly) {
                    Application.Run(new Launcher(manifest, darkMode: true, detectRoot: root == null ? (Func<string>)null : (() => root)));
                    return;
                }
                if (String.IsNullOrWhiteSpace(root)) throw new ArgumentException("无人值守安装必须指定 --root。");
                root = Installer.Canonical(root);
                Installer.ValidateDestinationCapacity(root);
                using (var lease = Installer.AcquireRoot(root)) {
                    Installer.Begin(root, manifest, lockHeld: true);
                    Installer.InstallUninstaller(root);
                    Core.Prepare(root, manifest, CancellationToken.None, new Progress<Status>());
                    Installer.ExtractResource("app.ico", Path.Combine(root, "voxcpm.ico"));
                    Installer.ExtractResource("installer.ico", Path.Combine(root, "voxcpm-installer.ico"));
                    Installer.Complete(root, manifest, shortcuts, shortcuts);
                }
                if (report != null) File.WriteAllText(report, json.Serialize(new { ok = true, root, desktopInstalled = true, resourcesPreparedOnFirstLaunch = true }));
            } catch (Exception error) {
                Environment.ExitCode = 1;
                if (report != null) File.WriteAllText(report, new JavaScriptSerializer().Serialize(new {ok = false, error = error.Message}));
                else MessageBox.Show(error.Message, Brand.Name + " 安装未完成", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }
}
