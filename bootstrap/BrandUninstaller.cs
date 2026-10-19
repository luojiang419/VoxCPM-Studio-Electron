using System;
using System.Windows.Forms;
namespace VoxBootstrap {
    static class BrandUninstaller {
        [STAThread] static void Main(string[] args) {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            try { if (!Installer.RouteUninstall(args)) MessageBox.Show("请从系统应用列表或开始菜单卸载。", Brand.Name); }
            catch (Exception error) { MessageBox.Show(error.Message, Brand.Name, MessageBoxButtons.OK, MessageBoxIcon.Error); Environment.ExitCode = 1; }
        }
    }
}
