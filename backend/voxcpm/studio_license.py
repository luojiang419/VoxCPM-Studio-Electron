"""桌面及直接Python API共享的签名授权门禁。"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import time
import sys

# 试用分发携带独立验签依赖，避免首次安装音频环境时缺少cryptography。
crypto_bundle = Path(__file__).resolve().parents[2] / 'license-crypto'
if crypto_bundle.is_dir():
    sys.path.insert(0, str(crypto_bundle))

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import HTTPException


class LicenseGuard:
    def __init__(self, config_path=None, session_path=None, secret=None):
        default = Path(__file__).resolve().parents[2] / 'frontend/voxcpm_studio_electron/license-config.json'
        self.config_path = Path(config_path or os.environ.get('VOXCPM_LICENSE_CONFIG', default))
        self.session_path = Path(session_path or os.environ.get('VOXCPM_LICENSE_SESSION', self.config_path.parent / 'missing-session.json'))
        self.secret = secret or os.environ.get('VOXCPM_LICENSE_BRIDGE_SECRET', '')
        self.config = json.loads(self.config_path.read_text('utf-8'))
        self.high_water = 0

    def require(self):
        try:
            bridge = json.loads(self.session_path.read_text('utf-8'))
            if not self.secret or not hmac.compare_digest(bridge['mac'], hmac.new(self.secret.encode(), bridge['payload'].encode(), hashlib.sha256).hexdigest()):
                raise ValueError('登录会话无效')
            state = json.loads(bridge['payload'])
            envelope = state['license']
            Ed25519PublicKey.from_public_bytes(bytes.fromhex(self.config['publicKey'])).verify(bytes.fromhex(envelope['signature']), envelope['payload'].encode())
            p = json.loads(envelope['payload'])
            if p['schema'] != 1 or p['issuer'] != self.config['serverUrl'] or p['appId'] != self.config['appId'] or p['deviceId'] != state['deviceId']:
                raise ValueError('授权软件或设备不匹配')
            wall = time.time()
            if wall < state['wallTime']-300:
                raise ValueError('系统时间发生回拨，请联网重新验证')
            now = state['serverTime']+max(0, wall-state['wallTime'])
            self.high_water = max(self.high_water, now)
            if not p['active']:
                raise ValueError('授权已被管理员停用')
            if p['kind'] == 'trial':
                if self.high_water >= p['trialExpiresAt']:
                    raise ValueError('试用已到期，请联系作者开通永久权限')
                if self.high_water >= p['leaseUntil']:
                    raise ValueError('请联网刷新授权后继续创作')
            elif p['kind'] != 'permanent':
                raise ValueError('授权类型无效')
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(403, {'code': 'LICENSE_REQUIRED', 'message': str(e) if isinstance(e, ValueError) else '请先在软件中登录并激活授权'}) from e


def install_gate(app, guard):
    from fastapi.responses import JSONResponse

    @app.middleware('http')
    async def gate(request, call_next):
        path = request.url.path
        protected = request.method == 'POST' and (
            path.startswith('/api/tasks/') and not path.endswith('/cancel') or
            path.startswith('/api/training/start') or path == '/api/asr/recognize' or
            path in {'/api/music/compose', '/api/music/compile', '/api/music/generate', '/api/lipsync/generate'} or
            path.startswith('/api/workspace/') and path.endswith(('/generate', '/parse')) or
            path.startswith('/v1/audio/') and not path.endswith('/references')
        )
        if protected:
            try:
                guard.require()
            except HTTPException as error:
                return JSONResponse({'detail': error.detail}, status_code=error.status_code)
        return await call_next(request)
