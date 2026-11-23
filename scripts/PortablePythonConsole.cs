// Python wheel 的 Windows 命令入口默认绑定安装绝对路径；此入口相对自身定位解释器。
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;

public static class PortablePythonConsole {
    static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach(char character in value) {
            if(character=='\\') { slashes++; continue; }
            if(character=='"') result.Append('\\',slashes*2+1).Append('"');
            else result.Append('\\',slashes).Append(character);
            slashes=0;
        }
        return result.Append('\\',slashes*2).Append('"').ToString();
    }
    public static int Main(string[] args) {
        try {
            string executable=Assembly.GetExecutingAssembly().Location;
            string directory=Path.GetDirectoryName(executable);
            string python=Path.GetFullPath(Path.Combine(directory,"..","python.exe"));
            string script=Path.Combine(directory,"portable-entries",Path.GetFileNameWithoutExtension(executable)+".py");
            if(!File.Exists(python)||!File.Exists(script)) throw new IOException("便携 Python 命令入口缺少解释器或脚本。");
            var command=new StringBuilder("-I -B -X utf8 ").Append(Quote(script));
            foreach(string argument in args) command.Append(' ').Append(Quote(argument));
            using(var process=Process.Start(new ProcessStartInfo(python,command.ToString()) { UseShellExecute=false,CreateNoWindow=true,
                RedirectStandardOutput=true,RedirectStandardError=true,RedirectStandardInput=true })) {
                var output=process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                var errors=process.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
                Task.Run(()=>{try{Console.OpenStandardInput().CopyTo(process.StandardInput.BaseStream);process.StandardInput.Close();}catch{}});
                process.WaitForExit(); Task.WaitAll(output,errors); return process.ExitCode;
            }
        } catch(Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
