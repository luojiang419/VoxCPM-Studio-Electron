# VoxCPM / JVOX 开发者语音 API

版本：1.0.0；隔离演示验收日期：2026-10-21。

## 运行与连接

演示入口：

- H3 工作台：`http://127.0.0.1:8870/`。
- VoxCPM API 设置页：`http://127.0.0.1:8918/`，与 Electron 设置→开发者 API 使用同一个 React 组件。
- 开发者 API Base URL：`http://127.0.0.1:8848/v1`。
- 交互文档：`http://127.0.0.1:8848/docs`；规范：`http://127.0.0.1:8848/openapi.json`。

在 VoxCPM 设置→开发者 API 创建密钥，设置端口与监听范围，勾选启用并保存。配置立即应用，软件下次启动时自动恢复服务。VoxCPM 必须保持运行。所有生成使用当前桌面服务的模型实例与串行推理队列，不下载或复制模型、Python 或依赖。

仅本机模式监听 `127.0.0.1`；其他电脑调用时选择 `0.0.0.0`，将客户端 URL 的 `127.0.0.1` 替换为服务器局域网 IP，并确保系统允许对应端口的访问。独立公共端口不提供桌面的任意文件、设置、训练等管理接口。这里开放的是声音设计及两种声音克隆能力；音乐、视频及训练不属于此语音 API。

H3 设置→声音服务→添加 API，选“本机 VoxCPM / JVOX”，填写上面的 Base URL 和密钥，模型为 `voxcpm-2`，保存并选用；连接测试只查询模型，不执行生成。

## 鉴权与密钥

公共 API 支持无 Cookie 的跨源请求，浏览器开发者可显式携带 Bearer 密钥调用。除 `/health` 与交互文档外，下面所有接口都需要：

```http
Authorization: Bearer <API_KEY>
```

密钥管理支持独立名称、查看/复制、轮换、停用、删除，以及今日/累计生成提交次数、最后使用时间。Windows 下可还原密钥使用当前用户 DPAPI 加密保管，验证时使用 SHA-256；列表不返回明文。轮换立即使旧值失效，保留当前密钥 ID 对应的任务归属；删除后不能再通过该密钥读取历史结果。仅生成任务计入提交次数，查询/下载/重复请求复用不计数。

## 公共端点

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| GET | `/health` | 服务身份及就绪状态；不表示模型已加载 |
| GET | `/v1/models` | `data` 中包含 `voxcpm-2` |
| POST | `/v1/audio/speech` | 同步等待并直接返回 `audio/wav` |
| POST | `/v1/audio/generations` | HTTP 202，返回任务 ID 与状态路径 |
| GET | `/v1/audio/generations/{id}` | 查询任务状态与下载路径 |
| GET | `/v1/audio/generations/{id}/content` | 返回当前密钥的结果 WAV |
| POST | `/v1/audio/references` | 上传 WAV 二进制，HTTP 201，返回参考音 ID |

语音接口使用相同 JSON 请求：

| 字段 | 默认值 / 限制 | 说明 |
| --- | --- | --- |
| `model` | `voxcpm-2`，也接受 `VoxCPM2` | 本机声音模型 |
| `input` | 必填，1～3000 字符，不能为空白 | 要朗读的具体台词 |
| `instructions` | 空，最多 1200 字符 | 音色、音高、语速、口音和情绪要求，作为模型声音控制，不作为台词 |
| `mode` | `design` | `design` 声音设计；`clone` 可控克隆；`clone_prompt` 极致克隆 |
| `voice` | `design` | OpenAI 兼容保留字段；不选择远端命名音色。克隆使用 `reference_id` |
| `reference_id` | 空 | 克隆时必填，只能使用当前 Key 上传的参考音 ID；不接受服务器路径或远程 URL |
| `prompt_text` | 空，最多 3000 字符 | `clone_prompt` 必填，对应参考音的逐字文案；此模式不应用 `instructions` |
| `response_format` | `wav` | 当前只支持 WAV |
| `cfg_value` | 2，范围 1～5 | 模型引导参数 |
| `inference_timesteps` | 10，范围 4～50 | 模型推理步数 |

声音设计建议给出 40～100 字的自然试听文案；短台词同样可生成。首次调用需要加载和预热模型，耗时取决于硬件。语音模型用于人声，不用于环境音、音效或音乐。生成结果的音色与表达需要试听确认。

## 同步生成示例

安装了 `requests` 的任何客户端可调用，密钥通过环境变量提供：

```python
import os
from pathlib import Path
import requests

base = "http://127.0.0.1:8848/v1"
headers = {"Authorization": f"Bearer {os.environ['JVOX_API_KEY']}"}
r = requests.post(base + "/audio/speech", headers=headers, json={
    "model": "voxcpm-2",
    "input": "别害怕，孩子，外面的雨总会停的。先喝一口热茶，等天亮以后，我们一起去看那棵老树。",
    "instructions": "年长女性，温厚的中低音，普通话，语速舒缓，慈爱而坚定。",
    "mode": "design",
    "response_format": "wav"
}, timeout=660)
r.raise_for_status()
Path("reference.wav").write_bytes(r.content)
```

也可使用支持 `instructions` 的 OpenAI 兼容语音客户端；此服务只实现本文列出的兼容子集，不提供完整 OpenAI API 或流式输出。客户端请求同步接口时建议允许 660 秒，服务端最多等待 600 秒；超时后任务仍可能继续运行，应查询任务而非直接重新生成。

## 异步生成与批量

建议集成方使用异步接口，多个声音分别提交任务，由同一 GPU 队列执行：

```python
import os
import time
import uuid
from pathlib import Path
import requests

origin = "http://127.0.0.1:8848"
headers = {
    "Authorization": f"Bearer {os.environ['JVOX_API_KEY']}",
    "Idempotency-Key": "my-project-voice-" + uuid.uuid4().hex,
}
r = requests.post(origin + "/v1/audio/generations", headers=headers, json={
    "input": "奶奶，这雨会一直下吗？我有一点害怕。",
    "instructions": "清亮童声，普通话，轻声担忧，带一点犹豫。"
}, timeout=30)
r.raise_for_status()
job = r.json()
while True:
    r = requests.get(origin + job["status_url"], headers=headers, timeout=30)
    r.raise_for_status()
    status = r.json()
    if status["status"] == "completed":
        audio = requests.get(origin + status["audio_url"], headers=headers, timeout=60)
        audio.raise_for_status()
        Path("child.wav").write_bytes(audio.content)
        break
    if status["status"] in {"failed", "cancelled", "interrupted"}:
        raise RuntimeError(status)
    time.sleep(1)
```

状态为 `queued`、`running`、`completed`、`failed` 或 `interrupted`。任务 ID、归属与已完成文件路径持久化；服务重启后已完成结果仍可查询和下载，未完成推理标记为 `interrupted`，不自动重复生成。需要重新生成时使用新的请求标识。

可选请求头 `Idempotency-Key` 最长 128 字符，同一 Key 下相同标识及相同参数复用原任务；参数不同返回 409。它对同步与异步接口都生效。请求超时后保留原标识并重试，可避免重复推理。H3 自动使用持久化任务 ID 作为此标识，并记录提交时选择的声音服务配置。

同时等待中的开发者生成任务最多 16 个，超过返回 429；不限制已完成历史数。声音任务与桌面任务共用推理队列，运行顺序以入队顺序为准。

## 参考音克隆

上传 1～30 秒、最大 20 MB、单声道或双声道的有效 WAV。请求体直接放文件内容，不是 multipart 表单：

```python
with open("reference.wav", "rb") as f:
    r = requests.post(base + "/audio/references", headers={
        **headers, "Content-Type": "audio/wav"
    }, data=f, timeout=60)
r.raise_for_status()
reference_id = r.json()["id"]

r = requests.post(base + "/audio/speech", headers=headers, json={
    "input": "雨已经停了，我们一起出去看看吧。",
    "mode": "clone",
    "reference_id": reference_id,
    "instructions": "语气轻松，带一点微笑。"
}, timeout=660)
r.raise_for_status()
Path("cloned.wav").write_bytes(r.content)
```

如需极致克隆，改用 `mode="clone_prompt"` 并提供参考 WAV 的准确 `prompt_text`；此模式沿用模型原有行为，不使用声音控制描述。参考音与生成任务按密钥 ID 隔离，另一密钥无法读取或引用。

## 错误与管理接口

| HTTP 状态 | 含义 |
| --- | --- |
| 401 | 缺少、失效或已停用的密钥 |
| 403 | 非本机或跨站访问管理接口 |
| 404 | 任务/参考音不存在或不属于当前 Key |
| 409 | 任务未完成、重复标识参数冲突、名称冲突或服务端口占用 |
| 410 | 完成结果已被移走或删除 |
| 413 | 参考文件超过限制 |
| 422 | 空白台词、格式、模式或参数不符合约束 |
| 429 | 开发者生成队列已满 |
| 502 / 504 | 推理失败 / 同步等待超时，运行日志提供详细原因 |

设置页使用本机控制端口的接口：`GET/PUT /api/access`、`GET/POST /api/access/keys`、`GET /api/access/keys/{id}/secret`、`POST /api/access/keys/{id}/rotate`、`POST /api/access/keys/{id}/disable`、`DELETE /api/access/keys/{id}`。这些路径不在 8848 公共服务中提供。管理仅接受本机连接与本机 Host/同源访问；Electron 的 `Origin:null` 还需要主进程生成的每次启动管理令牌，该令牌不属于开发者 API Key。

H3 内部新增 `POST /api/jobs/voice-design`，请求 `{name, text, instructions}`；通过原有 `/api/jobs/{id}` 查询。完成结果包含媒体 `id`、`url`、声音名称、台词与需求，前端入库并按所属工程绑定。取消等待不强杀 VoxCPM 正在执行的 GPU 推理；可在 VoxCPM 作品记录核对已完成音频。

## H3 音频设计工作区与 AI 优化

声音资产页左侧是输入工作区，已入库声音只在右侧展示。可上传音频并直接入库，也可输入自己的理解与试听台词，生成新声音；选择/上传参考音后使用可控克隆生成新参考音。原音频与原声音资产保留，生成不会覆盖参考源。

设置→API配置→声音服务提供 **AI优化声音设计** 开关，默认开启并保存偏好。开启后使用当前动作规划 API 作为文本 AI 助手，仅整理表达与格式；不新增人物身份、性别、年龄、口音、情绪等未经用户要求的设定。原始需求与试听台词始终保留；实际提交提示词可展开查看。关闭后不调用 AI、不检索资料，原描述直接提交。

程序每24小时检索 OpenBMB/VoxCPM 官方仓库的 SKILL.md 候选及官方文档。2026-10-21 官方仓库尚无独立 SKILL.md，因此使用官方 Voice Design / Controllable Cloning 指引；网络不可用时使用已验证文档规则快照，不虚构技能来源。整理遵循 `(控制描述)原始台词`，括号封装由 VoxCPM 服务完成。

关键数值、否定、性别、口音、程度等明确约束有保守校验，未通过时沿用原描述；AI 请求失败时保留输入并显示错误，可重试或关闭开关后生成。已整理结果按原需求、台词、模式、指导版本和文本模型缓存，预览后生成通常无需重复调用 AI。生成任务保存整理结果及远端参考ID，恢复任务不会重新改写提示词或重复上传参考音。

H3 本机接口（8870端口，区别于VoxCPM公共8848端口）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/voice/guidance` | 官方资料来源、版本、检索时间；`refresh=true`可手动更新 |
| POST | `/api/voice/prepare` | 预览优化结果，不执行声音生成 |
| POST | `/api/jobs/voice-design` | 整理需求、生成及处理音频的持久化任务 |

两个POST共用请求字段：`name`、`text`、`instructions`，以及可选的 `reference_media_id`（H3媒体ID）、`ai_optimize`（默认true）、`speed`（0.6～1.6，默认1）、`pitch`（-6～6半音，默认0）。UI按开关状态明确传入 `ai_optimize`，批量补齐也遵循开关。仅上传入库不需要这些生成参数。

`speed`和`pitch`由H3使用FFmpeg处理生成结果，实现明确的数值变速/移调，不是VoxCPM原生数值参数。文字描述中的自然音色、音高感、语速和表达仍由模型理解。参考音自动转为16kHz单声道WAV，最长使用前30秒；原上传媒体不修改。

人物创建与编辑页均可上传或从声音库选择。选择时保存声音资产ID及媒体ID，保存人物资料后生效；项目选角继续复用原有声音引用链路。重新上传会切换为独立媒体；声音库条目的音频被编辑替换时，绑定人物跟随更新，项目手动覆盖保留。删除声音库条目保留人物已经引用的媒体，避免丢失声音。

## 本次实测

H3 页面真实生成“林奶奶 · 温柔安慰”12.48 秒、“小禾 · 参考声线”4.64 秒，均为 48 kHz 单声道 WAV。奶奶已有音频后，批量补齐只提交小禾一项；小禾结果自动入库、绑定人物并可播放。相同任务标识再次提交复用已完成结果，未新增推理。另用独立 Python 客户端上传奶奶参考 WAV，真实生成 2.88 秒克隆音频，并验证服务重启后的设置、密钥与结果可恢复。模型路径为原安装目录的 `models/openbmb__VoxCPM2`，依赖为原安装 Python；演示数据与原工程隔离。


继续开发实测：开启AI、使用奶奶参考音和自然语言需求，生成6.942秒WAV，语速1.1倍、音调+1半音；关闭AI后原文直传生成2.4秒。仅上传入库、人物创建选库、编辑改选、重新上传及刷新恢复均通过；演示最后恢复AI开关为开启。详细验证记录在开发任务/085-VoxCPM声音设计API隔离演示.md。
