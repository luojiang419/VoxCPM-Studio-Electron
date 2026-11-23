// 演示领域模型：只保存虚构账户和授权状态，不保存、校验或签发真实凭据。
export const DEMO_NOW = "2026-10-25T00:00:00.000Z";
export const DAY = 86_400_000;
export const STORAGE_KEY = "ee2x-license-design-v1";

export function addCalendarMonth(iso) {
  const local = new Date(new Date(iso).getTime() + 8 * 3600000);
  const day = local.getUTCDate();
  local.setUTCDate(1);
  local.setUTCMonth(local.getUTCMonth() + 1);
  const last = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0),
  ).getUTCDate();
  local.setUTCDate(Math.min(day, last));
  return new Date(local.getTime() - 8 * 3600000).toISOString();
}

export function dateLabel(iso, separator = "-") {
  return iso
    ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" })
        .format(new Date(iso))
        .replaceAll("-", separator)
    : "—";
}

export function licenseStatus(license, now = DEMO_NOW) {
  if (!license) return "none";
  if (license.kind === "permanent") return "permanent";
  return new Date(license.expiresAt) > new Date(now) ? "trial" : "expired";
}

export function daysLeft(license, now = DEMO_NOW) {
  return license?.expiresAt
    ? Math.max(
        0,
        Math.ceil((new Date(license.expiresAt) - new Date(now)) / DAY),
      )
    : 0;
}

export function initialState() {
  const users = [
    {
      id: "U-1048",
      name: "林间声场",
      username: "lin",
      email: "lin@example.com",
      initial: "L",
      avatar: true,
    },
    {
      id: "U-1023",
      name: "赵北辰",
      username: "zhao",
      email: "zhao@example.com",
      initial: "Z",
    },
    {
      id: "U-0976",
      name: "王若溪",
      username: "wang",
      email: "wrx@example.com",
      initial: "W",
    },
    {
      id: "U-0831",
      name: "陈墨言",
      username: "chen",
      email: "chen@example.com",
      initial: "C",
    },
    {
      id: "U-1089",
      name: "李思远",
      username: "li",
      email: "siyuan@example.com",
      initial: "L",
    },
  ];
  const expiries = [
    "2026-11-01",
    "2026-10-28",
    "2026-10-20",
    null,
    "2026-11-03",
  ];
  const starts = [
    "2026-10-01",
    "2026-09-28",
    "2026-09-20",
    "2026-09-06",
    "2026-10-03",
  ];
  return {
    version: 1,
    products: [
      {
        id: "jvox-studio",
        name: "JVOX Studio",
        subtitle: "配音系统",
        deviceLimit: 2,
        offlineHours: 72,
        enabled: true,
      },
    ],
    users,
    licenses: users.map((u, index) => ({
      userId: u.id,
      appId: "jvox-studio",
      kind: expiries[index] ? "trial" : "permanent",
      startsAt: starts[index] + "T00:00:00+08:00",
      expiresAt: expiries[index] ? expiries[index] + "T00:00:00+08:00" : null,
      number: "JVOX-••••-8F" + (index === 0 ? "2A" : index + "B"),
      devices: 1,
    })),
    logs: [
      {
        id: "seed",
        time: "2026-10-24T02:15:00+08:00",
        actor: "luo",
        action: "开通永久授权",
        user: "陈墨言",
        appId: "jvox-studio",
        note: "演示收款记录",
      },
    ],
    reminders: {},
    settings: {
      adminName: "luo",
      contact: "",
      purchaseNote: "联系作者并完成付款后，由作者为你开通永久使用权限。",
    },
  };
}

export function getLicense(state, userId, appId) {
  return state.licenses.find((l) => l.userId === userId && l.appId === appId);
}

export function claimTrial(state, userId, appId, now = DEMO_NOW) {
  if (
    !state.users.some((u) => u.id === userId) ||
    !state.products.some((p) => p.id === appId && p.enabled)
  )
    throw new Error("用户或软件不存在");
  if (getLicense(state, userId, appId)) return state;
  return {
    ...state,
    licenses: [
      ...state.licenses,
      {
        userId,
        appId,
        kind: "trial",
        startsAt: now,
        expiresAt: addCalendarMonth(now),
        number: "DEMO-••••-" + userId.slice(-4),
        devices: 1,
      },
    ],
  };
}

export function registerUser(
  state,
  { username, name, email },
  appId,
  now = DEMO_NOW,
) {
  username = username.trim();
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username))
    throw new Error("用户名须为3–24位字母、数字或下划线");
  if (
    state.users.some((u) => u.username.toLowerCase() === username.toLowerCase())
  )
    throw new Error("这个用户名已存在，请直接登录");
  if (
    email &&
    state.users.some(
      (u) => u.email?.toLowerCase() === email.trim().toLowerCase(),
    )
  )
    throw new Error("这个邮箱已注册，请直接登录");
  const id =
    "U-" +
    (Math.max(1099, ...state.users.map((u) => Number(u.id.slice(2)))) + 1);
  const user = {
    id,
    username,
    name: name.trim() || username,
    email: email.trim(),
    initial: username[0].toUpperCase(),
  };
  const registered = claimTrial(
    { ...state, users: [...state.users, user] },
    id,
    appId,
    now,
  );
  return {
    ...registered,
    logs: [
      {
        id: crypto.randomUUID(),
        time: now,
        actor: username,
        action: "注册并领取试用",
        user: user.name,
        appId,
        note: "自动创建一个自然月试用",
      },
      ...registered.logs,
    ],
  };
}

export function grantPermanent(
  state,
  userId,
  appId,
  received,
  note,
  now = DEMO_NOW,
) {
  if (!received) throw new Error("请先确认已核实用户付款");
  const current = getLicense(state, userId, appId);
  if (!current) throw new Error("请先选择已有授权的用户");
  if (current.kind === "permanent") return state;
  const user = state.users.find((u) => u.id === userId);
  return {
    ...state,
    licenses: state.licenses.map((l) =>
      l === current
        ? { ...l, kind: "permanent", expiresAt: null, grantedAt: now }
        : l,
    ),
    logs: [
      {
        id: crypto.randomUUID(),
        time: now,
        actor: state.settings.adminName,
        action: "开通永久授权",
        user: user.name,
        appId,
        note: note.trim() || "已核实收款",
      },
      ...state.logs,
    ],
  };
}

export function shanghaiDateTimeInput(iso) {
  return new Date(new Date(iso).getTime() + 8 * 3600000)
    .toISOString()
    .slice(0, 16);
}

export function parseShanghaiDateTime(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new Error("请选择有效的北京时间");
  const date = new Date(value + ":00+08:00");
  if (!Number.isFinite(date.getTime()) || shanghaiDateTimeInput(date) !== value)
    throw new Error("请选择有效的北京时间");
  return date.toISOString();
}

export function adjustTrialExpiry(
  state,
  userId,
  appId,
  expiresAt,
  reason,
  now = DEMO_NOW,
) {
  const current = getLicense(state, userId, appId);
  if (!current) throw new Error("用户尚未领取该软件试用");
  if (current.kind === "permanent") throw new Error("永久授权无需调整试用期限");
  const time =
    typeof expiresAt === "string" ? new Date(expiresAt).getTime() : NaN;
  if (!Number.isFinite(time)) throw new Error("请选择有效的到期时间");
  if (time < new Date(current.startsAt).getTime())
    throw new Error("到期时间不能早于试用开始时间");
  if (!reason?.trim() || reason.trim().length > 200)
    throw new Error("请填写200字以内的调整原因");
  const normalized = new Date(time).toISOString();
  if (normalized === new Date(current.expiresAt).toISOString()) return state;
  const user = state.users.find((u) => u.id === userId);
  return {
    ...state,
    licenses: state.licenses.map((l) =>
      l === current
        ? {
            ...l,
            expiresAt: normalized,
            revision: (l.revision || 0) + 1,
          }
        : l,
    ),
    logs: [
      {
        id: crypto.randomUUID(),
        time: now,
        actor: state.settings.adminName,
        action: "调整试用期限",
        user: user.name,
        appId,
        before: current.expiresAt,
        after: normalized,
        note: reason.trim(),
      },
      ...state.logs,
    ],
  };
}

export function reminderKey(userId, appId, now = DEMO_NOW) {
  return userId + ":" + appId + ":" + dateLabel(now);
}

export function shouldRemind(state, userId, appId, now = DEMO_NOW) {
  const license = getLicense(state, userId, appId);
  return (
    licenseStatus(license, now) === "trial" &&
    daysLeft(license, now) <= 7 &&
    !state.reminders[reminderKey(userId, appId, now)]
  );
}
