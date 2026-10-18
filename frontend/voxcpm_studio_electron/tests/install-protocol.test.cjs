const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { installationSession } = require("../install-protocol");

test("安装握手只允许当前目录、当前会话，拒绝向任意文件写报告", () => {
  const root = path.join(os.tmpdir(), "voxcpm-test"), session = crypto.randomBytes(16).toString("hex");
  assert.equal(installationSession({ root, dataRoot: root }), null);
  assert.throws(() => installationSession({ root, dataRoot: path.join(root, "data"), session: "../../x", report: path.join(root, "x") }));
  assert.throws(() => installationSession({ root, dataRoot: path.join(root, "data"), session, report: path.join(root, "private.json") }));
  assert.throws(() => installationSession({ root, dataRoot: path.join(root, "other"), session, report: path.join(root, "data/cache/install", session + ".json") }));
});

test("进度报告过滤运行日志和环境变量，只有显式 ready 才产生成功报告", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voxcpm-install-"));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const session = crypto.randomBytes(16).toString("hex"), report = path.join(root, "data/cache/install", session + ".json");
  const protocol = installationSession({ root, dataRoot: path.join(root, "data"), session, report });
  protocol.progress({ status: "ready", phase: "ready", message: "依赖已补齐", log: "sensitive", token: "secret", downloaded: 10, size: 10 });
  await assert.rejects(fs.stat(report), { code: "ENOENT" });
  const progress = JSON.parse(await fs.readFile(report + ".progress", "utf8"));
  assert.equal(progress.session, session); assert.equal(progress.log, undefined); assert.equal(progress.token, undefined);
  protocol.ready();
  const ready = JSON.parse(await fs.readFile(report, "utf8"));
  assert.equal(ready.ok, true); assert.equal(ready.status, "ready"); assert.equal(ready.root, root);
});

test("服务启动失败会明确报告失败", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voxcpm-install-"));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const session = crypto.randomBytes(16).toString("hex"), report = path.join(root, "data/cache/install", session + ".json");
  installationSession({ root, dataRoot: path.join(root, "data"), session, report }).fail(new Error("CUDA 不兼容"));
  const failure = JSON.parse(await fs.readFile(report, "utf8"));
  assert.equal(failure.ok, false); assert.equal(failure.error, "CUDA 不兼容");
});
