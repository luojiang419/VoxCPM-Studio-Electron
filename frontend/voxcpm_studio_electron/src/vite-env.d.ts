/// <reference types="vite/client" />

declare global {
  interface Window {
    voxcpmDesktop: {
      getWindowBehavior: () => Promise<import("./window-behavior-types").WindowBehaviorState>;
      setWindowBehavior: (behavior: import("./window-behavior-types").CloseBehavior) => Promise<import("./window-behavior-types").WindowBehaviorState>;
      requestWindowClose: () => Promise<boolean>;
      resolveWindowClose: (options: { behavior: import("./window-behavior-types").CloseBehavior; action: import("./window-behavior-types").CloseAction }) => Promise<import("./window-behavior-types").WindowBehaviorState>;
      cancelWindowClose: () => Promise<import("./window-behavior-types").WindowBehaviorState>;
      rendererReady: () => Promise<boolean>;
      getUpdateState: () => Promise<any>;
      checkUpdate: () => Promise<any>;
      downloadUpdate: () => Promise<any>;
      installUpdate: () => Promise<boolean>;
      setAutoCheckUpdate: (enabled: boolean) => Promise<any>;
      getBootstrapState: () => Promise<any>;
      startBackend: (options?: { prepare?: boolean }) => Promise<any>;
      getPreparationState: () => Promise<any>;
      cancelPreparation: () => Promise<boolean>;
      getComponents: () => Promise<any>;
      selectComponents: (value: any) => Promise<any>;
      removeComponent: (id: string) => Promise<any>;
      stopBackend: () => Promise<any>;
      getResourceStats: () => Promise<any>;
      setThemeSource: (themeSource: string) => Promise<any>;
      openDialog: (options: any) => Promise<any>;
      saveDialog: (options: any) => Promise<any>;
      openExternal: (targetUrl: string) => Promise<boolean>;
      openPath: (targetPath: string) => Promise<boolean>;
      showItemInFolder: (targetPath: string) => Promise<boolean>;
      onRuntimeEvent: (handler: (payload: any) => void) => () => void;
    };
  }
}

export {};
