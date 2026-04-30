/// <reference types="vite/client" />

declare global {
  interface Window {
    voxcpmDesktop: {
      getBootstrapState: () => Promise<any>;
      startBackend: () => Promise<any>;
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
