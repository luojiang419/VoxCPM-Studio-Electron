from pathlib import Path
import subprocess
ROOT=Path(__file__).resolve().parents[1]
out=ROOT/'builds/unified-tests';out.mkdir(exist_ok=True)
exe=out/'UnifiedTests.exe'
subprocess.run(['C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe','/nologo','/target:exe','/define:UNIFIED','/main:UnifiedTests','/out:'+str(exe),
    *['/reference:'+name for name in ['System.Windows.Forms.dll','System.Drawing.dll','Accessibility.dll','System.Web.Extensions.dll','System.IO.Compression.dll','System.IO.Compression.FileSystem.dll']],
    *[str(ROOT/'bootstrap'/name) for name in ['Program.cs','SharedTheme.cs','Installation.cs','Components.cs','DiskCard.cs','UnifiedTests.cs']],str(ROOT/'repair/Program.cs'),str(ROOT/'updater/Program.cs')],check=True)
subprocess.run([str(exe)],check=True)
