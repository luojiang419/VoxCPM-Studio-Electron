using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using VoxBootstrap;

public static class BootstrapPreview {
    [STAThread] public static int Main(string[] args) {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        var manifest = new JavaScriptSerializer().Deserialize<Manifest>(File.ReadAllText(args[0], Encoding.UTF8));
        string output = Path.GetFullPath(args[1]); Directory.CreateDirectory(output);
        foreach (bool dark in new[] { false, true }) foreach (string state in new[] { "idle", "downloading", "paused", "ready", "disk-blocked", "disk-scroll" }) {
            Func<string> detector = state == "disk-blocked" ? (Func<string>)(() => { throw new IOException("其他分区空间均不足。\n至少需要 25 GiB；D盘 8.2 GiB，E盘 3.6 GiB。请释放空间后重新检测。不会自动安装到 C 盘。"); }) : null;
            Func<InstallDrive[]> survey = state == "disk-blocked" ? (Func<InstallDrive[]>)(() => new[] {
                new InstallDrive { root=@"C:\", ready=true, free=100L*1073741824 },
                new InstallDrive { root=@"D:\", ready=true, free=(long)(8.2*1073741824) },
                new InstallDrive { root=@"E:\", ready=true, free=(long)(3.6*1073741824) }
            }) : null;
            if(state=="disk-scroll") {
                detector=()=>@"D:\VoxCPMStudio";
                survey=()=>new[] { "C","D","E","F","G","H" }.Select(letter=>new InstallDrive { root=letter+@":\",ready=true,free=Installer.RequiredSpace*3 }).ToArray();
            }
            using (var form = new Launcher(manifest, true, dark, detector, survey)) {
                form.ShowInTaskbar = false; form.Opacity = 0; form.Show(); Application.DoEvents();
                if (state != "disk-blocked") form.SetPreview(state=="disk-scroll"?"idle":state, state == "ready" ? 1 : state == "idle" || state=="disk-scroll" ? 0 : .42); form.Update();
                var panel = (DiskStrip)form.Controls["local-disks"];
                foreach (DiskCard card in panel.Controls) card.AdvanceAnimation(1);
                ((TextBox)form.Controls["destination"]).DeselectAll();
                using (var bitmap = new Bitmap(form.ClientSize.Width, form.ClientSize.Height)) {
                    form.DrawToBitmap(bitmap, form.ClientRectangle);
                    bitmap.Save(Path.Combine(output, state + (dark ? "-dark.png" : "-light.png")), ImageFormat.Png);
                }
                form.Close();
            }
        }
        using (var form = new Launcher(manifest, true, false)) {
            form.ShowInTaskbar=false; form.Opacity=0; form.Show(); Application.DoEvents();
            var panel=(DiskStrip)form.Controls["local-disks"];
            var cards=panel.Controls.Cast<DiskCard>().ToArray();
            var choices=cards.Where(card => card.Enabled).Take(3).ToArray();
            string frames=Path.Combine(output,"disk-animation-frames"); Directory.CreateDirectory(frames);
            int index=0;
            foreach (DiskCard card in cards) card.AdvanceAnimation(1);
            foreach (DiskCard choice in choices.Concat(choices.Take(1))) {
                choice.Choose();
                for (int frame=0;frame<=10;frame++) {
                    foreach (DiskCard card in cards) card.AdvanceAnimation(frame/10.0);
                    ((TextBox)form.Controls["destination"]).DeselectAll();
                    using (var bitmap=new Bitmap(form.ClientSize.Width,form.ClientSize.Height)) {
                        form.DrawToBitmap(bitmap,form.ClientRectangle);
                        using (var crop=bitmap.Clone(new Rectangle(30,232,660,255),PixelFormat.Format32bppArgb))
                            crop.Save(Path.Combine(frames,(index++).ToString("D3")+".png"),ImageFormat.Png);
                    }
                }
            }
            form.Close();
        }
        Console.WriteLine("12 张实际原生界面已渲染：" + output); return 0;
    }
}
