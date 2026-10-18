using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using VoxBootstrap;

public static class BootstrapPreview {
    [STAThread] public static int Main(string[] args) {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        var manifest = new JavaScriptSerializer().Deserialize<Manifest>(File.ReadAllText(args[0], Encoding.UTF8));
        string output = Path.GetFullPath(args[1]); Directory.CreateDirectory(output);
        foreach (bool dark in new[] { false, true }) foreach (string state in new[] { "idle", "downloading", "paused", "ready" }) {
            using (var form = new Launcher(manifest, true, dark)) {
                form.ShowInTaskbar = false; form.Opacity = 0; form.Show(); Application.DoEvents();
                form.SetPreview(state, state == "ready" ? 1 : state == "idle" ? 0 : .42); form.Update();
                using (var bitmap = new Bitmap(form.ClientSize.Width, form.ClientSize.Height)) {
                    form.DrawToBitmap(bitmap, form.ClientRectangle);
                    bitmap.Save(Path.Combine(output, state + (dark ? "-dark.png" : "-light.png")), ImageFormat.Png);
                }
                form.Close();
            }
        }
        Console.WriteLine("8 张实际原生界面已渲染：" + output); return 0;
    }
}
