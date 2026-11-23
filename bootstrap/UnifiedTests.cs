using System;
using System.IO;
using VoxLegacyRepair;
class UnifiedTests {
    static void Check(bool value,string name) {if(!value) throw new Exception(name);Console.WriteLine("PASS "+name);}
    static int Main() {
        string root=Path.Combine(Path.GetTempPath(),"VoxCPM-Unified-Test-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
        try {
            Check(!Program.NeedsMaintenance(root),"新目录进入安装");
            string marker=Path.Combine(root,".voxcpm-install.json");
            File.WriteAllText(marker,"{\"state\":\"preparing\"}");Check(!Program.NeedsMaintenance(root),"未完成安装继续安装");
            File.WriteAllText(marker,"{\"state\":\"complete\"}");Check(Program.NeedsMaintenance(root),"缺失主程序仍识别已安装");
            File.WriteAllText(marker,"{damaged");Check(Program.NeedsMaintenance(root),"损坏安装记录进入检查");
            File.WriteAllText(marker,"{\"state\":\"uninstalled\"}");Check(!Program.NeedsMaintenance(root),"已卸载进入重新安装");
            File.Delete(marker);File.WriteAllText(Path.Combine(root,"runtime_manifest.json"),"{}");Check(Program.NeedsMaintenance(root),"便携版进入检查");
            return 0;
        } finally {Directory.Delete(root,true);}
    }
}
