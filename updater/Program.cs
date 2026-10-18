using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using VoxBootstrap;

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
        readonly SoftButton close = new SoftButton { Primary = true };
        readonly SoftButton logs = new SoftButton(), theme = new SoftButton(), minimize = new SoftButton(), windowClose = new SoftButton();
        readonly ToolTip tips = new ToolTip();
        readonly Timer animation = new Timer { Interval = 30 };
        readonly Stopwatch clock = Stopwatch.StartNew();
        readonly object logLock = new object();
        readonly bool preview;
        Bitmap brandMark;
        bool dark;
        int progressValue;
        string view = "working";
        Process worker;
        StreamWriter log;
        bool finished;
        Dictionary<string, object> settings;

        public UpdateForm(string folder, bool previewMode = false, bool? forceDark = null) {
            session = folder;
            preview = previewMode;
            try { settings = Read(Path.Combine(session, "session.json")); } catch { }
            dark = forceDark ?? (settings != null && settings.ContainsKey("theme") && Convert.ToString(settings["theme"]) == "dark");
            Text = "VoxCPM Studio · 独立更新器";
            ClientSize = new Size(720, 580);
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.None;
            DoubleBuffered = true;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Microsoft YaHei UI", 10);
            try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("app-mark.png"))
                if (stream != null) using (var image = Image.FromStream(stream)) brandMark = new Bitmap(image);
            message.Text = "正在校验更新，工作台将在准备完成后关闭…";
            message.AutoEllipsis = true;
            message.AccessibleName = "更新状态";
            detail.Text = "更新器准备完成后，工作台会自动关闭。";
            detail.AutoEllipsis = true;
            logs.Text = "查看更新日志"; logs.AccessibleName = "打开本次更新日志目录";
            logs.Click += delegate { Process.Start(new ProcessStartInfo("explorer.exe", Quote(session)) { UseShellExecute = true }); };
            close.Text = "正在更新，请稍候"; close.Enabled = false;
            close.Click += delegate { Close(); };
            theme.Glyph = dark ? ButtonGlyph.Sun : ButtonGlyph.Moon; theme.AccessibleName = "切换更新器主题";
            minimize.Glyph = ButtonGlyph.Minimize; minimize.AccessibleName = "最小化更新器";
            windowClose.Glyph = ButtonGlyph.Close; windowClose.AccessibleName = "关闭更新器"; windowClose.Enabled = false;
            theme.Click += delegate { ApplyTheme(!dark); };
            minimize.Click += delegate { WindowState = FormWindowState.Minimized; };
            windowClose.Click += delegate { Close(); };
            Controls.AddRange(new Control[] { message, detail, logs, close, theme, minimize, windowClose });
            FormClosing += delegate(object sender, FormClosingEventArgs e) { if (!finished) e.Cancel = true; };
            Shown += delegate { if (!preview) StartWorker(); };
            animation.Tick += delegate { if (!finished && progressValue >= 90) Invalidate(new Rectangle(40, 268, 640, 160)); };
            animation.Start();
            Resize += delegate { LayoutContent(); };
            ApplyTheme(dark); LayoutContent();
        }

        void ApplyTheme(bool value) {
            dark = value; BackColor = StudioTheme.Paper(dark); ForeColor = StudioTheme.Ink(dark);
            message.BackColor = detail.BackColor = StudioTheme.Card(dark);
            message.ForeColor = StudioTheme.Ink(dark); detail.ForeColor = StudioTheme.Muted(dark);
            foreach (var button in new[] { logs, close, theme, minimize, windowClose }) {
                button.Dark = dark; button.BackColor = BackColor; button.Invalidate();
            }
            theme.Glyph = dark ? ButtonGlyph.Sun : ButtonGlyph.Moon;
            tips.SetToolTip(theme, dark ? "切换浅色主题" : "切换深色主题");
            tips.SetToolTip(windowClose, finished ? "关闭更新器" : "安装完成后可关闭");
            Invalidate();
        }

        void LayoutContent() {
            float sx = ClientSize.Width / 720f, sy = ClientSize.Height / 580f;
            message.SetBounds((int)(64*sx), (int)(313*sy), (int)(592*sx), (int)(48*sy));
            detail.SetBounds((int)(64*sx), (int)(364*sy), (int)(592*sx), (int)(22*sy));
            message.Font = new Font("Microsoft YaHei UI", 18*sx, FontStyle.Bold, GraphicsUnit.Pixel);
            detail.Font = new Font("Microsoft YaHei UI", 12*sx, FontStyle.Regular, GraphicsUnit.Pixel);
            logs.SetBounds((int)(44*sx), (int)(514*sy), (int)(154*sx), (int)(46*sy));
            close.SetBounds((int)(458*sx), (int)(514*sy), (int)(220*sx), (int)(46*sy));
            theme.SetBounds((int)(594*sx), (int)(27*sy), (int)(28*sx), (int)(28*sy));
            minimize.SetBounds((int)(630*sx), (int)(27*sy), (int)(28*sx), (int)(28*sy));
            windowClose.SetBounds((int)(666*sx), (int)(27*sy), (int)(28*sx), (int)(28*sy));
            foreach (var button in new[] { logs, close, theme, minimize, windowClose }) button.Font = new Font("Microsoft YaHei UI", 10*sx);
            using (var shape = StudioTheme.Round(new RectangleF(0,0,ClientSize.Width,ClientSize.Height),22*sx)) {
                var old = Region; Region = new Region(shape); if (old != null) old.Dispose();
            }
            Invalidate();
        }

        protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ClassStyle |= 0x20000; return p; } }
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool ReleaseCapture();
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
        protected override void OnMouseDown(MouseEventArgs e) {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Left && e.Y < ClientSize.Height*.16 && e.X < ClientSize.Width*.81) {
                ReleaseCapture(); SendMessage(Handle,0xA1,new IntPtr(2),IntPtr.Zero);
            }
        }

        static void TextAt(Graphics g, string text, float size, Color color, RectangleF bounds, bool bold = false) {
            using (var font = new Font("Microsoft YaHei UI", size, bold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel))
            using (var brush = new SolidBrush(color))
            using (var format = new StringFormat { Trimming = StringTrimming.EllipsisCharacter }) g.DrawString(text,font,brush,bounds,format);
        }

        protected override void OnPaint(PaintEventArgs e) {
            base.OnPaint(e);
            var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            g.ScaleTransform(ClientSize.Width/720f,ClientSize.Height/580f);
            Color ink=StudioTheme.Ink(dark), muted=StudioTheme.Muted(dark), accent=StudioTheme.Accent(dark), paper=StudioTheme.Paper(dark);
            using (var shape=StudioTheme.Round(new RectangleF(.5f,.5f,719,579),22)) using(var pen=new Pen(StudioTheme.Border(dark))) g.DrawPath(pen,shape);
            if (brandMark != null) g.DrawImage(brandMark,new Rectangle(36,28,50,50));
            TextAt(g,"VOXCPM",14,ink,new RectangleF(92,35,160,22),true); TextAt(g,"STUDIO",10,muted,new RectangleF(93,57,140,20));
            TextAt(g,"独立更新器",11,muted,new RectangleF(470,43,112,20));
            TextAt(g,view=="error"?"更新暂未完成。":finished?"更新完成，继续创作。":"更新交给我们。",31,ink,new RectangleF(40,133,420,48));
            TextAt(g,view=="error"?"请保留原目录，查看日志了解原因。":"独立完成更新，准备好后自动回到工作台。",14,muted,new RectangleF(43,184,390,42));
            using(var pen=new Pen(dark?Color.FromArgb(48,52,46):Color.FromArgb(234,232,221))) { g.DrawEllipse(pen,470,109,150,150); g.DrawEllipse(pen,493,132,104,104); }
            for(int i=0;i<37;i++) {
                double envelope=Math.Pow(Math.Sin((i+1)*Math.PI/38),1.8);
                float height=(float)(8+envelope*(20+42*Math.Abs(Math.Sin(i*.69))));
                using(var pen=new Pen(i>14&&i<24?accent:(dark?Color.FromArgb(115,120,108):Color.FromArgb(181,186,171)),2.8f) { StartCap=LineCap.Round,EndCap=LineCap.Round }) g.DrawLine(pen,444+i*5.7f,184-height/2,444+i*5.7f,184+height/2);
            }
            using(var shape=StudioTheme.Round(new RectangleF(42,268,636,158),18)) using(var brush=new SolidBrush(StudioTheme.Card(dark))) g.FillPath(brush,shape);
            TextAt(g,view=="error"?"需要处理":"软件更新",12,muted,new RectangleF(64,286,380,22));
            TextAt(g,view=="error"?"未完成":finished?"已完成":progressValue>=90?"启动检查":progressValue+"%",12,muted,new RectangleF(578,286,78,22));
            RectangleF bar=new RectangleF(64,391,592,5);
            using(var shape=StudioTheme.Round(bar,2.5f)) using(var brush=new SolidBrush(StudioTheme.Track(dark))) g.FillPath(brush,shape);
            if(!finished && progressValue>=90) {
                var saved=g.Save(); g.SetClip(bar);
                float moving=(float)((clock.Elapsed.TotalSeconds%2.8)/2.8*740)-148;
                using(var brush=new SolidBrush(accent)) g.FillRectangle(brush,64+moving,391,148,5); g.Restore(saved);
            } else if(progressValue>0) using(var shape=StudioTheme.Round(new RectangleF(64,391,(float)(592*progressValue/100.0),5),2.5f)) using(var brush=new SolidBrush(accent)) g.FillPath(brush,shape);
            TextAt(g,view=="error"?"查看日志了解原因，原目录与个人数据会保留。":"独立运行 · 安装完成后自动打开新版",10,muted,new RectangleF(64,405,592,18));
            int phase=finished&&view!="error"?3:progressValue<30?0:progressValue<90?1:2;
            string[] steps={"核验更新","安装文件","启动检查","更新完成"};
            for(int i=0;i<4;i++) {
                int x=44+i*159; bool active=i==phase;
                using(var brush=new SolidBrush(active?accent:StudioTheme.Track(dark))) g.FillEllipse(brush,x,450,20,20);
                TextAt(g,i<phase?"✓":(i+1).ToString(),10,active?paper:muted,new RectangleF(x+5,453,20,18));
                TextAt(g,steps[i],11,active?ink:muted,new RectangleF(x+29,453,95,20));
                if(i<3) using(var pen=new Pen(StudioTheme.Track(dark))) g.DrawLine(pen,x+118,460,x+145,460);
            }
            using(var brush=new SolidBrush(accent)) g.FillEllipse(brush,44,485,5,5);
            TextAt(g,"模型、配置与作品都会保留",11,muted,new RectangleF(56,479,500,22));
        }

        void UpdateProgress(string text, int percent) {
            message.Text=text; progressValue=Math.Max(0,Math.Min(100,percent));
            detail.Text=progressValue>=90?"首次准备可能需要一些时间，请保持窗口打开。":progressValue>=30?"正在替换应用文件，个人数据会保留。":"更新器准备完成后，工作台会自动关闭。";
            tips.SetToolTip(message,text); AccessibleDescription=text; Invalidate();
        }

        public void SetPreview(string state, int percent) {
            view=state; finished=state=="complete" || state=="error";
            UpdateProgress(state=="error"?"更新未完成：新版启动检查超时，已恢复原版本。":state=="complete"?"更新完成，新版软件已启动。":state=="long"?"正在校验包含中文和空格的应用文件，随后将等待工作台退出并完成安装，请保持更新窗口打开。":percent>=90?"正在重启并检查本地服务…":percent>=30?"正在安装更新文件 68/108":"正在校验更新，工作台将在准备完成后关闭…",percent);
            close.Enabled=windowClose.Enabled=finished;
            close.Text=finished?"关闭更新器":"正在更新，请稍候";
            if(state=="error") detail.Text="请查看更新日志，原版本和个人数据已保留。";
            if(state=="complete") detail.Text="所有检查已通过，可以继续创作。";
            Invalidate();
        }

        protected override void Dispose(bool disposing) {
            if(disposing) { animation.Stop(); animation.Dispose(); tips.Dispose(); if(brandMark!=null) brandMark.Dispose(); }
            base.Dispose(disposing);
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
                if (!IsDisposed) BeginInvoke((Action)(() => UpdateProgress(text,percent)));
            } catch { }
        }

        void Finish(int code, string error) {
            if (finished) return;
            finished = true;
            animation.Stop();
            lock (logLock) { if (log != null) { log.Dispose(); log = null; } }
            close.Enabled = true; close.Text = "关闭";
            windowClose.Enabled = true; tips.SetToolTip(windowClose,"关闭更新器");
            if (code == 0) {
                Text = "VoxCPM Studio · 更新完成";
                message.Text = "更新完成，新版软件已启动。"; progressValue = 100;
                detail.Text = "所有检查已通过，可以继续创作。"; view = "complete"; Invalidate();
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
            detail.Text = Convert.ToString(state["status"]) == "rolled-back" ? "已恢复原版本，请查看日志后重试。" : "请保留原目录，按日志提示处理后重试。";
            view = "error"; tips.SetToolTip(message,reason); AccessibleDescription=reason+" 日志："+Path.Combine(session,"updater.log"); Invalidate();
        }
    }
}
