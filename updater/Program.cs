using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace VoxStandaloneUpdater {
    static class Program {
        [STAThread]
        static void Main(string[] args) {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try {
                if (args.Length != 2 || args[0] != "--session") throw new ArgumentException("缺少有效更新会话");
                string session = Path.GetFullPath(args[1]).TrimEnd(Path.DirectorySeparatorChar);
                string own = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                if (!String.Equals(own, session, StringComparison.OrdinalIgnoreCase)) throw new IOException("请从已校验的更新会话启动更新器");
                Application.Run(new UpdateForm(session));
            } catch (Exception error) {
                MessageBox.Show(error.Message, "独立更新器无法启动", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }

    sealed class UpdateForm : Form {
        readonly string session;
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        readonly Label message = new Label();
        readonly Label detail = new Label();
        readonly ProgressBar progress = new ProgressBar();
        readonly Button close = new Button();
        readonly object logLock = new object();
        Process worker;
        StreamWriter log;
        bool finished;
        Dictionary<string, object> settings;

        public UpdateForm(string folder) {
            session = folder;
            Text = "VoxCPM Studio · 独立更新器";
            ClientSize = new Size(650, 325);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(24, 24, 23);
            ForeColor = Color.FromArgb(239, 235, 227);
            Font = new Font("Microsoft YaHei UI", 10);
            try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }
            var title = new Label { Text = "独立更新器正在接管安装", Location = new Point(30, 27), Size = new Size(590, 38), Font = new Font(Font.FontFamily, 18, FontStyle.Bold) };
            message.Text = "正在校验更新，工作台将在准备完成后关闭…";
            message.Location = new Point(32, 88); message.Size = new Size(585, 54);
            progress.Location = new Point(33, 151); progress.Size = new Size(582, 21);
            detail.Text = "此窗口独立于工作台运行。安装后自动打开新版，模型、配置和作品会保留。";
            detail.Location = new Point(32, 188); detail.Size = new Size(585, 46); detail.ForeColor = Color.FromArgb(180, 175, 163);
            var logs = new Button { Text = "查看更新日志", Location = new Point(33, 260), Size = new Size(130, 34) };
            logs.Click += delegate { Process.Start(new ProcessStartInfo("explorer.exe", Quote(session)) { UseShellExecute = true }); };
            close.Text = "安装中，请稍候"; close.Location = new Point(455, 260); close.Size = new Size(160, 34); close.Enabled = false;
            close.Click += delegate { Close(); };
            Controls.AddRange(new Control[] { title, message, progress, detail, logs, close });
            FormClosing += delegate(object sender, FormClosingEventArgs e) { if (!finished) e.Cancel = true; };
            Shown += delegate { StartWorker(); };
        }

        static string Quote(string value) {
            var result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in value) {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') result.Append('\\', slashes * 2 + 1).Append(c);
                else result.Append('\\', slashes).Append(c);
                slashes = 0;
            }
            return result.Append('\\', slashes * 2).Append('"').ToString();
        }

        Dictionary<string, object> Read(string file) {
            return json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Encoding.UTF8));
        }

        void Write(string file, object value) {
            string temporary = file + ".host-tmp";
            File.WriteAllText(temporary, json.Serialize(value), new UTF8Encoding(false));
            if (File.Exists(file)) File.Delete(file);
            File.Move(temporary, file);
        }

        void StartWorker() {
            try {
                settings = Read(Path.Combine(session, "session.json"));
                if (!String.Equals(Path.GetFullPath(Convert.ToString(settings["session"])), session, StringComparison.OrdinalIgnoreCase)) throw new IOException("更新会话身份不匹配");
                string python = Convert.ToString(settings["pythonExecutable"]);
                if (!File.Exists(python) || !File.Exists(Path.Combine(session, "updater.py"))) throw new IOException("已校验的更新脚本或Python运行环境不存在");
                log = new StreamWriter(new FileStream(Path.Combine(session, "updater.log"), FileMode.Append, FileAccess.Write, FileShare.ReadWrite), new UTF8Encoding(false)); log.AutoFlush = true;
                var start = new ProcessStartInfo(python, "-u " + Quote(Path.Combine(session, "updater.py")) + " " + Quote(session) + " --worker") {
                    WorkingDirectory = session, UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardOutput = true, RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
                };
                start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
                worker = new Process { StartInfo = start, EnableRaisingEvents = true };
                worker.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { Receive(e.Data, true); };
                worker.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { Receive(e.Data, false); };
                worker.Exited += delegate {
                    worker.WaitForExit();
                    int code = worker.ExitCode;
                    if (!IsDisposed) BeginInvoke((Action)(() => Finish(code, null)));
                };
                if (!worker.Start()) throw new IOException("无法创建独立更新工作进程");
                worker.BeginOutputReadLine(); worker.BeginErrorReadLine();
                Write(Path.Combine(session, "host-ready.json"), new { session, hostPid = Process.GetCurrentProcess().Id,
                    workerPid = worker.Id, executable = Assembly.GetExecutingAssembly().Location, independent = true });
            } catch (Exception error) { Finish(1, error.Message); }
        }

        void Receive(string line, bool isProgress) {
            if (line == null) return;
            lock (logLock) { if (log != null) log.WriteLine(line); }
            if (!isProgress) return;
            try {
                // 每个回调使用自己的JSON解析器，避免stdout/stderr回调共享可变状态。
                var state = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line);
                string text = Convert.ToString(state["message"]);
                int percent = state.ContainsKey("progress") ? Convert.ToInt32(state["progress"]) : 0;
                if (!IsDisposed) BeginInvoke((Action)(() => { message.Text = text; progress.Value = Math.Max(0, Math.Min(100, percent)); }));
            } catch { }
        }

        void Finish(int code, string error) {
            if (finished) return;
            finished = true;
            lock (logLock) { if (log != null) { log.Dispose(); log = null; } }
            close.Enabled = true; close.Text = "关闭";
            if (code == 0) {
                Text = "VoxCPM Studio · 更新完成";
                message.Text = "更新完成，新版软件已启动。"; progress.Value = 100;
                var timer = new Timer { Interval = 1800 };
                timer.Tick += delegate { timer.Stop(); timer.Dispose(); Close(); }; timer.Start();
                return;
            }
            var state = new Dictionary<string, object>();
            string statusFile = Path.Combine(session, "status.json");
            try { if (File.Exists(statusFile)) state = Read(statusFile); } catch { }
            string reason = error ?? (state.ContainsKey("message") ? Convert.ToString(state["message"]) : "更新工作进程退出：" + code);
            if (!state.ContainsKey("status") || Convert.ToString(state["status"]) != "rolled-back") state["status"] = "error";
            state["message"] = reason; state["session"] = session;
            try {
                File.AppendAllText(Path.Combine(session, "updater.log"), "更新器错误：" + reason + Environment.NewLine, new UTF8Encoding(false));
                Write(statusFile, state);
                if (settings != null && settings.ContainsKey("resultPath")) Write(Convert.ToString(settings["resultPath"]), state);
            } catch { }
            Text = "VoxCPM Studio · 更新未完成";
            message.Text = "更新未完成：" + reason;
            detail.Text = "请保留原软件目录。日志位于：" + Path.Combine(session, "updater.log");
        }
    }
}
