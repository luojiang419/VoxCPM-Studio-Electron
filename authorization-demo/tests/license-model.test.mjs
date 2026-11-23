import test from "node:test";
import assert from "node:assert/strict";
import {
  DEMO_NOW,
  DAY,
  addCalendarMonth,
  claimTrial,
  dateLabel,
  getLicense,
  grantPermanent,
  initialState,
  licenseStatus,
  registerUser,
  reminderKey,
  shouldRemind,
  adjustTrialExpiry,
  parseShanghaiDateTime,
  shanghaiDateTimeInput,
} from "../src/model.mjs";

test("管理员可延长、缩短试用和恢复已过期账户", () => {
  const s = initialState();
  const extended = adjustTrialExpiry(
    s,
    "U-1048",
    "jvox-studio",
    "2026-12-31T00:00:00+08:00",
    "延长体验",
  );
  assert.equal(
    dateLabel(getLicense(extended, "U-1048", "jvox-studio").expiresAt),
    "2026-12-31",
  );
  const ended = adjustTrialExpiry(
    extended,
    "U-1048",
    "jvox-studio",
    DEMO_NOW,
    "立即结束",
  );
  assert.equal(
    licenseStatus(getLicense(ended, "U-1048", "jvox-studio")),
    "expired",
  );
  const restored = adjustTrialExpiry(
    ended,
    "U-1048",
    "jvox-studio",
    "2026-11-15T18:30:00+08:00",
    "恢复试用",
  );
  assert.equal(
    licenseStatus(getLicense(restored, "U-1048", "jvox-studio")),
    "trial",
  );
  assert.equal(
    getLicense(restored, "U-1048", "jvox-studio").startsAt,
    getLicense(s, "U-1048", "jvox-studio").startsAt,
  );
  assert.equal(getLicense(restored, "U-1048", "jvox-studio").revision, 3);
});

test("期限变更按软件隔离、记录前后时间和原因，重复保存不重复记录", () => {
  let s = initialState();
  s.products.push({ id: "other-app", name: "第二款软件", enabled: true });
  s = claimTrial(s, "U-1048", "other-app");
  const target = "2026-11-25T12:34:00+08:00";
  const next = adjustTrialExpiry(
    s,
    "U-1048",
    "jvox-studio",
    target,
    "补偿用户",
  );
  assert.equal(
    getLicense(next, "U-1048", "other-app"),
    getLicense(s, "U-1048", "other-app"),
  );
  assert.equal(
    next.logs[0].before,
    getLicense(s, "U-1048", "jvox-studio").expiresAt,
  );
  assert.equal(next.logs[0].after, new Date(target).toISOString());
  assert.equal(next.logs[0].note, "补偿用户");
  assert.equal(next.logs[0].actor, "luo");
  assert.equal(
    adjustTrialExpiry(next, "U-1048", "jvox-studio", target, "重复保存"),
    next,
  );
});

test("期限调整拒绝永久授权、无效时间、早于试用开始和缺少原因", () => {
  const s = initialState();
  assert.throws(
    () => adjustTrialExpiry(s, "U-0831", "jvox-studio", DEMO_NOW, "修改"),
    /永久授权/,
  );
  assert.throws(
    () => adjustTrialExpiry(s, "U-1048", "jvox-studio", "invalid", "修改"),
    /有效/,
  );
  assert.throws(
    () =>
      adjustTrialExpiry(
        s,
        "U-1048",
        "jvox-studio",
        "2026-09-01T00:00:00Z",
        "修改",
      ),
    /不能早于/,
  );
  assert.throws(
    () => adjustTrialExpiry(s, "U-1048", "jvox-studio", DEMO_NOW, " "),
    /调整原因/,
  );
  assert.throws(
    () => adjustTrialExpiry(s, "missing", "jvox-studio", DEMO_NOW, "修改"),
    /尚未领取/,
  );
});

test("日期输入固定北京时间并拒绝不存在的日期", () => {
  assert.equal(
    parseShanghaiDateTime("2026-11-01T18:30"),
    "2026-11-01T10:30:00.000Z",
  );
  assert.equal(
    shanghaiDateTimeInput("2026-11-01T10:30:00Z"),
    "2026-11-01T18:30",
  );
  assert.throws(() => parseShanghaiDateTime("2026-02-30T18:30"), /有效/);
  assert.throws(() => parseShanghaiDateTime("2026-11-01"), /有效/);
});

test("自然月在月末截断到下月最后一日，并保持北京时间时分秒", () => {
  assert.equal(
    addCalendarMonth("2026-01-31T10:34:56+08:00"),
    "2026-02-28T02:34:56.000Z",
  );
  assert.equal(
    addCalendarMonth("2028-01-31T10:34:56+08:00"),
    "2028-02-29T02:34:56.000Z",
  );
  assert.equal(
    addCalendarMonth("2026-12-31T23:59:59+08:00"),
    "2027-01-31T15:59:59.000Z",
  );
  assert.equal(dateLabel(addCalendarMonth(DEMO_NOW)), "2026-11-25");
});
test("注册只为指定软件创建试用，重复用户名大小写均被拒绝", () => {
  const s = registerUser(
    initialState(),
    { username: "newuser", name: "演示账户", email: "new@example.com" },
    "jvox-studio",
  );
  const user = s.users.at(-1);
  const license = getLicense(s, user.id, "jvox-studio");
  assert.equal(licenseStatus(license), "trial");
  assert.equal(dateLabel(license.expiresAt), "2026-11-25");
  assert.throws(
    () =>
      registerUser(
        s,
        { username: "NEWUSER", name: "", email: "" },
        "jvox-studio",
      ),
    /已存在/,
  );
  assert.throws(
    () =>
      registerUser(
        s,
        { username: "another", name: "", email: "NEW@example.com" },
        "jvox-studio",
      ),
    /已注册/,
  );
  assert.equal(s.licenses.filter((l) => l.userId === user.id).length, 1);
});
test("重复领取、到期后领取均不得重置试用", () => {
  const s = initialState();
  assert.equal(
    claimTrial(s, "U-1048", "jvox-studio", "2026-12-01T00:00:00Z"),
    s,
  );
  assert.equal(claimTrial(s, "U-0976", "jvox-studio"), s);
});
test("永久开通需要核实收款，按软件隔离且重复点击不重复记账", () => {
  let s = initialState();
  s.products.push({ id: "other-app", name: "第二款软件", enabled: true });
  s = claimTrial(s, "U-1048", "other-app");
  assert.throws(
    () => grantPermanent(s, "U-1048", "jvox-studio", false, ""),
    /确认/,
  );
  const granted = grantPermanent(
    s,
    "U-1048",
    "jvox-studio",
    true,
    "测试收款备注",
  );
  assert.equal(
    licenseStatus(getLicense(granted, "U-1048", "jvox-studio")),
    "permanent",
  );
  assert.equal(
    licenseStatus(getLicense(granted, "U-1048", "other-app")),
    "trial",
  );
  assert.equal(granted.logs.length, s.logs.length + 1);
  assert.equal(
    grantPermanent(granted, "U-1048", "jvox-studio", true, ""),
    granted,
  );
});
test("到期瞬间停止试用，永久授权没有到期边界", () => {
  const s = initialState();
  const l = getLicense(s, "U-1048", "jvox-studio");
  assert.equal(
    licenseStatus(
      l,
      new Date(new Date(l.expiresAt).getTime() - 1).toISOString(),
    ),
    "trial",
  );
  assert.equal(licenseStatus(l, l.expiresAt), "expired");
  assert.equal(
    licenseStatus(
      getLicense(s, "U-0831", "jvox-studio"),
      "2099-01-01T00:00:00Z",
    ),
    "permanent",
  );
});
test("提醒只在最后7天触发，每北京时间自然日一次", () => {
  const s = initialState();
  const l = getLicense(s, "U-1048", "jvox-studio");
  const cutoff = new Date(
    new Date(l.expiresAt).getTime() - 7 * DAY,
  ).toISOString();
  const before = new Date(new Date(cutoff).getTime() - 1).toISOString();
  assert.equal(shouldRemind(s, "U-1048", "jvox-studio", before), false);
  assert.equal(shouldRemind(s, "U-1048", "jvox-studio", cutoff), true);
  s.reminders[reminderKey("U-1048", "jvox-studio", cutoff)] = true;
  assert.equal(shouldRemind(s, "U-1048", "jvox-studio", cutoff), false);
  assert.equal(
    shouldRemind(
      s,
      "U-1048",
      "jvox-studio",
      new Date(new Date(cutoff).getTime() + DAY).toISOString(),
    ),
    true,
  );
  assert.equal(shouldRemind(s, "U-1048", "jvox-studio", l.expiresAt), false);
  assert.equal(shouldRemind(s, "U-0831", "jvox-studio"), false);
});
test("账户不存在或软件不存在时不生成孤立授权", () => {
  const s = initialState();
  assert.throws(() => claimTrial(s, "missing", "jvox-studio"), /不存在/);
  assert.throws(() => claimTrial(s, "U-1048", "missing"), /不存在/);
});
