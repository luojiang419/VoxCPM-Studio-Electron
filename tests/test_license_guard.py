import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
import time

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

spec = importlib.util.spec_from_file_location('studio_license', Path(__file__).resolve().parents[1]/'backend/voxcpm/studio_license.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@pytest.fixture
def guard(tmp_path):
    key=Ed25519PrivateKey.generate()
    config={'enabled':True,'serverUrl':'https://admin.ee2x.cn','appId':'jvox-studio','publicKey':key.public_key().public_bytes(Encoding.Raw,PublicFormat.Raw).hex()}
    conf=tmp_path/'config.json';conf.write_text(json.dumps(config))
    bridge=tmp_path/'session.json'
    def write(**overrides):
        p={'schema':1,'issuer':config['serverUrl'],'appId':'jvox-studio','deviceId':'device','kind':'trial','active':True,'issuedAt':time.time(),'trialExpiresAt':time.time()+86400,'leaseUntil':time.time()+3600,**overrides}
        raw=json.dumps(p);envelope={'payload':raw,'signature':key.sign(raw.encode()).hex()}
        state=json.dumps({'license':envelope,'deviceId':'device','serverTime':time.time(),'wallTime':time.time()})
        bridge.write_text(json.dumps({'payload':state,'mac':hmac.new(b'secret',state.encode(),hashlib.sha256).hexdigest()}))
    return module.LicenseGuard(conf,bridge,'secret'),write,bridge


def test_guard_fail_closed_and_signature(guard):
    g,write,file=guard
    with pytest.raises(HTTPException):g.require()
    write();g.require()
    raw=file.read_text().replace('trial','permanent');file.write_text(raw)
    with pytest.raises(HTTPException):g.require()


def test_config_cannot_disable_authorization(guard):
    g,_,_=guard
    g.config['enabled']=False
    with pytest.raises(HTTPException):g.require()


@pytest.mark.parametrize('override',[{'active':False},{'appId':'other'},{'trialExpiresAt':0},{'leaseUntil':0}])
def test_guard_denies_unauthorized(guard,override):
    g,write,_=guard;write(**override)
    with pytest.raises(HTTPException) as error:g.require()
    assert error.value.status_code==403


def test_api_gate_protects_creation_allows_existing_works(guard):
    g,write,_=guard
    app=FastAPI();module.install_gate(app,g)
    @app.post('/api/music/generate')
    def generate():return {'created':True}
    @app.post('/api/files/save-as')
    def export():return {'exported':True}
    @app.get('/api/workspace/works')
    def works():return {'items':[]}
    with TestClient(app) as c:
        assert c.post('/api/music/generate').status_code==403
        assert c.post('/api/files/save-as').status_code==200
        assert c.get('/api/workspace/works').status_code==200
        write();assert c.post('/api/music/generate').status_code==200
        write(trialExpiresAt=0);assert c.post('/api/music/generate').status_code==403
