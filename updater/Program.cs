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
        readonly bool repairMode;
        readonly bool maintenance;
        readonly bool promptMode;
        readonly Timer promptTimer = new Timer { Interval = 250 };
        readonly TextBox releaseNotes = new TextBox { Multiline = true, ReadOnly = true, BorderStyle = BorderStyle.None, ScrollBars = ScrollBars.Vertical };
        bool promptWorking;
        bool healthy;
        readonly TextBox repairRoot = new TextBox();
        readonly SoftButton browseRoot = new SoftButton();
        bool repairStarted;
        public int ResultCode { get; private set; }
        Bitmap brandMark;
        bool dark;
        int progressValue;
        string view = "working";
        Process worker;
        StreamWriter log;
        bool finished;
        Dictionary<string, object> settings;

        public UpdateForm(string folder, bool previewMode = false, bool? forceDark = null, bool repair = false) {
            session = folder;
            preview = previewMode;
            repairMode = repair;
            ResultCode = 1;
            try { settings = Read(Path.Combine(session, "session.json")); } catch { }
            maintenance = settings != null && settings.ContainsKey("maintenance") && (bool)settings["maintenance"];
            promptMode = !repairMode && settings != null && settings.ContainsKey("mode") && Convert.ToString(settings["mode"]) == "prompt";
            dark = forceDark ?? (settings != null && settings.ContainsKey("theme") && Convert.ToString(settings["theme"]) == "dark");
            Text = maintenance ? "VoxCPM Studio · 安装与修复" : repairMode ? "VoxCPM Studio · 更新修复器" : "VoxCPM Studio · 独立更新器";
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
            logs.Click += delegate { if (promptMode) { ChooseUpdate("later"); Close(); } else Process.Start(new ProcessStartInfo("explorer.exe", Quote(session)) { UseShellExecute = true }); };
            close.Text = "正在更新，请稍候"; close.Enabled = false;
            close.Click += delegate { if (promptMode) ChooseUpdate("now"); else if(maintenance && finished && ResultCode==0) {
                var start=new ProcessStartInfo(Path.Combine(Convert.ToString(settings["repairRoot"]),"VoxCPM Studio.exe"),"--voxcpm-run --voxcpm-show") {UseShellExecute=false,WorkingDirectory=Convert.ToString(settings["repairRoot"])};
                start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
                Process.Start(start); Close();
            } else if (repairMode && (!repairStarted || (finished && ResultCode != 0))) BeginRepair(); else Close(); };
            theme.Glyph = dark ? ButtonGlyph.Sun : ButtonGlyph.Moon; theme.AccessibleName = "切换更新器主题";
            minimize.Glyph = ButtonGlyph.Minimize; minimize.AccessibleName = "最小化更新器";
            windowClose.Glyph = ButtonGlyph.Close; windowClose.AccessibleName = "关闭更新器"; windowClose.Enabled = false;
            // .NET Framework 的 UIA 桥接用 Text 作为图标按钮名称；绘制仍使用 Glyph。
            theme.Text = theme.AccessibleName; minimize.Text = minimize.AccessibleName; windowClose.Text = windowClose.AccessibleName;
            theme.Click += delegate { ApplyTheme(!dark); };
            minimize.Click += delegate { WindowState = FormWindowState.Minimized; };
            windowClose.Click += delegate { Close(); };
            Controls.AddRange(new Control[] { message, detail, logs, close, theme, minimize, windowClose });
            if (repairMode) {
                repairRoot.BorderStyle = BorderStyle.None; repairRoot.AccessibleName = "原软件安装目录";
                repairRoot.Text = settings != null && settings.ContainsKey("repairRoot") ? Convert.ToString(settings["repairRoot"]) : "";
                browseRoot.Text = "选择目录"; browseRoot.AccessibleName = "选择原软件安装目录";
                browseRoot.Click += delegate { using(var picker=new FolderBrowserDialog { Description="请选择包含 VoxCPM Studio.exe 的原安装目录，不要新建目录",ShowNewFolderButton=false }) {
                    if(Directory.Exists(repairRoot.Text)) picker.SelectedPath=repairRoot.Text;
                    if(picker.ShowDialog(this)==DialogResult.OK) repairRoot.Text=picker.SelectedPath;
                } };
                Controls.Add(repairRoot); Controls.Add(browseRoot);
                message.Visible = false; close.Enabled = windowClose.Enabled = true; close.Text = "开始修复并升级  →";
                detail.Text = maintenance ? "正在检查已安装程序；发现问题后自动修复，保留模型与作品。" : "请先保存任务；修复会自动关闭并强制结束本目录残留进程。";
            }
            if (promptMode) {
                Controls.Add(releaseNotes);
                releaseNotes.AccessibleName = "新版更新说明";
                releaseNotes.Text = settings.ContainsKey("notes") ? Convert.ToString(settings["notes"]) : "改进软件体验与稳定性。";
                releaseNotes.TabStop = true;
                view = "prompt"; close.Text = "现在更新"; logs.Text = "下次启动更新";
                close.AccessibleName = "现在更新"; logs.AccessibleName = "下次启动更新";
                close.Enabled = windowClose.Enabled = true;
                message.Text = "VoxCPM Studio " + Convert.ToString(settings["version"]) + " · " + (Convert.ToDouble(settings["size"]) / 1048576).ToString("0.0") + " MB";
                detail.Visible = false;
                tips.SetToolTip(message, "发布序号 " + (settings.ContainsKey("releaseId") ? Convert.ToString(settings["releaseId"]) : ""));
            }
            FormClosing += delegate(object sender, FormClosingEventArgs e) {
                if (promptMode) { if (promptWorking && !finished) e.Cancel = true; else if (!finished) ChooseUpdate("later"); }
                else if (!finished && (!repairMode || repairStarted)) e.Cancel = true;
            };
            Shown += delegate {
                if (!preview && promptMode) {
                    Write(Path.Combine(session, "prompt-ready.json"), new { session, hostPid = Process.GetCurrentProcess().Id });
                    promptTimer.Tick += delegate { PollPrompt(); }; promptTimer.Start(); Activate();
                }
                else if (!preview && !repairMode) StartWorker();
                else if (!preview && repairMode && settings != null && settings.ContainsKey("autoRepair") && (bool)settings["autoRepair"]) BeginRepair();
            };
            animation.Tick += delegate { if (!finished && progressValue >= 90) Invalidate(new Rectangle(40, 268, 640, 160)); };
            animation.Start();
            Resize += delegate { LayoutContent(); };
            ApplyTheme(dark); LayoutContent();
        }

        void ApplyTheme(bool value) {
            dark = value; BackColor = StudioTheme.Paper(dark); ForeColor = StudioTheme.Ink(dark);
            message.BackColor = detail.BackColor = repairRoot.BackColor = StudioTheme.Card(dark);
            releaseNotes.BackColor = StudioTheme.Card(dark); releaseNotes.ForeColor = StudioTheme.Muted(dark);
            repairRoot.ForeColor = StudioTheme.Ink(dark);
            message.ForeColor = StudioTheme.Ink(dark); detail.ForeColor = StudioTheme.Muted(dark);
            foreach (var button in new[] { logs, close, theme, minimize, windowClose, browseRoot }) {
                button.Dark = dark; button.BackColor = BackColor; button.Invalidate();
            }
            theme.Glyph = dark ? ButtonGlyph.Sun : ButtonGlyph.Moon;
            tips.SetToolTip(theme, dark ? "切换浅色主题" : "切换深色主题");
            tips.SetToolTip(windowClose, promptMode && !promptWorking ? "下次启动更新" : finished || (repairMode && !repairStarted) ? "关闭窗口" : "完成后可关闭");
            Invalidate();
        }

        void LayoutContent() {
            if (WindowState == FormWindowState.Minimized || ClientSize.Width <= 0 || ClientSize.Height <= 0) return;
            float sx = ClientSize.Width / 720f, sy = ClientSize.Height / 580f;
            message.SetBounds((int)(64*sx), (int)(313*sy), (int)(592*sx), (int)(48*sy));
            detail.SetBounds((int)(64*sx), (int)(364*sy), (int)(592*sx), (int)(22*sy));
            releaseNotes.SetBounds((int)(64*sx), (int)(350*sy), (int)(592*sx), (int)(62*sy));
            releaseNotes.Font = new Font("Microsoft YaHei UI", 12*sx, FontStyle.Regular, GraphicsUnit.Pixel);
            if (promptMode && !promptWorking) message.Height = (int)(32*sy);
            message.Font = new Font("Microsoft YaHei UI", 18*sx, FontStyle.Bold, GraphicsUnit.Pixel);
            detail.Font = new Font("Microsoft YaHei UI", 12*sx, FontStyle.Regular, GraphicsUnit.Pixel);
            logs.SetBounds((int)(44*sx), (int)(514*sy), (int)(154*sx), (int)(46*sy));
            close.SetBounds((int)(458*sx), (int)(514*sy), (int)(220*sx), (int)(46*sy));
            theme.SetBounds((int)(594*sx), (int)(27*sy), (int)(28*sx), (int)(28*sy));
            minimize.SetBounds((int)(630*sx), (int)(27*sy), (int)(28*sx), (int)(28*sy));
            windowClose.SetBounds((int)(666*sx), (int)(27*sy), (int)(28*sx), (int)(28*sy));
            repairRoot.SetBounds((int)(64*sx),(int)(321*sy),(int)(485*sx),(int)(25*sy));
            browseRoot.SetBounds((int)(562*sx),(int)(311*sy),(int)(94*sx),(int)(38*sy));
            repairRoot.Font = new Font("Microsoft YaHei UI",13*sx,FontStyle.Regular,GraphicsUnit.Pixel);
            foreach (var button in new[] { logs, close, theme, minimize, windowClose, browseRoot }) button.Font = new Font("Microsoft YaHei UI", 10*sx);
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
            if (WindowState == FormWindowState.Minimized || ClientSize.Width <= 0 || ClientSize.Height <= 0) return;
            var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            g.ScaleTransform(ClientSize.Width/720f,ClientSize.Height/580f);
            Color ink=StudioTheme.Ink(dark), muted=StudioTheme.Muted(dark), accent=StudioTheme.Accent(dark), paper=StudioTheme.Paper(dark);
            using (var shape=StudioTheme.Round(new RectangleF(.5f,.5f,719,579),22)) using(var pen=new Pen(StudioTheme.Border(dark))) g.DrawPath(pen,shape);
            if (brandMark != null) g.DrawImage(brandMark,new Rectangle(36,28,50,50));
            TextAt(g,"VOXCPM",14,ink,new RectangleF(92,35,160,22),true); TextAt(g,"STUDIO",10,muted,new RectangleF(93,57,140,20));
            TextAt(g,maintenance?"安装与修复":repairMode?"更新修复器":"独立更新器",11,muted,new RectangleF(470,43,112,20));
            TextAt(g,view=="prompt"?"发现新版本。":healthy?"一切正常，开始创作吧。":maintenance && !finished?"检查一下，安心创作。":view=="error"?(repairMode?"修复需要处理。":"更新暂未完成。"):finished?(repairMode?"修复完成，安心创作。":"更新完成，继续创作。"):repairMode?"修好更新，安心创作。":"更新交给我们。",31,ink,new RectangleF(40,133,420,48));
            TextAt(g,view=="prompt"?"现在更新，或留到下次启动再决定。":healthy?"无需再次安装，你的创作空间已准备好。":maintenance?"检查安装完整性，有问题自动修复。":view=="error"?(promptMode?"工作台保持运行，可以重试或下次启动更新。":"请保留原目录，查看日志了解原因。"):repairMode?"修复旧版更新通道，保留模型与作品。":"独立完成更新，准备好后自动回到工作台。",14,muted,new RectangleF(43,184,390,42));
            using(var pen=new Pen(dark?Color.FromArgb(48,52,46):Color.FromArgb(234,232,221))) { g.DrawEllipse(pen,470,109,150,150); g.DrawEllipse(pen,493,132,104,104); }
            for(int i=0;i<37;i++) {
                double envelope=Math.Pow(Math.Sin((i+1)*Math.PI/38),1.8);
                float height=(float)(8+envelope*(20+42*Math.Abs(Math.Sin(i*.69))));
                using(var pen=new Pen(i>14&&i<24?accent:(dark?Color.FromArgb(115,120,108):Color.FromArgb(181,186,171)),2.8f) { StartCap=LineCap.Round,EndCap=LineCap.Round }) g.DrawLine(pen,444+i*5.7f,184-height/2,444+i*5.7f,184+height/2);
            }
            using(var shape=StudioTheme.Round(new RectangleF(42,268,636,158),18)) using(var brush=new SolidBrush(StudioTheme.Card(dark))) g.FillPath(brush,shape);
            TextAt(g,maintenance?"安装检查与修复":view=="error"?"需要处理":repairMode&&!repairStarted?"原软件安装目录":repairMode?"修复与升级":"软件更新",12,muted,new RectangleF(64,286,380,22));
            TextAt(g,view=="prompt"?"待选择":view=="error"?"未完成":finished?"已完成":repairMode&&!repairStarted?"待开始":progressValue>=90?"验证中":progressValue+"%",12,muted,new RectangleF(578,286,78,22));
            RectangleF bar=new RectangleF(64,391,592,5);
            if(view!="prompt") using(var shape=StudioTheme.Round(bar,2.5f)) using(var brush=new SolidBrush(StudioTheme.Track(dark))) g.FillPath(brush,shape);
            if(view!="prompt" && !finished && progressValue>=90) {
                var saved=g.Save(); g.SetClip(bar);
                float moving=(float)((clock.Elapsed.TotalSeconds%2.8)/2.8*740)-148;
                using(var brush=new SolidBrush(accent)) g.FillRectangle(brush,64+moving,391,148,5); g.Restore(saved);
            } else if(progressValue>0) using(var shape=StudioTheme.Round(new RectangleF(64,391,(float)(592*progressValue/100.0),5),2.5f)) using(var brush=new SolidBrush(accent)) g.FillPath(brush,shape);
            if(view!="prompt") TextAt(g,view=="error"?(promptMode?"可直接重试更新，或选择下次启动更新。":"查看日志了解原因，原目录与个人数据会保留。"):repairMode?"自带修复环境 · 无需安装开发工具":"独立运行 · 安装完成后自动打开新版",10,muted,new RectangleF(64,405,592,18));
            int phase=promptMode?(promptWorking?1:0):finished&&view!="error"?3:progressValue<30?0:progressValue<90?1:2;
            string[] steps=promptMode?new[] {"选择时间","下载校验","独立安装","回到工作台"}:maintenance?new[] {"识别安装","检查文件","环境与修复","最终复检"}:repairMode?new[] {"检查旧版","修复升级","启动验证","通道验证"}:new[] {"核验更新","安装文件","启动检查","更新完成"};
            for(int i=0;i<4;i++) {
                int x=44+i*159; bool active=i==phase;
                using(var brush=new SolidBrush(active?accent:StudioTheme.Track(dark))) g.FillEllipse(brush,x,450,20,20);
                TextAt(g,i<phase?"✓":(i+1).ToString(),10,active?paper:muted,new RectangleF(x+5,453,20,18));
                TextAt(g,steps[i],11,active?ink:muted,new RectangleF(x+29,453,95,20));
                if(i<3) using(var pen=new Pen(StudioTheme.Track(dark))) g.DrawLine(pen,x+118,460,x+145,460);
            }
            using(var brush=new SolidBrush(accent)) g.FillEllipse(brush,44,485,5,5);
            TextAt(g,promptMode?"更新前请保存作品，并结束生成或训练任务。":"模型、配置与作品都会保留",11,muted,new RectangleF(56,479,590,22));
        }

        void ChooseUpdate(string action) {
            if (promptWorking || finished) return;
            Write(Path.Combine(session,"choice.json"),new { session, hostPid=Process.GetCurrentProcess().Id, action });
            if (action=="later") { finished=true; return; }
            promptWorking=true; view="working"; releaseNotes.Visible=false; detail.Visible=true;
            close.Enabled=logs.Enabled=windowClose.Enabled=false; close.Text="正在准备更新…";
            UpdateProgress("正在准备下载与校验…",0); LayoutContent();
        }

        void PollPrompt() {
            try {
                try { using(var parent=Process.GetProcessById(Convert.ToInt32(settings["parentPid"]))) if(parent.HasExited) { finished=true; Close(); return; } }
                catch(ArgumentException) { finished=true; Close(); return; }
                string file=Path.Combine(session,"prompt-state.json");
                if(!File.Exists(file)) return;
                var state=Read(file); string status=Convert.ToString(state["status"]);
                if(status=="closed") { finished=true; Close(); return; }
                if(status=="error") {
                    promptWorking=false; view="error"; releaseNotes.Visible=false; detail.Visible=true;
                    message.Text=Convert.ToString(state["message"]); tips.SetToolTip(message,message.Text);
                    detail.Text="工作台保持运行，可重试；模型、配置与作品会保留。";
                    close.Text="重试更新"; close.Enabled=logs.Enabled=windowClose.Enabled=true;
                    AccessibleDescription=message.Text; Invalidate(); return;
                }
                if(status=="downloading" || status=="downloaded" || status=="installing") {
                    promptWorking=true; view="working"; releaseNotes.Visible=false; detail.Visible=true;
                    close.Enabled=logs.Enabled=windowClose.Enabled=false;
                    int progress=state.ContainsKey("progress")?Convert.ToInt32(state["progress"]):0;
                    UpdateProgress(Convert.ToString(state["message"]),Math.Min(89,progress));
                    detail.Text="自动完成下载、校验与安装，准备就绪后才关闭工作台。";
                }
            } catch(IOException) { /* 原子文件交接时下一次读取。 */ }
              catch(InvalidOperationException) { /* 文件替换窗口，稍后重读。 */ }
              catch(ArgumentException) { /* 文件尚未完整可读，稍后重读。 */ }
        }

        void UpdateProgress(string text, int percent) {
            message.Text=text; progressValue=Math.Max(0,Math.Min(100,percent));
            detail.Text=progressValue>=90?"首次准备可能需要一些时间，请保持窗口打开。":progressValue>=30?"正在替换应用文件，个人数据会保留。":repairMode?"正在自动清理本目录的工作台与隐藏进程，请稍候。":"更新器准备完成后，工作台会自动关闭。";
            tips.SetToolTip(message,text); AccessibleDescription=text; Invalidate();
        }

        void BeginRepair() {
            string root=repairRoot.Text.Trim().Trim('"');
            if(File.Exists(root)) root=Path.GetDirectoryName(root);
            if(String.IsNullOrWhiteSpace(root) || !Directory.Exists(root)) {
                detail.Text="请先选择原软件安装目录。";
                if(settings.ContainsKey("exitOnComplete") && (bool)settings["exitOnComplete"]) Finish(1,detail.Text);
                return;
            }
            settings["repairRoot"]=Path.GetFullPath(root);
            Write(Path.Combine(session,"session.json"),settings);
            Write(Path.Combine(session,"repair-request.json"),new { root=Path.GetFullPath(root), work=session,
                maintenance=maintenance, payload=Convert.ToString(settings["payload"]), resultPath=Convert.ToString(settings["resultPath"]) });
            foreach(string name in new[] {"status.json","host-ready.json"}) if(File.Exists(Path.Combine(session,name))) File.Delete(Path.Combine(session,name));
            finished=false; repairStarted=true; view="working"; ResultCode=1;
            repairRoot.Visible=browseRoot.Visible=false; message.Visible=true;
            close.Enabled=windowClose.Enabled=false; close.Text=maintenance?"正在检查，请稍候":"正在修复，请稍候";
            UpdateProgress("正在检查原安装与更新通道…",0); animation.Start(); StartWorker();
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
            if(disposing) { promptTimer.Stop(); promptTimer.Dispose(); animation.Stop(); animation.Dispose(); tips.Dispose(); if(brandMark!=null) brandMark.Dispose(); }
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
                string script = repairMode ? Convert.ToString(settings["workerScript"]) : Path.Combine(session,"updater.py");
                if (!File.Exists(python) || !File.Exists(script)) throw new IOException("已校验的更新脚本或Python运行环境不存在");
                log = new StreamWriter(new FileStream(Path.Combine(session, "updater.log"), FileMode.Append, FileAccess.Write, FileShare.ReadWrite), new UTF8Encoding(false)); log.AutoFlush = true;
                string arguments = repairMode ? "-B -u " + Quote(script) + " --request " + Quote(Path.Combine(session,"repair-request.json")) : "-B -u " + Quote(script) + " " + Quote(session) + " --worker";
                var start = new ProcessStartInfo(python, arguments) {
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
            ResultCode = code;
            animation.Stop();
            lock (logLock) { if (log != null) { log.Dispose(); log = null; } }
            close.Enabled = true; close.Text = "关闭";
            windowClose.Enabled = true; tips.SetToolTip(windowClose,"关闭更新器");
            if (code == 0) {
                Text = repairMode ? "VoxCPM Studio · 修复完成" : "VoxCPM Studio · 更新完成";
                message.Text = repairMode ? "修复完成，更新通道已验证。" : "更新完成，新版软件已启动。"; progressValue = 100;
                detail.Text = repairMode ? "后续请在软件内检查更新，无需重复运行修复器。" : "所有检查已通过，可以继续创作。"; view = "complete"; Invalidate();
                if(maintenance) {
                    var result=Read(Path.Combine(session,"status.json"));
                    healthy=result.ContainsKey("status") && Convert.ToString(result["status"])=="healthy";
                    Text=healthy?"VoxCPM Studio · 一切正常":"VoxCPM Studio · 修复完成";
                    message.Text=healthy?"一切正常，无需再次安装。":"问题已修复，开始创作吧。";
                    detail.Text=healthy?"开始创作吧！已有作品、模型和设置保持完好。":"修复后检查已通过，作品、模型与设置已保留。";
                    close.Text="开始创作  →"; AccessibleDescription=Convert.ToString(result["message"]); Invalidate();
                }
                if(repairMode && (!settings.ContainsKey("exitOnComplete") || !(bool)settings["exitOnComplete"])) return;
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
            if(repairMode) { Text="VoxCPM Studio · 修复需要处理"; close.Text="重新检测并修复"; }
            message.Text = "更新未完成：" + reason;
            detail.Text = Convert.ToString(state["status"]) == "rolled-back" ? "已恢复原版本，请查看日志后重试。" : "请保留原目录，按日志提示处理后重试。";
            view = "error"; tips.SetToolTip(message,reason); AccessibleDescription=reason+" 日志："+Path.Combine(session,"updater.log"); Invalidate();
            if(repairMode && settings.ContainsKey("exitOnComplete") && (bool)settings["exitOnComplete"]) {
                var timer=new Timer { Interval=1200 }; timer.Tick+=delegate { timer.Stop(); timer.Dispose(); Close(); }; timer.Start();
            }
        }
    }
}
