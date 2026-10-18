const fs = require("node:fs");
const path = require("node:path");
const { atomicJson } = require("./update-service");

function installationSession({ root, dataRoot, report, session }) {
  if (!report && !session) return null;
  if (!/^[a-f0-9]{32}$/.test(session || "")) throw new Error("安装会话标识无效");
  const directory = path.resolve(root, "data", "cache", "install");
  const expected = path.join(directory, `${session}.json`);
  if (path.resolve(dataRoot).toLowerCase() !== path.resolve(root, "data").toLowerCase() ||
      path.resolve(report || ".").toLowerCase() !== expected.toLowerCase()) throw new Error("安装就绪报告必须位于当前安装目录");
  fs.mkdirSync(directory, { recursive: true });
  return {
    progress(value) {
      const { status, phase, message, name, downloaded, size } = value;
      atomicJson(expected + ".progress", { session, root: path.resolve(root), status, phase, message, name, downloaded, size });
    },
    ready() { atomicJson(expected, { session, root: path.resolve(root), ok: true, status: "ready" }); },
    fail(error) { atomicJson(expected, { session, root: path.resolve(root), ok: false, status: "error", error: String(error?.message || error) }); },
  };
}
module.exports = { installationSession };
