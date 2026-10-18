// 首次补齐由 Electron 执行，不依赖用户安装 Python。
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { StringDecoder } = require("node:string_decoder");

function safePath(root, name) {
  if (!name || /[\\:\x00]/.test(name) || name.startsWith("/") || name.split("/").some((p) => !p || p === "." || p === "..")) {
    throw new Error(`资源路径无效：${name}`);
  }
  const result = path.resolve(root, name);
  if (!result.startsWith(path.resolve(root) + path.sep)) throw new Error("资源路径越界");
  return result;
}

async function digest(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function verified(file, asset) {
  try { return (await fsp.stat(file)).size === asset.size && await digest(file) === asset.sha256; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function validateAsset(asset) {
  safePath(process.cwd(), asset.name);
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !Array.isArray(asset.urls) || !asset.urls.length || asset.urls.some((u) => new URL(u).protocol !== "https:")) {
    throw new Error(`资源清单校验失败：${asset.name}`);
  }
}

async function downloadAsset(asset, directory, { signal, progress = () => {}, fetchImpl = fetch, allowHttp = false } = {}) {
  if (!allowHttp) validateAsset(asset);
  const target = safePath(directory, asset.name), part = target + ".part";
  await fsp.mkdir(path.dirname(target), { recursive: true });
  signal?.throwIfAborted();
  progress({ name: asset.name, downloaded: 0, size: asset.size, verifying: true });
  if (await verified(target, asset)) { signal?.throwIfAborted(); progress({ name: asset.name, downloaded: asset.size, size: asset.size, reused: true }); return target; }
  if (await verified(part, asset)) { signal?.throwIfAborted(); await fsp.rename(part, target); return target; }
  progress({ name: asset.name, downloaded: 0, size: asset.size, downloading: true, verifying: false });
  const errors = [];
  for (const url of asset.urls) {
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      let offset = (await fsp.stat(part).catch(() => ({ size: 0 }))).size;
      if (offset >= asset.size) { await fsp.rm(part, { force: true }); offset = 0; }
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      let watchdog;
      const touch = () => { clearTimeout(watchdog); watchdog = setTimeout(() => controller.abort(new Error("下载超过 60 秒没有数据，请检查网络后重试")), 60000); };
      try {
        touch();
        const response = await fetchImpl(url, { headers: { "User-Agent": "VoxCPM-Studio-Runtime/1.0", ...(offset ? { Range: `bytes=${offset}-` } : {}) }, signal: controller.signal });
        if (![200, 206].includes(response.status)) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
        const range = response.headers.get("content-range");
        if (response.status === 206 && range !== `bytes ${offset}-${asset.size - 1}/${asset.size}`) {
          await response.body?.cancel(); throw new Error("服务器返回了错误的续传范围");
        }
        if (response.status === 200) offset = 0;
        const length = Number(response.headers.get("content-length"));
        if (length && length !== asset.size - offset) { await response.body?.cancel(); throw new Error("服务器文件大小与清单不符"); }
        let done = offset, last = 0;
        progress({ name: asset.name, downloaded: done, size: asset.size });
        const meter = new Transform({ transform(chunk, _encoding, callback) {
          touch(); done += chunk.length;
          if (done > asset.size) { callback(new Error("下载大小超过清单限制")); return; }
          if (Date.now() - last > 250) { progress({ name: asset.name, downloaded: done, size: asset.size }); last = Date.now(); }
          callback(null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(part, { flags: offset ? "a" : "w" }), { signal: controller.signal });
        if (!await verified(part, asset)) {
          if ((await fsp.stat(part)).size >= asset.size) await fsp.rm(part, { force: true });
          throw new Error("文件不完整或 SHA-256 不匹配");
        }
        signal?.throwIfAborted();
        await fsp.rename(part, target);
        progress({ name: asset.name, downloaded: asset.size, size: asset.size });
        return target;
      } catch (error) {
        signal?.throwIfAborted();
        errors.push(`${new URL(url).host}：${error.message}`);
      } finally { clearTimeout(watchdog); signal?.removeEventListener("abort", abort); }
    }
  }
  throw new Error(`${asset.name} 下载失败，可重试续传。${errors.join("；")}`);
}

function selectProfile(gpus) {
  if (!gpus.length) return { profile: "cpu", label: "CPU 模式", gpu: null };
  const gpu = [...gpus].sort((a, b) => b.capability - a.capability)[0];
  const blackwell = gpu.capability >= 10 || /RTX\s*50\d\d|RTX\s*PRO\s*\d+.*Blackwell|\b[Bb](100|200)\b/i.test(gpu.name);
  const profile = blackwell ? "cu128" : "cu126";
  const required = blackwell ? 570.65 : 560.76;
  if (!Number.isFinite(Number(gpu.driver)) || Number(gpu.driver) < required) {
    throw new Error(`${gpu.name} 的 NVIDIA 驱动 ${gpu.driver} 过旧。${profile} 需要 Windows 驱动 ${required} 或更新版本，请更新 NVIDIA 驱动并重新运行。`);
  }
  if (gpu.capability && gpu.capability < 5) throw new Error(`${gpu.name} 的计算架构过旧，请使用支持的 NVIDIA 显卡。`);
  return { profile, label: `${gpu.name} · CUDA ${blackwell ? "12.8" : "12.6"}`, gpu };
}

function resolveManagedPython(root) {
  for (const profile of ["cu128", "cu126", "cpu"]) {
    const directory = path.join(root, "runtime", "managed", `py312-${profile}`);
    const python = path.join(directory, "python.exe");
    if (fs.existsSync(path.join(directory, "ready.json")) && fs.existsSync(python)) return python;
  }
  return "";
}

function offlinePipArgs(config, profile, cache, requirements) {
  const version = config.profiles[profile].torch;
  return ["-m", "pip", "install", "--force-reinstall", "--no-index", "--only-binary=:all:",
    "--find-links", cache, "--cache-dir", path.join(cache, "pip"),
    "-r", requirements, "-r", safePath(cache, config.wheelhouse.requirements.name),
    `torch==${version}+${profile}`, `torchaudio==${version}+${profile}`];
}

const PROBE = String.raw`
import json, os, sys, locale
if os.name == 'nt':
    locale.setlocale(locale.LC_CTYPE, '.UTF8')
import torch, torchaudio
expected = sys.argv[1]
if expected not in ('existing', 'existing-gpu'):
    version = {'cu128': '2.7.1', 'cu126': '2.6.0', 'cpu': '2.6.0'}[expected]
    assert torch.__version__.split('+')[0] == version, 'PyTorch 版本不匹配'
    assert ('cpu' if torch.version.cuda is None else 'cu'+torch.version.cuda.replace('.', '')) == expected, 'CUDA 构建不匹配'
if expected != 'cpu' and (expected != 'existing' or torch.cuda.is_available()):
    assert torch.cuda.is_available(), 'CUDA 不可用，请更新显卡驱动'
    cap = torch.cuda.get_device_capability(0)
    if cap[0] >= 10:
        assert torch.version.cuda and tuple(map(int, torch.version.cuda.split('.'))) >= (12, 8), 'Blackwell 需要 CUDA 12.8+'
    # is_available 并不能证明架构兼容；实际测试基本 kernel、cuBLAS 和语音模型使用的 SDPA。
    x = torch.ones((32,32), device='cuda', dtype=torch.bfloat16)
    y = x @ x
    z = torch.nn.functional.scaled_dot_product_attention(x[None,None], x[None,None], x[None,None])
    torch.cuda.synchronize()
    assert y[0,0].item() == 32 and torch.isfinite(z).all().item(), 'GPU 运算校验失败'
import gradio, numpy, soundfile, yaml, funasr, modelscope, transformers, librosa
import fastapi, uvicorn, safetensors, datasets, wetext, inflect, einops, addict
if expected not in ('existing', 'existing-gpu'):
    import imageio_ffmpeg
    assert os.path.isfile(imageio_ffmpeg.get_ffmpeg_exe()), 'FFmpeg 缺失'
if len(sys.argv) > 2:
    import importlib.metadata as metadata
    for line in open(sys.argv[2], encoding='utf-8'):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        name, version = line.split('==')
        assert metadata.version(name) == version, name + ' 版本需要更新'
print(json.dumps({'torch':torch.__version__, 'cuda':torch.version.cuda, 'python':sys.executable}))
`;

// 正常重启只检查核心启动、包入口和版本，不再次加载所有语音框架和 GPU。
const STARTUP_PROBE = String.raw`
import sys, ssl, json, importlib.util, importlib.metadata as metadata
from pathlib import Path
modules = ['torch', 'torchaudio', 'gradio', 'numpy', 'soundfile', 'yaml', 'funasr', 'modelscope',
           'transformers', 'librosa', 'fastapi', 'uvicorn', 'safetensors', 'datasets', 'wetext',
           'inflect', 'einops', 'addict']
files = []
for name in modules:
    spec = importlib.util.find_spec(name)
    assert spec is not None, name + ' 缺失'
    if spec.origin and Path(spec.origin).is_file():
        files.append(spec.origin)
        files.append(str(Path(spec.origin).parent))
        if name == 'torch':
            folder = Path(spec.origin).parent
            files += [str(p) for p in folder.glob('_C*.pyd')]
            files += [str(p) for p in (folder/'lib').glob('*.dll')]
if len(sys.argv) > 2:
    assert '.'.join(map(str, sys.version_info[:3])) == sys.argv[2], 'Python 版本需要更新'
    for line in Path(sys.argv[1]).read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if line and not line.startswith('#'):
            name, version = line.split('==')
            assert metadata.version(name) == version, name + ' 版本需要更新'
    for name in ['torch', 'torchaudio']:
        assert metadata.version(name) == sys.argv[3], name + ' CUDA 构建需要更新'
print(json.dumps({'files': files}))
`;

class RuntimeService {
  constructor({ root, appRoot, dataRoot, appDir, onState = () => {}, config, runProcess } = {}) {
    Object.assign(this, { root, appRoot, dataRoot, appDir, onState });
    this.config = config || JSON.parse(fs.readFileSync(path.join(appDir, "runtime-config.json"), "utf8"));
    if (this.config.protocol !== 1) throw new Error("不支持的运行环境清单");
    for (const a of [this.config.python, this.config.pip, ...Object.values(this.config.profiles).flatMap((p) => p.wheels),
      ...(this.config.wheelhouse ? [this.config.wheelhouse.requirements, ...this.config.wheelhouse.files] : []),
      ...this.config.models.flatMap((m) => m.files)]) validateAsset(a);
    this.state = { status: "idle", activity: "startup", phase: "idle", message: "音频系统待启动，启动后会检查已安装环境与模型。", log: "" };
    this.processRunner = runProcess;
  }
  emit(partial) {
    if ("downloaded" in partial) partial = { verifying: false, reused: false, ...partial };
    this.state = { ...this.state, ...partial }; this.onState(this.state);
  }
  log(text) {
    this.emit({ log: (this.state.log + text).slice(-10000) });
    fs.appendFileSync(this.logPath, text, "utf8");
  }
  cancel() { this.controller?.abort(new Error("资源准备已暂停，下次启动可继续")); }
  check(partial) { this.emit({ status: this.state.status === "working" ? "working" : "checking", ...partial }); }
  assetProgress(value) {
    if (value.downloading) this.emit({ status: "working", activity: "prepare", message: `正在下载缺失资源：${value.name}`, ...value });
    else this.check(value);
  }
  startupSignature(selected, options) {
    return crypto.createHash("sha256").update(JSON.stringify({ config: this.config, selected, options,
      root: path.resolve(this.root), appRoot: path.resolve(this.appRoot) }))
      .update(fs.readFileSync(path.join(this.appDir, "runtime-requirements.txt"))).digest("hex");
  }
  async startupProbe(python, selected, managed) {
    const args = ["-c", STARTUP_PROBE];
    if (managed) args.push(path.join(this.appDir, "runtime-requirements.txt"), this.config.python.version,
      `${this.config.profiles[selected.profile].torch}+${selected.profile}`);
    const output = await this.run(python, args, { quiet: true, timeout: 20000 });
    const parsed = JSON.parse(output.trim().split(/\r?\n/).at(-1));
    if (!Array.isArray(parsed.files)) throw new Error("运行环境快速检查返回无效结果");
    return parsed.files;
  }
  async stamps(files) {
    return Promise.all([...new Set(files.map(file => path.resolve(file)))].map(async file => {
      const stat = await fsp.stat(file);
      if (!stat.isFile() && !stat.isDirectory()) throw new Error(`组件文件缺失：${file}`);
      return { file, type: stat.isDirectory() ? "directory" : "file", size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
    }));
  }
  async modelFiles(modelDir) {
    const files = [];
    for (const [i, model] of this.config.models.entries()) {
      const folder = i === 0 ? modelDir : safePath(this.root, `models/${model.folder}`);
      if (i === 0) {
        const config = JSON.parse(await fsp.readFile(path.join(folder, "config.json"), "utf8"));
        if (config.architecture && config.architecture !== "voxcpm2") {
          for (const entry of await fsp.readdir(folder, { withFileTypes: true })) if (entry.isFile()) files.push(path.join(folder, entry.name));
          continue;
        }
      }
      files.push(...model.files.map(asset => safePath(folder, asset.name)));
    }
    return files;
  }
  async reuseReady(signature, selected) {
    try {
      const ready = JSON.parse(await fsp.readFile(this.readyPath, "utf8"));
      if (ready.protocol !== 1 || ready.signature !== signature || !ready.files?.length) {
        this.log("运行环境清单、设备或路径发生变化，执行一次完整复检。\n");
        return null;
      }
      const current = await this.stamps(ready.files.map(item => item.file));
      if (JSON.stringify(current) !== JSON.stringify(ready.files)) {
        this.log("已就绪组件的文件信息发生变化，执行一次完整复检。\n");
        return null;
      }
      await this.startupProbe(ready.python, selected, ready.managed);
      this.controller.signal.throwIfAborted();
      this.log("已复用验证通过的本地环境，跳过完整依赖加载、pip 检查和模型哈希。\n");
      this.emit({ status: "ready", phase: "environment-ready", cached: true, message: "已复用就绪环境，正在启动本地服务", name: "", size: 0 });
      return this.runtimeResult(ready.python, ready.modelDir, ready.managed);
    } catch (error) {
      this.controller.signal.throwIfAborted();
      if (error.code !== "ENOENT" || error.path !== this.readyPath) this.log(`就绪缓存需要重新检查：${error.message}\n`);
      return null;
    }
  }
  runtimeResult(python, modelDir, managed) {
    return { python, modelDir, env: { ...this.modelEnv(), ...(managed ? {
      PATH: `${path.join(path.dirname(python), "ffmpeg")}${path.delimiter}${this.env.PATH || this.env.Path || ""}` } : {}) } };
  }
  async rememberReady(signature, selected, python, modelDir, managed) {
    let temp;
    try {
      const files = await this.startupProbe(python, selected, managed);
      const directory = path.dirname(python);
      for (const entry of await fsp.readdir(directory)) if (/\.(?:exe|dll|pyd|zip|_pth)$/i.test(entry)) files.push(path.join(directory, entry));
      if (managed) files.push(path.join(directory, "ffmpeg/ffmpeg.exe"));
      files.push(python, ...await this.modelFiles(modelDir));
      const ready = { protocol: 1, signature, python, modelDir, managed, files: await this.stamps(files), checkedAt: new Date().toISOString() };
      this.controller.signal.throwIfAborted();
      temp = `${this.readyPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fsp.writeFile(temp, JSON.stringify(ready));
      await fsp.rename(temp, this.readyPath);
    } catch (error) {
      this.controller.signal.throwIfAborted();
      this.log(`本次环境可用，但未能保存快速启动缓存：${error.message}\n`);
    } finally { if (temp) await fsp.rm(temp, { force: true }).catch(() => {}); }
  }
  async run(command, args, options = {}) {
    if (this.processRunner) return this.processRunner(command, args, options);
    this.controller.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true, cwd: this.appRoot, env: this.env || process.env, stdio: ["ignore", "pipe", "pipe"], ...options });
      let output = "", settled = false;
      const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
      const collect = (text) => { output = (output + text).slice(-30000); if (!options.quiet) this.log(text); };
      [child.stdout, child.stderr].forEach((stream, i) => stream.on("data", (b) => collect(decoders[i].write(b))));
      const stop = () => {
        if (process.platform === "win32" && child.pid) spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
        else child.kill();
      };
      const timer = setTimeout(() => { stop(); finish(new Error("运行环境检查超时，请查看补齐日志")); }, options.timeout || 30 * 60 * 1000);
      const abort = () => { stop(); };
      this.controller.signal.addEventListener("abort", abort, { once: true });
      const finish = (error) => {
        if (settled) return; settled = true;
        clearTimeout(timer); this.controller.signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve(output);
      };
      child.on("error", finish);
      child.on("close", (code) => {
        decoders.forEach((d) => collect(d.end()));
        finish(this.controller.signal.aborted ? this.controller.signal.reason : code === 0 ? null : new Error(`命令退出 ${code}：${output.slice(-5000)}`));
      });
    });
  }
  async detect() {
    let output;
    try {
      output = await this.run("nvidia-smi", ["--query-gpu=index,name,driver_version,compute_cap", "--format=csv,noheader,nounits"], { quiet: true, timeout: 15000 });
    } catch {
      this.controller.signal.throwIfAborted();
      // 部分旧驱动不支持 compute_cap 字段，仍可按型号路由。
      try { output = await this.run("nvidia-smi", ["--query-gpu=index,name,driver_version", "--format=csv,noheader,nounits"], { quiet: true, timeout: 15000 }); }
      catch {
        this.controller.signal.throwIfAborted();
        const adapters = await this.run("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"], { quiet: true, timeout: 20000 });
        if (/NVIDIA/i.test(adapters)) throw new Error("检测到 NVIDIA 显卡，但 nvidia-smi 不可用，请先安装或修复 NVIDIA 驱动。");
        return selectProfile([]);
      }
    }
    const gpus = output.trim().split(/\r?\n/).filter(Boolean).map((row) => {
      const [index, name, driver, capability] = row.split(",").map((v) => v.trim());
      if (!/^\d+$/.test(index) || !name || !driver) throw new Error("无法解析 NVIDIA 显卡信息");
      return { index, name, driver, capability: Number(capability) || 0 };
    });
    return selectProfile(gpus);
  }
  prepare(options = {}) {
    if (this.pending) return this.pending;
    this.controller = new AbortController();
    this.pending = this.prepareInternal(options).catch((error) => {
      this.emit({ status: this.controller.signal.aborted ? "cancelled" : "error", message: error.message });
      throw error;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
  async prepareInternal({ existingPython, existingModel, managed = false } = {}) {
    this.logPath = path.join(this.dataRoot, "cache", "runtime-bootstrap.log");
    this.readyPath = path.join(this.dataRoot, "cache", "runtime-ready.json");
    await fsp.mkdir(path.dirname(this.logPath), { recursive: true });
    this.emit({ status: "checking", activity: "startup", phase: "detect", cached: false, message: "正在识别音频设备与已安装环境", log: "", downloaded: 0, size: 0, name: "", modelName: "", modelState: "" });
    const selected = await this.detect();
    this.emit({ ...selected, phase: "check", message: `已识别 ${selected.label}，正在加载并检查音频组件` });
    this.env = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONNOUSERSITE: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" };
    if (selected.gpu) this.env.CUDA_VISIBLE_DEVICES = selected.gpu.index;
    const existingDirectory = existingPython ? path.resolve(path.dirname(existingPython)) : "";
    managed = managed || (path.dirname(existingDirectory) === path.join(this.root, "runtime", "managed") && /^py312-(cpu|cu126|cu128)$/.test(path.basename(existingDirectory)));
    const startupSignature = this.startupSignature(selected, { existingPython: managed ? "" : existingPython, existingModel, managed });
    const reused = await this.reuseReady(startupSignature, selected);
    if (reused) return reused;
    // 完整旧包先实测；不修补其 Python，失败才创建独立托管环境。
    if (!managed && existingPython && fs.existsSync(existingPython)) {
      let existingValid = false;
      try {
        await this.run(existingPython, ["-c", PROBE, selected.gpu ? "existing-gpu" : "existing"], { quiet: true, timeout: 90000,
          env: { ...this.env, PYTHONPATH: path.join(this.appRoot, "src") } });
        existingValid = true;
      } catch (e) { this.controller.signal.throwIfAborted(); this.log(`已有环境需要独立补齐：${e.message}\n`); }
      if (existingValid) {
        const modelDir = await this.prepareModels(existingModel);
        await this.rememberReady(startupSignature, selected, existingPython, modelDir, false);
        this.emit({ status: "ready", phase: "environment-ready", message: "已有运行环境检查通过，正在启动服务" });
        return this.runtimeResult(existingPython, modelDir, false);
      }
    }
    if (process.platform !== "win32" || process.arch !== "x64") throw new Error("自动补齐目前支持 Windows x64");
    const directory = path.join(this.root, "runtime", "managed", `py312-${selected.profile}`);
    const python = path.join(directory, "python.exe");
    const cache = path.join(this.dataRoot, "cache", "runtime-downloads");
    const progress = (value) => this.assetProgress(value);
    const get = (asset, target = cache) => downloadAsset(asset, target, { signal: this.controller.signal, progress });
    let pythonUsable = false;
    if (fs.existsSync(python)) {
      try {
        await this.run(python, ["-I", "-c", "import sys,ssl,zipfile; assert '.'.join(map(str,sys.version_info[:3])) == sys.argv[1]", this.config.python.version], { quiet: true, timeout: 20000 });
        pythonUsable = true;
      } catch (error) { this.controller.signal.throwIfAborted(); this.log(`Python 核心检查失败，开始恢复：${error.message}\n`); }
    }
    if (!pythonUsable) {
      this.emit({ status: "working", activity: "prepare", phase: "python", message: "正在准备缺失的音频运行环境" });
      const archive = await get(this.config.python);
      const staging = directory + ".extracting";
      if (path.dirname(staging) !== path.join(this.root, "runtime", "managed")) throw new Error("运行环境解压路径无效");
      await fsp.rm(staging, { recursive: true, force: true });
      await fsp.mkdir(staging, { recursive: true });
      // 先检查所有 ZIP 条目，再解压，避免路径穿越；目录只使用本程序计算的路径。
      await this.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($env:VOXCPM_EXTRACT_ZIP)
try {
 $base=[IO.Path]::GetFullPath($env:VOXCPM_EXTRACT_DIR)+[IO.Path]::DirectorySeparatorChar
 foreach($entry in $zip.Entries) {
  $full=[IO.Path]::GetFullPath([IO.Path]::Combine($base,$entry.FullName))
  if(-not $full.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)){throw 'ZIP path escapes destination'}
 }
} finally {$zip.Dispose()}
[IO.Compression.ZipFile]::ExtractToDirectory($env:VOXCPM_EXTRACT_ZIP,$env:VOXCPM_EXTRACT_DIR)
`], { env: { ...this.env, VOXCPM_EXTRACT_ZIP: archive, VOXCPM_EXTRACT_DIR: staging }, timeout: 60000 });
      if (fs.existsSync(directory)) {
        // 仅覆盖经清单验证的 Python 核心文件，保留已经补齐的依赖。
        await fsp.cp(staging, directory, { recursive: true, force: true });
        await fsp.rm(staging, { recursive: true, force: true });
      } else await fsp.rename(staging, directory);
    }
    await fsp.mkdir(path.join(directory, "Lib", "site-packages"), { recursive: true });
    await fsp.writeFile(path.join(directory, "python312._pth"), `python312.zip\n.\nLib/site-packages\n${path.join(this.appRoot, "src")}\nimport site\n`);
    let valid = false;
    const signature = crypto.createHash("sha256").update(JSON.stringify(this.config.profiles[selected.profile]))
      .update(fs.readFileSync(path.join(this.appDir, "runtime-requirements.txt"))).digest("hex");
    const marker = path.join(directory, "ready.json");
    // 中断后可能已安装完整，只是尚未写 ready；按真实导入、版本和依赖闭包检查复用。
    try {
      await this.run(python, ["-c", PROBE, selected.profile, path.join(this.appDir, "runtime-requirements.txt")], { quiet: true, timeout: 120000 });
      await this.run(python, ["-m", "pip", "check"], { quiet: true, timeout: 30000 });
      valid = true;
    } catch (e) { this.controller.signal.throwIfAborted(); this.log(`环境复检失败，开始补齐：${e.message}\n`); }
    if (!valid) {
      this.emit({ status: "working", activity: "prepare", phase: "dependencies", message: "正在安装缺失的音频依赖与 CUDA 运行时", name: "", size: 0 });
      const pip = await get(this.config.pip);
      await this.run(python, ["-c", "import sys,runpy; sys.path.insert(0,sys.argv.pop(1)); runpy.run_module('pip',run_name='__main__')", pip,
        "install", "--no-deps", "--force-reinstall", pip]);
      const wheels = [];
      for (const asset of this.config.profiles[selected.profile].wheels) wheels.push(await get(asset));
      if (this.config.wheelhouse) {
        await get(this.config.wheelhouse.requirements);
        let next = 0, complete = 0;
        const files = this.config.wheelhouse.files;
        const batch = await Promise.allSettled(Array.from({ length: Math.min(4, files.length) }, async () => {
          while (next < files.length) {
            await get(files[next++]);
            this.emit({ message: `正在补齐魔搭固定依赖（${++complete} / ${files.length}）` });
          }
        }));
        const failure = batch.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
        this.emit({ name: "", size: 0, message: "正在安装已校验的依赖，无需连接 PyPI" });
        await this.run(python, offlinePipArgs(this.config, selected.profile, cache, path.join(this.appDir, "runtime-requirements.txt")));
      } else {
      const indexes = ["https://mirrors.aliyun.com/pypi/simple/", "https://pypi.tuna.tsinghua.edu.cn/simple/"];
      let installed = false, lastError;
      for (const index of indexes) {
        try {
          // 嵌入式 Python 的 _pth 不读取 PEP 517 临时 PYTHONPATH；先安装构建工具，
          // 纯 Python sdist（argbind / antlr）在本环境构建，避免依赖系统 Python。
          await this.run(python, ["-m", "pip", "install", "--index-url", index, "setuptools==82.0.1", "wheel==0.47.0", "packaging>=24"]);
          // 显式约束已选 torch/audio，禁止依赖解析器替换为 CPU 或其他 CUDA 构建。
          const version = this.config.profiles[selected.profile].torch;
          this.emit({ name: "", size: 0, message: "正在安装依赖，请稍候；可展开日志查看下载和安装详情" });
          await this.run(python, ["-m", "pip", "install", "--force-reinstall", "--index-url", index, "--prefer-binary",
            "--no-build-isolation", "--find-links", cache,
            "--timeout", "30", "--retries", "2", "--cache-dir", path.join(cache, "pip"),
            "-r", path.join(this.appDir, "runtime-requirements.txt"), `torch==${version}+${selected.profile}`, `torchaudio==${version}+${selected.profile}`]);
          installed = true; break;
        } catch (error) { this.controller.signal.throwIfAborted(); lastError = error; this.log(`镜像安装失败，切换国内备用源：${error.message}\n`); }
      }
      if (!installed) throw lastError;
      }
      this.emit({ phase: "verify", message: "正在验证依赖与显卡实际运算", name: "", size: 0 });
      await this.run(python, ["-c", PROBE, selected.profile, path.join(this.appDir, "runtime-requirements.txt")], { timeout: 120000 });
      await this.run(python, ["-m", "pip", "check"], { timeout: 30000 });
    }
    const modelDir = await this.prepareModels(existingModel);
    // imageio 的官方 Windows wheel 携带 FFmpeg，无需系统安装。
    const ffmpegDir = path.join(directory, "ffmpeg");
    await fsp.mkdir(ffmpegDir, { recursive: true });
    await this.run(python, ["-c", "import imageio_ffmpeg,shutil,sys; shutil.copy2(imageio_ffmpeg.get_ffmpeg_exe(),sys.argv[1])", path.join(ffmpegDir, "ffmpeg.exe")], { quiet: true, timeout: 15000 });
    await fsp.writeFile(marker, JSON.stringify({ signature, ...selected, checkedAt: new Date().toISOString() }));
    await this.rememberReady(startupSignature, selected, python, modelDir, true);
    this.emit({ status: "ready", phase: "environment-ready", message: "本地环境已就绪，正在启动服务", name: "", size: 0 });
    return this.runtimeResult(python, modelDir, true);
  }
  modelEnv() {
    return { ...this.env, VOXCPM_MODELS_ROOT: path.join(this.root, "models"),
      ZIPENHANCER_MODEL_PATH: safePath(this.root, `models/${this.config.models[2].folder}`) };
  }
  async prepareModels(existingModel) {
    this.check({ phase: "models", message: "正在检查本地语音、识别和降噪模型", name: "", size: 0 });
    let modelDir = existingModel;
    for (const [i, model] of this.config.models.entries()) {
      const label = ["VoxCPM 2", "SenseVoice 语音识别", "ZipEnhancer 音频降噪"][i] || model.folder;
      this.check({ modelName: label, modelState: "checking", message: `${label} 模型文件检查中`, name: "", size: 0 });
      // 显式指定的其他版本模型由用户管理；默认 VoxCPM2 按清单检查所有必要文件。
      if (i === 0 && existingModel && fs.existsSync(path.join(existingModel, "config.json"))) {
        const config = JSON.parse(await fsp.readFile(path.join(existingModel, "config.json"), "utf8"));
        if (config.architecture && config.architecture !== "voxcpm2") continue;
      }
      const target = i === 0 && existingModel ? existingModel : safePath(this.root, `models/${model.folder}`);
      for (const asset of model.files) await downloadAsset(asset, target, {
        signal: this.controller.signal, progress: (value) => this.assetProgress(value) });
      this.check({ modelName: label, modelState: "ready", message: `${label} 模型文件检查完成`, name: "", size: 0 });
      if (i === 0) modelDir = target;
    }
    return modelDir;
  }
}

module.exports = { RuntimeService, selectProfile, downloadAsset, verified, safePath, validateAsset, resolveManagedPython, offlinePipArgs, PROBE, STARTUP_PROBE };
