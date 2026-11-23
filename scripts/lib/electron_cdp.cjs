const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(probe, timeout = 30000) {
  let last;
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await probe(); if (value) return value; } catch (error) { last = error; }
    await wait(250);
  }
  throw new Error("等待界面超时：" + (last?.message || "条件未满足"));
}
async function connect(port) {
  const target = await until(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return targets.find((item) => item.type === "page" && item.url.startsWith("file:"));
  });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const pending = new Map(), events = [];
  let sequence = 0;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    } else if (message.method) events.push(message);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }, 120000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  await send("Runtime.enable");
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  return { send, evaluate, events, close: () => socket.close() };
}
module.exports = { connect, until, wait };
