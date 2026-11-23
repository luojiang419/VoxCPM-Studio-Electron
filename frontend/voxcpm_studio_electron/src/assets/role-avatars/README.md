# 角色头像资源

由用户确认使用 imgx（Shiying / gemini-3-pro-image-preview）生成，六种角色配色各 1 张，1:1、1K。白底、清晰面部、居中头肩像，统一细腻柔和的半写实插画，无文字或水印。

| 文件 | 配色 | 形象方向 |
| --- | --- | --- |
| warm-orange.webp | 暖橙 | 温暖亲切，柔和微笑 |
| moss-green.webp | 苔绿 | 温柔知性，安静亲和 |
| ochre-gold.webp | 赭金 | 沉稳专业，自信从容 |
| rose.webp | 玫瑰 | 清新灵动，明朗细腻 |
| terracotta.webp | 陶土 | 成熟厚重，平和可靠 |
| olive.webp | 橄榄 | 自然文艺，清爽松弛 |

界面使用 512×512 WebP，六张合计约 230 KiB。原始 1024×1024 JPEG 保存在 originals/，随源码纳入 Git，不进入前端发布包。完整提示词、原始图片路径及生成记录见 generation.json；API 原始输出与 manifest 保存在 builds/role-avatar-generation/，其中陶土首轮发生 HTTP 500，单独重试后成功，重试记录位于 terracotta-retry/。

role-appearance.ts 为颜色、名称和头像的唯一映射入口。角色使用当前显示颜色决定头像，历史颜色沿用已有兼容映射。音色库使用音色 ID 稳定映射同组资源，避免筛选和排序时头像改变；不修改工程或音色的持久数据结构。
