const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 执行生产控制器，验证键盘重复与修饰键不会误切换全屏。
function fixture() {
  const module = { exports: {} };
  const app = new EventEmitter();
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../window-behavior.js"), "utf8"), {
    module, setImmediate, require(name) {
      if (name === "electron") return { app };
      if (name === "node:fs") return { readFileSync() { throw new Error("首次使用"); } };
      if (name === "./update-service") return {};
      return require(name);
    },
  });
  const window = new EventEmitter();
  window.webContents = new EventEmitter();
  window.fullScreen = false;
  window.calls = 0;
  window.isDestroyed = () => false;
  window.isFullScreen = () => window.fullScreen;
  window.setFullScreen = value => { window.fullScreen = value; window.calls++; };
  new module.exports.WindowBehavior({ dataRoot: "fixture", icon: "" }).attach(window);
  function key(input) {
    let prevented = false;
    window.webContents.emit("before-input-event", { preventDefault() { prevented = true; } }, { key: "F11", type: "keyDown", ...input });
    return prevented;
  }
  return { window, key };
}

test("F11 可反复进入和退出全屏，长按和松开不重复切换", () => {
  const { window, key } = fixture();
  assert.equal(key(), true);
  assert.equal(window.fullScreen, true);
  key({ isAutoRepeat: true });
  key({ type: "keyUp" });
  assert.equal(window.calls, 1);
  assert.equal(window.fullScreen, true);
  key();
  assert.equal(window.fullScreen, false);
  assert.equal(window.calls, 2);
});

test("修饰键和其他按键不拦截，销毁中的窗口不切换", () => {
  const { window, key } = fixture();
  for (const modifier of ["control", "alt", "meta", "shift"]) assert.equal(key({ [modifier]: true }), false);
  assert.equal(key({ key: "F10" }), false);
  assert.equal(window.calls, 0);
  window.isDestroyed = () => true;
  key();
  assert.equal(window.calls, 0);
});
