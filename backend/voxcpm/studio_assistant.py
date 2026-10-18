"""可复用的AI助手配置与文本请求，兼容已有minimax配置，密钥只在服务端解密。"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import re
import threading
import urllib.error
import urllib.request
from urllib.parse import urlsplit, urlunsplit
import uuid


class AssistantError(RuntimeError):
    pass


class _Blob(ctypes.Structure):
    _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]


def _protect(value: bytes, decrypt=False) -> bytes:
    if os.name != 'nt':
        raise AssistantError('当前加密助手配置需要保存密钥的Windows账户')
    raw = (ctypes.c_ubyte * len(value)).from_buffer_copy(value)
    source = _Blob(len(value), ctypes.cast(raw, ctypes.POINTER(ctypes.c_ubyte)))
    target = _Blob()
    crypt = ctypes.windll.crypt32
    if decrypt:
        ok = crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target))
    else:
        ok = crypt.CryptProtectData(ctypes.byref(source), ctypes.c_wchar_p('VoxCPM AI Assistant'), None, None, None, 1, ctypes.byref(target))
    if not ok:
        raise AssistantError('当前Windows账户无法读取助手密钥，请重新保存API Key')
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        ctypes.windll.kernel32.LocalFree(target.data)


def seal(value: str) -> str:
    return 'dpapi:' + _protect(value.encode('utf8')).hex() if value else ''


def unseal(value: str, legacy_root: Path | None = None) -> str:
    if not value:
        return ''
    try:
        if value.startswith('node:v1:') and legacy_root is not None:
            from cryptography.fernet import Fernet
            return Fernet((legacy_root / 'config/assistant-node.key').read_bytes()).decrypt(value[len('node:v1:'):].encode()).decode('utf8')
        return _protect(bytes.fromhex(value.removeprefix('dpapi:')), decrypt=True).decode('utf8')
    except AssistantError:
        raise
    except Exception:
        raise AssistantError('助手密钥无法解密，请重新保存配置') from None


def normalize_url(value: str) -> str:
    value = value.strip().rstrip('/')
    if '://' not in value:
        value = ('http://' if re.match(r'^(localhost|127\.|\[::1\])', value, re.I) else 'https://') + value
    parsed = urlsplit(value)
    if parsed.scheme not in {'https', 'http'} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('助手地址需要为不含密钥、查询参数的HTTP或HTTPS地址')
    endpoint = re.sub(r'/(?:responses|chat/completions|models)/?$', '', parsed.path.rstrip('/'))
    return urlunsplit((parsed.scheme, parsed.netloc, endpoint or '/v1', '', ''))


def api_type(value):
    return 'responses' if value in {'responses', 'OpenAI Responses API'} else 'chat-completions'


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class AssistantStore:
    def __init__(self, data_root: Path, transport=None):
        self.file = data_root / 'config/assistant-providers.json'
        self.lock = threading.RLock()
        self.transport = transport or self._request

    def _read(self):
        try:
            value = json.loads(self.file.read_text(encoding='utf-8-sig'))
        except FileNotFoundError:
            return {'protocol': 1, 'defaultProviderId': '', 'autoOptimizeMusic': True, 'providers': []}
        except (OSError, ValueError):
            raise AssistantError('AI助手配置读取失败，请重新导入或配置') from None
        if not isinstance(value, dict) or value.get('protocol') != 1 or not isinstance(value.get('providers'), list):
            raise AssistantError('AI助手配置格式无效')
        return value

    def _write(self, value):
        self.file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.file.with_suffix('.tmp')
        with temporary.open('w', encoding='utf8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush(); os.fsync(stream.fileno())
        temporary.replace(self.file)

    def public(self):
        with self.lock:
            value = self._read()
            return {**{k: value[k] for k in ('protocol', 'defaultProviderId', 'autoOptimizeMusic')},
                'providers': [{k: p.get(k) for k in ('id', 'name', 'baseUrl', 'model', 'apiType', 'enabled')} |
                              {'hasApiKey': bool(p.get('encryptedKey'))} for p in value['providers']]}

    def save(self, payload):
        with self.lock:
            previous = self._read()
            providers = payload.get('providers')
            if not isinstance(providers, list) or len(providers) > 20:
                raise ValueError('助手配置应为最多20项的列表')
            old = {p['id']: p for p in previous['providers']}
            saved, ids = [], set()
            for row in providers:
                if not isinstance(row, dict):
                    raise ValueError('助手配置项需要为对象')
                identity = str(row.get('id') or uuid.uuid4().hex)
                if not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', identity) or identity in ids:
                    raise ValueError('助手标识无效或重复')
                ids.add(identity)
                name, model = str(row.get('name', '')).strip(), str(row.get('model', '')).strip()
                if not name or len(name) > 100 or not model or len(model) > 300:
                    raise ValueError('请填写助手名称和模型名称')
                encrypted = old.get(identity, {}).get('encryptedKey', '')
                if row.get('clearKey'):
                    encrypted = ''
                elif row.get('apiKey'):
                    if len(row['apiKey']) > 8192 or '\n' in row['apiKey'] or '\r' in row['apiKey']:
                        raise ValueError('API Key格式无效')
                    encrypted = seal(row['apiKey'].strip())
                saved.append({'id': identity, 'name': name, 'baseUrl': normalize_url(str(row.get('baseUrl', ''))),
                    'model': model, 'apiType': api_type(row.get('apiType')), 'enabled': bool(row.get('enabled', True)), 'encryptedKey': encrypted})
            preferred = payload.get('defaultProviderId', '')
            if preferred not in {p['id'] for p in saved if p['enabled']}:
                preferred = next((p['id'] for p in saved if p['enabled']), '')
            self._write({'protocol': 1, 'defaultProviderId': preferred, 'autoOptimizeMusic': bool(payload.get('autoOptimizeMusic', True)), 'providers': saved})
            return self.public()

    def import_file(self, file: str):
        source = Path(file).expanduser().resolve()
        if not source.is_file() or source.stat().st_size > 1024**2:
            raise ValueError('请选择已有助手配置JSON文件')
        rows = json.loads(source.read_text(encoding='utf-8-sig'))
        if isinstance(rows, dict):
            rows = rows.get('providers')
        if not isinstance(rows, list) or len(rows) > 20:
            raise ValueError('未识别到可导入的助手配置')
        with self.lock:
            current = self._read()
            updates = {p['id']: p for p in current['providers']}
            for row in rows:
                if not isinstance(row, dict):
                    raise ValueError('导入配置中的助手项需要为对象')
                identity = str(row.get('id') or uuid.uuid4().hex)
                if not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', identity):
                    raise ValueError('导入配置的助手标识无效')
                key = row.get('encryptedKey', '')
                if not isinstance(key, str):
                    raise ValueError('导入配置的密钥字段无效')
                if key.startswith('node:v1:'):
                    key = seal(unseal(key, source.parent.parent))
                elif key and not key.startswith('dpapi:'):
                    # 兼容minimax桌面版的同账户DPAPI十六进制密文。
                    unseal(key); key = 'dpapi:' + key
                if 'apiKey' in row:
                    raise ValueError('请在设置中输入密钥，不导入含明文密钥的配置文件')
                model = str(row.get('model') or row.get('defaultModel') or '').strip()
                name = str(row.get('name') or model).strip()
                if not model or len(model) > 300 or not name or len(name) > 100:
                    raise ValueError('导入配置缺少名称或模型')
                updates[identity] = {'id': identity, 'name': name, 'baseUrl': normalize_url(str(row.get('baseUrl') or '')),
                    'model': model, 'apiType': api_type(row.get('apiType')), 'enabled': bool(row.get('enabled', True)), 'encryptedKey': key}
            if len(updates) > 20:
                raise ValueError('导入后助手数量超过20项，请先移除不用的助手')
            current['providers'] = list(updates.values())
            if current['defaultProviderId'] not in {p['id'] for p in updates.values() if p['enabled']}:
                current['defaultProviderId'] = next((p['id'] for p in updates.values() if p['enabled']), '')
            self._write(current)
            return self.public()

    def session(self, provider_id=''):
        with self.lock:
            config = self._read()
            identity = provider_id or config['defaultProviderId']
            provider = next((p for p in config['providers'] if p['id'] == identity and p['enabled']), None)
            if not provider:
                raise AssistantError('请先在AI助手设置中配置并启用一个助手')
            provider = dict(provider)
        key = unseal(provider.get('encryptedKey', ''))
        def complete(system, user):
            text = self.transport(provider, key, system, user)
            return text, {k: provider[k] for k in ('id', 'name', 'model')}
        return complete

    def complete(self, system: str, user: str, provider_id=''):
        return self.session(provider_id)(system, user)

    def test(self, provider_id=''):
        text, provider = self.complete('Reply only with OK.', 'Connection test.', provider_id)
        if not text.strip():
            raise AssistantError('助手没有返回文本')
        return {'ok': True, 'provider': provider}

    @staticmethod
    def _request(provider, key, system, user):
        responses = provider['apiType'] == 'responses'
        body = ({'model': provider['model'], 'instructions': system, 'input': user, 'max_output_tokens': 8192}
                if responses else {'model': provider['model'], 'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}], 'max_tokens': 8192})
        headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
        if key:
            headers['Authorization'] = 'Bearer ' + key
        request = urllib.request.Request(normalize_url(provider['baseUrl']) + ('/responses' if responses else '/chat/completions'),
            data=json.dumps(body, ensure_ascii=False).encode('utf8'), headers=headers, method='POST')
        try:
            with urllib.request.build_opener(_NoRedirect()).open(request, timeout=180) as response:
                raw = response.read(2 * 1024**2 + 1)
            if len(raw) > 2 * 1024**2:
                raise AssistantError('助手响应过长，请缩短需求后重试')
            data = json.loads(raw.decode('utf8'))
        except urllib.error.HTTPError as error:
            raise AssistantError(f'AI助手返回HTTP {error.code}，请检查地址、接口类型、模型和密钥') from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise AssistantError('AI助手连接失败或超时，请检查网络和服务地址') from None
        except (ValueError, UnicodeError):
            raise AssistantError('AI助手返回的响应不是有效JSON') from None
        if not isinstance(data, dict):
            raise AssistantError('AI助手响应格式无效')
        if responses:
            if data.get('status') == 'incomplete':
                raise AssistantError('助手输出被截断，请缩短需求或歌词后重试')
            text = data.get('output_text') or '\n'.join(c.get('text', '') for output in (data.get('output') or []) if isinstance(output, dict)
                for c in (output.get('content') or []) if isinstance(c, dict) and c.get('type') == 'output_text')
        else:
            choices = data.get('choices') or []
            if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
                raise AssistantError('AI助手没有返回可用文本')
            if choices[0].get('finish_reason') == 'length':
                raise AssistantError('助手输出被截断，请缩短需求或歌词后重试')
            content = choices[0].get('message', {}).get('content', '')
            if not isinstance(content, (str, list)):
                raise AssistantError('AI助手没有返回可用文本')
            text = content if isinstance(content, str) else '\n'.join(c.get('text', '') for c in content if isinstance(c, dict))
        if not isinstance(text, str) or not text.strip():
            raise AssistantError('AI助手没有返回可用文本')
        return text.strip()
