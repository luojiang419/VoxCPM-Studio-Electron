import concurrent.futures
import importlib.util
import json
from pathlib import Path
import time

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi.testclient import TestClient
import pytest

spec = importlib.util.spec_from_file_location('ee2x_auth_server', Path(__file__).with_name('server.py'))
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


@pytest.fixture
def service(tmp_path):
    now = [time.time()]
    app = server.create_app(tmp_path, admin_password='test-admin-password', public_url='http://testserver', clock=lambda: now[0])
    return app, now


def registered(client, name='firstuser', device='a'*64, app_id='jvox-studio'):
    result = client.post('/api/v1/auth/register', json={'username': name, 'password': 'test-password-123', 'device_id': device, 'app_id': app_id, 'mac_hashes': [server.digest('mac:'+device+app_id)]})
    assert result.status_code == 201, result.text
    return result.json()


def admin(client):
    result = client.post('/api/v1/admin/auth/login', json={'username': 'luo', 'password': 'test-admin-password'})
    assert result.status_code == 200
    return {'Authorization': 'Bearer '+result.json()['token']}


def edit(client, headers, license, action='trial-expiry', **values):
    return client.post('/api/v1/admin/entitlements/'+license['id']+'/'+action, headers=headers,
                       json={'revision': license['revision'], 'request_id': 'test-request-'+str(time.monotonic_ns()), 'reason': '测试调整', **values})


def test_passwords_sessions_and_csrf(service):
    app, _ = service
    with TestClient(app, client=("192.0.2.10", 50000)) as c:
        first = registered(c)
        assert c.post('/api/v1/auth/logout').status_code == 403
        assert c.post('/api/v1/auth/logout', headers={'X-CSRF-Token': first['csrf'], 'Origin': 'https://evil.example'}).status_code == 403
        token = first['token']
        next_session = c.post('/api/v1/auth/refresh', headers={'Authorization':'Bearer '+token}).json()
        assert c.get('/api/v1/me', headers={'Authorization':'Bearer '+token}).status_code == 401
        assert c.post('/api/v1/auth/logout', headers={'Authorization':'Bearer '+next_session['token']}).status_code == 200
        assert c.get('/api/v1/me', headers={'Authorization':'Bearer '+next_session['token']}).status_code == 401
        assert c.post('/api/v1/auth/login', json={'username':'firstuser','password':'wrong','device_id':'a'*64}).status_code == 401
    with app.state.db() as db:
        hashed = db.execute("SELECT password FROM identities WHERE username='firstuser'").fetchone()[0]
        assert hashed.startswith('$argon2id$') and 'test-password' not in hashed


def test_trial_signing_duplicate_device_and_month(service):
    app, now = service
    with TestClient(app, client=("192.0.2.10", 50000)) as c:
        result = registered(c)
        envelope = result['license']
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(app.state.public_key)).verify(bytes.fromhex(envelope['signature']), envelope['payload'].encode())
        p = json.loads(envelope['payload'])
        assert p['trialExpiresAt'] == server.month_after(now[0])
        assert p['leaseUntil'] == now[0]+72*3600
        assert c.post('/api/v1/auth/register', json={'username':'seconduser','password':'test-password-123','device_id':'a'*64}).status_code == 409
        login = c.post('/api/v1/auth/login', json={'username':'firstuser','password':'test-password-123','device_id':'a'*64}).json()
        assert json.loads(login['license']['payload'])['trialExpiresAt'] == p['trialExpiresAt']
        assert c.get('/api/v1/admin/state', headers={'Authorization':'Bearer '+result['token']}).status_code == 403


def test_admin_deadline_revisions_permanent_and_audit(service):
    app, now = service
    with TestClient(app, client=("192.0.2.10", 50000)) as c:
        user = registered(c); headers = admin(c)
        row = c.get('/api/v1/admin/state', headers=headers).json()['licenses'][0]
        until = server.iso(now[0]-10)
        change = {'revision':row['revision'],'request_id':'same-request-id','reason':'立即结束','expires_at':until}
        # 试用开始前不接受错误期限。
        assert c.post('/api/v1/admin/entitlements/'+row['id']+'/trial-expiry', headers=headers,json=change).status_code == 422
        now[0] += 60
        change['expires_at'] = server.iso(now[0]-10)
        path = '/api/v1/admin/entitlements/'+row['id']+'/trial-expiry'
        assert c.post(path, headers=headers,json=change).status_code == 200
        assert c.post(path, headers=headers,json=change).json()['replayed']
        assert c.post(path, headers=headers,json={**change,'reason':'不同内容'}).status_code == 409
        assert edit(c,headers,row,expires_at=server.iso(now[0]+86400)).status_code == 409
        state = c.get('/api/v1/admin/state', headers=headers).json()
        assert len(state['logs']) == 1
        row = state['licenses'][0]
        assert row['revision'] == 2
        assert json.loads(state['logs'][0]['after'])['expires'] == pytest.approx(now[0]-10, abs=1e-5)
        refreshed = c.post('/api/v1/licenses/refresh', headers={'Authorization':'Bearer '+user['token']}).json()
        assert json.loads(refreshed['license']['payload'])['trialExpiresAt'] < now[0]
        assert edit(c,headers,row,'grant-permanent',received=False).status_code == 422
        assert edit(c,headers,row,'grant-permanent',received=True).status_code == 200
        row = c.get('/api/v1/admin/state', headers=headers).json()['licenses'][0]
        assert row['kind'] == 'permanent' and row['expires'] is None
        assert edit(c,headers,row,expires_at=server.iso(now[0]+86400)).status_code == 409


def test_multi_software_isolation_and_devices(service):
    app, now = service
    with TestClient(app, client=("192.0.2.10", 50000)) as c:
        first=registered(c); headers=admin(c)
        assert c.post('/api/v1/admin/apps', headers=headers,json={'id':'second-app','name':'第二软件','device_limit':1}).status_code == 200
        login=c.post('/api/v1/auth/login',json={'username':'firstuser','password':'test-password-123','device_id':'a'*64,'app_id':'second-app','mac_hashes':['b'*64]}).json()
        rows=c.get('/api/v1/admin/state',headers=headers).json()['licenses']
        row=next(r for r in rows if r['app_id']=='jvox-studio')
        assert edit(c,headers,row,'grant-permanent',received=True).status_code==200
        refreshed=c.post('/api/v1/licenses/refresh',headers={'Authorization':'Bearer '+login['token']}).json()
        assert json.loads(refreshed['license']['payload'])['kind']=='trial'
        assert c.post('/api/v1/auth/login',json={'username':'firstuser','password':'test-password-123','device_id':'b'*64,'app_id':'second-app'}).status_code==409
        assert c.post('/api/v1/devices/release',headers={'Authorization':'Bearer '+login['token']},json={'device_id':'a'*64}).status_code==200
        assert c.post('/api/v1/licenses/refresh',headers={'Authorization':'Bearer '+login['token']}).status_code==401


def test_admin_password_change_revokes_existing_sessions(service):
    app,_=service
    with TestClient(app, client=("192.0.2.10", 50000)) as c:
        headers=admin(c)
        result=c.patch('/api/v1/admin/account',headers=headers,json={'username':'newadmin','current_password':'test-admin-password','new_password':'changed-password-456'})
        assert result.status_code==200
        assert c.get('/api/v1/admin/state',headers=headers).status_code==401
        assert c.post('/api/v1/admin/auth/login',json={'username':'luo','password':'test-admin-password'}).status_code==401
        assert c.post('/api/v1/admin/auth/login',json={'username':'newadmin','password':'changed-password-456'}).status_code==200


def test_concurrent_device_limit(service):
    app,_=service
    with TestClient(app, client=("192.0.2.10", 50000)) as c:
        registered(c)
    def activate(device):
        with TestClient(app, client=("192.0.2.10", 50000)) as c:
            return c.post('/api/v1/auth/login',json={'username':'firstuser','password':'test-password-123','device_id':device*64}).status_code
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(activate,['b','c']))==[200,409]
    with app.state.db() as c:
        assert c.execute('SELECT COUNT(*) FROM devices').fetchone()[0]==2


def trial_request(name, device, mac):
    return {'username': name, 'password': 'test-password-123', 'device_id': device * 64,
            'mac_hashes': [mac * 64], 'app_id': 'jvox-studio'}


def test_ip_mac_joint_limits_and_spoofed_headers(service):
    app, _ = service
    with TestClient(app, client=('192.0.2.10', 50000)) as c:
        registered(c)
        # 换设备与网卡并伪造回源头，不能绕过真实IP的累计名额。
        result = c.post('/api/v1/auth/register', json=trial_request('seconduser', 'b', 'b'),
                        headers={'X-Forwarded-For': '203.0.113.99', 'X-Real-IP': '203.0.113.99'})
        assert result.status_code == 409 and 'IP' in result.json()['detail']
        # 正常换网登录不消耗试用或锁死既有用户。
    with TestClient(app, client=('198.51.100.12', 50000)) as c:
        proof = server.digest('mac:' + 'a' * 64 + 'jvox-studio')
        result = c.post('/api/v1/auth/register', json={**trial_request('thirduser', 'c', 'c'), 'mac_hashes':[proof]})
        assert result.status_code == 409 and '网卡' in result.json()['detail']
        assert c.post('/api/v1/auth/login', json={'username':'firstuser','password':'test-password-123','device_id':'a'*64}).status_code == 200
    with app.state.db() as c:
        assert c.execute("SELECT COUNT(*) FROM identities WHERE role='user'").fetchone()[0] == 1
        assert c.execute('SELECT COUNT(*) FROM trial_claims').fetchone()[0] == 1


def test_abuse_policy_admin_release_and_missing_mac(service):
    app, _ = service
    with TestClient(app, client=('192.0.2.10', 50000)) as c:
        no_mac = trial_request('missingmac', 'a', 'a'); no_mac['mac_hashes'] = []
        assert c.post('/api/v1/auth/register', json=no_mac).status_code == 422
        registered(c)
        headers = admin(c)
        state = c.get('/api/v1/admin/state', headers=headers).json()
        row = state['trial_claims'][0]
        endpoint = '/api/v1/admin/trial-claims/' + row['id'] + '/release'
        assert c.post(endpoint, json={'reason':'误判放行'}).status_code == 403
        assert c.put('/api/v1/admin/abuse-policy/jvox-studio', headers=headers, json={'max_ip_trials': 0}).status_code == 422
        assert c.put('/api/v1/admin/abuse-policy/jvox-studio', headers=headers, json={'max_ip_trials': 2}).status_code == 200
        registered(c, 'seconduser', 'b'*64)
        assert c.post(endpoint, headers=headers, json={'reason':'共用网络与网卡测试放行'}).status_code == 200
        assert c.post(endpoint, headers=headers, json={'reason':'重复放行'}).json()['unchanged']
        # 仅释放所选领取的限制，原账号授权保留。
        registered(c, 'thirduser', 'a'*64)
        state = c.get('/api/v1/admin/state', headers=headers).json()
        assert len(state['licenses']) == 3
        assert sum(x['action']=='trial-release' for x in state['logs']) == 1


def test_parallel_ip_limit_is_atomic(service):
    app, _ = service
    def attempt(values):
        name, dev, mac = values
        with TestClient(app, client=('192.0.2.10', 50000)) as c:
            return c.post('/api/v1/auth/register', json=trial_request(name, dev, mac)).status_code
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(attempt, [('firstuser','a','a'), ('seconduser','b','b')])) == [201,409]


def test_ipv6_privacy_addresses_share_quota(service):
    app, _ = service
    with TestClient(app, client=('2001:db8:1:2::1', 50000)) as c:
        registered(c)
    with TestClient(app, client=('2001:db8:1:2:abcd::99', 50000)) as c:
        result = c.post('/api/v1/auth/register', json=trial_request('seconduser','b','b'))
        assert result.status_code == 409 and 'IP' in result.json()['detail']
