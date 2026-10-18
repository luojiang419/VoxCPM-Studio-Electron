using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Windows.Forms;

namespace VoxBootstrap {
    // 仅有自绘横向滚动，不启用 Windows 原生滚动条。
    public sealed class DiskStrip : Panel {
        readonly bool dark;
        readonly Timer animation = new Timer { Interval=16 };
        readonly Stopwatch clock = new Stopwatch();
        double offset, from, target;
        int contentWidth;
        bool layingOut, dragging;
        float dragStart;
        double dragOffset;
        public bool HasOverflow { get { return contentWidth > ClientSize.Width; } }
        public double ScrollOffset { get { return offset; } }
        public DiskStrip(bool darkMode) {
            dark=darkMode; AutoScroll=false;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer,true);
            animation.Tick += (sender,args) => AdvanceScrollAnimation(clock.Elapsed.TotalMilliseconds/300);
        }
        protected override void OnControlAdded(ControlEventArgs e) {
            base.OnControlAdded(e);
            e.Control.Enter += (sender,args) => EnsureCardVisible(e.Control);
            e.Control.MouseWheel += (sender,args) => ScrollWheel(args);
        }
        void EnsureCardVisible(Control card) {
            double left=card.Left+offset, right=left+card.Width;
            if (left<offset) ScrollToOffset(left); else if (right>offset+ClientSize.Width) ScrollToOffset(right-ClientSize.Width);
        }
        protected override void OnLayout(LayoutEventArgs e) {
            base.OnLayout(e); if (layingOut) return;
            layingOut=true;
            try {
                contentWidth=0; foreach(Control card in Controls) contentWidth+=card.Width+card.Margin.Right;
                offset=Math.Max(0,Math.Min(offset,contentWidth-ClientSize.Width));
                int x=-(int)Math.Round(offset);
                foreach(Control card in Controls) { card.Location=new Point(x,0); x+=card.Width+card.Margin.Right; }
            } finally { layingOut=false; }
            Invalidate();
        }
        public void ScrollToOffset(double value, bool animate=true) {
            target=Math.Max(0,Math.Min(value,Math.Max(0,contentWidth-ClientSize.Width))); from=offset;
            if (animate) { clock.Restart(); animation.Start(); } else AdvanceScrollAnimation(1);
        }
        public void AdvanceScrollAnimation(double progress) {
            offset=from+(target-from)*BezierMotion.Ease(progress);
            if(progress>=1) { animation.Stop(); clock.Stop(); }
            PerformLayout(); Invalidate();
        }
        RectangleF Thumb() {
            if(!HasOverflow) return RectangleF.Empty;
            float width=Math.Max(42,ClientSize.Width*(float)ClientSize.Width/contentWidth);
            float x=(float)(offset/Math.Max(1,contentWidth-ClientSize.Width))*(ClientSize.Width-width);
            return new RectangleF(x,ClientSize.Height-9,width,5);
        }
        protected override void OnPaint(PaintEventArgs e) {
            base.OnPaint(e); if(!HasOverflow) return;
            e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;
            using(var path=Launcher.Round(new RectangleF(0,Height-9,Width,5),2.5f))
            using(var fill=new SolidBrush(dark?Color.FromArgb(57,64,53):Color.FromArgb(227,231,218))) e.Graphics.FillPath(fill,path);
            using(var path=Launcher.Round(Thumb(),2.5f))
            using(var fill=new SolidBrush(dark?Color.FromArgb(185,151,109):Color.FromArgb(165,153,123))) e.Graphics.FillPath(fill,path);
        }
        void ScrollWheel(MouseEventArgs e) {
            if(!HasOverflow) return;
            ScrollToOffset((animation.Enabled?target:offset)-Math.Sign(e.Delta)*150);
            var handled=e as HandledMouseEventArgs; if(handled!=null) handled.Handled=true;
        }
        protected override void OnMouseWheel(MouseEventArgs e) { ScrollWheel(e); }
        protected override void OnMouseDown(MouseEventArgs e) {
            base.OnMouseDown(e); if(!HasOverflow || e.Button!=MouseButtons.Left || e.Y<Height-16) return;
            if(Thumb().Contains(e.Location)) { dragging=true; dragStart=e.X; dragOffset=offset; Capture=true; animation.Stop(); }
            else ScrollToOffset(offset+(e.X<Thumb().Left?-ClientSize.Width*.7:ClientSize.Width*.7));
        }
        protected override void OnMouseMove(MouseEventArgs e) {
            base.OnMouseMove(e);
            if(dragging) ScrollToOffset(dragOffset+(e.X-dragStart)*(contentWidth-ClientSize.Width)/Math.Max(1,ClientSize.Width-Thumb().Width),false);
        }
        protected override void OnMouseUp(MouseEventArgs e) { base.OnMouseUp(e); dragging=false; Capture=false; }
        protected override void Dispose(bool disposing) { if(disposing) animation.Dispose(); base.Dispose(disposing); }
    }
    public static class BezierMotion {
        // CSS cubic-bezier(.22, 1, .36, 1)：先反解 x(t)，再计算 y(t)。
        public static double Ease(double progress) {
            if (progress <= 0) return 0; if (progress >= 1) return 1;
            double low = 0, high = 1, t = progress;
            for (int i = 0; i < 22; i++) {
                t = (low + high) / 2; double u = 1 - t;
                double x = 3*u*u*t*.22 + 3*u*t*t*.36 + t*t*t;
                if (x < progress) low = t; else high = t;
            }
            return 1 - Math.Pow(1-t, 3);
        }
    }
    public sealed class DiskCard : Control {
        readonly Image icon;
        readonly bool dark;
        readonly Timer motion = new Timer { Interval = 16 };
        readonly Stopwatch elapsed = new Stopwatch();
        bool selected, hovering;
        double blend, scale = 1, fromBlend, fromScale = 1, toBlend, toScale = 1;
        public readonly InstallDrive Drive;
        public string Detail;
        public bool Selected { get { return selected; } }
        public double IconScale { get { return scale; } }
        public bool IsAnimating { get { return motion.Enabled; } }
        public DiskCard(InstallDrive drive, Image image, bool darkMode, string detail) {
            Drive = drive; icon = image; dark = darkMode; Detail = detail;
            Name = "drive-" + drive.root.Substring(0,1).ToUpperInvariant();
            AccessibleName = drive.root.Substring(0,2) + " 本地磁盘"; AccessibleDescription = detail;
            AccessibleRole = AccessibleRole.RadioButton; TabStop = true; Cursor = Cursors.Hand;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.Selectable, true);
            BackColor = dark ? Color.FromArgb(29,31,29) : Color.FromArgb(251,250,247);
            motion.Tick += (sender, args) => AdvanceAnimation(elapsed.Elapsed.TotalMilliseconds / 380);
        }
        public void SetSelected(bool value, bool animate = true) {
            selected = value; AccessibleDescription = (selected ? "已选中；" : "") + Detail;
            Retarget(); if (!animate) AdvanceAnimation(1);
        }
        void Retarget() {
            fromBlend = blend; fromScale = scale; toBlend = selected ? 1 : 0;
            toScale = !Enabled ? 1 : selected ? 1.17 : hovering ? 1.045 : 1;
            elapsed.Restart(); motion.Start(); Invalidate();
        }
        public void AdvanceAnimation(double progress) {
            double eased = BezierMotion.Ease(progress);
            blend = fromBlend + (toBlend-fromBlend)*eased; scale = fromScale+(toScale-fromScale)*eased;
            if (progress >= 1) { motion.Stop(); elapsed.Stop(); }
            Invalidate();
        }
        protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); hovering = true; Retarget(); }
        protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); hovering = false; Retarget(); }
        protected override void OnEnabledChanged(EventArgs e) { base.OnEnabledChanged(e); Retarget(); }
        protected override void OnMouseDown(MouseEventArgs e) { base.OnMouseDown(e); if (Enabled) Focus(); }
        protected override void OnKeyDown(KeyEventArgs e) {
            base.OnKeyDown(e); if ((e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter) && Enabled) { OnClick(EventArgs.Empty); e.Handled = true; e.SuppressKeyPress = true; }
        }
        public void Choose() { if (Enabled) OnClick(EventArgs.Empty); }
        static Color Mix(Color a, Color b, double t) { return Color.FromArgb((int)(a.R+(b.R-a.R)*t), (int)(a.G+(b.G-a.G)*t), (int)(a.B+(b.B-a.B)*t)); }
        protected override void OnPaint(PaintEventArgs e) {
            base.OnPaint(e); var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias; g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            Color paper = dark ? Color.FromArgb(35,38,33) : Color.FromArgb(246,246,239);
            Color chosen = dark ? Color.FromArgb(48,61,48) : Color.FromArgb(232,239,224);
            Color edge = Mix(dark ? Color.FromArgb(64,70,59) : Color.FromArgb(222,226,215), Color.FromArgb(181,137,93), blend);
            Color ink = dark ? Color.FromArgb(233,234,222) : Color.FromArgb(49,64,49), muted = dark ? Color.FromArgb(156,168,150) : Color.FromArgb(120,132,113);
            if (!Enabled) { ink = muted; edge = dark ? Color.FromArgb(50,55,47) : Color.FromArgb(230,230,222); }
            using (var path = Launcher.Round(new RectangleF(1,1,Width-3,Height-3), 14)) {
                using (var fill = new SolidBrush(Mix(paper, chosen, blend))) g.FillPath(fill, path);
                using (var pen = new Pen(edge, (float)(1+blend*.6))) g.DrawPath(pen, path);
            }
            if (icon != null) {
                float size = (float)(88 * scale), y = (float)(2 - 2*blend);
                var rectangle = Rectangle.Round(new RectangleF((Width-size)/2, y, size, size));
                using (var attrs = new ImageAttributes()) {
                    if (!Enabled) { var matrix = new ColorMatrix(); matrix.Matrix33 = .35f; attrs.SetColorMatrix(matrix); }
                    g.DrawImage(icon, rectangle, 0,0,icon.Width,icon.Height,GraphicsUnit.Pixel,attrs);
                }
            }
            using (var font = new Font("Microsoft YaHei UI", 12, FontStyle.Bold, GraphicsUnit.Pixel))
                TextRenderer.DrawText(g, Drive.root.Substring(0,2) + " 本地磁盘", font, new Rectangle(5,87,Width-10,19), ink, TextFormatFlags.HorizontalCenter | TextFormatFlags.SingleLine);
            using (var font = new Font("Microsoft YaHei UI", 10, GraphicsUnit.Pixel))
                TextRenderer.DrawText(g, Detail, font, new Rectangle(6,109,Width-12,16), muted, TextFormatFlags.HorizontalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.SingleLine);
            if (blend > .01) {
                using (var fill = new SolidBrush(Color.FromArgb((int)(255*blend),181,137,93))) g.FillEllipse(fill, Width-26,10,15,15);
                using (var pen = new Pen(Color.FromArgb((int)(255*blend),Color.White),1.5f)) { pen.StartCap = pen.EndCap = LineCap.Round; g.DrawLines(pen,new[] { new Point(Width-22,17),new Point(Width-19,20),new Point(Width-15,15) }); }
            }
            if (Focused && ShowFocusCues) using (var pen = new Pen(muted) { DashStyle = DashStyle.Dot })
                using (var path = Launcher.Round(new RectangleF(4,4,Width-9,Height-9),11)) g.DrawPath(pen,path);
        }
        protected override AccessibleObject CreateAccessibilityInstance() { return new CardAccessibility(this); }
        sealed class CardAccessibility : ControlAccessibleObject {
            readonly DiskCard card;
            public CardAccessibility(DiskCard control) : base(control) { card = control; }
            public override AccessibleStates State { get { return base.State | (card.Selected ? AccessibleStates.Checked : 0); } }
            public override string DefaultAction { get { return "选择安装磁盘"; } }
            public override void DoDefaultAction() { card.Choose(); }
        }
        protected override void Dispose(bool disposing) { if (disposing) motion.Dispose(); base.Dispose(disposing); }
    }
}
