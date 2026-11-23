export type CloseBehavior = "quit" | "background" | "ask";
export type CloseAction = Exclude<CloseBehavior, "ask">;
export type WindowBehaviorState = { behavior: CloseBehavior; promptOpen: boolean };

export const closeChoices: { value: CloseBehavior; title: string; description: string; badge: string }[] = [
  { value: "quit", title: "关闭软件", description: "退出应用并停止本地服务，释放占用的资源。", badge: "彻底退出" },
  { value: "background", title: "后台运行", description: "收起至系统托盘，正在进行的任务继续运行。", badge: "保持任务" },
  { value: "ask", title: "每次询问", description: "每次点击关闭时，再决定退出还是后台运行。", badge: "随时决定" },
];
