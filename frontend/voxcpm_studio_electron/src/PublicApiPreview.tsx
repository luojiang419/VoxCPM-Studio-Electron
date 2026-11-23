import React from "react";
import {createRoot} from "react-dom/client";
import PublicApiSettings from "./PublicApiSettings";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<React.StrictMode><main style={{maxWidth:1100,margin:"0 auto",padding:"36px 24px",height:"auto",overflow:"visible"}}><p style={{color:"var(--accent)"}}>JVOX Studio · 开发演示</p><h1>开发者 API</h1><p>使用设置页中的真实 API 管理组件，配置和作品独立保存。</p><PublicApiSettings backendBaseUrl=""/></main></React.StrictMode>);
