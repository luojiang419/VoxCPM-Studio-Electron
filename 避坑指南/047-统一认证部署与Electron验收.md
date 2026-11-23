# 统一认证部署与Electron验收

2026-10-25，均来自本次实际失败、定位及复验。

## Electron被当作Node运行

表现：试用EXE提示`bad option: --remote-debugging-port`，窗口未出现。根因：开发执行环境带有`ELECTRON_RUN_AS_NODE`，即使设置为空字符串也不能作为可靠清除方式。处理：构造子进程环境后直接`delete env.ELECTRON_RUN_AS_NODE`。复验：实际试用EXE、预加载IPC、本地Python启动和公网认证闭环通过。

## 新事件覆盖启动状态

原App运行事件默认会写入bootstrap状态。增加`license-state`后必须在通用处理前返回，让独立账户组件接收，否则授权刷新会把后端地址/就绪信息覆盖。已在原App事件处理里排除授权事件，真实刷新与退出后后端仍可读取既有作品。

## 独立包缺少验签依赖

音频依赖清单没有直接声明cryptography，不能只因开发机安装目录中存在就假定首次用户也具备。试用包从已校验的独立更新运行时提取cryptography、cffi、pycparser及许可证信息，放在`app/license-crypto`；后端优先读取此独立目录，不重装或修改正式音频环境。测试使用包内依赖实际完成验签。

## systemd专用用户无法进入源码目录

表现：服务以200/CHDIR反复退出。根因：部署使用`umask 077`创建了root独占的源码和虚拟环境目录。处理：源码/venv授予专用服务组读取和目录遍历权限，移除非owner写权限；数据归专用用户，systemd只开放data写权限。复验：`/opt/useradmin/current`服务active，公网健康检查200。

## SSH中嵌套Python引号

PowerShell→ssh→shell→`python -c`多层转义曾导致备份验证语法错误。不要用JSON转义当shell转义。复杂逻辑写为独立Python或shell脚本并上传执行。本次`maintenance.py verify`实际恢复检查通过；Certbot模拟续期也成功，不能因随后另一条Python命令失败而误报证书续期失败。

## 自动提醒与测试时序

界面收到最后一周授权后，会自动请求并消费当日提醒标记。测试不能随后直接断言`shouldRemindTrial()`第一次必须为true；应检查实际提醒已出现，并验证后续返回false。提醒收据单独保护保存，退出/重新登录同日不会重复提示；长时间开启软件时也需定时检查是否进入最后一周。

## 表单程序化提交

原生`form.requestSubmit()`可能不携带submitter，直接访问`event.submitter.disabled`会抛异常。管理端回退查找表单实际提交按钮，真实管理页登录和改期保存已复验。日期控件需同步实际input值，不能把旧React状态误当提交值；演示修复记录见046任务文档。

## Windows私密目录权限

对整个树套用`icacls /inheritance:r /grant user:(OI)(CI)F /T`时，文件可能变成空ACL，导致同一用户的Node/Python读取也返回EPERM。目录使用可继承的`(OI)(CI)F`，文件单独授予当前用户`F`，并实际用Node/Python验证可读，不能只看icacls进程退出码。修复后最终试用包公网链路重新通过。

## 窗口截图与永久版重启验收

安装器刚出现MainWindowHandle时子控件可能尚未绘制，立即PrintWindow会把磁盘卡区域截成黑块。等待首次绘制后截图，实际窗口区域正常。Electron以`windowsHide:true`作为后台测试进程启动时，CDP可正常运行界面，但Windows进程的MainWindowTitle可能为空。验证原生窗口标题应实际显示GUI再查询，不能把空标题误判为授权切换失效。实际显示GUI后，重新登录及完全重启两轮标题、配置和作品检查通过。

## 管理界面验收会话残留

失败退出的隔离浏览器可能保留Cookie，下一轮直接进入后台，等待登录表单会超时。测试启动前只清理它自己独立userData中的Cookie/localStorage。管理脚本以ES module运行，其顶层变量不在executeJavaScript的全局作用域中；需要通过受认证API获取精确QA记录，再通过真实界面操作。复验防滥用设置保存、释放QA名额及退出成功，控制台无错误。

## 服务启动等待

服务器导入依赖与密码哈希初始化可能超过5秒。首次v6发布的过短健康检查触发了源码回滚，服务没有报启动异常。核对journal后把检查窗口延长至25秒，再部署成功；保留生产签名公钥与一致性备份。不要机械反复重启或替换密钥。
