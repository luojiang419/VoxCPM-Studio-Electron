import React, { useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle,
  Clock,
  Copy,
  GearSix,
  ShieldCheck,
  SignOut,
  User,
  X,
} from "@phosphor-icons/react";
import {
  DEMO_NOW,
  STORAGE_KEY,
  daysLeft,
  getLicense,
  grantPermanent,
  initialState,
  licenseStatus,
  shouldRemind,
  reminderKey,
} from "./model.mjs";
import { Client } from "./Client.jsx";
import { Admin } from "./Admin.jsx";
import { TrialExpiryDialog } from "./TrialExpiryDialog.jsx";

export function Status({ license, now = DEMO_NOW }) {
  const status = licenseStatus(license, now);
  return (
    <span className={"status " + status}>
      <span className="status-dot" />
      {
        {
          trial: "试用中",
          permanent: "永久授权",
          expired: "已过期",
          none: "未领取",
        }[status]
      }
    </span>
  );
}
export function Avatar({ user, large = false }) {
  return (
    <span className={"avatar " + (large ? "large" : "")}>
      {user.avatar ? (
        <img src="/assets/lin-avatar.webp" alt="" />
      ) : (
        user.initial
      )}
    </span>
  );
}
export function Modal({ title, children, onClose }) {
  const ref = React.useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    const dialog = ref.current;
    dialog.showModal();
    return () => {
      dialog.close();
      prev?.focus?.();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby="modal-title"
    >
      <div className="modal-heading">
        <h2 id="modal-title">{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="关闭对话框"
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (
      saved?.version === 1 &&
      ["users", "licenses", "products", "logs"].every((key) =>
        Array.isArray(saved[key]),
      ) &&
      saved.settings &&
      saved.reminders
    )
      return saved;
  } catch {
    /* 禁用存储时仍可演示。 */
  }
  return initialState();
}
export function App() {
  const [state, setState] = useState(load);
  const [view, setView] = useState("用户授权");
  const [appId, setAppId] = useState("jvox-studio");
  const [selected, setSelected] = useState("U-1048");
  const [received, setReceived] = useState(false);
  const [note, setNote] = useState("");
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState("");
  const [storageProblem, setStorageProblem] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [clientUser, setClientUser] = useState("U-1048");
  const [scenario, setScenario] = useState("actual");
  const product =
    state.products.find((p) => p.id === appId) || state.products[0];
  const user = state.users.find((u) => u.id === selected);
  const isClient = ["客户端演示", "注册", "登录", "管理员登录"].includes(view);
  const notify = (message) => setToast(message);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      setStorageProblem(false);
    } catch {
      setStorageProblem(true);
    }
  }, [state]);
  useEffect(() => {
    if (toast) {
      const id = setTimeout(() => setToast(""), 4200);
      return () => clearTimeout(id);
    }
  }, [toast]);
  useEffect(() => {
    setReceived(false);
    setNote("");
  }, [selected, appId]);
  useEffect(() => {
    if (
      view === "客户端演示" &&
      scenario === "actual" &&
      shouldRemind(state, clientUser, appId)
    ) {
      setState((s) => ({
        ...s,
        reminders: { ...s.reminders, [reminderKey(clientUser, appId)]: true },
      }));
      setModal("reminder");
    }
  }, [view, clientUser, appId, scenario, state]);
  function go(next) {
    setProfileOpen(false);
    setView(next);
  }
  function changeProduct(id) {
    setAppId(id);
    setScenario("actual");
  }
  return (
    <div className="ee-app">
      <header className="topbar">
        <button
          className="brand"
          onClick={() => go("用户授权")}
          aria-label="EE2X 授权中心首页"
        >
          <strong>EE2X</strong>
          <span>/</span>
          <small>AUTH CENTER</small>
        </button>
        <nav className="global-nav" aria-label="主导航">
          {["用户授权", "软件接入", "操作记录", "设置"].map((n) => (
            <button
              className={view === n ? "active" : ""}
              key={n}
              onClick={() => go(n)}
            >
              {n}
            </button>
          ))}
        </nav>
        <div className="top-actions">
          <button
            className={"client-switch " + (isClient ? "selected" : "")}
            onClick={() => go(isClient ? "用户授权" : "客户端演示")}
          >
            {isClient ? "管理后台" : "客户端演示"}
            <ArrowUpRight size={14} />
          </button>
          <div className="profile">
            <button
              className="profile-button"
              onClick={() => setProfileOpen(!profileOpen)}
              aria-expanded={profileOpen}
            >
              <User size={20} />
              <span>{state.settings.adminName}</span>
            </button>
            {profileOpen && (
              <div className="profile-menu">
                <button onClick={() => go("设置")}>
                  <GearSix size={16} />
                  账号设置
                </button>
                <button onClick={() => go("管理员登录")}>
                  <SignOut size={16} />
                  查看登录页
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      {storageProblem && (
        <div className="storage-warning" role="alert">
          浏览器存储不可用，刷新后演示改动不会保留。
        </div>
      )}
      {isClient ? (
        <Client
          {...{
            state,
            setState,
            view,
            go,
            appId,
            product,
            changeProduct,
            clientUser,
            setClientUser,
            scenario,
            setScenario,
            notify,
            setModal,
            setSelected,
          }}
        />
      ) : (
        <Admin
          {...{
            state,
            setState,
            view,
            go,
            appId,
            product,
            changeProduct,
            selected,
            setSelected,
            received,
            setReceived,
            note,
            setNote,
            notify,
            setModal,
            setClientUser,
            setScenario,
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCircle size={20} />
          {toast}
        </div>
      )}
      {modal === "adjust-trial" && (
        <TrialExpiryDialog
          state={state}
          setState={setState}
          userId={selected}
          appId={appId}
          onClose={() => setModal(null)}
          notify={notify}
        />
      )}
      {modal === "activate" && (
        <Modal title="开通永久使用权限" onClose={() => setModal(null)}>
          <p className="modal-copy">
            为 <strong>{user.name}</strong> 开通 <strong>{product.name}</strong>{" "}
            的永久使用权限。其他软件的授权不受影响。
          </p>
          <div className="confirmation-detail">
            <span>收款确认</span>
            <strong>已核实</strong>
            <span>备注</span>
            <strong>{note || "已核实收款"}</strong>
          </div>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setModal(null)}>
              返回检查
            </button>
            <button
              className="primary"
              onClick={() => {
                setState((s) =>
                  grantPermanent(s, selected, appId, received, note),
                );
                setModal(null);
                notify("已为 " + user.name + " 开通永久权限");
              }}
            >
              确认开通
              <ArrowRight size={18} />
            </button>
          </div>
        </Modal>
      )}
      {modal === "reset" && (
        <Modal title="重置演示数据" onClose={() => setModal(null)}>
          <p className="modal-copy">
            恢复最初的五个示例账户，清除本演示中的注册、授权与配置记录。不会影响正式软件。
          </p>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setModal(null)}>
              保留当前演示
            </button>
            <button
              className="primary"
              onClick={() => {
                setState(initialState());
                setAppId("jvox-studio");
                setSelected("U-1048");
                setClientUser("U-1048");
                setReceived(false);
                setModal(null);
                setScenario("actual");
                go("用户授权");
                notify("演示数据已恢复");
              }}
            >
              恢复示例数据
            </button>
          </div>
        </Modal>
      )}
      {(modal === "reminder" || modal === "contact") && (
        <Modal
          title={
            modal === "reminder" ? "让创作，继续发生。" : "联系作者开通永久权限"
          }
          onClose={() => setModal(null)}
        >
          <div className="contact-copy">
            <span className="section-label">{product.name}</span>
            <h3>
              {modal === "reminder"
                ? "你的试用将在 " +
                  (scenario === "week"
                    ? 7
                    : daysLeft(getLicense(state, clientUser, appId))) +
                  " 天后结束"
                : "一次开通，长期创作。"}
            </h3>
            <p>{state.settings.purchaseNote}</p>
            <div className="contact-block">
              <small>作者联系方式</small>
              <strong>
                {state.settings.contact || "作者尚未配置联系方式"}
              </strong>
              {state.settings.contact && (
                <button
                  className="icon-button"
                  aria-label="复制作者联系方式"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        state.settings.contact,
                      );
                      notify("联系方式已复制");
                    } catch {
                      notify("请选中联系方式后手动复制");
                    }
                  }}
                >
                  <Copy size={18} />
                </button>
              )}
            </div>
            <small>联系作者时请提供用户编号 {clientUser} 和软件名称。</small>
          </div>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setModal(null)}>
              稍后再说
            </button>
            <button
              className="primary"
              onClick={() => {
                setModal(null);
                go("设置");
              }}
            >
              查看联系配置
              <ArrowRight size={18} />
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
