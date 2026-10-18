using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Windows.Forms;
using VoxBootstrap;
using System.Web.Script.Serialization;

namespace VoxStandaloneUpdater {
    public static class UpdaterPreview {
        [STAThread]
        public static void Main(string[] args) {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            string output=Path.GetFullPath(args[0]); Directory.CreateDirectory(output);
            string[] states={"checking","installing","restarting","complete","error","long"};
            foreach(bool dark in new[] { false,true }) foreach(string state in states) {
                using(var form=new UpdateForm(output,true,dark)) {
                    form.ShowInTaskbar=false; form.Opacity=0; form.Show(); Application.DoEvents();
                    form.SetPreview(state,state=="complete"?100:state=="restarting"||state=="error"?90:state=="checking"?5:62);
                    form.Update();
                    using(var bitmap=new Bitmap(form.ClientSize.Width,form.ClientSize.Height)) {
                        form.DrawToBitmap(bitmap,form.ClientRectangle);
                        bitmap.Save(Path.Combine(output,state+(dark?"-dark.png":"-light.png")),ImageFormat.Png);
                    }
                    form.Close();
                }
            }
            var observations=new List<object>();
            foreach(double scale in new[] { 1.25,1.5,2.0 }) using(var form=new UpdateForm(output,true,false)) {
                form.ClientSize=new Size((int)(720*scale),(int)(580*scale));
                form.ShowInTaskbar=false; form.Opacity=0; form.Show(); Application.DoEvents(); form.SetPreview("long",62); form.Update();
                foreach(Control control in form.Controls) if(control.Visible && !form.ClientRectangle.Contains(control.Bounds)) throw new Exception("缩放后控件超出实际窗口");
                var labels=form.Controls.OfType<Label>().ToArray();
                if(labels[0].Bounds.IntersectsWith(labels[1].Bounds)) throw new Exception("缩放后状态与说明重叠");
                observations.Add(new { scale, requested=new[] {(int)(720*scale),(int)(580*scale)}, actual=new[] {form.ClientSize.Width,form.ClientSize.Height}, controlsInsideClient=true });
                using(var bitmap=new Bitmap(form.ClientSize.Width,form.ClientSize.Height)) {
                    form.DrawToBitmap(bitmap,form.ClientRectangle);
                    bitmap.Save(Path.Combine(output,"scale-"+scale.ToString("0.00",System.Globalization.CultureInfo.InvariantCulture)+".png"),ImageFormat.Png);
                }
                form.Close();
            }
            File.WriteAllText(Path.Combine(output,"scale-observations.json"),new JavaScriptSerializer().Serialize(observations));
            using(var form=new UpdateForm(output,true,false)) {
                form.ShowInTaskbar=false; form.Opacity=0; form.Show(); Application.DoEvents(); form.SetPreview("installing",62);
                string status=form.AccessibleDescription;
                var theme=form.Controls.OfType<SoftButton>().Single(b=>b.AccessibleName=="切换更新器主题");
                var close=form.Controls.OfType<SoftButton>().Single(b=>b.AccessibleName=="关闭更新器");
                theme.PerformClick();
                if(form.BackColor!=StudioTheme.Paper(true) || form.AccessibleDescription!=status || close.Enabled) throw new Exception("主题切换影响更新状态或关闭保护");
                form.Close(); if(form.IsDisposed) throw new Exception("进行中允许关闭更新器");
                form.SetPreview("complete",100); close.PerformClick();
                if(!form.IsDisposed) throw new Exception("完成后关闭按钮不可用");
            }
            Console.WriteLine("浅深主题、长文本、多尺寸与主题切换/关闭保护均通过");
        }
    }
}
