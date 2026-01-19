# koishi-plugin-hass

[![npm](https://img.shields.io/npm/v/koishi-plugin-hass?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-hass)

监控homeassistant实体状态变化并支持自定义触发命令进行查询或推送

## 安装

```bash
npm i koishi-plugin-hass
```

或在 Koishi 控制台的插件市场中安装。

## 配置

最小配置（只用于手动查询）：

```yaml
plugins:
  hass:
    apiUrl: https://ha.example.org
    accessToken: your_long_lived_token
```

启用轮询规则与通知示例：

```yaml
plugins:
  hass:
    apiUrl: https://ha.example.org
    accessToken: your_long_lived_token
    syncOnStart: true
    pollingEnabled: true
    pollingIntervalSec: 30
    notifyChannels:
      - platform: sandbox
        channelId: 123456
    alertRules:
      - enabled: true
        entity: sensor.battery_level
        operator: lt
        value: 20
        message: "电池过低：{name} 当前 {state}"
```

消息触发回复（多实体）示例：

```yaml
plugins:
  hass:
    apiUrl: https://ha.example.org
    accessToken: your_long_lived_token
    messageReplies:
      - enabled: true
        trigger: 状态
        entities:
          - key: 电池
            entity: sensor.battery_level
          - key: 屏幕
            entity: binary_sensor.screen
        reply: "电池{电池}，屏幕{屏幕}"
```

## 配置项说明

- apiUrl: Home Assistant API 地址（不带尾部斜杠）
- accessToken: Home Assistant 长期访问令牌
- defaultEntities: hass 命令未指定实体时使用的默认列表
- syncOnStart: 启动时自动同步实体列表（等价于执行 `hass.sync`）
- requestTimeoutSec: 请求超时（秒）
- pollingEnabled: 是否启用轮询触发规则
- pollingIntervalSec: 轮询间隔（秒）
- notifyChannels: 通知目标列表
  - platform: 适配器平台名（如 telegram/discord/qq/sandbox）
  - channelId: 频道 ID（平台内唯一）
  - guildId: 群组/服务器 ID（部分平台需要）
- alertRules: 条件规则列表
  - enabled: 是否启用
  - entity: 监控的实体
  - operator: 条件（gt/gte/lt/lte/eq/neq/changed）
  - value: 比较值（状态变化可留空）
  - message: 触发通知内容
- messageReplies: 消息触发回复列表
  - enabled: 是否启用
  - trigger: 触发消息（完全匹配）
  - entities: 实体列表（在回复中用 {占位名} 引用）
  - reply: 回复内容模板

## 占位符

规则通知（alertRules）支持：
- `{name}` 实体名称（friendly_name）
- `{entity}` 实体 ID
- `{state}` 当前状态
- `{prev}` 上一次状态（仅状态变化）
- `{value}` 比较值

消息回复（messageReplies）支持：
- `{占位名}`：只替换为该实体的 `state`（状态值）
- `{name}` `{entity}` `{state}`：仅当有实体时可用（默认取第一个实体）

## 命令

- `hass.sync`：同步实体列表（写入缓存并刷新下拉）
- `hass.schema`：查看实体 schema 同步状态（调试）
- `hass [entity]`：查询实体状态，未指定时使用 `defaultEntities` 的第一个

## 平台与通知

`notifyChannels` 需要指定平台是因为频道 ID 在不同平台可能重复，且需要知道用哪个 bot 发送。  
插件会在运行时读取 `ctx.bots`，匹配平台后发送通知。

如果只使用一个平台，也可以只填写该平台的频道 ID 列表。

## 依赖与注意事项

- 必需：`http` 插件（用于请求 Home Assistant API）
- 建议：至少启用一个适配器 bot（用于发送通知）
- 动态实体下拉依赖控制台（console）服务刷新


## FAQ

1) 为什么看不到实体列表？
- 先运行 `hass.sync` 或开启 `syncOnStart`。

2) 为什么通知没有发送？
- 检查 `pollingEnabled` 与 `pollingIntervalSec`；
- 确保 `notifyChannels` 填了正确的平台与频道 ID；
- 检查实体状态是否满足条件。

3) `{占位名}` 显示的是什么？
- 显示该实体的 `state`（状态值），不是名称。
