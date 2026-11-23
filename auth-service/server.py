"""EE2X统一账号与授权服务。启动配置通过环境变量提供，不包含初始凭据。"""
from __future__ import annotations

import base64
import calendar
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
import threading
import uuid

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, InvalidHashError
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, PublicFormat, NoEncryption
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

UTC = timezone.utc
PASSWORDS = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=2)
PASSWORD_SLOTS = threading.BoundedSemaphore(2)


def hash_password(value):
    with PASSWORD_SLOTS:
        return PASSWORDS.hash(value)


def verify_password(hashed, value):
    with PASSWORD_SLOTS:
        return PASSWORDS.verify(hashed, value)


def iso(t):
    return datetime.fromtimestamp(t, UTC).isoformat().replace('+00:00', 'Z')


def month_after(t):
    # 中国区产品按北京时间自然月计算，包括月末和闰年。
    from datetime import timedelta
    dt = datetime.fromtimestamp(t, timezone(timedelta(hours=8)))
    year, month = dt.year + (dt.month == 12), dt.month % 12 + 1
    return dt.replace(year=year, month=month, day=min(dt.day, calendar.monthrange(year, month)[1])).timestamp()


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


class Credentials(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=128)
    name: str = Field(default='', max_length=40)
    email: str = Field(default='', max_length=150)
    app_id: str = Field(default='jvox-studio', pattern=r'^[a-z][a-z0-9-]{2,39}$')
    device_id: str = Field(default='', max_length=64)
    mac_hashes: list[str] = Field(default_factory=list, max_length=16)


class AbusePolicy(BaseModel):
    max_ip_trials: int = Field(default=1, ge=1, le=1000)


class ReleaseClaim(BaseModel):
    reason: str = Field(min_length=3, max_length=200)


class Change(BaseModel):
    expires_at: str = ''
    reason: str = Field(default='', max_length=200)
    received: bool = False
    revision: int = Field(ge=1)
    request_id: str = Field(min_length=8, max_length=100)


class Product(BaseModel):
    id: str = Field(pattern=r'^[a-z][a-z0-9-]{2,39}$')
    name: str = Field(min_length=1, max_length=50)
    device_limit: int = Field(default=2, ge=1, le=10)
    contact: str = Field(default='', max_length=200)
    purchase_note: str = Field(default='联系作者核实付款后开通永久权限。', max_length=500)


class AccountChange(BaseModel):
    username: str = Field(min_length=3, max_length=24)
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=10, max_length=128)


def create_app(data_root=None, admin_password=None, public_url=None, clock=time.time):
    root = Path(data_root or os.environ.get('EE2X_DATA_ROOT', Path(__file__).parent / 'data')).resolve()
    root.mkdir(parents=True, exist_ok=True)
    origin = (public_url or os.environ.get('EE2X_PUBLIC_URL', 'https://admin.ee2x.cn')).rstrip('/')
    dbpath = root / 'auth.sqlite3'

    @contextmanager
    def db(write=False):
        conn = sqlite3.connect(dbpath, timeout=20, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys=ON')
        try:
            if write:
                conn.execute('BEGIN IMMEDIATE')
            yield conn
            if write:
                conn.commit()
        except Exception:
            if write:
                conn.rollback()
            raise
        finally:
            conn.close()

    with db() as c:
        c.execute('PRAGMA journal_mode=WAL')
        c.executescript('''
        CREATE TABLE IF NOT EXISTS identities(id TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE,
          name TEXT NOT NULL, email TEXT UNIQUE COLLATE NOCASE, password TEXT NOT NULL, role TEXT NOT NULL,
          disabled INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS apps(id TEXT PRIMARY KEY, name TEXT NOT NULL, device_limit INTEGER NOT NULL,
          contact TEXT NOT NULL DEFAULT '', purchase_note TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS sessions(digest TEXT PRIMARY KEY, identity_id TEXT NOT NULL REFERENCES identities(id),
          csrf TEXT NOT NULL, expires REAL NOT NULL, device_id TEXT NOT NULL, app_id TEXT NOT NULL,
          family TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS entitlements(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES identities(id),
          app_id TEXT NOT NULL REFERENCES apps(id), kind TEXT NOT NULL, starts REAL NOT NULL, expires REAL,
          active INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1, UNIQUE(user_id,app_id));
        CREATE TABLE IF NOT EXISTS devices(user_id TEXT NOT NULL, app_id TEXT NOT NULL, device_id TEXT NOT NULL,
          last_seen REAL NOT NULL, PRIMARY KEY(user_id,app_id,device_id));
        CREATE TABLE IF NOT EXISTS trial_devices(app_id TEXT NOT NULL, device_id TEXT NOT NULL, user_id TEXT NOT NULL,
          PRIMARY KEY(app_id,device_id));
        CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
          user_id TEXT NOT NULL, app_id TEXT NOT NULL, before TEXT, after TEXT, reason TEXT, time REAL NOT NULL,
          request_id TEXT UNIQUE);
        CREATE TABLE IF NOT EXISTS attempts(key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS abuse_policies(app_id TEXT PRIMARY KEY REFERENCES apps(id), max_ip_trials INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS trial_claims(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, app_id TEXT NOT NULL,
          device_id TEXT NOT NULL, ip TEXT NOT NULL, mac_hashes TEXT NOT NULL, created REAL NOT NULL, released INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS trial_claims_ip ON trial_claims(app_id,ip,released);
        ''')
        if 'request_hash' not in {r['name'] for r in c.execute('PRAGMA table_info(audit)')}:
            c.execute('ALTER TABLE audit ADD COLUMN request_hash TEXT')
    keypath = root / 'license-ed25519.key'
    if not keypath.exists():
        key = Ed25519PrivateKey.generate()
        with keypath.open('xb') as stream:
            stream.write(key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption()))
        keypath.chmod(0o600)
    key = Ed25519PrivateKey.from_private_bytes(keypath.read_bytes())
    public_key = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex()
    with db(True) as c:
        if not c.execute("SELECT 1 FROM identities WHERE role='admin'").fetchone():
            initial = admin_password or os.environ.get('EE2X_ADMIN_PASSWORD', '')
            if not initial:
                raise RuntimeError('首次启动须设置 EE2X_ADMIN_PASSWORD')
            c.execute('INSERT INTO identities VALUES(?,?,?,?,?,?,0,?)', ('admin', os.environ.get('EE2X_ADMIN_USERNAME', 'luo'),
                      '管理员', None, hash_password(initial), 'admin', clock()))
        c.execute("INSERT OR IGNORE INTO apps VALUES('jvox-studio','JVOX Studio',2,'','联系作者核实付款后开通永久权限。')")

    app = FastAPI(title='EE2X 统一授权中心', docs_url=None, redoc_url=None, openapi_url=None)
    app.state.db = db
    app.state.public_key = public_key
    app.state.data_root = root

    @app.middleware('http')
    async def protections(request, call_next):
        if request.method not in {'GET', 'HEAD', 'OPTIONS'}:
            if request.headers.get('origin') not in {None, origin}:
                return JSONResponse({'detail': '不允许跨站操作'}, status_code=403)
            try:
                size = int(request.headers.get('content-length', '0') or '0')
            except ValueError:
                return JSONResponse({'detail': '请求长度无效'}, status_code=400)
            if size > 65536:
                return JSONResponse({'detail': '请求过大'}, status_code=413)
        result = await call_next(request)
        result.headers['Cache-Control'] = 'no-store'
        result.headers['X-Content-Type-Options'] = 'nosniff'
        result.headers['Referrer-Policy'] = 'no-referrer'
        result.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        return result

    def limit(request, name, maximum=10, window=900):
        # 只使用直连地址。公网部署须在可信回源层开启proxy_headers及明确forwarded-allow-ips。
        ip = request.client.host if request.client else 'unknown'
        k = digest(name + ':' + ip)
        with db(True) as c:
            c.execute('DELETE FROM attempts WHERE reset<?', (clock(),))
            row = c.execute('SELECT * FROM attempts WHERE key=?', (k,)).fetchone()
            if row and row['count'] >= maximum:
                raise HTTPException(429, '操作过于频繁，请稍后重试')
            c.execute('INSERT INTO attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1', (k, clock()+window))

    def identity(request, role=None):
        bearer = request.headers.get('authorization', '')
        token = bearer[7:] if bearer.startswith('Bearer ') else request.cookies.get('ee2x_session', '')
        with db() as c:
            row = c.execute('''SELECT s.*,i.username,i.name,i.email,i.role,i.disabled FROM sessions s
              JOIN identities i ON i.id=s.identity_id WHERE digest=?''', (digest(token),)).fetchone()
        if not row or row['revoked'] or row['expires'] <= clock() or row['disabled']:
            raise HTTPException(401, '登录已失效，请重新登录')
        if role and row['role'] != role:
            raise HTTPException(403, '没有管理权限')
        if not bearer and request.method not in {'GET', 'HEAD'}:
            if not secrets.compare_digest(request.headers.get('x-csrf-token', ''), row['csrf']):
                raise HTTPException(403, '会话校验失败，请刷新后重试')
        return dict(row)

    def public_user(row):
        return {k: row[k] for k in ('id', 'username', 'name', 'email', 'role')}

    def new_session(c, user, device, application, family=None):
        token, csrf = secrets.token_urlsafe(40), secrets.token_urlsafe(24)
        c.execute('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,0)',
                  (digest(token), user, csrf, clock()+30*86400, device, application, family or uuid.uuid4().hex))
        return token, csrf

    def set_cookie(response, token):
        response.set_cookie('ee2x_session', token, httponly=True, secure=origin.startswith('https:'),
                            samesite='strict', path='/', max_age=30*86400)

    def client_ip(request):
        # Uvicorn仅信任回源代理；不直接读取用户可伪造的转发头。
        raw = request.client.host if request.client else ''
        try:
            ip = ipaddress.ip_address(raw)
            if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
                ip = ip.ipv4_mapped
            return str(ip) if ip.version == 4 else str(ipaddress.ip_network(str(ip) + '/64', strict=False))
        except ValueError:
            raise HTTPException(400, '无法识别访问IP，请联系作者')

    def mac_proof(values):
        if any(not re.fullmatch(r'[0-9a-f]{64}', v) for v in values):
            raise HTTPException(422, '网卡指纹格式无效')
        return sorted(set(values))

    def claim(c, user, application, device, request, mac_hashes):
        product = c.execute('SELECT * FROM apps WHERE id=?', (application,)).fetchone()
        if not product:
            raise HTTPException(404, '软件不存在')
        if not re.fullmatch(r'[0-9a-f]{64}', device):
            raise HTTPException(422, '设备标识无效')
        license = c.execute('SELECT * FROM entitlements WHERE user_id=? AND app_id=?', (user, application)).fetchone()
        if not license:
            previous = c.execute('SELECT user_id FROM trial_devices WHERE app_id=? AND device_id=?', (application, device)).fetchone()
            if previous and previous['user_id'] != user:
                raise HTTPException(409, '此设备已领取过该软件试用，请登录原账号或联系作者')
            macs = mac_proof(mac_hashes)
            if not macs:
                raise HTTPException(422, '未检测到有效网卡，请启用物理网卡或联系作者；需要新版客户端注册试用')
            ip = client_ip(request)
            claims = c.execute('SELECT * FROM trial_claims WHERE app_id=? AND released=0', (application,)).fetchall()
            if any(set(macs).intersection(json.loads(r['mac_hashes'])) for r in claims):
                raise HTTPException(409, '此网卡已领取过该软件试用，请登录原账号或联系作者')
            policy = c.execute('SELECT max_ip_trials FROM abuse_policies WHERE app_id=?', (application,)).fetchone()
            maximum = policy['max_ip_trials'] if policy else 1
            if sum(r['ip'] == ip for r in claims) >= maximum:
                raise HTTPException(409, '此IP的试用名额已用完，请登录原账号；共用网络用户可联系作者放行')
            c.execute('INSERT INTO entitlements VALUES(?,?,?,?,?,?,1,1)',
                      (uuid.uuid4().hex, user, application, 'trial', clock(), month_after(clock())))
            c.execute('INSERT OR IGNORE INTO trial_devices VALUES(?,?,?)', (application, device, user))
            c.execute('INSERT INTO trial_claims VALUES(?,?,?,?,?,?,?,0)',
                      (uuid.uuid4().hex, user, application, device, ip, json.dumps(macs), clock()))
        if not c.execute('SELECT 1 FROM devices WHERE user_id=? AND app_id=? AND device_id=?', (user, application, device)).fetchone():
            count = c.execute('SELECT COUNT(*) FROM devices WHERE user_id=? AND app_id=?', (user, application)).fetchone()[0]
            if count >= product['device_limit']:
                raise HTTPException(409, '已达到设备上限，请在账户页解绑旧设备或联系作者')
            c.execute('INSERT INTO devices VALUES(?,?,?,?)', (user, application, device, clock()))
        else:
            c.execute('UPDATE devices SET last_seen=? WHERE user_id=? AND app_id=? AND device_id=?', (clock(), user, application, device))

    def lease(user, application, device):
        with db() as c:
            row = c.execute('SELECT * FROM entitlements WHERE user_id=? AND app_id=?', (user, application)).fetchone()
            product = c.execute('SELECT * FROM apps WHERE id=?', (application,)).fetchone()
            person = c.execute('SELECT * FROM identities WHERE id=?', (user,)).fetchone()
        if not row:
            raise HTTPException(404, '尚未领取授权')
        t = clock()
        until = None if row['kind'] == 'permanent' else min(t+72*3600, row['expires'])
        payload = {'schema': 1, 'issuer': origin, 'appId': application, 'userId': user, 'deviceId': device,
                   'entitlementId': row['id'], 'kind': row['kind'], 'startsAt': row['starts'],
                   'trialExpiresAt': row['expires'], 'active': bool(row['active']), 'revision': row['revision'],
                   'issuedAt': t, 'leaseUntil': until, 'username': person['username'], 'name': person['name'],
                   'contact': product['contact'], 'purchaseNote': product['purchase_note']}
        raw = json.dumps(payload, separators=(',', ':'), ensure_ascii=False)
        return {'payload': raw, 'signature': key.sign(raw.encode()).hex()}

    @app.get('/api/v1/health')
    def health():
        return {'ok': True, 'service': 'ee2x-auth', 'server_time': clock()}

    @app.get('/api/v1/public-key')
    def public():
        return {'algorithm': 'Ed25519', 'public_key': public_key}

    @app.get('/api/v1/apps/{app_id}/public-config')
    def app_config(app_id: str):
        with db() as c:
            row = c.execute('SELECT * FROM apps WHERE id=?', (app_id,)).fetchone()
        if not row:
            raise HTTPException(404, '软件不存在')
        return dict(row)

    @app.post('/api/v1/auth/register', status_code=201)
    def register(body: Credentials, request: Request, response: Response):
        limit(request, 'register', 6, 3600)
        username = body.username.strip()
        if not re.fullmatch(r'[A-Za-z0-9_]{3,24}', username) or len(body.password) < 8:
            raise HTTPException(422, '用户名须为3–24位字母数字下划线，密码至少8位')
        email = body.email.strip().lower() or None
        if email and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email):
            raise HTTPException(422, '邮箱格式无效')
        uid = 'U-' + uuid.uuid4().hex[:12]
        hashed = hash_password(body.password)
        try:
            with db(True) as c:
                c.execute('INSERT INTO identities VALUES(?,?,?,?,?,?,0,?)', (uid, username, body.name.strip() or username, email, hashed, 'user', clock()))
                claim(c, uid, body.app_id, body.device_id, request, body.mac_hashes)
                token, csrf = new_session(c, uid, body.device_id, body.app_id)
        except sqlite3.IntegrityError:
            raise HTTPException(409, '用户名或邮箱已注册，请直接登录')
        set_cookie(response, token)
        return {'token': token, 'csrf': csrf, 'license': lease(uid, body.app_id, body.device_id), 'server_time': clock()}

    def login(body, request, response, admin=False):
        limit(request, 'login', 15)
        with db() as c:
            row = c.execute('SELECT * FROM identities WHERE (username=? COLLATE NOCASE OR email=? COLLATE NOCASE) AND role=?',
                            (body.username.strip(), body.username.strip(), 'admin' if admin else 'user')).fetchone()
        try:
            verify_password(row['password'] if row else app.state.dummy_hash, body.password)
            if not row or row['disabled']:
                raise ValueError()
        except (VerificationError, InvalidHashError, ValueError):
            raise HTTPException(401, '用户名或密码错误')
        with db(True) as c:
            if not admin:
                claim(c, row['id'], body.app_id, body.device_id, request, body.mac_hashes)
            token, csrf = new_session(c, row['id'], body.device_id if not admin else '', body.app_id if not admin else '')
        set_cookie(response, token)
        return {'token': token, 'csrf': csrf, 'user': public_user(row), 'server_time': clock(),
                **({'license': lease(row['id'], body.app_id, body.device_id)} if not admin else {})}

    app.state.dummy_hash = hash_password(secrets.token_urlsafe(32))

    @app.post('/api/v1/auth/login')
    def user_login(body: Credentials, request: Request, response: Response):
        return login(body, request, response)

    @app.post('/api/v1/admin/auth/login')
    def admin_login(body: Credentials, request: Request, response: Response):
        return login(body, request, response, True)

    @app.get('/api/v1/me')
    def me(request: Request):
        s = identity(request)
        with db() as c:
            row = c.execute('SELECT * FROM identities WHERE id=?', (s['identity_id'],)).fetchone()
        return {'user': public_user(row), 'csrf': s['csrf'], 'server_time': clock()}

    @app.post('/api/v1/auth/logout')
    def logout(request: Request, response: Response):
        s = identity(request)
        with db(True) as c:
            c.execute('UPDATE sessions SET revoked=1 WHERE family=?', (s['family'],))
        response.delete_cookie('ee2x_session', path='/')
        return {'ok': True}

    @app.post('/api/v1/auth/refresh')
    def refresh(request: Request, response: Response):
        s = identity(request)
        with db(True) as c:
            # 事务内二次校验，阻止同一旧token并发刷新。
            old = c.execute('SELECT revoked FROM sessions WHERE digest=?', (s['digest'],)).fetchone()
            if old['revoked']:
                raise HTTPException(401, '会话已轮换，请重新登录')
            c.execute('UPDATE sessions SET revoked=1 WHERE digest=?', (s['digest'],))
            token, csrf = new_session(c, s['identity_id'], s['device_id'], s['app_id'], s['family'])
        set_cookie(response, token)
        return {'token': token, 'csrf': csrf, 'server_time': clock()}

    @app.post('/api/v1/licenses/refresh')
    def refresh_license(request: Request):
        s = identity(request, 'user')
        with db(True) as c:
            if not c.execute('SELECT 1 FROM devices WHERE user_id=? AND app_id=? AND device_id=?',
                             (s['identity_id'], s['app_id'], s['device_id'])).fetchone():
                raise HTTPException(403, '此设备已解绑，请重新登录')
        return {'license': lease(s['identity_id'], s['app_id'], s['device_id']), 'server_time': clock()}

    @app.get('/api/v1/me/devices')
    def devices(request: Request):
        s = identity(request, 'user')
        with db() as c:
            return {'items': [dict(r) for r in c.execute('SELECT app_id,device_id,last_seen FROM devices WHERE user_id=?', (s['identity_id'],))]}

    @app.post('/api/v1/devices/release')
    def release_device(body: dict, request: Request):
        s = identity(request, 'user')
        with db(True) as c:
            c.execute('DELETE FROM devices WHERE user_id=? AND app_id=? AND device_id=?',
                      (s['identity_id'], s['app_id'], str(body.get('device_id', ''))))
            c.execute('UPDATE sessions SET revoked=1 WHERE identity_id=? AND app_id=? AND device_id=?',
                      (s['identity_id'], s['app_id'], str(body.get('device_id', ''))))
        return {'ok': True}

    @app.get('/api/v1/admin/state')
    def admin_state(request: Request):
        identity(request, 'admin')
        with db() as c:
            return {'users': [public_user(r) for r in c.execute("SELECT * FROM identities WHERE role='user' ORDER BY created DESC LIMIT 1000")],
                    'licenses': [dict(r) for r in c.execute('SELECT e.*,(SELECT COUNT(*) FROM devices d WHERE d.user_id=e.user_id AND d.app_id=e.app_id) devices FROM entitlements e LIMIT 2000')],
                    'apps': [dict(r) for r in c.execute('SELECT * FROM apps')],
                    'abuse_policies': [dict(r) for r in c.execute('SELECT a.id app_id,COALESCE(p.max_ip_trials,1) max_ip_trials FROM apps a LEFT JOIN abuse_policies p ON p.app_id=a.id')],
                    'trial_claims': [dict(r) for r in c.execute('SELECT * FROM trial_claims ORDER BY created DESC LIMIT 1000')],
                    'logs': [dict(r) for r in c.execute('SELECT * FROM audit ORDER BY time DESC,rowid DESC LIMIT 200')], 'server_time': clock()}

    @app.put('/api/v1/admin/abuse-policy/{app_id}')
    def save_abuse_policy(app_id: str, body: AbusePolicy, request: Request):
        s = identity(request, 'admin')
        with db(True) as c:
            if not c.execute('SELECT 1 FROM apps WHERE id=?', (app_id,)).fetchone():
                raise HTTPException(404, '软件不存在')
            before = c.execute('SELECT max_ip_trials FROM abuse_policies WHERE app_id=?', (app_id,)).fetchone()
            c.execute('INSERT INTO abuse_policies VALUES(?,?) ON CONFLICT(app_id) DO UPDATE SET max_ip_trials=excluded.max_ip_trials', (app_id, body.max_ip_trials))
            c.execute('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?,?,?,?)', (uuid.uuid4().hex, s['username'], 'abuse-policy', '', app_id,
                      json.dumps({'max_ip_trials': before[0] if before else 1}), json.dumps(body.model_dump()), '调整同IP试用名额', clock(), None, None))
        return {'ok': True}

    @app.post('/api/v1/admin/trial-claims/{claim_id}/release')
    def release_trial_claim(claim_id: str, body: ReleaseClaim, request: Request):
        s = identity(request, 'admin')
        if len(body.reason.strip()) < 3:
            raise HTTPException(422, '请填写放行原因')
        with db(True) as c:
            row = c.execute('SELECT * FROM trial_claims WHERE id=?', (claim_id,)).fetchone()
            if not row:
                raise HTTPException(404, '试用领取记录不存在')
            if row['released']:
                return {'ok': True, 'unchanged': True}
            c.execute('UPDATE trial_claims SET released=1 WHERE id=?', (claim_id,))
            c.execute('DELETE FROM trial_devices WHERE app_id=? AND device_id=? AND user_id=?', (row['app_id'], row['device_id'], row['user_id']))
            c.execute('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?,?,?,?)', (uuid.uuid4().hex, s['username'], 'trial-release', row['user_id'], row['app_id'],
                      json.dumps(dict(row)), json.dumps({'released': True}), body.reason.strip(), clock(), None, None))
        return {'ok': True}

    @app.post('/api/v1/admin/apps')
    def add_product(body: Product, request: Request):
        identity(request, 'admin')
        with db(True) as c:
            if c.execute('SELECT 1 FROM apps WHERE id=?', (body.id,)).fetchone():
                raise HTTPException(409, '软件标识已存在')
            c.execute('INSERT INTO apps VALUES(?,?,?,?,?)', (body.id, body.name, body.device_limit, body.contact, body.purchase_note))
        return {'ok': True}

    @app.put('/api/v1/admin/apps/{app_id}')
    def save_product(app_id: str, body: Product, request: Request):
        identity(request, 'admin')
        if app_id != body.id:
            raise HTTPException(422, '软件标识不能修改')
        with db(True) as c:
            c.execute('UPDATE apps SET name=?,device_limit=?,contact=?,purchase_note=? WHERE id=?',
                      (body.name, body.device_limit, body.contact, body.purchase_note, app_id))
        return {'ok': True}

    @app.post('/api/v1/admin/entitlements/{eid}/{action}')
    def change_license(eid: str, action: str, body: Change, request: Request):
        s = identity(request, 'admin')
        if action not in {'trial-expiry', 'grant-permanent', 'suspend', 'restore'}:
            raise HTTPException(404, '操作不存在')
        if not body.reason.strip():
            raise HTTPException(422, '请填写操作原因或收款备注')
        with db(True) as c:
            request_hash = digest(json.dumps({'eid': eid, 'action': action, **body.model_dump(exclude={'request_id'})}, sort_keys=True))
            previous = c.execute('SELECT * FROM audit WHERE request_id=?', (body.request_id,)).fetchone()
            if previous:
                if previous['user_id'] != eid or previous['action'] != action or previous['request_hash'] != request_hash:
                    raise HTTPException(409, '幂等请求不匹配')
                return {'ok': True, 'replayed': True}
            row = c.execute('SELECT * FROM entitlements WHERE id=?', (eid,)).fetchone()
            if not row:
                raise HTTPException(404, '授权不存在')
            if row['revision'] != body.revision:
                raise HTTPException(409, '授权已被其他操作修改，请刷新后重试')
            before = dict(row)
            if action == 'trial-expiry':
                if row['kind'] != 'trial':
                    raise HTTPException(409, '永久授权不能调整试用期限')
                try:
                    dt = datetime.fromisoformat(body.expires_at.replace('Z', '+00:00'))
                    if dt.tzinfo is None:
                        raise ValueError()
                    expiry = dt.timestamp()
                    if expiry < row['starts'] or expiry > 253402214400:
                        raise ValueError()
                except (ValueError, OverflowError):
                    raise HTTPException(422, '到期时间无效或早于试用开始时间')
                if expiry == row['expires']:
                    return {'ok': True, 'unchanged': True}
                c.execute('UPDATE entitlements SET expires=?,revision=revision+1 WHERE id=?', (expiry, eid))
            elif action == 'grant-permanent':
                if not body.received:
                    raise HTTPException(422, '请核实已收到付款')
                if row['kind'] == 'permanent' and row['active']:
                    return {'ok': True, 'unchanged': True}
                c.execute("UPDATE entitlements SET kind='permanent',expires=NULL,active=1,revision=revision+1 WHERE id=?", (eid,))
            else:
                c.execute('UPDATE entitlements SET active=?,revision=revision+1 WHERE id=?', (int(action == 'restore'), eid))
            after = dict(c.execute('SELECT * FROM entitlements WHERE id=?', (eid,)).fetchone())
            c.execute('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?,?,?,?)', (uuid.uuid4().hex, s['username'], action, eid,
                      row['app_id'], json.dumps(before), json.dumps(after), body.reason, clock(), body.request_id, request_hash))
        return {'ok': True}

    @app.patch('/api/v1/admin/account')
    def change_account(body: AccountChange, request: Request, response: Response):
        s = identity(request, 'admin')
        limit(request, 'change-password', 8)
        if not re.fullmatch(r'[A-Za-z0-9_]{3,24}', body.username):
            raise HTTPException(422, '管理员用户名格式无效')
        with db(True) as c:
            row = c.execute('SELECT password FROM identities WHERE id=?', (s['identity_id'],)).fetchone()
            try:
                verify_password(row['password'], body.current_password)
            except VerificationError:
                raise HTTPException(401, '当前密码错误')
            if c.execute('SELECT 1 FROM identities WHERE username=? COLLATE NOCASE AND id<>?', (body.username,s['identity_id'])).fetchone():
                raise HTTPException(409, '用户名已被使用')
            c.execute('UPDATE identities SET username=?,password=? WHERE id=?',
                      (body.username, hash_password(body.new_password), s['identity_id']))
            c.execute('UPDATE sessions SET revoked=1 WHERE identity_id=?', (s['identity_id'],))
        response.delete_cookie('ee2x_session', path='/')
        return {'ok': True, 'message': '凭据已修改，请使用新账号重新登录'}

    web = Path(__file__).parent / 'web'
    if web.exists():
        app.mount('/assets', StaticFiles(directory=web), name='assets')

        @app.get('/{path:path}')
        def index(path: str):
            if path.startswith('api/'):
                raise HTTPException(404)
            return FileResponse(web / 'index.html')
    return app


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(create_app(), host='127.0.0.1', port=int(os.environ.get('EE2X_PORT', '4102')),
                proxy_headers=True, forwarded_allow_ips=os.environ.get('EE2X_PROXY_IPS', '127.0.0.1'))
