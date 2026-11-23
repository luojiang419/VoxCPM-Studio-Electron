using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

// 仅用于验收：使用 Windows SAFER 普通用户令牌启动子进程，不请求 UAC。
public static class StandardUserRunner {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
        public int size; public string reserved, desktop, title;
        public int x, y, width, height, xChars, yChars, fill, flags;
        public short show, reservedSize; public IntPtr reservedPointer, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public int processId, threadId; }
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SaferCreateLevel(int scope, int level, int flags, out IntPtr handle, IntPtr reserved);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SaferComputeTokenFromLevel(IntPtr level, IntPtr original, out IntPtr token, int flags, IntPtr reserved);
    [DllImport("advapi32.dll")] static extern bool SaferCloseLevel(IntPtr handle);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessWithTokenW(IntPtr token, int logon, string application, string command, int flags, IntPtr environment, string directory, ref Startup startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] static extern int WaitForSingleObject(IntPtr handle, int timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out int code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    public static int Main(string[] args) {
        IntPtr level = IntPtr.Zero, token = IntPtr.Zero; ProcessInfo process = new ProcessInfo();
        try {
            if (!SaferCreateLevel(1, 0x20000, 1, out level, IntPtr.Zero) || !SaferComputeTokenFromLevel(level, IntPtr.Zero, out token, 0, IntPtr.Zero)) throw new Win32Exception();
            string command = String.Join(" ", Array.ConvertAll(args, Quote));
            var startup = new Startup { size = Marshal.SizeOf(typeof(Startup)), desktop = "winsta0\\default" };
            if (!CreateProcessWithTokenW(token, 0, args[0], command, 0x08000000, IntPtr.Zero, System.IO.Path.GetDirectoryName(args[0]), ref startup, out process)) throw new Win32Exception();
            if (WaitForSingleObject(process.process, 600000) != 0) throw new Exception("普通用户安装验收超时");
            int code; if (!GetExitCodeProcess(process.process, out code)) throw new Win32Exception();
            Console.WriteLine("普通用户验收退出码：" + code); return code;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        finally { if (process.thread != IntPtr.Zero) CloseHandle(process.thread); if (process.process != IntPtr.Zero) CloseHandle(process.process); if (token != IntPtr.Zero) CloseHandle(token); if (level != IntPtr.Zero) SaferCloseLevel(level); }
    }
}
