using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using VoxBootstrap;

public static class BootstrapTests {
    sealed class Quiet : IProgress<Status> { public void Report(Status value) { } }
    sealed class ConsoleProgress : IProgress<Status> {
        readonly System.Diagnostics.Stopwatch clock=System.Diagnostics.Stopwatch.StartNew();
        string previous;
        public void Report(Status value) {
            if(value.text!=previous || clock.ElapsedMilliseconds>10000) {
                Console.WriteLine(value.text+(value.total>0 ? String.Format(" {0:F2}/{1:F2} GiB",value.done/1073741824.0,value.total/1073741824.0) : ""));
                previous=value.text; clock.Restart();
            }
        }
    }
    sealed class Server : IDisposable {
        readonly TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
        readonly byte[] bytes;
        readonly string mode;
        volatile bool stopped;
        public int Requests;
        public string LastRange;
        public string Url;
        public Server(byte[] content, string value) {
            bytes = content; mode = value; listener.Start(); Url = "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port + "/asset";
            Task.Run(() => {
                while (!stopped) {
                    try { using (var client = listener.AcceptTcpClient()) using (var stream = client.GetStream()) {
                        var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
                        string line; LastRange = null;
                        while (!String.IsNullOrEmpty(line = reader.ReadLine())) if (line.StartsWith("Range:", StringComparison.OrdinalIgnoreCase)) LastRange = line.Substring(6).Trim();
                        int count = Interlocked.Increment(ref Requests);
                        int offset = LastRange == null ? 0 : Int32.Parse(LastRange.Substring(6).TrimEnd('-'));
                        bool partial = offset > 0 && mode != "ignore";
                        if (!partial) offset = 0;
                        string headers = "HTTP/1.1 " + (partial ? "206 Partial Content" : "200 OK") + "\r\nConnection: close\r\nContent-Length: " + (bytes.Length - offset) + "\r\n";
                        if (partial) headers += "Content-Range: bytes " + (mode == "bad-range" ? 0 : offset) + "-" + (bytes.Length - 1) + "/" + bytes.Length + "\r\n";
                        byte[] header = Encoding.ASCII.GetBytes(headers + "\r\n"); stream.Write(header, 0, header.Length);
                        int length = mode == "truncate" && count == 1 ? 1024 : bytes.Length - offset;
                        byte[] body = mode == "corrupt" ? new byte[bytes.Length] : bytes;
                        stream.Write(body, offset, length); stream.Flush();
                    } } catch { if (stopped) break; }
                }
            });
        }
        public void Dispose() { stopped = true; listener.Stop(); }
    }
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    static void Reject(Action action, string message) { bool failed = false; try { action(); } catch { failed = true; } Check(failed, message); }
    static string BytesHash(byte[] bytes) { using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    static Asset MakeAsset(byte[] bytes, string url) { return new Asset { name = "asset.bin", size = bytes.Length, sha256 = BytesHash(bytes), urls = new[] { url } }; }
    static int passes;
    static void Run(string name, Action test) { test(); passes++; Console.WriteLine("PASS " + name); }
    public static int Main(string[] args) {
        Core.EnableLongPaths();
        if (args.Length == 2 || args.Length == 3) {
            try {
                var manifest = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue }.Deserialize<Manifest>(File.ReadAllText(args[0], Encoding.UTF8));
                if(manifest.fullBundle && !Directory.Exists(args[1]))
                    Installer.Begin(Path.GetFullPath(args[1]),manifest,remember:false,registryKey:Installer.UninstallKey+".Test."+Guid.NewGuid().ToString("N"));
                Console.WriteLine(Core.Prepare(Path.GetFullPath(args[1]), manifest, CancellationToken.None, new ConsoleProgress(), args.Length == 3 ? args[2] : null));
                return 0;
            } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        }
        string root = Path.Combine(Path.GetTempPath(), "Vox启动器测试-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            Run("路径穿越与重复路径保护", () => { foreach (string name in new[] { "../a", "a/../../b", "C:/a", "a\\b", "a/.", "a. /b" }) Reject(() => Core.SafePath(root, name), name); });
            byte[] content = Encoding.UTF8.GetBytes(String.Concat(Enumerable.Repeat("可信桌面资源", 6000)));
            var quiet = new Quiet();
            Run("续传与完成文件零下载复用", () => {
                string directory = Path.Combine(root, "resume"); Directory.CreateDirectory(directory);
                using (var server = new Server(content, "range")) {
                    var asset = MakeAsset(content, server.Url); string target = Path.Combine(directory, asset.name);
                    File.WriteAllBytes(target + ".part", content.Take(513).ToArray()); Core.Download(asset, directory, CancellationToken.None, quiet, true);
                    Check(server.LastRange == "bytes=513-" && Core.Verified(target, asset), "未正确续传");
                    int requests = server.Requests; Core.Download(asset, directory, CancellationToken.None, quiet, true); Check(server.Requests == requests, "完整缓存不应联网");
                }
            });
            Run("忽略 Range 时覆盖重下", () => {
                string directory = Path.Combine(root, "ignored"); Directory.CreateDirectory(directory);
                using (var server = new Server(content, "ignore")) {
                    var asset = MakeAsset(content, server.Url); File.WriteAllBytes(Path.Combine(directory, asset.name) + ".part", content.Take(20).ToArray());
                    Core.Download(asset, directory, CancellationToken.None, quiet, true); Check(Core.Verified(Path.Combine(directory, asset.name), asset), "重复追加字节");
                }
            });
            Run("截断下载自动续接", () => {
                using (var server = new Server(content, "truncate")) { var asset = MakeAsset(content, server.Url); Core.Download(asset, Path.Combine(root, "truncated"), CancellationToken.None, quiet, true); Check(server.Requests == 2 && server.LastRange == "bytes=1024-", "没有续接分片"); }
            });
            Run("哈希错误不生成完成文件", () => {
                using (var server = new Server(content, "corrupt")) { var asset = MakeAsset(content, server.Url); string dir = Path.Combine(root, "corrupt"); Reject(() => Core.Download(asset, dir, CancellationToken.None, quiet, true), "错误哈希通过"); Check(!File.Exists(Path.Combine(dir, asset.name)), "损坏文件成为完成文件"); }
            });
            Run("错误续传范围被拒绝", () => {
                string dir = Path.Combine(root, "bad-range"); Directory.CreateDirectory(dir);
                using (var server = new Server(content, "bad-range")) { var asset = MakeAsset(content, server.Url); File.WriteAllBytes(Path.Combine(dir, asset.name) + ".part", content.Take(9).ToArray()); Reject(() => Core.Download(asset, dir, CancellationToken.None, quiet, true), "错误 Range 通过"); }
            });
            Run("取消与默认 HTTPS 限制", () => {
                using (var server = new Server(content, "range")) {
                    var asset = MakeAsset(content, server.Url); var cancel = new CancellationTokenSource(); cancel.Cancel();
                    Reject(() => Core.Download(asset, Path.Combine(root, "cancel"), cancel.Token, quiet, true), "取消未生效");
                    Reject(() => Core.Download(asset, Path.Combine(root, "http"), CancellationToken.None, quiet), "非 HTTPS 未被拒绝"); Check(server.Requests == 0, "不应发送请求");
                }
            });
            Run("ZIP 完整校验和越界拒绝", () => {
                string archive = Path.Combine(root, "desktop.zip"); var file = MakeAsset(content, "https://example.com"); file.name = "file.bin";
                var manifest = new Manifest { files = new[] { file } };
                using (var zip = ZipFile.Open(archive, ZipArchiveMode.Create)) using (var stream = zip.CreateEntry("bundle/file.bin").Open()) stream.Write(content, 0, content.Length);
                string stage = Path.Combine(root, "stage"); Directory.CreateDirectory(stage); Core.Extract(archive, stage, manifest, CancellationToken.None); Check(Core.Verified(Path.Combine(stage, "file.bin"), file), "解压校验失败");
                string evil = Path.Combine(root, "evil.zip"); using (var zip = ZipFile.Open(evil, ZipArchiveMode.Create)) using (var stream = zip.CreateEntry("bundle/../../escape.bin").Open()) stream.Write(content, 0, content.Length);
                Reject(() => Core.Extract(evil, Path.Combine(root, "stage2"), manifest, CancellationToken.None), "ZIP 越界通过");
            });
            Run("应用升级后保留新版并继续校验桌面核心", () => {
                string directory = Path.Combine(root, "updated"); Directory.CreateDirectory(Path.Combine(directory, "resources/app/dist"));
                string executable = Path.Combine(directory, "VoxCPM Studio.exe"); File.WriteAllBytes(executable, content);
                File.WriteAllText(Path.Combine(directory, "resources/app/package.json"), "{\"version\":\"2.0.3\"}");
                File.WriteAllText(Path.Combine(directory, "resources/app/update-config.json"), "{\"releaseId\":\"20261019000000\"}");
                foreach (string name in new[] { "main.js", "preload.js", "dist/index.html" }) File.WriteAllText(Path.Combine(directory, "resources/app/" + name), "updated");
                var asset = MakeAsset(content, "https://example.com"); asset.name = "VoxCPM Studio.exe";
                var manifest = new Manifest { appVersion = "2.0.2", appReleaseId = "20261018000000", entry = asset.name, files = new[] { asset } };
                Check(Core.DesktopReady(directory, manifest, CancellationToken.None), "不应还原成旧版");
                File.WriteAllBytes(executable, new byte[content.Length]);
                Reject(() => Core.DesktopReady(directory, manifest, CancellationToken.None), "桌面核心损坏应被拒绝");
                Check(File.ReadAllText(Path.Combine(directory, "resources/app/package.json")).Contains("2.0.3"), "新版配置不应被覆盖");
            });
            Run("全量包受限资源路径、本地安装与缺失损坏拒绝", () => {
                string source = Path.Combine(root, "full-source"); Directory.CreateDirectory(source);
                string archive = Path.Combine(source, "full.zip");
                var assets = new[] { "app.exe", "models/voice/model.bin", "runtime/managed/py312-cu128/python.exe", "data/lipsync/source/model.bin", "offline-assets/dependency.whl" }
                    .Select(name => new Asset { name = name, size = content.Length, sha256 = BytesHash(content), urls = new string[0] }).ToArray();
                using(var zip=ZipFile.Open(archive,ZipArchiveMode.Create)) foreach(var asset in assets)
                    using(var stream=zip.CreateEntry("JVOXStudio/"+asset.name).Open()) stream.Write(content,0,content.Length);
                var manifest = new Manifest { protocol=1, releaseId="20261024000000", entry="app.exe", files=assets,
                    fullBundle=true, installedSize=assets.Sum(a=>a.size),
                    package=new Asset { name="full.zip",size=new FileInfo(archive).Length,sha256=Core.Hash(archive),urls=new string[0] } };
                Core.Validate(manifest);
                manifest.fullBundle=false; Reject(()=>Core.Validate(manifest),"旧桌面清单不能允许资源路径"); manifest.fullBundle=true;
                var original=assets[1].name; assets[1].name="data/config/api-keys.json";
                Reject(()=>Core.Validate(manifest),"全量包不能包含个人设置或密钥目录"); assets[1].name=original;
                string target=Path.Combine(root,"full-install");
                Installer.Begin(target,manifest,remember:false,registryKey:Installer.UninstallKey+".Test."+Guid.NewGuid().ToString("N"));
                Check(Installer.ReadState(target).files.All(name=>!name.Contains("/")),"全量安装标记应只记录根文件，依赖按所属目录管理");
                Check(Core.Prepare(target,manifest,CancellationToken.None,quiet,source)==Path.Combine(target,"app.exe"),"本地全量安装失败");
                Check(Core.DesktopReady(target,manifest,CancellationToken.None),"全量文件校验失败");
                Check(!File.Exists(Path.Combine(target,"data/cache/bootstrap/full.zip")),"不应再复制一份大型资源包");
                File.WriteAllText(archive,"corrupt");
                Reject(()=>Core.Prepare(Path.Combine(root,"full-corrupt"),manifest,CancellationToken.None,quiet,source),"损坏本地资源包不能通过");
                File.Delete(archive);
                Reject(()=>Core.Prepare(Path.Combine(root,"full-missing"),manifest,CancellationToken.None,quiet,source),"丢失本地资源包不能转为联网假安装");
            });
            Console.WriteLine(passes + " native bootstrap tests passed"); return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        finally {
            string resolved = Path.GetFullPath(root);
            if (Path.GetDirectoryName(resolved).TrimEnd(Path.DirectorySeparatorChar) == Path.GetTempPath().TrimEnd(Path.DirectorySeparatorChar) && Path.GetFileName(resolved).StartsWith("Vox启动器测试-")) Directory.Delete(resolved, true);
        }
    }
}
