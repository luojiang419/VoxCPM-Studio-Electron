import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading

import pytest

from voxcpm.studio_assistant import AssistantError, AssistantStore, normalize_url, seal


def provider(**values):
    return {'id': 'test', 'name': '测试助手', 'model': 'test-model', 'baseUrl': 'http://localhost:1/v1', 'apiType': 'chat-completions', 'enabled': True, **values}


@pytest.mark.parametrize('url,expected', [
    ('localhost:11434', 'http://localhost:11434/v1'),
    ('https://example.invalid/v1/responses', 'https://example.invalid/v1'),
    ('https://example.invalid/compatible-mode/v1/chat/completions', 'https://example.invalid/compatible-mode/v1'),
])
def test_normalize_supported_endpoints(url, expected):
    assert normalize_url(url) == expected


@pytest.mark.parametrize('url', ['https://user:password@example.invalid', 'https://example.invalid/?key=secret', 'file:///secret', 'https://example.invalid/#secret'])
def test_url_cannot_carry_credentials_or_local_file_access(url):
    with pytest.raises(ValueError):
        normalize_url(url)


def test_keys_encrypted_redacted_preserved_and_explicitly_removed(tmp_path):
    store = AssistantStore(tmp_path)
    config = store.save({'providers': [provider(apiKey='unit-test-only-key')]})
    assert config['providers'][0]['hasApiKey']
    assert 'unit-test-only-key' not in store.file.read_text(encoding='utf8')
    assert 'encryptedKey' not in json.dumps(config)
    store.save({'providers': [provider(model='updated')]})
    assert store.public()['providers'][0]['hasApiKey']
    store.save({'providers': [provider(clearKey=True)]})
    assert not store.public()['providers'][0]['hasApiKey']


def test_disabling_default_selects_enabled_provider(tmp_path):
    store = AssistantStore(tmp_path)
    result = store.save({'defaultProviderId': 'disabled', 'providers': [provider(id='disabled', enabled=False), provider(id='enabled')]})
    assert result['defaultProviderId'] == 'enabled'


def test_import_existing_minimax_dpapi_configuration_without_plaintext(tmp_path):
    source = tmp_path / 'legacy/config/assistant-providers.json'; source.parent.mkdir(parents=True)
    source.write_text(json.dumps([{'id': 'legacy', 'name': '现有助手', 'baseUrl': 'http://localhost:1', 'defaultModel': 'existing-model',
                                  'apiType': 'OpenAI Responses API', 'enabled': True, 'encryptedKey': seal('unit-test-import-key').removeprefix('dpapi:')}]), encoding='utf8')
    store = AssistantStore(tmp_path / 'new')
    value = store.import_file(str(source))
    assert value['providers'][0]['model'] == 'existing-model'
    assert value['providers'][0]['apiType'] == 'responses'
    assert 'unit-test-import-key' not in store.file.read_text(encoding='utf8')
    source.write_text(json.dumps([{'apiKey': 'unit-test-plaintext'}]))
    with pytest.raises(ValueError, match='明文'):
        store.import_file(str(source))


@pytest.fixture
def server():
    state = {'status': 200, 'payload': {'choices': [{'message': {'content': 'OK'}, 'finish_reason': 'stop'}]}, 'requests': []}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            state['requests'].append({'path': self.path, 'body': json.loads(self.rfile.read(int(self.headers['Content-Length']))), 'authorization': self.headers.get('Authorization')})
            self.send_response(state['status']); self.send_header('Content-Type', 'application/json')
            if state['status'] == 302:
                self.send_header('Location', '/not-allowed')
            self.end_headers(); self.wfile.write(json.dumps(state['payload']).encode())
    service = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=service.serve_forever, daemon=True); thread.start()
    yield f'http://127.0.0.1:{service.server_port}/v1', state
    service.shutdown(); service.server_close(); thread.join()


@pytest.mark.parametrize('kind', ['chat-completions', 'responses'])
def test_actual_compatible_http_payloads_and_response_parsing(server, tmp_path, kind):
    url, state = server
    if kind == 'responses':
        state['payload'] = {'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': 'OK'}]}]}
    store = AssistantStore(tmp_path)
    store.save({'providers': [provider(baseUrl=url, apiType=kind, apiKey='unit-test-http-key')]})
    assert store.test()['ok']
    request = state['requests'][0]
    assert request['authorization'] == 'Bearer unit-test-http-key'
    assert request['path'] == '/v1/' + ('responses' if kind == 'responses' else 'chat/completions')
    assert ('instructions' if kind == 'responses' else 'messages') in request['body']


def test_upstream_errors_and_redirect_do_not_expose_tokens_or_follow_redirect(server, tmp_path):
    url, state = server
    store = AssistantStore(tmp_path); store.save({'providers': [provider(baseUrl=url)]})
    state['status'] = 401; state['payload'] = {'error': {'message': 'unit-test-sensitive-upstream-key'}}
    with pytest.raises(AssistantError) as error:
        store.test()
    assert 'HTTP 401' in str(error.value) and 'sensitive' not in str(error.value)
    state['status'] = 302
    with pytest.raises(AssistantError, match='302'):
        store.test()
    assert len(state['requests']) == 2


def test_empty_or_truncated_results_are_errors(server, tmp_path):
    url, state = server
    store = AssistantStore(tmp_path); store.save({'providers': [provider(baseUrl=url)]})
    state['payload'] = {'choices': [{'message': {'content': None}}]}
    with pytest.raises(AssistantError, match='可用文本'):
        store.test()
    state['payload'] = {'choices': [{'message': {'content': 'partial'}, 'finish_reason': 'length'}]}
    with pytest.raises(AssistantError, match='截断'):
        store.test()
