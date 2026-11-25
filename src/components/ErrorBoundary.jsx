import React from "react";
import { Button } from "@heroui/react";
export class ErrorBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    // A failed development render has no App listener to checkpoint. Preserve
    // the last valid saved project and let the normal code-restart path recover.
    if (window.fox24?.autoRestoreRecovery)
      this.stopRestartListener = window.fox24.onBeforeDevRestart?.(async () => {
        if (!await window.fox24.readRecovery()) throw new Error("没有可恢复的工程，已保留当前窗口。");
      });
  }
  componentWillUnmount() {
    this.stopRestartListener?.();
  }
  render() {
    return this.state.failed ? (
      <main className="fatal-error" role="alert">
        <h1>界面暂时无法显示</h1>
        <p>重新载入后可恢复最近保存的工程。</p>
        <Button onPress={() => location.reload()}>重新载入</Button>
      </main>
    ) : (
      this.props.children
    );
  }
}
