const root = document.querySelector("#root");
let session,
  data,
  selected = "",
  appId = "jvox-studio",
  page = "用户授权",
  query = "";
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const stamp = (t) =>
  t == null
    ? "永久有效"
    : new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Shanghai",
        dateStyle: "short",
        timeStyle: "short",
        hour12: false,
      }).format(new Date(t * 1000));
const dateInput = (t) =>
  new Date(t * 1000 + 8 * 3600000).toISOString().slice(0, 16);
let toastTimer;
function notice(text) {
  document.querySelector("#notice").textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => (document.querySelector("#notice").textContent = ""),
    5000,
  );
}
async function api(path, body, method) {
  const res = await fetch("/api/v1" + path, {
    method: method || (body ? "POST" : "GET"),
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(session?.csrf ? { "X-CSRF-Token": session.csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  if (!res.ok) {
    if (res.status === 401 && session) {
      session = null;
      renderLogin();
    }
    throw Error(
      typeof json.detail === "string" ? json.detail : "请检查输入内容",
    );
  }
  return json;
}
function button(label, cls = "secondary", attrs = "") {
  return `<button class="${cls}" ${attrs}>${esc(label)}</button>`;
}
function field(name, label, value = "", type = "text", extra = "") {
  return `<label class="field"><span>${esc(label)}</span><input name="${esc(name)}" type="${type}" value="${esc(value)}" ${extra}></label>`;
}
function status(l) {
  return !l.active
    ? "已停用"
    : l.kind === "permanent"
      ? "永久授权"
      : l.expires > data.server_time
        ? "试用中"
        : "已到期";
}
function shell(content) {
  return `<header><a class="brand" href="/admin">EE2X <small>/ AUTH CENTER</small></a><nav>${["用户授权", "软件接入", "防滥用", "操作记录", "账户设置"].map((n) => button(n, page === n ? "nav active" : "nav", `data-page="${n}"`)).join("")}</nav><span class="admin-identity">${esc(session.user.username)} ${button("退出登录", "text", 'id="logout"')}</span></header><main><div class="eyebrow">统一授权中心 <span>ADMIN.EE2X.CN</span></div><h1>${esc(page)}</h1><p class="subtitle">${page === "用户授权" ? "让每一次开通，都有迹可循。" : "账号统一，权限独立。"}</p>${content}</main>`;
}
function renderLogin() {
  root.innerHTML = `<div class="login-layout"><section class="story"><div class="brand">EE2X <small>/ AUTH CENTER</small></div><h1>每一份授权，<br>都有迹可循。</h1><p>从用户注册到永久开通，统一管理每一款软件的使用权限。</p><span class="muted">EE2X · 统一授权中心</span></section><section class="login-form"><span class="eyebrow">管理员登录</span><h2>欢迎回来，作者。</h2><p class="muted">使用管理员账号登录，查看用户与软件授权。</p><form id="login">${field("username", "管理员账号", "", "text", 'required autocomplete="username"')}${field("password", "登录密码", "", "password", 'required autocomplete="current-password"')}${button("登录管理后台", "primary", 'type="submit"')}<p id="form-error" role="alert"></p></form></section></div>`;
  document.querySelector("#login").onsubmit = async (e) => {
    e.preventDefault();
    const submit =
      e.submitter || e.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      session = await api(
        "/admin/auth/login",
        Object.fromEntries(new FormData(e.currentTarget)),
      );
      history.replaceState(null, "", "/admin");
      await load();
    } catch (err) {
      document.querySelector("#form-error").textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  };
}
async function load() {
  data = await api("/admin/state");
  if (!data.apps.some((a) => a.id === appId)) appId = data.apps[0]?.id;
  render();
}
function render() {
  let content = "";
  if (page === "用户授权") {
    const licenses = data.licenses.filter((l) => l.app_id === appId);
    const rows = licenses.filter((l) => {
      const u = data.users.find((u) => u.id === l.user_id);
      return [u?.name, u?.username, u?.id]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase());
    });
    if (!licenses.some((l) => l.id === selected))
      selected = licenses[0]?.id || "";
    const l = licenses.find((l) => l.id === selected),
      u = data.users.find((u) => u.id === l?.user_id);
    const product = data.apps.find((a) => a.id === appId);
    content = `<div class="layout"><section><div class="toolbar"><label>选择软件 <select id="app-select">${data.apps.map((a) => `<option value="${esc(a.id)}" ${a.id === appId ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label><input id="search" placeholder="搜索用户、账号、用户编号" value="${esc(query)}"></div><div class="table-scroll"><table><thead><tr><th>用户</th><th>授权</th><th>到期时间</th></tr></thead><tbody>${
      rows
        .map((l) => {
          const u = data.users.find((u) => u.id === l.user_id);
          return `<tr class="${l.id === selected ? "selected" : ""}"><td><button class="user" data-select="${l.id}"><strong>${esc(u?.name)}</strong><small>${esc(u?.username)} · ${esc(u?.id)}</small></button></td><td>${esc(status(l))}</td><td>${esc(stamp(l.expires))}</td></tr>`;
        })
        .join("") ||
      '<tr><td colspan="3" class="muted">暂无用户。用户从软件注册后会自动出现在这里。</td></tr>'
    }</tbody></table></div><p class="muted list-count">共 ${rows.length} 位用户</p></section><aside>${l ? `<h2>${esc(u?.name)}</h2><p>${esc(product.name)}</p><div class="detail-line">授权状态 <strong>${esc(status(l))}</strong></div><div class="time-left"><small>${l.kind === "permanent" ? "使用期限" : "试用剩余"}</small><strong>${l.kind === "permanent" ? "永久有效" : Math.max(0, Math.ceil((l.expires - data.server_time) / 86400)) + " 天"}</strong></div><div class="detail-line">到期时间 <strong>${esc(stamp(l.expires))}</strong></div><div class="detail-line">已绑定设备 <strong>${l.devices} / ${product.device_limit} 台</strong></div><div class="detail-line">授权编号 <code>${esc(l.id.slice(0, 12))}</code></div>${l.kind === "trial" ? button("调整试用期限", "secondary wide", 'id="adjust"') : ""}<hr><h3>开通永久使用权限</h3><p class="muted">核实收款后，仅为该用户开通此软件的永久权限。</p>${l.kind === "permanent" ? '<p class="success">永久权限已开通</p>' : `<label class="check"><input type="checkbox" id="received">已核实该用户付款</label><label class="field"><span>收款备注</span><textarea id="reason" maxlength="200" placeholder="订单号、付款方式或备注"></textarea></label>${button("开通永久权限", "primary wide", 'id="grant" disabled')}`}<hr>${button(l.active ? "停用此授权" : "恢复此授权", "text", 'id="toggle-license"')}` : '<h2>尚无授权用户</h2><p class="muted">用户注册后自动领取一个月试用。</p>'}</aside></div>`;
  }
  if (page === "软件接入")
    content = `<div class="section-heading"><h2>已接入软件</h2>${button("添加软件", "primary", 'id="add-app"')}</div>${data.apps.map((a) => `<article class="product"><div><h2>${esc(a.name)}</h2><code>${esc(a.id)}</code><p class="muted">注册即享一个自然月试用 · 设备上限 ${a.device_limit} 台</p></div>${button("编辑软件与联系信息", "secondary", `data-edit-app="${esc(a.id)}"`)}</article>`).join("")}`;
  if (page === "防滥用") {
    const p = data.abuse_policies.find((p) => p.app_id === appId);
    const claims = data.trial_claims.filter((c) => c.app_id === appId);
    content = `<div class="toolbar"><label>选择软件 <select id="app-select">${data.apps.map((a) => `<option value="${esc(a.id)}" ${a.id === appId ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label></div><section class="settings"><h2>IP 与网卡联合限制</h2><p class="muted">同设备或同 MAC 网卡只可领取一次试用；每个公网 IP 默认一份试用，IPv6 按 /64 网段计。限制只针对新试用，正常登录、更换网络与永久授权不受 IP 名额影响。</p><form id="abuse-policy">${field("max_ip_trials", "同 IP 累计试用名额", p?.max_ip_trials || 1, "number", 'required min="1" max="1000"')}${button("保存防滥用设置", "primary", 'type="submit"')}</form><p class="muted">网卡仅上传按软件隔离的 SHA-256 指纹。旧账号与已签发授权继续有效；新客户端注册必须提供网卡指纹。共用网络可提高名额；误判可逐条释放，操作保留审计。</p></section><div class="table-scroll"><table><thead><tr><th>领取用户 / 时间</th><th>公网 IP / 网段</th><th>设备与网卡指纹</th><th>试用限制</th></tr></thead><tbody>${claims.map((c) => `<tr><td>${esc(data.users.find((u) => u.id === c.user_id)?.username || c.user_id)}<small>${esc(stamp(c.created))}</small></td><td><code>${esc(c.ip)}</code></td><td><small>设备 ${esc(c.device_id.slice(0, 16))}…</small>${JSON.parse(c.mac_hashes).map((m) => `<small>MAC ${esc(m.slice(0, 16))}…</small>`).join("")}</td><td>${c.released ? "已释放（保留记录）" : button("释放领取限制", "secondary", `data-release-claim="${esc(c.id)}"`)}</td></tr>`).join("") || '<tr><td colspan="4">尚无新版客户端试用领取记录。</td></tr>'}</tbody></table></div>`;
  }
  if (page === "操作记录")
    content = `<div class="table-scroll"><table><thead><tr><th>时间</th><th>操作人</th><th>操作 / 软件</th><th>原因与变更</th></tr></thead><tbody>${
      data.logs
        .map((l) => {
          const b = l.before ? JSON.parse(l.before) : null,
            a = l.after ? JSON.parse(l.after) : null;
          return `<tr><td>${esc(stamp(l.time))}</td><td>${esc(l.actor)}</td><td>${esc({ "trial-expiry": "调整试用期限", "grant-permanent": "开通永久授权", suspend: "停用授权", restore: "恢复授权", "abuse-policy": "调整IP名额", "trial-release": "释放领取限制" }[l.action] || l.action)}<small>${esc(l.app_id)} · ${esc(data.users.find((u) => u.id === a?.user_id)?.username || "")}</small></td><td>${esc(l.reason)}${b && a && "expires" in a ? `<small>${esc(stamp(b.expires))} → ${esc(stamp(a.expires))}</small>` : ""}</td></tr>`;
        })
        .join("") || '<tr><td colspan="4">暂无操作记录</td></tr>'
    }</tbody></table></div>`;
  if (page === "账户设置")
    content = `<section class="settings"><h2>修改管理员账号与密码</h2><p class="muted">保存后全部旧会话失效，需使用新凭据重新登录。</p><form id="account">${field("username", "管理员用户名", session.user.username, "text", 'required pattern="[A-Za-z0-9_]{3,24}"')}${field("current_password", "当前密码", "", "password", 'required autocomplete="current-password"')}${field("new_password", "新密码（至少10位）", "", "password", 'required minlength="10" autocomplete="new-password"')}${field("confirm", "确认新密码", "", "password", 'required minlength="10" autocomplete="new-password"')}${button("保存并重新登录", "primary", 'type="submit"')}</form></section>`;
  root.innerHTML = shell(content);
  document.querySelectorAll("[data-page]").forEach(
    (b) =>
      (b.onclick = () => {
        page = b.dataset.page;
        render();
      }),
  );
  document.querySelector("#logout").onclick = async () => {
    try {
      await api("/auth/logout", {});
      session = null;
      renderLogin();
    } catch (e) {
      notice(e.message);
    }
  };
  document.querySelector("#app-select")?.addEventListener("change", (e) => {
    appId = e.target.value;
    selected = "";
    query = "";
    render();
  });
  document.querySelector("#search")?.addEventListener("change", (e) => {
    query = e.target.value;
    render();
  });
  document.querySelectorAll("[data-select]").forEach(
    (b) =>
      (b.onclick = () => {
        selected = b.dataset.select;
        render();
      }),
  );
  document
    .querySelector("#received")
    ?.addEventListener(
      "change",
      (e) => (document.querySelector("#grant").disabled = !e.target.checked),
    );
  document
    .querySelector("#adjust")
    ?.addEventListener("click", () => expiryDialog());
  document.querySelector("#grant")?.addEventListener("click", async () => {
    const reason = document.querySelector("#reason").value.trim();
    if (!reason) return notice("请填写收款备注");
    const l = data.licenses.find((l) => l.id === selected);
    if (!confirm("确认已核实收款，并为该用户开通此软件永久权限？")) return;
    try {
      await change(l, "grant-permanent", { reason, received: true });
    } catch (e) {
      notice(e.message);
    }
  });
  document
    .querySelector("#toggle-license")
    ?.addEventListener("click", async () => {
      const l = data.licenses.find((l) => l.id === selected);
      const reason = prompt("请输入" + (l.active ? "停用" : "恢复") + "原因");
      if (!reason?.trim()) return;
      try {
        await change(l, l.active ? "suspend" : "restore", { reason });
      } catch (e) {
        notice(e.message);
      }
    });
  document
    .querySelector("#add-app")
    ?.addEventListener("click", () => productDialog());
  document
    .querySelectorAll("[data-edit-app]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          productDialog(data.apps.find((a) => a.id === b.dataset.editApp))),
    );
  document.querySelector("#account")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.currentTarget));
    if (v.confirm !== v.new_password) return notice("两次新密码输入不一致");
    delete v.confirm;
    try {
      await api("/admin/account", v, "PATCH");
      session = null;
      renderLogin();
      notice("凭据已修改，请重新登录");
    } catch (e) {
      notice(e.message);
    }
  });
  document.querySelector("#abuse-policy")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = Number(new FormData(e.currentTarget).get("max_ip_trials"));
    try {
      await api(`/admin/abuse-policy/${appId}`, {max_ip_trials: value}, "PUT");
      await load(); notice("防滥用设置已保存");
    } catch (err) { notice(err.message); }
  });
  document.querySelectorAll("[data-release-claim]").forEach((b) => b.onclick = () => {
    dialog("释放领取限制", `<p>释放此记录占用的 IP、设备及网卡试用名额，允许再次申请。已有授权和作品不受影响。</p>${field("reason", "放行原因", "", "text", 'required minlength="3" maxlength="200"')}`, async (v) => {
      await api(`/admin/trial-claims/${b.dataset.releaseClaim}/release`, v);
      await load(); notice("领取限制已释放，操作已记录");
    });
  });
}
async function change(l, action, values) {
  await api(`/admin/entitlements/${l.id}/${action}`, {
    ...values,
    revision: l.revision,
    request_id: crypto.randomUUID(),
  });
  await load();
  notice("授权已更新，客户端联网刷新后生效");
}
function dialog(title, html, onSubmit) {
  const d = document.createElement("dialog");
  d.innerHTML = `<div class="dialog-heading"><h2>${esc(title)}</h2>${button("关闭", "text", 'type="button" data-close')}</div><form>${html}<p role="alert" class="error"></p><div class="dialog-actions">${button("取消", "secondary", 'type="button" data-close')}${button("保存", "primary", 'type="submit"')}</div></form>`;
  document.body.append(d);
  d.querySelectorAll("[data-close]").forEach(
    (b) => (b.onclick = () => d.close()),
  );
  d.onclose = () => d.remove();
  d.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const submit =
      e.submitter || e.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await onSubmit(Object.fromEntries(new FormData(e.currentTarget)));
      d.close();
    } catch (err) {
      d.querySelector(".error").textContent = err.message;
      submit.disabled = false;
    }
  };
  d.showModal();
  return d;
}
function expiryDialog() {
  const l = data.licenses.find((l) => l.id === selected);
  const d = dialog(
    "调整试用期限",
    `<p class="muted">可延长、缩短、立即结束，也可为过期用户恢复试用。所有时间均为北京时间。</p><div class="shortcuts">${button("延长7天", "secondary", 'type="button" data-days="7"')}${button("延长30天", "secondary", 'type="button" data-days="30"')}${button("立即结束", "secondary", 'type="button" data-days="0"')}</div><p>原到期时间：${esc(stamp(l.expires))}</p>${field("expiry", "新的到期时间", dateInput(l.expires), "datetime-local", "required")}${field("reason", "调整原因", "", "text", 'required maxlength="200"')}`,
    async (v) => {
      await change(l, "trial-expiry", {
        expires_at: v.expiry + ":00+08:00",
        reason: v.reason,
      });
    },
  );
  d.querySelectorAll("[data-days]").forEach(
    (b) =>
      (b.onclick = () =>
        (d.querySelector('[name="expiry"]').value = dateInput(
          Number(b.dataset.days) === 0
            ? data.server_time
            : Math.max(data.server_time, l.expires) +
                Number(b.dataset.days) * 86400,
        ))),
  );
}
function productDialog(a) {
  dialog(
    a ? "软件设置" : "添加软件",
    `${field("id", "软件标识", a?.id || "", "text", `required pattern="[a-z][a-z0-9-]{2,39}" ${a ? "readonly" : ""}`)}${field("name", "软件名称", a?.name || "", "text", 'required maxlength="50"')}${field("device_limit", "设备上限", a?.device_limit || 2, "number", 'required min="1" max="10"')}${field("contact", "作者联系方式", a?.contact || "", "text", 'maxlength="200"')}${field("purchase_note", "购买说明", a?.purchase_note || "联系作者核实付款后开通永久权限。", "text", 'maxlength="500"')}`,
    async (v) => {
      v.device_limit = Number(v.device_limit);
      await api(
        a ? "/admin/apps/" + a.id : "/admin/apps",
        v,
        a ? "PUT" : "POST",
      );
      await load();
    },
  );
}
try {
  session = await api("/me");
  if (session.user.role !== "admin") {
    session = null;
    renderLogin();
  } else await load();
} catch {
  session = null;
  renderLogin();
}
