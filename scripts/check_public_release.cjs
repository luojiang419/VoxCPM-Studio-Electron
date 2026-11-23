// 匿名读取已发布签名入口与说明，并用实际 UpdateService 检查新旧客户端状态。
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { UpdateService, verifyEnvelope, request } = require("../frontend/voxcpm_studio_electron/update-service");
const repo = path.resolve(__dirname, ".."), snapshot = path.resolve(process.argv[2]);
const frontend = path.join(repo, "frontend/voxcpm_studio_electron");
const config = JSON.parse(fs.readFileSync(path.join(frontend, "update-config.json")));
const expected = JSON.parse(fs.readFileSync(path.join(snapshot, "envelope.json")));
async function read(url) { const stream = await request(url, 0, { Range: "bytes=0-" }); const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks).toString("utf8"); }
(async () => {
  const envelope = JSON.parse(await read(config.manifestUrl)); assert.deepEqual(envelope, expected);
  const manifest = verifyEnvelope(envelope, config.publicKey, "2.0.2");
  const publication = JSON.parse(fs.readFileSync(path.join(snapshot, "repairer-publication.json")));
  assert.equal(publication.releaseId, manifest.releaseId); assert.equal(publication.anonymousVerification, true);
  const readmeUrl = `https://modelscope.cn/api/v1/models/${config.repository}/repo?Revision=master&FilePath=README.md`;
  const readme = await read(readmeUrl);
  assert.ok(readme.includes(publication.repairUrl)); assert.ok(readme.includes(publication.sha256));
  assert.ok(readme.includes(manifest.notes));
  const clients = [];
  for (const [version, releaseId, status] of [["2.0.2", "20261018235215", "available"], ["2.0.3", "20261019103629", "available"], [manifest.version, manifest.releaseId, "current"]]) {
    const root = path.join(snapshot, "public-client-check", version);
    const service = new UpdateService({ root, dataRoot: path.join(root, "data"), appDir: frontend, currentVersion: version, config: { ...config, releaseId } });
    const result = await service.check(); assert.equal(result.status, status); assert.equal(result.latestVersion, manifest.version);
    clients.push({ version, releaseId, status: result.status, latestVersion: result.latestVersion });
  }
  const report = { passed: true, anonymousSignedManifest: true, version: manifest.version, releaseId: manifest.releaseId,
    clients, readmeLinksMatchInstaller: true, readmeHashMatchesInstaller: true, releaseNotesPublished: true, checkedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(snapshot, "public-client-check.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
