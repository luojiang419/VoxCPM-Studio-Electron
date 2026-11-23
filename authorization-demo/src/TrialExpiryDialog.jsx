import React, { useState } from "react";
import { ArrowRight, Check } from "@phosphor-icons/react";
import { Modal } from "./App.jsx";
import {
  DEMO_NOW,
  DAY,
  addCalendarMonth,
  adjustTrialExpiry,
  getLicense,
  parseShanghaiDateTime,
  shanghaiDateTimeInput,
} from "./model.mjs";

export function TrialExpiryDialog({
  state,
  setState,
  userId,
  appId,
  onClose,
  notify,
}) {
  const user = state.users.find((u) => u.id === userId);
  const product = state.products.find((p) => p.id === appId);
  const license = getLicense(state, userId, appId);
  const [value, setValue] = useState(shanghaiDateTimeInput(license.expiresAt));
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const oldValue = shanghaiDateTimeInput(license.expiresAt);
  const base = new Date(
    Math.max(
      new Date(license.expiresAt).getTime(),
      new Date(DEMO_NOW).getTime(),
    ),
  ).toISOString();
  function submit(e) {
    e.preventDefault();
    try {
      const next = adjustTrialExpiry(
        state,
        userId,
        appId,
        parseShanghaiDateTime(
          String(new FormData(e.currentTarget).get("expiresAt")),
        ),
        reason,
      );
      setState(next);
      onClose();
      notify(
        next === state ? "到期时间未变化" : "试用期限已调整，客户端演示已同步",
      );
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <Modal title="调整试用期限" onClose={onClose}>
      <p className="modal-copy">
        为 <strong>{user.name}</strong> 调整 <strong>{product.name}</strong>{" "}
        的试用期限。可延长、缩短，也可为已到期用户恢复试用。
      </p>
      <form className="expiry-form" onSubmit={submit}>
        <div className="expiry-shortcuts" aria-label="快捷调整">
          <button
            type="button"
            className="secondary"
            onClick={() =>
              setValue(
                shanghaiDateTimeInput(
                  new Date(new Date(base).getTime() + 7 * DAY),
                ),
              )
            }
          >
            延长7天
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              setValue(shanghaiDateTimeInput(addCalendarMonth(base)))
            }
          >
            延长一个月
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => setValue(shanghaiDateTimeInput(DEMO_NOW))}
          >
            立即结束试用
          </button>
        </div>
        <label className="field">
          <span>
            新的到期时间 <small>北京时间 UTC+8</small>
          </span>
          <input
            type="datetime-local"
            name="expiresAt"
            required
            step="60"
            min={shanghaiDateTimeInput(license.startsAt)}
            value={value}
            onInput={(e) => {
              setValue(e.currentTarget.value);
              setError("");
            }}
            onChange={(e) => {
              setValue(e.target.value);
              setError("");
            }}
          />
        </label>
        <div className="expiry-change">
          <span>原到期时间</span>
          <strong>{oldValue.replace("T", " ")}</strong>
          <ArrowRight size={16} />
          <span>新到期时间</span>
          <strong>{value.replace("T", " ") || "请选择"}</strong>
        </div>
        <label className="field">
          <span>调整原因</span>
          <textarea
            required
            maxLength={200}
            rows={2}
            placeholder="例如：补偿试用、延长体验、结束试用"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <p className="muted expiry-hint">
          保存后更新该软件的倒计时和到期状态，并记录调整前后时间。其他软件的授权不受影响。
        </p>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary">
            保存试用期限
            <Check size={18} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
