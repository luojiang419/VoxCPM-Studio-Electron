if (process.argv.includes("--voxcpm-updater")) {
  require("./update-window");
} else {
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } = require("electron");
const { UpdateService, atomicJson } = require("./update-service");
const { RuntimeService, resolveManagedPython } = require("./runtime-service");
const { installationSession } = require("./install-protocol");
const { ComponentService } = require("./component-service");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const WINDOW_BOUNDS = {
  width: 1560,
  height: 980,
  minWidth: 1180,
  minHeight: 760,
};

const SERVICE_PORT_START = 8808;
const SERVICE_PORT_END = 8899;
const SERVER_WAIT_TIMEOUT_MS = 180_000;

let mainWindow = null;
let backendProcess = null;
let backendStartPromise = null;
let backendLogBuffer = "";
let backendStartedAt = 0;
let backendStopRequested = false;
let lastBackendExitCode = null;
let previousCpuSample = null;
let currentThemeSource = "dark";
let updateService = null;
let runtimeService = null;
let componentService = null;
let componentReceipt = null;
let updatePreparationHeartbeat = null;
let installSession = null;
const preparingInstallation = process.argv.includes("--voxcpm-install");
let updateHealthWritten = false;
let rendererReadyResolve;
const rendererReady = new Promise((resolve) => { rendererReadyResolve = resolve; });
let bootstrapState = {
  status: "booting",
  statusText: "正在准备 Electron 桌面壳。",
  detail: "即将启动本地 Python API 服务。",
  backendBaseUrl: "",
  backendLogPath: "",
  backendPid: null,
  backendRunning: false,
  backendStartedAt: 0,
  lastBackendExitCode: null,
  projectRoot: "",
  appRoot: "",
  dataRoot: "",
  themeSource: "dark",
  systemPrefersDark: true,
};
let startupUpdateScheduled = false;

function scheduleStartupUpdate() {
  if (startupUpdateScheduled || !updateService.getAutoCheck()) return;
  startupUpdateScheduled = true;
  void rendererReady.then(() => {
    setTimeout(() => {
      if (bootstrapState.status === "ready" && updateService.getAutoCheck()) void updateService.check({ source: "startup" });
    }, 1000).unref();
  });
}

function findUp(startDir, matcher) {
  let current = path.resolve(startDir);
  while (true) {
    if (matcher(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveProjectRoot() {
  const bundledRoot = findUp(__dirname, (candidate) =>
    fs.existsSync(path.join(candidate, "runtime_manifest.json")) ||
    fs.existsSync(path.join(candidate, "VoxCPM Studio.exe")),
  );
  if (bundledRoot) {
    return bundledRoot;
  }

  const repoRoot = findUp(__dirname, (candidate) =>
    fs.existsSync(path.join(candidate, "pyproject.toml")) &&
    fs.existsSync(path.join(candidate, "app.py")),
  );
  if (repoRoot) {
    return repoRoot;
  }

  return path.resolve(__dirname, "..", "..");
}

function resolveAppRoot() {
  const overrideRoot = process.env.VOXCPM_APP_ROOT;
  if (overrideRoot && overrideRoot.trim()) {
    return path.resolve(overrideRoot);
  }
  const projectRoot = resolveProjectRoot();
  const packagedAppRoot = path.join(projectRoot, "app");
  if (fs.existsSync(path.join(packagedAppRoot, "desktop_api.py"))) {
    return packagedAppRoot;
  }
  return projectRoot;
}

function resolveDataRoot() {
  const overrideRoot = process.env.VOXCPM_DATA_ROOT;
  if (overrideRoot && overrideRoot.trim()) {
    return path.resolve(overrideRoot);
  }
  return path.join(resolveProjectRoot(), "data");
}

function resolveBackendLogPath() {
  return path.join(resolveDataRoot(), "cache", "electron_backend.log");
}

function resolveBackendStatePath() {
  return path.join(resolveDataRoot(), "cache", "electron_backend_state.json");
}

function resolveBundledModelDir(projectRoot) {
  const bundledModelDir = path.join(projectRoot, "models");
  if (fs.existsSync(path.join(bundledModelDir, "config.json"))) {
    return bundledModelDir;
  }
  return "";
}

function resolvePythonCommand(appRoot, projectRoot) {
  const override = process.env.VOXCPM_PYTHON_EXE;
  if (override && override.trim()) {
    return override;
  }
  const managed = resolveManagedPython(projectRoot);
  if (managed) return managed;

  const candidates = process.platform === "win32"
    ? [
        path.join(projectRoot, "runtime", "python", "python.exe"),
        path.join(appRoot, ".venv", "Scripts", "python.exe"),
        path.join(appRoot, "runtime", "python", "python.exe"),
        "python",
        "py",
      ]
    : [
        path.join(projectRoot, "runtime", "python", "bin", "python3"),
        path.join(appRoot, ".venv", "bin", "python"),
        path.join(appRoot, ".venv", "bin", "python3"),
        "python3",
        "python",
      ];

  for (const candidate of candidates) {
    if (!candidate.includes(path.sep)) {
      return candidate;
    }
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return process.platform === "win32" ? "python" : "python3";
}

function normalizeProcessValue(value) {
  return String(value || "").replace(/\//g, "\\").toLowerCase();
}

function readBackendState() {
  const statePath = resolveBackendStatePath();
  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (error) {
    console.warn("Failed to read backend state:", error);
    return null;
  }
}

function writeBackendState(payload) {
  const statePath = resolveBackendStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(payload, null, 2), "utf8");
}

function clearBackendState() {
  try {
    fs.rmSync(resolveBackendStatePath(), { force: true });
  } catch (error) {
    console.warn("Failed to clear backend state:", error);
  }
}

function normalizeProcessRecords(payload) {
  const records = Array.isArray(payload) ? payload : payload ? [payload] : [];
  return records
    .map((record) => ({
      pid: Number(record.ProcessId ?? record.pid ?? record.PID ?? 0),
      commandLine: String(record.CommandLine ?? record.commandLine ?? record.cmd ?? ""),
    }))
    .filter((record) => Number.isInteger(record.pid) && record.pid > 0 && record.commandLine);
}

function listKnownDesktopApiProcesses(projectRoot, appRoot) {
  const knownPythonCommands = [
    path.join(projectRoot, "runtime", "python", "python.exe"),
    path.join(appRoot, ".venv", "Scripts", "python.exe"),
    path.join(appRoot, "runtime", "python", "python.exe"),
    ...["cpu", "cu126", "cu128"].map((profile) => path.join(projectRoot, "runtime", "managed", `py312-${profile}`, "python.exe")),
  ]
    .map(normalizeProcessValue)
    .filter(Boolean);

  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$items = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*desktop_api.py*' } | Select-Object ProcessId, CommandLine",
      "if ($items) { $items | ConvertTo-Json -Compress }",
    ].join("; ");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    });
    const output = (result.stdout || "").trim();
    if (!output) {
      return [];
    }

    try {
      return normalizeProcessRecords(JSON.parse(output)).filter((record) => {
        const commandLine = normalizeProcessValue(record.commandLine);
        return commandLine.includes("desktop_api.py") && knownPythonCommands.some((snippet) => commandLine.includes(snippet));
      });
    } catch (error) {
      console.warn("Failed to parse managed backend process list:", error);
      return [];
    }
  }

  const result = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number(match[1]),
        commandLine: match[2],
      };
    })
    .filter(Boolean)
    .filter((record) => {
      const commandLine = normalizeProcessValue(record.commandLine);
      return commandLine.includes("desktop_api.py") && knownPythonCommands.some((snippet) => commandLine.includes(snippet));
    });
}

function terminateProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return result.status === 0;
  }

  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function cleanupStaleBackendProcesses(projectRoot, appRoot) {
  const records = listKnownDesktopApiProcesses(projectRoot, appRoot);
  const cleanedPids = [];
  for (const candidate of records) {
    if (terminateProcessTree(candidate.pid)) {
      cleanedPids.push(candidate.pid);
    }
  }

  clearBackendState();
  return cleanedPids;
}

function sendRuntimeEvent(type, payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("runtime:event", { type, ...payload });
}

function setBootstrapState(partial) {
  bootstrapState = {
    ...bootstrapState,
    ...partial,
    projectRoot: resolveProjectRoot(),
    appRoot: resolveAppRoot(),
    dataRoot: resolveDataRoot(),
    themeSource: currentThemeSource,
    systemPrefersDark: nativeTheme.shouldUseDarkColors,
  };
}

function loadFallbackHtml(message) {
  if (!mainWindow) {
    return;
  }
  const safeMessage = String(message)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  mainWindow.loadURL(
    `data:text/html;charset=utf-8,<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>VoxCPM Studio Electron</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#181817;color:#eeece6;font-family:'Segoe UI','Microsoft YaHei UI',sans-serif}main{width:min(760px,calc(100vw - 48px));padding:28px;border-radius:24px;background:rgba(32,32,30,.94);border:1px solid rgba(255,255,255,.08);box-shadow:0 20px 60px rgba(0,0,0,.34)}pre{white-space:pre-wrap;word-break:break-word;background:rgba(255,255,255,.05);padding:14px;border-radius:16px;color:#ffd9d9}</style></head><body><main><h1>VoxCPM Studio Electron</h1><p>前端构建文件不存在，请先执行 <code>npm run build</code>。</p><pre>${safeMessage}</pre></main></body></html>`,
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "VoxCPM Studio Electron",
    icon: path.join(__dirname, "app.ico"),
    show: !preparingInstallation,
    width: WINDOW_BOUNDS.width,
    height: WINDOW_BOUNDS.height,
    minWidth: WINDOW_BOUNDS.minWidth,
    minHeight: WINDOW_BOUNDS.minHeight,
    backgroundColor: "#181817",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const distIndex = path.join(__dirname, "dist", "index.html");
  if (fs.existsSync(distIndex)) {
    mainWindow.loadFile(distIndex);
    return;
  }
  loadFallbackHtml(`缺少构建文件：${distIndex}`);
}

function isBackendRunning() {
  return Boolean(backendProcess && backendProcess.exitCode === null && !backendProcess.killed);
}

function summarizeBootstrapState() {
  return {
    ...bootstrapState,
    backendPid: backendProcess ? backendProcess.pid : null,
    backendRunning: isBackendRunning(),
    backendStartedAt,
    lastBackendExitCode,
  };
}

function killBackend(reason = "manual-stop") {
  if (!backendProcess || backendProcess.killed || backendProcess.exitCode !== null) {
    backendProcess = null;
    backendStartedAt = 0;
    const cleanedPids = reason === "manual-stop"
      ? cleanupStaleBackendProcesses(resolveProjectRoot(), resolveAppRoot())
      : [];
    if (reason === "manual-stop") {
      setBootstrapState({
        status: "stopped",
        statusText: "本地服务已停止",
        detail: cleanedPids.length
          ? `本地服务当前未运行，已额外清理 ${cleanedPids.length} 个旧服务进程。`
          : "本地服务当前未运行，可手动重新启动。",
        backendBaseUrl: "",
        backendPid: null,
        backendRunning: false,
        backendStartedAt: 0,
      });
      sendRuntimeEvent("backend-stopped", summarizeBootstrapState());
    }
    return;
  }

  try {
    backendStopRequested = reason === "manual-stop";
    setBootstrapState({
      status: "stopping",
      statusText: "正在停止本地服务",
      detail: "已发送停止信号，正在等待本地服务退出。",
    });
    sendRuntimeEvent("backend-stopping", summarizeBootstrapState());
    terminateProcessTree(backendProcess.pid);
  } catch (error) {
    console.error("Failed to stop backend:", error);
  }
}

function getCpuSample() {
  const totals = os.cpus().reduce(
    (accumulator, cpu) => {
      accumulator.idle += cpu.times.idle;
      accumulator.total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
      return accumulator;
    },
    { idle: 0, total: 0 },
  );

  const currentSample = {
    idle: totals.idle,
    total: totals.total,
    time: Date.now(),
  };

  if (!previousCpuSample) {
    previousCpuSample = currentSample;
    return { usagePercent: 0 };
  }

  const idleDelta = currentSample.idle - previousCpuSample.idle;
  const totalDelta = currentSample.total - previousCpuSample.total;
  previousCpuSample = currentSample;

  if (totalDelta <= 0) {
    return { usagePercent: 0 };
  }

  const usage = 100 - (idleDelta / totalDelta) * 100;
  return { usagePercent: Math.max(0, Math.min(100, usage)) };
}

function getGpuMemoryStats() {
  const result = spawnSync("nvidia-smi", ["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 2000,
  });

  if (result.error || result.status !== 0 || !result.stdout) {
    return {
      gpuMemorySupported: false,
      gpuMemoryUsedMB: 0,
      gpuMemoryTotalMB: 0,
      gpuMemoryUsagePercent: 0,
      gpuMemoryDeviceCount: 0,
    };
  }

  const rows = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [usedValue, totalValue] = line.split(",").map((item) => Number(item.trim()));
      return {
        used: usedValue,
        total: totalValue,
      };
    })
    .filter((item) => Number.isFinite(item.used) && Number.isFinite(item.total) && item.total > 0);

  if (!rows.length) {
    return {
      gpuMemorySupported: false,
      gpuMemoryUsedMB: 0,
      gpuMemoryTotalMB: 0,
      gpuMemoryUsagePercent: 0,
      gpuMemoryDeviceCount: 0,
    };
  }

  const gpuMemoryUsedMB = rows.reduce((sum, item) => sum + item.used, 0);
  const gpuMemoryTotalMB = rows.reduce((sum, item) => sum + item.total, 0);
  return {
    gpuMemorySupported: true,
    gpuMemoryUsedMB: Math.round(gpuMemoryUsedMB),
    gpuMemoryTotalMB: Math.round(gpuMemoryTotalMB),
    gpuMemoryUsagePercent: Number(((gpuMemoryUsedMB / gpuMemoryTotalMB) * 100).toFixed(1)),
    gpuMemoryDeviceCount: rows.length,
  };
}

function getResourceStats() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const cpu = getCpuSample();
  const gpu = getGpuMemoryStats();

  return {
    cpuUsagePercent: Number(cpu.usagePercent.toFixed(1)),
    systemMemoryTotalMB: Math.round(totalMemory / 1024 / 1024),
    systemMemoryUsedMB: Math.round(usedMemory / 1024 / 1024),
    systemMemoryFreeMB: Math.round(freeMemory / 1024 / 1024),
    systemMemoryUsagePercent: Number(((usedMemory / totalMemory) * 100).toFixed(1)),
    appMemoryRssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    gpuMemorySupported: gpu.gpuMemorySupported,
    gpuMemoryUsedMB: gpu.gpuMemoryUsedMB,
    gpuMemoryTotalMB: gpu.gpuMemoryTotalMB,
    gpuMemoryUsagePercent: gpu.gpuMemoryUsagePercent,
    gpuMemoryDeviceCount: gpu.gpuMemoryDeviceCount,
    backendPid: backendProcess ? backendProcess.pid : null,
    backendRunning: isBackendRunning(),
    backendStartedAt,
    backendUptimeSec: backendStartedAt ? Math.max(0, Math.round((Date.now() - backendStartedAt) / 1000)) : 0,
    platform: process.platform,
    cpuCoreCount: os.cpus().length,
  };
}

function waitForServer(url, timeoutMs = SERVER_WAIT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;

    const probe = () => {
      const request = http.get(url, { timeout: 2000 }, (response) => {
        response.resume();
        resolve(response.statusCode < 500);
      });

      request.on("error", () => {
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(probe, 1000);
      });

      request.on("timeout", () => {
        request.destroy();
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(probe, 1000);
      });
    };

    probe();
  });
}

function findFreePort(start = SERVICE_PORT_START, end = SERVICE_PORT_END) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > end) {
        reject(new Error(`Unable to find free port in range ${start}-${end}`));
        return;
      }

      const server = net.createServer();
      server.unref();
      server.on("error", () => tryPort(port + 1));
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        const actualPort = typeof address === "object" && address ? address.port : port;
        server.close(() => resolve(actualPort));
      });
    };

    tryPort(start);
  });
}

async function startBackend() {
  if (isBackendRunning() && bootstrapState.status === "ready") {
    return summarizeBootstrapState();
  }
  if (backendStartPromise) {
    return backendStartPromise;
  }
  backendStartPromise = (async () => {
  if (isBackendRunning()) {
    const previous = backendProcess;
    const exited = new Promise(resolve => previous.once("exit", resolve));
    killBackend("retry-preparation");
    await exited;
  }
  const projectRoot = resolveProjectRoot();
  const appRoot = resolveAppRoot();
  const dataRoot = resolveDataRoot();
  let pythonCommand = resolvePythonCommand(appRoot, projectRoot);
  const backendLogPath = resolveBackendLogPath();
  const bundledModelDir = resolveBundledModelDir(projectRoot);
  let modelDir = (process.env.VOXCPM_MODEL_DIR || bundledModelDir || "").trim();
  const cleanedPids = cleanupStaleBackendProcesses(projectRoot, appRoot);
  setBootstrapState({ status: "preparing", statusText: "音频系统启动中", detail: "正在检查已安装模型并加载音频组件，完成后自动进入工作区。" });
  sendRuntimeEvent("boot", summarizeBootstrapState());
  let runtime;
  try {
    runtime = await runtimeService.prepare({ existingPython: pythonCommand, existingModel: modelDir,
      managed: fs.existsSync(path.join(projectRoot, "lightweight.json")) });
    pythonCommand = runtime.python;
    modelDir = runtime.modelDir || modelDir;
  } catch (error) {
    setBootstrapState({ status: "error", statusText: "运行环境准备未完成", detail: error.message });
    sendRuntimeEvent("error", summarizeBootstrapState());
    throw error;
  }
  const port = await findFreePort();
  runtimeService.emit({ status: "checking", activity: "startup", phase: "service", message: "音频服务加载中，已安装模型将在生成时按需加载", modelName: "音频服务", modelState: "loading", name: "", size: 0 });
  const serviceUrl = `http://127.0.0.1:${port}`;
  const healthUrl = `${serviceUrl}/api/health`;

  fs.mkdirSync(path.dirname(backendLogPath), { recursive: true });

  const launchArgs = ["desktop_api.py", "--server-name", "127.0.0.1", "--port", String(port)];
  if (modelDir.trim()) {
    launchArgs.push("--model-dir", modelDir.trim());
  }

  lastBackendExitCode = null;
  backendStopRequested = false;
  setBootstrapState({
    status: "booting",
    statusText: "正在启动本地 API 服务",
    detail: cleanedPids.length
      ? `已自动清理 ${cleanedPids.length} 个旧服务进程，服务地址将绑定到 ${serviceUrl}`
      : `服务地址将绑定到 ${serviceUrl}`,
    backendBaseUrl: "",
    backendLogPath,
    backendPid: null,
    backendRunning: false,
    backendStartedAt: 0,
    lastBackendExitCode: null,
  });
  sendRuntimeEvent("boot", summarizeBootstrapState());

  const pythonDir = path.dirname(pythonCommand);
  const pythonScriptsDir = process.platform === "win32"
    ? path.join(pythonDir, "Scripts")
    : path.join(pythonDir, "..", "bin");
  const ffmpegRoot = path.join(projectRoot, "ffmpeg");
  const ffmpegBin = path.join(ffmpegRoot, "bin");
  const currentPathValue = runtime.env.PATH || runtime.env.Path || "";
  const backendPathValue = [
    pythonDir,
    pythonScriptsDir,
    ffmpegBin,
    ffmpegRoot,
    currentPathValue,
  ]
    .filter((entry, index) => entry && (index === 4 || fs.existsSync(entry)))
    .join(path.delimiter);
  const backendEnv = {
    ...process.env,
    ...runtime.env,
    PATH: backendPathValue,
    Path: backendPathValue,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    VOXCPM_BACKEND_LOG: backendLogPath,
    VOXCPM_DATA_ROOT: dataRoot,
    VOXCPM_PROJECT_ROOT: projectRoot,
    VOXCPM_PYTHON_EXE: pythonCommand,
    VOXCPM_MODEL_DIR: modelDir,
    HF_HOME: path.join(dataRoot, "cache", "hf-home"),
    HUGGINGFACE_HUB_CACHE: path.join(dataRoot, "cache", "hf-hub"),
    TRANSFORMERS_CACHE: path.join(dataRoot, "cache", "transformers"),
    MODELSCOPE_CACHE: path.join(dataRoot, "cache", "modelscope"),
    TORCH_HOME: path.join(dataRoot, "cache", "torch"),
  };

  backendProcess = spawn(pythonCommand, launchArgs, {
    cwd: appRoot,
    env: backendEnv,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  backendLogBuffer = "";
  backendStartedAt = Date.now();
  writeBackendState({
    pid: backendProcess.pid,
    port,
    serviceUrl,
    pythonCommand,
    appRoot,
    projectRoot,
    modelDir,
    startedAt: new Date(backendStartedAt).toISOString(),
  });

  backendProcess.stdout.on("data", (data) => {
    backendLogBuffer += data.toString("utf-8");
    backendLogBuffer = backendLogBuffer.slice(-24000);
  });

  backendProcess.stderr.on("data", (data) => {
    backendLogBuffer += data.toString("utf-8");
    backendLogBuffer = backendLogBuffer.slice(-24000);
  });

  backendProcess.on("exit", (code) => {
    lastBackendExitCode = code;
    const wasManualStop = backendStopRequested;
    backendStopRequested = false;
    clearBackendState();
    const detail = wasManualStop
      ? "本地服务已手动停止。"
      : code === 0
        ? "本地服务已正常退出。"
        : `本地服务异常退出，退出码：${code}`;
    setBootstrapState({
      status: "stopped",
      statusText: wasManualStop ? "本地服务已停止" : "本地服务已退出",
      detail,
      backendBaseUrl: "",
      backendPid: null,
      backendRunning: false,
      backendStartedAt: 0,
      lastBackendExitCode: code,
    });
    sendRuntimeEvent(wasManualStop ? "backend-stopped" : "backend-exit", {
      code,
      ...summarizeBootstrapState(),
    });
    backendProcess = null;
    backendStartedAt = 0;
  });

  const ready = await waitForServer(healthUrl);
  if (!ready) {
    killBackend("startup-failed");
    throw new Error(
      [
        `无法连接到本地地址 ${healthUrl}`,
        `Python 启动命令：${pythonCommand} ${launchArgs.join(" ")}`,
        "",
        "最近日志片段：",
        backendLogBuffer || "暂无日志输出，请检查依赖、模型目录和端口占用。",
      ].join("\n"),
    );
  }

  setBootstrapState({ status: "preparing", statusText: "音频系统启动中", detail: "音频服务加载完成，正在检查所选功能。" });
  componentReceipt = await componentService.prepare({ url: serviceUrl, runtime });
  setBootstrapState({
    status: "ready",
    statusText: "控制台已就绪",
    detail: "Electron 原生界面已经连接到本地 VoxCPM API。",
    backendBaseUrl: serviceUrl,
    backendLogPath,
    backendPid: backendProcess ? backendProcess.pid : null,
    backendRunning: true,
    backendStartedAt,
    lastBackendExitCode: null,
    projectRoot,
    appRoot,
    dataRoot,
  });
  sendRuntimeEvent("ready", summarizeBootstrapState());
  scheduleStartupUpdate();
  return summarizeBootstrapState();
  })();

  try {
    return await backendStartPromise;
  } catch (error) {
    setBootstrapState({ status: "error", statusText: "本地服务尚未就绪", detail: String(error) });
    sendRuntimeEvent("error", summarizeBootstrapState());
    throw error;
  } finally {
    backendStartPromise = null;
  }
}

ipcMain.handle("runtime:get-bootstrap-state", () => {
  setBootstrapState({});
  return summarizeBootstrapState();
});

ipcMain.handle("update:state", () => updateService?.state);
ipcMain.handle("runtime:renderer-ready", () => { rendererReadyResolve(); return true; });
ipcMain.handle("update:check", () => updateService.check());
ipcMain.handle("update:download", () => updateService.download());
ipcMain.handle("update:auto-check", (_event, enabled) => updateService.setAutoCheck(enabled));
ipcMain.handle("update:install", async () => {
  if (!fs.existsSync(resolvePythonCommand(resolveAppRoot(), resolveProjectRoot()))) {
    await dialog.showMessageBox(mainWindow, { type: "info", title: "请先准备运行环境", message: "请先点击运行，完成环境补齐后再安装更新。" });
    return false;
  }
  const answer = await dialog.showMessageBox(mainWindow, { type: "question", title: "重启并更新",
    message: "安装更新需要关闭软件。请确认生成与训练任务已结束。",
    detail: "安装完成后将自动重启，模型、配置与已有作品会保留。",
    buttons: ["取消", "重启并安装"], defaultId: 0, cancelId: 0 });
  if (answer.response !== 1) return false;
  await updateService.launch();
  app.quit();
  return true;
});

ipcMain.handle("runtime:set-theme-source", (_event, themeSource) => {
  currentThemeSource = ["dark", "light", "system"].includes(themeSource) ? themeSource : "dark";
  nativeTheme.themeSource = currentThemeSource;
  setBootstrapState({});
  return summarizeBootstrapState();
});

ipcMain.handle("runtime:start-backend", async () => startBackend());
ipcMain.handle("runtime:preparation-state", () => runtimeService.state);
ipcMain.handle("runtime:cancel-preparation", () => { runtimeService.cancel(); return true; });
ipcMain.handle("components:state", () => componentService.state());
ipcMain.handle("components:select", (_event, value) => {
  if (componentService.working || backendStartPromise) throw new Error("请先暂停并等待当前准备结束");
  const profile = componentService.select(value);
  componentReceipt = null;
  killBackend("component-selection");
  setBootstrapState({ status: "stopped", statusText: "组件选择已保存", detail: "点击准备并进入，补齐所选功能。" });
  sendRuntimeEvent("boot", summarizeBootstrapState());
  return profile;
});
ipcMain.handle("components:remove", async (_event, id) => {
  if (isBackendRunning() || backendStartPromise) throw new Error("请先停止本地引擎，再移除模型");
  const release = componentService.acquire();
  try { return await componentService.remove(id); } finally { release(); }
});

ipcMain.handle("runtime:stop-backend", async () => {
  killBackend("manual-stop");
  return summarizeBootstrapState();
});

ipcMain.handle("runtime:get-resource-stats", async () => getResourceStats());

ipcMain.handle("dialog:open", async (_event, options) => dialog.showOpenDialog(mainWindow, options));
ipcMain.handle("dialog:save", async (_event, options) => dialog.showSaveDialog(mainWindow, options));

ipcMain.handle("shell:open-external", async (_event, targetUrl) => {
  if (!targetUrl) {
    return false;
  }
  await shell.openExternal(targetUrl);
  return true;
});

ipcMain.handle("shell:open-path", async (_event, targetPath) => {
  if (!targetPath) {
    return false;
  }
  const result = await shell.openPath(targetPath);
  return result === "";
});

ipcMain.handle("shell:show-item-in-folder", async (_event, targetPath) => {
  if (!targetPath) {
    return false;
  }
  shell.showItemInFolder(targetPath);
  return true;
});

nativeTheme.on("updated", () => {
  setBootstrapState({});
  sendRuntimeEvent("theme-updated", summarizeBootstrapState());
});

if (preparingInstallation || fs.existsSync(path.join(resolveProjectRoot(), ".voxcpm-install.json"))) {
  const profile = path.join(resolveDataRoot(), "cache", "electron-profile");
  fs.mkdirSync(profile, { recursive: true }); app.setPath("userData", profile);
}
app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.setAppUserModelId("VoxCPM.Studio");
  try {
    if (preparingInstallation) installSession = installationSession({ root: resolveProjectRoot(), dataRoot: resolveDataRoot(),
      report: process.env.VOXCPM_INSTALL_REPORT, session: process.env.VOXCPM_INSTALL_SESSION });
    if (preparingInstallation && !installSession) throw new Error("缺少安装会话");
  } catch (error) { dialog.showErrorBox("安装会话无效", String(error)); app.quit(); return; }
  const pendingPath = path.join(resolveProjectRoot(), "data", "cache", "updates", "pending.json");
  if (fs.existsSync(pendingPath) && !process.env.VOXCPM_UPDATE_SESSION) {
    try {
      const pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
      let running = false;
      try { process.kill(pending.pid, 0); running = true; } catch { /* 更新进程已退出。 */ }
      if (running) {
        dialog.showErrorBox("正在更新", "独立更新器正在安装，请等待更新完成。");
        app.quit(); return;
      }
      const result = spawnSync(resolvePythonCommand(resolveAppRoot(), resolveProjectRoot()),
        [path.join(__dirname, "updater.py"), pending.session, "--recover"], { windowsHide: true, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stdout || result.stderr || "更新恢复失败");
    } catch (error) {
      dialog.showErrorBox("更新恢复失败", String(error)); app.quit(); return;
    }
  }
  updateService = new UpdateService({ root: resolveProjectRoot(), dataRoot: resolveDataRoot(), appDir: __dirname,
    currentVersion: app.getVersion(), onState: (state) => sendRuntimeEvent("update-state", { update: state }) });
  runtimeService = new RuntimeService({ root: resolveProjectRoot(), appRoot: resolveAppRoot(), dataRoot: resolveDataRoot(), appDir: __dirname,
    onState: (preparation) => { installSession?.progress(preparation); sendRuntimeEvent("runtime-preparation", { preparation }); } });
  componentService = new ComponentService({ root: resolveProjectRoot(), appRoot: resolveAppRoot(), dataRoot: resolveDataRoot(), appDir: __dirname,
    runtimeService, reuseRoots: process.env.VOXCPM_COMPONENT_REUSE_ROOT ? [process.env.VOXCPM_COMPONENT_REUSE_ROOT] : [] });
  // 首次升级可能新增数十 GB 模型：有进度且进程存活时，更新器继续等待。
  if (process.env.VOXCPM_UPDATE_HEALTH_FILE) {
    const heartbeat = () => {
      if (updateHealthWritten) return;
      atomicJson(process.env.VOXCPM_UPDATE_HEALTH_FILE + ".preparing", { version: app.getVersion(),
        releaseId: updateService.config.releaseId || "00000000000000", pid: process.pid,
        status: runtimeService.state.status, checkedAt: Date.now() });
    };
    heartbeat(); updatePreparationHeartbeat = setInterval(heartbeat, 15000); updatePreparationHeartbeat.unref();
  }
  nativeTheme.themeSource = currentThemeSource;
  setBootstrapState({});
  createWindow();
  previousCpuSample = null;

  try {
    await startBackend();
    if (installSession) {
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("工作台界面初始化超时，请重新运行安装器")), 60000);
        rendererReady.then(() => { clearTimeout(deadline); resolve(); });
      });
      installSession.ready(componentReceipt);
    }
    if (process.env.VOXCPM_UPDATE_HEALTH_FILE && !updateHealthWritten) {
      await rendererReady;
      atomicJson(process.env.VOXCPM_UPDATE_HEALTH_FILE, { version: app.getVersion(),
        releaseId: updateService.config.releaseId || "00000000000000", pid: process.pid });
      updateHealthWritten = true;
    }
  } catch (error) {
    installSession?.fail(error);
    setBootstrapState({
      status: "error",
      statusText: "桌面壳启动失败",
      detail: String(error),
    });
    sendRuntimeEvent("error", summarizeBootstrapState());
  }
});

app.on("before-quit", () => {
  runtimeService?.cancel();
  killBackend();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
app.on("second-instance", () => {
  if (mainWindow) { mainWindow.show(); if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});
}
