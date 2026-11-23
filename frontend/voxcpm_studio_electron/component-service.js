// 安装器与存量应用共用的启动前组件准备；所有选择与移除状态保存在用户数据中。
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { downloadAsset, verified, safePath, validateAsset } = require('./runtime-service');
const { atomicJson } = require('./update-service');

const OPTIONS = [
  { id: 'lipsync', label: '视频对口型与照片说话', size: 6 * 1024 ** 3, minMemoryMB: 7680 },
  { id: 'ace-xl-turbo', label: 'ACE-Step 1.5 XL Turbo · 默认音乐模型', minMemoryMB: 15360 },
  { id: 'yue2', label: 'YuE2-3B', minMemoryMB: 7680 },
  { id: 'minimax-music3', label: 'MiniMax Music 3', minMemoryMB: 15360 },
  { id: 'heartmula', label: 'HeartMuLa 3B', minMemoryMB: 15360 },
];

function normalizeProfile(value = {}) {
  const ids = new Set(OPTIONS.map(o => o.id));
  if (!Array.isArray(value.selected) || value.selected.some(id => !ids.has(id))) throw new Error('组件选择无效');
  if (value.removed !== undefined && !Array.isArray(value.removed)) throw new Error('组件移除记录无效');
  const removed = [...new Set(value.removed || [])].filter(id => ids.has(id));
  const selected = [...new Set(value.selected)].filter(id => !removed.includes(id));
  return { protocol: 1, selected, removed,
    defaultModel: selected.includes(value.defaultModel) && value.defaultModel !== 'lipsync' ? value.defaultModel : selected.find(id => id !== 'lipsync') || 'ace-xl-turbo' };
}

class ComponentService {
  constructor({ root, dataRoot, appRoot, appDir, runtimeService, fetchImpl = fetch, catalog, reuseRoots = [] }) {
    Object.assign(this, { root, dataRoot, appRoot, appDir, runtimeService, fetchImpl, reuseRoots });
    if (runtimeService.readOnlyResources && process.env.VOXCPM_INSTALLED_ROOT) this.root = path.resolve(process.env.VOXCPM_INSTALLED_ROOT);
    this.file = path.join(dataRoot, 'component-selection.json');
    this.receipt = path.join(dataRoot, 'cache', 'component-ready.json');
    this.catalog = catalog || JSON.parse(fs.readFileSync(path.join(appDir, 'music-config.json'), 'utf8'));
    if (this.catalog.protocol !== 1 || !this.catalog.runtime?.parts?.length || this.catalog.models.length !== 4) throw new Error('组件资源清单不完整');
    const spec = this.catalog.runtime;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(spec.version) || !Number.isSafeInteger(spec.size) || spec.size <= 0 ||
      !Number.isSafeInteger(spec.installed_size) || spec.installed_size <= 0 || !/^[a-f0-9]{64}$/.test(spec.sha256) ||
      !Array.isArray(spec.required) || !spec.required.length || spec.parts.reduce((n, a) => n + a.size, 0) !== spec.size) throw new Error('音乐运行包校验清单无效');
    safePath(root, `runtime/music/${this.catalog.runtime.version}`);
    for (const asset of [...this.catalog.runtime.parts, ...this.catalog.models.flatMap(m => m.files)]) validateAsset(asset);
    for (const option of OPTIONS.filter(o => o.id !== 'lipsync')) if (!this.catalog.models.find(m => m.id === option.id)?.files.length) throw new Error('模型资源清单不完整');
    for (const file of this.catalog.runtime.required) safePath(root, file);
    const names = new Map();
    for (const asset of this.catalog.models.flatMap(m => m.files)) {
      if (!asset.name.startsWith('models/music/')) throw new Error('模型文件必须位于独立托管目录');
      if (asset.reusePath) safePath(root, asset.reusePath);
      const previous = names.get(asset.name.toLowerCase());
      if (previous && (previous.size !== asset.size || previous.sha256 !== asset.sha256)) throw new Error('共享模型文件清单冲突');
      names.set(asset.name.toLowerCase(), asset);
    }
  }
  profile() { try { return normalizeProfile(JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (e) { if (e.code !== 'ENOENT') throw e; return null; } }
  select(value) {
    if (this.working) throw new Error('请先暂停组件准备，再修改安装选择');
    const profile = normalizeProfile(value); atomicJson(this.file, profile); fs.rmSync(this.receipt, { force: true }); return profile;
  }
  options() {
    return OPTIONS.map(option => ({ ...option, size: option.id === 'lipsync' ? option.size : this.catalog.models.find(m => m.id === option.id).files.reduce((n, a) => n + a.size, 0) }));
  }
  state() {
    return { profile: this.profile(), working: !!this.working || !!this.runtimeService.pending, runtimeSize: this.catalog.runtime.installed_size,
      options: this.options().map(o => ({ ...o, present: o.id === 'lipsync' ? false : this.catalog.models.find(m => m.id === o.id).files.some(a => fs.existsSync(safePath(this.root, a.name)) || fs.existsSync(safePath(this.root, a.name) + '.part')),
        installed: o.id === 'lipsync' ? undefined : this.catalog.models.find(m => m.id === o.id).files.every(a => {
        try { return fs.statSync(safePath(this.root, a.name)).size === a.size; } catch { return false; }
      }) })) };
  }
  acquire() {
    fs.mkdirSync(this.dataRoot, { recursive: true });
    const file = path.join(this.dataRoot, '.component-preparation.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const fd = fs.openSync(file, 'wx'); fs.writeFileSync(fd, String(process.pid)); return () => { fs.closeSync(fd); fs.unlinkSync(file); }; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const pid = Number(fs.readFileSync(file, 'utf8'));
        try { if (pid > 0) { process.kill(pid, 0); throw new Error('另一进程正在准备或移除组件'); } }
        catch (e) { if (e.code !== 'ESRCH') throw e; }
        fs.unlinkSync(file);
      }
    }
    throw new Error('无法锁定组件目录');
  }
  async checkSpace(models, forceRuntime = false) {
    const needed = new Map();
    const add = (directory, size) => { const drive = path.parse(path.resolve(directory)).root; needed.set(drive, (needed.get(drive) || 0) + size); };
    for (const asset of models.flatMap(m => m.files)) {
      const target = safePath(this.root, asset.name);
      const exists = await fsp.stat(target).catch(() => null);
      if (exists?.size !== asset.size) {
        const partial = await fsp.stat(target + '.part').catch(() => null);
        // 同卷硬链接无需重复占用模型空间。
        const reusable = this.reuseRoots.some(root => path.parse(path.resolve(root)).root === path.parse(path.resolve(this.root)).root && (() => { try { return fs.statSync(safePath(root, asset.reusePath || asset.name)).size === asset.size; } catch { return false; } })());
        if (!reusable) add(this.root, Math.max(0, asset.size - (partial?.size || 0)));
      }
    }
    if ((models.length || forceRuntime) && (forceRuntime || !fs.existsSync(safePath(this.root, `runtime/music/${this.catalog.runtime.version}/ready.json`)))) {
      const spec = this.catalog.runtime, cache = safePath(this.dataRoot, `cache/music-runtime/${spec.version}`);
      add(this.root, spec.installed_size);
      let missing = 0;
      for (const part of spec.parts) {
        const complete = await fsp.stat(path.join(cache, part.name)).catch(() => null);
        const partial = await fsp.stat(path.join(cache, part.name + '.part')).catch(() => null);
        missing += complete?.size === part.size ? 0 : Math.max(0, part.size - (partial?.size || 0));
      }
      const merged = await fsp.stat(path.join(cache, 'music-runtime.zip.part')).catch(() => null);
      add(this.dataRoot, missing + Math.max(0, spec.size - (merged?.size || 0)));
    }
    for (const [drive, size] of needed) {
      const stat = await fsp.statfs(drive);
      const free = Number(stat.bavail) * Number(stat.bsize);
      if (free < size + 1024 ** 3) throw new Error(`${drive} 空间不足：还需约 ${(size / 1024 ** 3 + 1).toFixed(1)} GiB，可用 ${(free / 1024 ** 3).toFixed(1)} GiB。请取消部分模型或释放空间后继续。`);
    }
  }
  async api(url, route, body, signal) {
    const response = await this.fetchImpl(url + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : '组件服务请求失败');
    return result;
  }
  async prepare({ url, runtime }) {
    if (this.runtimeService.readOnlyResources) throw new Error('当前开发入口只读复用安装目录，不重新下载或安装组件。');
    if (this.working) return this.working;
    const perform = async () => {
      const service = this.runtimeService, signal = service.controller.signal;
      const emit = partial => service.emit({ status: 'checking', activity: 'startup', phase: 'components', name: '', size: 0, modelName: '', modelState: '', ...partial });
      const release = this.acquire();
      try {
        await fsp.rm(this.receipt, { force: true });
        emit({ message: '正在检查所选功能，全部就绪后进入工作区' });
        const video = await this.api(url, '/api/lipsync/status', undefined, signal);
        const hardware = video.hardware || {};
        let profile = this.profile();
        if (!profile) {
          profile = normalizeProfile({ selected: OPTIONS.filter(o => ['lipsync', 'ace-xl-turbo'].includes(o.id) && hardware.cuda && hardware.totalMB >= o.minMemoryMB).map(o => o.id), removed: [] });
          atomicJson(this.file, profile);
        }
        for (const id of profile.selected) {
          const option = OPTIONS.find(o => o.id === id);
          if (!hardware.cuda || hardware.totalMB < option.minMemoryMB) throw new Error(`${option.label}建议至少${option.minMemoryMB >= 15360 ? 16 : 8}GB NVIDIA显存。可在组件选择中取消，继续使用语音功能。`);
        }
        const models = this.catalog.models.filter(model => profile.selected.includes(model.id));
        await this.checkSpace(models);
        // 模型文件下载不需要视频或音乐 Python 环境；避免等待完整环境安装后才开始。
        for (const model of models) {
          emit({ message: `${model.label} 模型文件检查中`, modelName: model.label, modelState: 'checking', component: model.id });
          for (const asset of model.files) {
            const target = safePath(this.root, asset.name);
            await this.ensureFile(asset, target, emit, signal, true);
          }
          emit({ message: `${model.label} 模型文件检查完成`, modelName: model.label, modelState: 'ready', component: model.id });
        }
        if (profile.selected.includes('lipsync') && (video.needsPreparation || !video.ready)) {
          emit({ status: 'working', activity: 'prepare', message: `正在准备 LatentSync ${video.preferredVersion} 缺失的资源` });
          const task = await this.api(url, '/api/lipsync/prepare', { model_version: 'auto' }, signal);
          try {
            while (true) {
              signal.throwIfAborted();
              const state = await this.api(url, `/api/tasks/${task.taskId}`, undefined, signal);
              emit({ status: 'working', activity: 'prepare', message: state.progressText || state.statusText || '正在准备视频组件', component: 'lipsync' });
              if (state.status === 'error' || state.status === 'failed') throw new Error(state.error || state.statusText);
              if (state.status === 'cancelled' || state.result?.cancelled) throw new Error('视频准备已暂停，下次可继续');
              if (state.status === 'succeeded' || state.status === 'done' || state.status === 'completed') break;
              await new Promise(resolve => setTimeout(resolve, 600));
            }
          } catch (error) {
            // 即使客户端请求已取消，也通知后端停止本次补齐任务。
            await this.api(url, `/api/tasks/${task.taskId}/cancel`, {}).catch(() => {}); throw error;
          }
          const ready = await this.api(url, '/api/lipsync/status', undefined, signal);
          if (ready.needsPreparation || !ready.ready) throw new Error('视频组件复检未通过');
        }
        if (models.length) {
          await this.prepareRuntime(runtime, emit, signal);
          emit({ message: '音乐音频组件加载与自检中，模型权重将在生成时加载' });
          const directory = safePath(this.root, `runtime/music/${this.catalog.runtime.version}`);
          const args = [path.join(this.appRoot, 'src/voxcpm/music_worker.py'), '--probe', '--engine', directory, '--models', models.map(m => m.id).join(',')];
          try { await service.run(path.join(directory, 'python/python.exe'), args, { timeout: 180000 }); }
          catch (error) {
            signal.throwIfAborted();
            if (error.code === 'RUNTIME_PROCESS_TIMEOUT') throw error;
            emit({ message: '音乐环境自检未通过，正在从完整包修复一次' });
            await this.prepareRuntime(runtime, emit, signal, true);
            await service.run(path.join(directory, 'python/python.exe'), args, { timeout: 180000 });
          }
        }
        const signature = crypto.createHash('sha256').update(JSON.stringify({ profile, catalog: this.catalog })).digest('hex');
        const receipt = { protocol: 2, selected: profile.selected, signature, checkedAt: new Date().toISOString() };
        atomicJson(this.receipt, receipt);
        service.emit({ status: 'ready', activity: 'startup', phase: 'ready', message: '音频系统启动完成，正在进入工作区', modelName: '', modelState: '', name: '', size: 0 });
        return receipt;
      } catch (error) {
        service.emit({ status: signal.aborted ? 'cancelled' : 'error', phase: 'components', message: error.message }); throw error;
      } finally { release(); }
    };
    this.working = perform();
    try { return await this.working; } finally { this.working = null; }
  }
  async ensureFile(asset, target, emit, signal, reuse = false) {
    for (let current = target; current !== path.dirname(current); current = path.dirname(current)) {
      const info = await fsp.lstat(current).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (info?.isSymbolicLink()) throw new Error('托管模型路径经过目录连接或符号链接，已保留原文件');
      if (current === path.resolve(this.root) || current === path.resolve(this.dataRoot)) break;
    }
    if ((await fsp.lstat(target + '.part').catch(() => null))?.isSymbolicLink()) throw new Error('下载临时文件不能是符号链接');
    const cacheFile = path.join(this.dataRoot, 'cache', 'component-files.json');
    this.cache ||= (() => { try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { return {}; } })();
    const key = path.resolve(target), stat = await fsp.stat(target).catch(() => null);
    const previous = this.cache[key];
    if (stat && previous && previous.sha256 === asset.sha256 && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs && previous.ctimeMs === stat.ctimeMs) return;
    if (!await verified(target, asset)) {
      let reused = false;
      if (reuse && !stat) for (const root of this.reuseRoots) {
        const source = safePath(root, asset.reusePath || asset.name);
        if (!await verified(source, asset)) continue;
        signal.throwIfAborted();
        await fsp.mkdir(path.dirname(target), { recursive: true });
        try { await fsp.link(source, target); }
        catch (e) { if (e.code === 'EXDEV') await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL); else throw e; }
        reused = true;
        break;
      }
      if (!reused) {
        const space = await fsp.statfs(path.parse(target).root);
        const partial = await fsp.stat(target + '.part').catch(() => null);
        if (Number(space.bavail) * Number(space.bsize) < Math.max(0, asset.size - (partial?.size || 0)) + 512 * 1024 ** 2) throw new Error('下载空间不足，请释放空间后继续');
        let downloading = false;
        await downloadAsset({ ...asset, name: path.basename(target) }, path.dirname(target), { signal,
          fetchImpl: this.fetchImpl, progress: p => {
            downloading ||= !!p.downloading;
            emit({ ...p, activity: downloading ? 'prepare' : 'startup', status: downloading ? 'working' : 'checking', message: `${downloading ? '正在下载缺失资源' : '正在校验已安装文件'}：${path.basename(target)}` });
          } });
      }
    }
    signal.throwIfAborted();
    const ready = await fsp.stat(target);
    this.cache[key] = { sha256: asset.sha256, size: ready.size, mtimeMs: ready.mtimeMs, ctimeMs: ready.ctimeMs };
    atomicJson(cacheFile, this.cache);
  }
  async prepareRuntime(runtime, emit, signal, force = false) {
    const spec = this.catalog.runtime;
    if (!spec?.parts?.length) throw new Error('音乐运行包清单缺失，不能进入未准备好的功能');
    const directory = safePath(this.root, `runtime/music/${spec.version}`);
    let valid = false;
    try {
      const ready = JSON.parse(await fsp.readFile(path.join(directory, 'ready.json'), 'utf8'));
      valid = ready.sha256 === spec.sha256 && (await Promise.all(spec.required.map(p => fsp.stat(safePath(directory, p)).then(s => s.isFile()).catch(() => false)))).every(Boolean);
    } catch { /* 下载或安装中断后继续恢复。 */ }
    if (valid && !force) return;
    await this.checkSpace([], true);
    const cache = safePath(this.dataRoot, `cache/music-runtime/${spec.version}`);
    await fsp.mkdir(cache, { recursive: true });
    for (const part of spec.parts) await this.ensureFile(part, path.join(cache, part.name), emit, signal);
    emit({ status: 'working', activity: 'prepare', message: '正在安装已校验的独立音乐环境' });
    await this.runtimeService.run(runtime.python, [path.join(this.appRoot, 'src/voxcpm/music_install.py'), '--cache', cache, '--target', directory,
      '--spec', path.join(this.appDir, 'music-config.json')], { timeout: 30 * 60 * 1000 });
    signal.throwIfAborted();
  }
  async remove(id) {
    if (this.runtimeService.readOnlyResources) throw new Error('已安装模型正在被开发入口只读复用，不能从此入口移除。');
    if (this.working) throw new Error('组件准备中，请先暂停');
    const model = this.catalog.models.find(m => m.id === id);
    if (!model) throw new Error('该组件不支持在此移除');
    // 主进程仅在本地引擎停止时允许移除，避免与推理进程竞争文件。
    // 先保存用户主动移除意图，即使中途退出，也不会在下次更新中自动装回来。
    const profile = this.profile() || normalizeProfile({ selected: [] });
    this.select({ ...profile, selected: profile.selected.filter(x => x !== id), removed: [...profile.removed, id] });
    const stillUsed = new Set(this.catalog.models.filter(m => m.id !== id && (profile.selected.includes(m.id) || m.files.every(a => fs.existsSync(safePath(this.root, a.name))))).flatMap(m => m.files.map(a => a.name)));
    let freed = 0, removedBytes = 0, sharedBytes = 0;
    for (const asset of model.files) {
      if (stillUsed.has(asset.name)) continue;
      for (const target of [safePath(this.root, asset.name), safePath(this.root, asset.name) + '.part']) {
        const stat = await fsp.lstat(target).catch(() => null);
        if (!stat) continue;
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('模型路径不是托管普通文件，已保留');
        if (!(await fsp.realpath(target)).toLowerCase().startsWith((path.resolve(this.root) + path.sep).toLowerCase())) throw new Error('模型位于托管目录之外，已保留');
        await fsp.unlink(target); removedBytes += stat.size;
        if (stat.nlink > 1) sharedBytes += stat.size; else freed += stat.size;
      }
    }
    return { freed, removedBytes, sharedBytes, profile: this.profile() };
  }
}
module.exports = { ComponentService, normalizeProfile, OPTIONS };
