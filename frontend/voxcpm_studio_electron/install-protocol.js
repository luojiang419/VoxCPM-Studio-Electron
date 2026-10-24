const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

async function writeReport(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.promises.writeFile(temp, JSON.stringify(value, null, 2), { flag: "wx" });
    const delays = [20, 50, 100, 200, 400];
    for (let attempt = 0; ; attempt++) {
      try { await fs.promises.rename(temp, file); return; }
      catch (error) {
        if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= delays.length) throw error;
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      }
    }
  } finally { await fs.promises.rm(temp, { force: true }).catch(() => {}); }
}

function installationSession({ root, dataRoot, report, session }) {
  if (!report && !session) return null;
  if (!/^[a-f0-9]{32}$/.test(session || "")) throw new Error("安装会话标识无效");
  const directory = path.resolve(root, "data", "cache", "install");
  const expected = path.join(directory, `${session}.json`);
  if (path.resolve(dataRoot).toLowerCase() !== path.resolve(root, "data").toLowerCase() ||
      path.resolve(report || ".").toLowerCase() !== expected.toLowerCase()) throw new Error("安装就绪报告必须位于当前安装目录");
  fs.mkdirSync(directory, { recursive: true });
  let latest, pending, finished = false, warned = false;
  const finish = async value => {
    finished = true;
    latest = null;
    await pending;
    await writeReport(expected, value);
  };
  return {
    progress(value) {
      if (finished) return Promise.resolve();
      const { status, phase, message, name, downloaded, size } = value;
      latest = { session, root: path.resolve(root), status, phase, message, name, downloaded, size };
      if (!pending) pending = (async () => {
        while (latest && !finished) {
          const snapshot = latest; latest = null;
          try { await writeReport(expected + ".progress", snapshot); }
          catch (error) {
            // 进度属于可重试的显示数据，不能从下载流的事件回调抛出。
            if (!warned) { warned = true; console.warn(`安装进度暂未写入（${error.code || "IO"}），安装继续，后续进度会重试。`); }
          }
          if (latest && !finished) await new Promise(resolve => setTimeout(resolve, 100));
        }
      })().finally(() => { pending = null; });
      return pending;
    },
    ready(components) {
      if (!components || components.protocol !== 2 || !Array.isArray(components.selected) || !/^[a-f0-9]{64}$/.test(components.signature)) throw new Error("所选组件尚未全部就绪");
      return finish({ session, root: path.resolve(root), ok: true, status: "ready", components });
    },
    fail(error) { return finish({ session, root: path.resolve(root), ok: false, status: "error", error: String(error?.message || error) }); },
  };
}
module.exports = { installationSession, writeReport };
