/// <reference types="vite/client" />

declare global {
  interface Window {
    voxcpmDesktop: {
      rendererReady: () => Promise<boolean>;
      getUpdateState: () => Promise<any>;
      checkUpdate: () => Promise<any>;
      downloadUpdate: () => Promise<any>;
      installUpdate: () => Promise<boolean>;
      setAutoCheckUpdate: (enabled: boolean) => Promise<any>;
      getBootstrapState: () => Promise<any>;
      startBackend: () => Promise<any>;
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
