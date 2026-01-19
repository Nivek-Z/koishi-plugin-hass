import { Context, Schema } from 'koishi'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const name = 'hass'
export const inject = { required: ['http'], optional: ['console'] }

export interface Config {
  // Home Assistant API 地址（不带尾部斜杠）
  apiUrl: string
  // Home Assistant 长期访问令牌
  accessToken: string
  // hass 命令未指定实体时使用的默认实体列表
  defaultEntities: string[]
  // 启动时自动同步实体列表（等价于自动执行 hass.sync）
  syncOnStart: boolean
  // 请求超时（秒）
  requestTimeoutSec: number
  // 是否启用轮询触发规则
  pollingEnabled: boolean
  // 轮询间隔（秒）
  pollingIntervalSec: number
  // 满足条件时发送通知
  alertRules: AlertRule[]
  // 通知发送到哪些频道
  notifyChannels: NotifyChannel[]
  // 收到消息后触发的回复规则
  messageReplies: MessageReply[]
}

interface HassState {
  entity_id: string
  state: string
  attributes?: {
    friendly_name?: string
    unit_of_measurement?: string
  }
}

const CACHE_FILE = path.join('data', 'hass_cache.json')
const ENTITIES_SCHEMA_NAME = 'hass.entities'
const ENTITY_SCHEMA_NAME = 'hass.entity'
const ENTITIES_DESCRIPTION = '选择要监听/查询的实体（先运行 hass.sync）'
const RULES_DESCRIPTION = '满足条件时发送提示（支持 {name} {entity} {state} {prev} {value}）'

type RuleOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'changed'

export interface AlertRule {
  enabled: boolean
  entity: string
  operator: RuleOperator
  value?: string | number
  message: string
}

export interface NotifyChannel {
  platform: string
  channelId: string
  guildId?: string
}

export interface MessageReply {
  enabled: boolean
  trigger: string
  // {占位名} 只替换为实体 state（状态值）
  entities: ReplyEntity[]
  reply: string
}

export interface ReplyEntity {
  // 占位名会在回复模板中以 {占位名} 的形式使用
  key: string
  // 被查询的实体 ID
  entity: string
}

function getCachePath(ctx?: Context) {
  const baseDir = ctx?.app?.baseDir || process.cwd()
  return path.resolve(baseDir, CACHE_FILE)
}

async function readCache(ctx?: Context): Promise<string[]> {
  try {
    const content = await readFile(getCachePath(ctx), 'utf8')
    const parsed = JSON.parse(content)
    if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === 'string')
  } catch {
    // ignore cache errors and return empty list
  }
  return []
}

async function writeCache(ctx: Context, entities: string[]) {
  const filePath = getCachePath(ctx)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(entities, null, 2), 'utf8')
}

function buildEntitiesSchema(entities: string[]) {
  const inner = Schema.union(entities.map((value) => Schema.const(value)))
  const base = Schema.array(inner)
    .description(ENTITIES_DESCRIPTION)
    .default([])
  base.meta = { ...base.meta, role: 'select' }
  return base
}

function buildEntitySchema(entities: string[]) {
  const base = Schema.union(entities.map((value) => Schema.const(value)))
    .description(ENTITIES_DESCRIPTION)
  base.meta = { ...base.meta, role: 'select' }
  return base
}

function updateEntitiesSchema(ctx: Context, entities: string[]) {
  ctx.schema.set(ENTITIES_SCHEMA_NAME, buildEntitiesSchema(entities))
  ctx.schema.set(ENTITY_SCHEMA_NAME, buildEntitySchema(entities))
  ctx.get('console')?.refresh('schema')
}

function normalizeEndpoint(endpoint: string) {
  return endpoint.replace(/\/+$/, '')
}

async function requestStates(ctx: Context, config: Config): Promise<HassState[]> {
  const base = normalizeEndpoint(config.apiUrl)
  const url = `${base}/api/states`
  const timeout = Math.max(1, config.requestTimeoutSec || 10) * 1000
  return ctx.http.get(url, {
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    timeout,
  })
}

async function syncEntities(ctx: Context, config: Config) {
  const states = await requestStates(ctx, config)
  const entities = states
    .map((s) => s.entity_id)
    .filter((id) => typeof id === 'string')
    .sort()
  await writeCache(ctx, entities)
  updateEntitiesSchema(ctx, entities)
  return entities
}

async function requestState(ctx: Context, config: Config, entityId: string): Promise<HassState> {
  const base = normalizeEndpoint(config.apiUrl)
  const url = `${base}/api/states/${encodeURIComponent(entityId)}`
  const timeout = Math.max(1, config.requestTimeoutSec || 10) * 1000
  return ctx.http.get(url, {
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    timeout,
  })
}

function formatState(state: HassState) {
  const name = state.attributes?.friendly_name || state.entity_id
  const unit = state.attributes?.unit_of_measurement || ''
  const value = unit ? `${state.state} ${unit}` : state.state
  return `${name}: ${value}`
}

function formatRequestError(error: any) {
  const status = error?.response?.status
  const statusText = error?.response?.statusText
  if (status) {
    return `HTTP ${status}${statusText ? ` ${statusText}` : ''}`
  }
  if (error?.code) return `网络错误：${error.code}`
  if (error?.message) return `错误：${error.message}`
  return '未知错误'
}

async function sendToTargets(ctx: Context, config: Config, content: string) {
  const targets = (config.notifyChannels || [])
    .filter((target) => target.platform && target.channelId)
  if (!targets.length) return

  await Promise.all(targets.map(async (target) => {
    const bots = ctx.bots.filter((bot) => bot.platform === target.platform)
    if (!bots.length) {
      ctx.logger('hass').warn(`未找到平台 ${target.platform} 的 bot`)
      return
    }
    await Promise.all(bots.map(async (bot) => {
      try {
        await bot.sendMessage(target.channelId, content, target.guildId)
      } catch (error) {
        ctx.logger('hass').warn(`发送失败：${target.platform}:${target.channelId} ${formatRequestError(error)}`)
      }
    }))
  }))
}

function formatRuleMessage(rule: AlertRule, state: HassState, prevState?: string) {
  const name = state.attributes?.friendly_name || state.entity_id
  const template = rule.message?.trim()
  const fallback = rule.operator === 'changed'
    ? `HASS 状态变化：${name} 从 ${prevState ?? '-'} 变为 ${state.state}`
    : `HASS 提示：${name} 当前状态为 ${state.state}`
  const raw = template || fallback
  return raw.replace(/\{([^}]+)\}/g, (_, key) => {
    switch (key) {
      case 'name':
        return name
      case 'entity':
        return state.entity_id
      case 'state':
        return state.state
      case 'prev':
        return prevState ?? ''
      case 'value':
        return rule.value == null ? '' : String(rule.value)
      default:
        return ''
    }
  })
}

function evaluateRule(rule: AlertRule, state: HassState, prevState?: string) {
  if (!rule.enabled) return false
  const current = state.state
  switch (rule.operator) {
    case 'changed':
      return prevState !== undefined && current !== prevState
    case 'eq':
      return current === String(rule.value ?? '')
    case 'neq':
      return current !== String(rule.value ?? '')
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const left = toNumber(current)
      const right = toNumber(String(rule.value ?? ''))
      if (left === null || right === null) return false
      if (rule.operator === 'gt') return left > right
      if (rule.operator === 'gte') return left >= right
      if (rule.operator === 'lt') return left < right
      return left <= right
    }
    default:
      return false
  }
}

function toNumber(value: string): number | null {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

const entitiesDynamicSchema = Schema.dynamic(ENTITIES_SCHEMA_NAME)
entitiesDynamicSchema.meta = {
  ...entitiesDynamicSchema.meta,
  role: 'dynamic',
  extra: { name: ENTITIES_SCHEMA_NAME },
  description: ENTITIES_DESCRIPTION,
  default: [],
}

const entityDynamicSchema = Schema.dynamic(ENTITY_SCHEMA_NAME)
entityDynamicSchema.meta = {
  ...entityDynamicSchema.meta,
  role: 'dynamic',
  extra: { name: ENTITY_SCHEMA_NAME },
  description: ENTITIES_DESCRIPTION,
}

function formatReplyMessage(rule: MessageReply, states: Map<string, HassState>) {
  const primary = states.values().next().value as HassState | undefined
  const template = rule.reply?.trim()
  const fallback = primary
    ? `${primary.attributes?.friendly_name || primary.entity_id}: ${primary.state}`
    : ''
  const raw = template || fallback
  return raw.replace(/\{([^}]+)\}/g, (_, key) => {
    const state = states.get(key)
    if (state) return state.state
    if (!primary) return ''
    switch (key) {
      case 'name':
        return primary.attributes?.friendly_name || primary.entity_id
      case 'entity':
        return primary.entity_id
      case 'state':
        return primary.state
      default:
        return ''
    }
  })
}

const ConfigSchema = Schema.object({
  apiUrl: Schema.string().description('Home Assistant API 地址（不带尾部斜杠）'),
  accessToken: Schema.string().role('secret').description('Home Assistant 长期访问令牌'),
  defaultEntities: entitiesDynamicSchema.description('hass 命令未指定实体时使用的默认列表'),
  syncOnStart: Schema.boolean().default(false).description('启动时自动同步实体列表（等价于执行 hass.sync）'),
  requestTimeoutSec: Schema.number().default(10).min(1).description('请求超时（秒）'),
  pollingEnabled: Schema.boolean().default(false).description('启用轮询触发规则'),
  pollingIntervalSec: Schema.number().default(60).min(10).description('轮询间隔（秒）'),
  notifyChannels: Schema.array(Schema.object({
    platform: Schema.string().description('适配器平台名（如 telegram/discord/qq/sandbox）'),
    channelId: Schema.string().description('频道 ID（平台内唯一）'),
    guildId: Schema.string().description('群组/服务器 ID（部分平台需要）').required(false),
  })).role('table').default([]).description('通知目标（仅发送到这些频道）'),
  messageReplies: Schema.array(Schema.object({
    enabled: Schema.boolean().default(true).description('启用'),
    trigger: Schema.string().description('收到消息内容（完全匹配）'),
    entities: Schema.array(Schema.object({
      key: Schema.string().description('占位名（如 电池/屏幕）'),
      entity: entityDynamicSchema,
    })).role('table').default([]).description('实体列表（在回复中用 {占位名} 引用；只替换 state）'),
    reply: Schema.string().role('textarea').description('回复内容（支持 {name} {entity} {state} 或 {占位名}）'),
  })).role('table').default([]).description('消息触发回复'),
  alertRules: Schema.array(Schema.object({
    enabled: Schema.boolean().default(true).description('启用'),
    entity: entityDynamicSchema.description('被监控的实体'),
    operator: Schema.union([
      Schema.const('gt').description('大于'),
      Schema.const('gte').description('大于等于'),
      Schema.const('lt').description('小于'),
      Schema.const('lte').description('小于等于'),
      Schema.const('eq').description('等于'),
      Schema.const('neq').description('不等于'),
      Schema.const('changed').description('状态变化'),
    ]).default('changed').description('条件'),
    value: Schema.union([Schema.number(), Schema.string()]).description('比较值（状态变化可留空）'),
    message: Schema.string().role('textarea').description(RULES_DESCRIPTION),
  })).role('table').default([]).description('条件规则'),
})

export const Config = ConfigSchema

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('hass')
  const lastStates = new Map<string, string>()

  void (async () => {
    const cached = await readCache(ctx)
    updateEntitiesSchema(ctx, cached)
  })()

  if (config.syncOnStart) {
    void (async () => {
      try {
        const entities = await syncEntities(ctx, config)
        if (entities.length) {
          logger.info(`自动同步成功：${entities.length} 个实体`)
        }
      } catch (error) {
        const status = error?.response?.status
        if (status === 401) {
          logger.warn('自动同步失败：认证失败，请检查 accessToken')
        } else {
          logger.warn(`自动同步失败：${formatRequestError(error)}`)
        }
      }
    })()
  }

  ctx.command('hass.sync', '同步 HASS 实体列表')
    .action(async () => {
      try {
        const entities = await syncEntities(ctx, config)
        return `已同步 ${entities.length} 个实体`
      } catch (error) {
        const status = error?.response?.status
        if (status === 401) return '认证失败：请检查 accessToken'
        return `同步失败：${formatRequestError(error)}`
      }
    })

  ctx.command('hass.schema', '查看实体 schema 同步状态')
    .action(() => {
      const schema = ctx.schema._data[ENTITIES_SCHEMA_NAME]
      if (!schema) return 'schema 未注册'
      const json = JSON.parse(JSON.stringify(schema))
      const array = json?.refs?.[json.uid]
      const union = array?.inner ? json?.refs?.[array.inner] : null
      const count = Array.isArray(union?.list) ? union.list.length : 0
      return `schema 已注册，选项数：${count}`
    })

  ctx.command('hass [entity]', '查询 HASS 实体状态')
    .action(async (_, entity) => {
      const target = entity || config.defaultEntities?.[0]
      if (!target) return '请提供实体 ID 或先在配置中选择实体'
      try {
        const state = await requestState(ctx, config, target)
        return formatState(state)
      } catch (error) {
        const status = error?.response?.status
        if (status === 401) return '认证失败：请检查 accessToken'
        if (status === 404) return `未找到实体：${target}`
        return `查询失败：${formatRequestError(error)}`
      }
    })

  ctx.middleware(async (session, next) => {
    const content = session.stripped?.content?.trim()
    if (!content) return next()
    const rules = config.messageReplies || []
    if (!rules.length) return next()

    for (const rule of rules) {
      if (!rule.enabled || !rule.trigger) continue
      if (rule.trigger.trim() !== content) continue
      const entries = (rule.entities || [])
        .filter((entry) => entry.key && entry.entity)
      if (!entries.length) return next()
      try {
        const uniqueEntities = Array.from(new Set(entries.map((entry) => entry.entity)))
        const entityStates = new Map<string, HassState>()
        await Promise.all(uniqueEntities.map(async (entityId) => {
          entityStates.set(entityId, await requestState(ctx, config, entityId))
        }))

        const statesByKey = new Map<string, HassState>()
        for (const entry of entries) {
          const state = entityStates.get(entry.entity)
          if (state) statesByKey.set(entry.key, state)
        }

        await session.send(formatReplyMessage(rule, statesByKey))
      } catch (error) {
        const status = error?.response?.status
        if (status === 401) return session.send('认证失败：请检查 accessToken')
        if (status === 404) return session.send('未找到实体')
        return session.send(`查询失败：${formatRequestError(error)}`)
      }
      return
    }

    return next()
  })

  if (config.pollingEnabled) {
    ctx.setInterval(async () => {
      logger.info('轮询开始')
      const ruleEntities = (config.alertRules || [])
        .filter((rule) => rule.enabled && typeof rule.entity === 'string' && rule.entity)
        .map((rule) => rule.entity)
      const targets = new Set<string>(ruleEntities)
      if (!targets.size) return

      try {
        const states = await requestStates(ctx, config)
        const stateMap = new Map(states.map((state) => [state.entity_id, state]))
        logger.info(`轮询完成，收到 ${states.length} 个实体`)

        for (const rule of config.alertRules || []) {
          if (!rule.enabled || !rule.entity) continue
          const state = stateMap.get(rule.entity)
          if (!state) continue
          const prevState = lastStates.get(rule.entity)
          if (evaluateRule(rule, state, prevState)) {
            logger.info(`规则触发：${rule.entity} ${rule.operator} ${rule.value ?? ''}`.trim())
            await sendToTargets(ctx, config, formatRuleMessage(rule, state, prevState))
          }
          lastStates.set(rule.entity, state.state)
        }
      } catch {
        // ignore transient errors during polling
      }
    }, config.pollingIntervalSec * 1000)
  }
}
