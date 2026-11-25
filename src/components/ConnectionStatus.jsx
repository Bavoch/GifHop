import React, { useEffect, useRef, useState } from "react";
import { Plug } from "lucide-react";
import { desktop } from "../desktop-client";

export function ConnectionStatus({ status, onStatus, busy }) {
  const [checking, setChecking] = useState(true);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    let alive = true;
    let pending = false;
    const refresh = async () => {
      if (!alive || pending || busyRef.current || document.visibilityState === "hidden") return;
      pending = true;
      setChecking(true);
      try {
        const value = await desktop.status();
        if (alive) onStatus(value);
      } catch (error) {
        if (alive) onStatus({ ready: false, message: error.message || "Codex 检测失败，请检查本机安装和登录。" });
      } finally {
        pending = false;
        if (alive) setChecking(false);
      }
    };
    // Recheck after external installation/login without polling or duplicate requests.
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    refresh();
    return () => {
      alive = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [onStatus]);
  if (!status || status.ready || status.mode === "browser-preview") return null;
  const label = status.installed === false ? "未找到 Codex" : status.compatible === false ? "Codex 需升级" : status.loggedIn === false ? "Codex 未登录" : "Codex 未连接";
  const detail = status.message && status.message !== label ? status.message : "请检查 Codex 安装和登录后返回应用。";
  return (
    <div className="connection-banner" role="alert" aria-label={label} aria-busy={checking}>
      <Plug size={16} aria-hidden="true" />
      <p><strong>{label}</strong>。{detail}</p>
    </div>
  );
}
