using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;
using VoxStandaloneUpdater;
using VoxBootstrap;

namespace VoxLegacyRepair {
    public static class Program {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength=4*1024*1024 };
        [STAThread]
        public static void Main(string[] args) {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            bool owns=false;
            string specified=null, report=null; bool auto=false, exit=false;
            using(var mutex=new Mutex(false,"Local\\VoxCPMStudioLegacyRepair")) {
                try {
                    try { owns=mutex.WaitOne(0); } catch(AbandonedMutexException) { owns=true; }
                    if(!owns) { MessageBox.Show("修复器已经在运行，请查看已有窗口。","JVOX Studio配音系统更新修复器"); return; }
                    if(!Environment.Is64BitOperatingSystem) throw new IOException("此修复器适用于64位Windows版JVOX Studio配音系统");
                    for(int i=0;i<args.Length;i++) {
                        if(args[i]=="--root" && i+1<args.Length) specified=args[++i];
                        else if(args[i]=="--report" && i+1<args.Length) report=args[++i];
                        else if(args[i]=="--repair") auto=true;
                        else if(args[i]=="--exit-on-complete") exit=true;
                        else throw new ArgumentException("不支持的参数："+args[i]);
                    }
                    string baseDirectory=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"VoxCPMStudioRepair");
                    Directory.CreateDirectory(baseDirectory);
                    string payload=PreparePayload(Path.Combine(baseDirectory,"packages"));
                    string work=Path.Combine(baseDirectory,"sessions",DateTime.Now.ToString("yyyyMMdd-HHmmss")+"-"+Guid.NewGuid().ToString("N").Substring(0,8));
                    Directory.CreateDirectory(work);
                    string root=specified ?? DetectRoot(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location));
                    if(root!=null && File.Exists(root)) root=Path.GetDirectoryName(root);
                    string result=report==null?Path.Combine(work,"repair-result.json"):Path.GetFullPath(report);
                    Directory.CreateDirectory(Path.GetDirectoryName(result));
                    var settings=new { session=work,payload,pythonExecutable=Path.Combine(payload,"runtime","python.exe"),
                        workerScript=Path.Combine(payload,"worker.py"),repairRoot=root ?? "",resultPath=result,autoRepair=auto,exitOnComplete=exit };
                    File.WriteAllText(Path.Combine(work,"session.json"),Json.Serialize(settings),new UTF8Encoding(false));
                    using(var form=new UpdateForm(work,false,null,true)) { if(Application.MessageLoop) form.ShowDialog(); else Application.Run(form); Environment.ExitCode=form.ResultCode; }
                } catch(Exception error) {
                    if(!exit) MessageBox.Show(error.Message,"JVOX Studio配音系统修复器未能启动",MessageBoxButtons.OK,MessageBoxIcon.Error);
                    else if(report!=null) { Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(report))); File.WriteAllText(report,Json.Serialize(new {status="error",message=error.Message}),new UTF8Encoding(false)); }
                    Environment.ExitCode=1;
                } finally { if(owns) mutex.ReleaseMutex(); }
            }
        }

        public static bool IsInstall(string root) {
            return !String.IsNullOrWhiteSpace(root) && File.Exists(Brand.ExecutablePath(root)) &&
                (File.Exists(Path.Combine(root,"runtime_manifest.json")) || File.Exists(Path.Combine(root,".voxcpm-install.json")));
        }

        public static string DetectRoot(string adjacent) {
            foreach(string path in new[] { @"Software\VoxCPMStudio\Installer", @"Software\Microsoft\Windows\CurrentVersion\Uninstall\VoxCPMStudio" })
                using(var key=Registry.CurrentUser.OpenSubKey(path)) { string saved=key==null?null:key.GetValue("InstallLocation") as string; if(IsInstall(saved)) return Path.GetFullPath(saved); }
            if(IsInstall(adjacent)) return Path.GetFullPath(adjacent);
            var candidates=new List<string>();
            string local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), profile=Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            candidates.AddRange(new[] {Path.Combine(local,"JVOXStudio"),Path.Combine(local,"Apps","JVOXStudio"),Path.Combine(profile,"Apps","JVOXStudio"),Path.Combine(profile,"JVOXStudio"),Path.Combine(local,"VoxCPMStudio"),Path.Combine(local,"Apps","VoxCPMStudio"),Path.Combine(profile,"Apps","VoxCPMStudio"),Path.Combine(profile,"VoxCPMStudio")});
            foreach(var drive in DriveInfo.GetDrives()) try { if(drive.DriveType==DriveType.Fixed && drive.IsReady) { candidates.Add(Path.Combine(drive.RootDirectory.FullName,"Program Files","JVOXStudio")); candidates.Add(Path.Combine(drive.RootDirectory.FullName,"Program Files","VoxCPMStudio")); } } catch(IOException) { }
            var found=candidates.Where(IsInstall).Select(Path.GetFullPath).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            return found.Length==1?found[0]:null;
        }

#if UNIFIED
        public static bool NeedsMaintenance(string root) {
            if(String.IsNullOrWhiteSpace(root) || !Directory.Exists(root)) return false;
            string marker=Path.Combine(root,".voxcpm-install.json");
            if(File.Exists(marker)) {
                try {
                    var state=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(marker));
                    string status=state.ContainsKey("state")?Convert.ToString(state["state"]):"";
                    if(status=="preparing" || status=="uninstalled") return false;
                    return true;
                } catch { return true; }
            }
            return File.Exists(Path.Combine(root,"runtime_manifest.json"));
        }
        public static string UnifiedRoot() {
            foreach(string path in new[] { @"Software\VoxCPMStudio\Installer", @"Software\Microsoft\Windows\CurrentVersion\Uninstall\VoxCPMStudio" })
                using(var key=Registry.CurrentUser.OpenSubKey(path)) {
                    string value=key==null?null:key.GetValue("InstallLocation") as string;
                    if(NeedsMaintenance(value)) return Path.GetFullPath(value);
                }
            string adjacent=Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            if(NeedsMaintenance(adjacent)) return adjacent;
            return DetectRoot(adjacent);
        }
        public static void Maintain(string root, string report=null, bool exit=false) {
            VoxBootstrap.Installer.ValidateRoot(root);
            string home=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"VoxCPMStudioRepair");
            string payload=PreparePayload(Path.Combine(home,"packages"));
            string work=Path.Combine(home,"sessions","maintenance-"+Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(work);
            string result=report==null?Path.Combine(work,"result.json"):Path.GetFullPath(report);
            Directory.CreateDirectory(Path.GetDirectoryName(result));
            File.WriteAllText(Path.Combine(work,"session.json"),Json.Serialize(new {session=work,payload,
                pythonExecutable=Path.Combine(payload,"runtime/python.exe"),workerScript=Path.Combine(payload,"worker.py"),
                repairRoot=root,resultPath=result,autoRepair=true,exitOnComplete=exit,maintenance=true}),new UTF8Encoding(false));
            using(var form=new UpdateForm(work,false,null,true)) { if(Application.MessageLoop) form.ShowDialog(); else Application.Run(form); Environment.ExitCode=form.ResultCode; }
        }
#endif

        static string Digest(Stream stream) { using(var hash=SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant(); }
        static string Digest(string file) { using(var stream=File.OpenRead(file)) return Digest(stream); }
        static string Safe(string root,string relative) {
            if(String.IsNullOrEmpty(relative) || relative.IndexOfAny(new[] {'\\',':','\0'})>=0 || relative.StartsWith("/") || relative.Split('/').Any(p=>p==".." || p=="." || p=="")) throw new IOException("修复器资源路径非法");
            string target=Path.GetFullPath(Path.Combine(root,relative.Replace('/',Path.DirectorySeparatorChar)));
            if(!target.StartsWith(Path.GetFullPath(root)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)) throw new IOException("修复器资源路径越界");
            return target;
        }
        static bool Verified(string directory,Dictionary<string,object>[] records) {
            try {
                if(!Directory.Exists(directory) || Directory.GetFiles(directory,"*",SearchOption.AllDirectories).Length!=records.Length) return false;
                foreach(var item in records) {
                    string file=Safe(directory,Convert.ToString(item["path"]));
                    if(!File.Exists(file) || (File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0 || new FileInfo(file).Length!=Convert.ToInt64(item["size"]) || Digest(file)!=Convert.ToString(item["sha256"])) return false;
                }
                return true;
            } catch(IOException) { return false; } catch(UnauthorizedAccessException) { return false; }
        }
        public static string PreparePayload(string packages) {
            var assembly=Assembly.GetExecutingAssembly();
            Dictionary<string,object> manifest;
            using(var stream=assembly.GetManifestResourceStream("repair-bundle.json")) using(var reader=new StreamReader(stream,Encoding.UTF8)) manifest=Json.Deserialize<Dictionary<string,object>>(reader.ReadToEnd());
            if(Convert.ToString(manifest["product"])!="voxcpm-studio-repairer") throw new IOException("修复器资源身份无效");
            string hash=Convert.ToString(manifest["sha256"]), target=Path.Combine(packages,hash.Substring(0,16));
            var records=((System.Collections.IEnumerable)manifest["files"]).Cast<Dictionary<string,object>>().ToArray();
            if(Verified(target,records)) return target;
            Directory.CreateDirectory(packages);
            string stage=target+".new-"+Guid.NewGuid().ToString("N"); Directory.CreateDirectory(stage);
            using(var stream=assembly.GetManifestResourceStream("repair-payload.zip")) {
                if(Digest(stream)!=hash) throw new IOException("修复器内置资源完整性校验失败");
            }
            using(var stream=assembly.GetManifestResourceStream("repair-payload.zip")) using(var zip=new ZipArchive(stream,ZipArchiveMode.Read)) {
                var allowed=records.ToDictionary(r=>Convert.ToString(r["path"]),StringComparer.OrdinalIgnoreCase);
                var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach(var entry in zip.Entries) {
                    Dictionary<string,object> record;
                    if(!allowed.TryGetValue(entry.FullName,out record) || !seen.Add(entry.FullName) || entry.Length!=Convert.ToInt64(record["size"])) throw new IOException("修复器压缩资源与清单不一致");
                    string file=Safe(stage,entry.FullName); Directory.CreateDirectory(Path.GetDirectoryName(file));
                    using(var input=entry.Open()) using(var output=File.Create(file)) input.CopyTo(output);
                }
                if(seen.Count!=records.Length) throw new IOException("修复器资源缺失");
            }
            if(!Verified(stage,records)) throw new IOException("修复器解压校验失败");
            if(Directory.Exists(target)) Directory.Move(target,target+".previous-"+Guid.NewGuid().ToString("N"));
            Directory.Move(stage,target); return target;
        }
    }
}
