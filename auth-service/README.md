# EE2X统一授权中心

真实账号与授权服务，使用FastAPI、SQLite WAL、Argon2id密码哈希和Ed25519签名。管理端沿用已选石墨深灰方案，软件内注册、登录与退出由Electron主进程对接本服务。`authorization-demo/`仍仅是历史设计演示，不参与生产认证。

## 生产运行

- 地址：`https://admin.ee2x.cn/admin/login`。
- 服务器：按根项目 `DOC/腾讯服务器/腾讯云.txt` 连接腾讯云，端口419、指定密钥登录；不要使用旧公网部署说明中的另一台服务器。
- 用户指定部署目录：`/opt/useradmin`。`current`指向当前源码发布，`releases/`保留版本，`venv/`是独立Python环境，`data/`是数据库和授权签名私钥，`backups/`保存一致性数据库备份，`deploy/`是发布暂存。
- 服务：`ee2x-auth.service`，专用`ee2x-auth`系统用户，监听`127.0.0.1:4102`，OpenResty代理HTTPS。systemd保护源码只读，只允许服务写`/opt/useradmin/data`。
- 站点：`/opt/1panel/www/conf.d/admin.ee2x.cn.conf`；证书由Certbot续期，部署钩子同步至1Panel站点证书目录并校验、重载OpenResty。不要复制数据库或私钥到web目录。
- 管理员首次按用户提供凭据初始化；凭据不在源码或分发包。账户设置可修改用户名与密码，保存后既有管理员会话全部失效。

## 管理操作

1. 用户从软件注册后，后台“用户授权”自动出现对应软件的试用记录。
2. 选择软件和用户，点击“调整试用期限”，可指定北京时间、延长、缩短、立即结束或恢复试用；填写原因后保存。
3. 核实用户付款，勾选收款确认、填写备注，再二次确认“开通永久权限”。仅影响所选软件。
4. “软件接入”可添加新app_id、设置设备上限和作者联系方式。app_id固定，账号可以共用，授权分别发放。
5. “操作记录”显示操作者、软件、调整原因和前后时间；停用与恢复同样记录。
6. “账户设置”可修改管理员凭据；顶部可退出管理员登录。
7. “防滥用”查看新版客户端领取试用时的IP、设备和MAC指纹；可按软件调整同IP累计名额，或填写原因逐条释放误判记录。默认每IP一份试用，同设备或同MAC只领一次；IPv6按/64网段计数。

云端记录修改后立即保存。运行中的桌面每分钟静默联网同步，重新聚焦窗口也会刷新，可在左下角“账户与授权”主动刷新。开通永久权限后自动显示“正式版”，无需重装或迁移数据。试用离线租约最多72小时且不超过到期时间；缩短或停用无法在离线设备上瞬间生效。永久证书允许离线使用，停用在重新联网后同步。

## 后续软件对接

注册/登录请求：`POST /api/v1/auth/register`、`POST /api/v1/auth/login`；JSON包含`username`、`password`、`app_id`、64位十六进制`device_id`及`mac_hashes`，注册可附带`name`和`email`。新试用必须提供1–16个网卡指纹。网卡地址去除冒号/短横线并转小写，对`ee2x-mac-v1:{app_id}:{12位MAC}`做SHA-256；过滤全零、多播和虚拟网卡，不上传原始MAC。Windows读取物理网卡（含断开状态），切换Wi-Fi/有线不会仅因接口排列变化改变指纹。默认每用户每软件一个自然月试用、两台设备。

服务端只使用可信回源解析后的客户端IP，不信任注册JSON或直接读取转发头；反向代理必须覆盖X-Forwarded-For，Uvicorn仅信任指定回源IP。IP名额、MAC交集与设备历史在同一SQLite写事务中检查和登记，并发请求无法重复占用同一个名额。账号创建失败整体回滚；限制仅针对领取新试用，既有用户换网络正常登录不重新扣名额，已签发授权继续有效。

管理接口：`PUT /api/v1/admin/abuse-policy/{app_id}`设置`max_ip_trials`（1–1000）；`POST /api/v1/admin/trial-claims/{id}/release`需`reason`，释放所选记录的IP、MAC及初始设备领取限制，保留原授权和审计。放行不撤销已签发的离线证书。旧账号缺少历史IP/MAC时不虚构补录。客户端提供的硬件信息可被修改，IP也能通过代理更换；这是联合防重复机制，不宣称不可绕过。

响应返回会话Token、服务器时间及`license`签名信封。信封的`payload`是原始UTF-8 JSON字符串，`signature`为Ed25519签名十六进制。使用固定公钥验证原始字节，再检查schema、issuer、appId、deviceId、active、trialExpiresAt及leaseUntil。`app_id`是标识，不是秘密；客户端不内置服务端签名私钥或通用client_secret。

桌面使用Bearer会话访问`POST /api/v1/auth/refresh`轮换Token，再调用`POST /api/v1/licenses/refresh`获取最新授权。`POST /api/v1/auth/logout`撤销当前会话族。设备查询`GET /api/v1/me/devices`，解绑`POST /api/v1/devices/release`；解绑不清除领取试用历史。

管理网页使用HttpOnly/Secure/SameSite Cookie和CSRF令牌；所有管理写接口验证管理员权限。授权变更需`revision`、唯一`request_id`及原因，不允许旧修订覆盖新状态；重复请求内容不一致返回409。

完整业务方案与接口位置见 `../docs/统一授权中心设计方案.md`。当前网页仅提供管理员界面，普通用户注册登录在软件内；不把旧演示的网页入口当成真实用户门户。

## 本地启动及测试

```powershell
python -m pip install -r auth-service/requirements.txt
# 首次初始化须由本机环境提供EE2X_ADMIN_PASSWORD；可选EE2X_ADMIN_USERNAME。
$env:EE2X_PUBLIC_URL='http://127.0.0.1:4102'
python auth-service/server.py
python -m pytest auth-service/test_server.py tests/test_license_guard.py -q
node --test frontend/voxcpm_studio_electron/tests/license-service.test.cjs
```

生产使用`requirements.lock.txt`固定已验证依赖。测试依赖pytest、httpx；不要把生产数据目录用于单元测试。

## 备份与恢复

```bash
/opt/useradmin/venv/bin/python /opt/useradmin/current/maintenance.py backup /opt/useradmin/data/auth.sqlite3 --output /opt/useradmin/backups/新的唯一备份名称.sqlite3
/opt/useradmin/venv/bin/python /opt/useradmin/current/maintenance.py verify /opt/useradmin/backups/备份名称.sqlite3
systemctl status ee2x-auth
journalctl -u ee2x-auth --no-pager -n 50
```

备份通过SQLite API生成一致性快照，不能在运行时只复制主db而遗漏WAL。恢复验证将备份加载至独立内存库，检查完整性及管理员记录。恢复正式数据前先停止服务并备份当前状态，再恢复数据库；签名私钥另行保护和备份，不能随意重建，否则已有客户端将无法验证新授权。

源码回滚可将`current`指向兼容的旧`releases`目录后重启服务。数据库schema只做兼容新增列，仍需核对版本与备份。旧路径`/opt/APP/ee2x-auth`及`/var/lib/ee2x-auth`是首次迁移恢复点，当前服务不使用它们。
