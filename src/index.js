'use strict'

// koishi-plugin-fundraising-pk
// 参考 CoolQ 插件 me.cqp.lyt.grouppk（集资 PK 3.5）的功能重写。
// 原插件依赖私有鉴权与远端同步服务器，本插件在 Koishi 进程内完成计分与播报。

const fs = require('node:fs/promises')
const path = require('node:path')
const { Schema } = require('koishi')

const PLATFORM_LINK = {
  weidian: (id) => `https://weidian.com/item.html?itemID=${id}`,
  modian: (id) => `https://zhongchou.modian.com/item/${id}`,
  owhat: (id) => `https://m.owhat.cn/shop/shopdetail.html?id=${id}`,
  taoba: (id) => `https://www.taoba.club/#/pages/idols/detail?id=${id}`,
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

/* ---------------------------------- 工具 ---------------------------------- */

function walk(object, visitor, depth = 0) {
  if (!object || typeof object !== 'object' || depth > 10) return false
  for (const [key, value] of Object.entries(object)) {
    if (visitor(key, value)) return true
    if (value && typeof value === 'object' && walk(value, visitor, depth + 1)) return true
  }
  return false
}

function findNumber(object, keys) {
  let result
  walk(object, (key, value) => {
    if (!keys.some((candidate) => candidate.toLowerCase() === key.toLowerCase())) return false
    if (typeof value === 'number' && Number.isFinite(value)) {
      result = value
      return true
    }
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      result = Number(value)
      return true
    }
    return false
  })
  return result
}

function findString(object, keys) {
  let result
  walk(object, (key, value) => {
    if (!keys.some((candidate) => candidate.toLowerCase() === key.toLowerCase())) return false
    if (typeof value === 'string' && value.trim()) {
      result = value.trim()
      return true
    }
    return false
  })
  return undefined
}

function parseLooseJson(payload) {
  if (payload && typeof payload === 'object') return payload
  const text = String(payload ?? '')
  const firstBrace = text.indexOf('{')
  const firstBracket = text.indexOf('[')
  let start = firstBrace
  if (firstBracket >= 0 && (firstBrace < 0 || firstBracket < firstBrace)) start = firstBracket
  if (start < 0) throw new Error('响应中未找到 JSON 数据')
  const closing = text[start] === '{' ? '}' : ']'
  const end = text.lastIndexOf(closing)
  if (end <= start) throw new Error('响应中的 JSON 数据不完整')
  return JSON.parse(text.slice(start, end + 1))
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[^\d.-]/g, ''))
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function money(value) {
  return Number(value || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function parseTime(input) {
  if (!input) return null
  const parsed = Date.parse(String(input).trim().replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : null
}

function formatDuration(milliseconds) {
  if (milliseconds <= 0) return '00天00时00分00秒'
  const total = Math.floor(milliseconds / 1000)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(days)}天${pad(hours)}时${pad(minutes)}分${pad(seconds)}秒`
}

function parseChannel(channel) {
  if (channel.includes(':')) {
    const index = channel.indexOf(':')
    return { platform: channel.slice(0, index), id: channel.slice(index + 1) }
  }
  return { platform: '', id: channel }
}

/* ------------------------------- 数据抓取 -------------------------------- */

function buildUrl(project) {
  if (project.api) return project.api
  switch (project.platform) {
    case 'modian':
      return `https://zhongchou.modian.com/realtime/get_simple_product?ids=${encodeURIComponent(project.id)}`
    case 'owhat': {
      const data = JSON.stringify({ fk_goods_id: project.id })
      return `https://appo4.owhat.cn/api?client_id=3&cmd_m=findPricesAndStock&cmd_s=shop.price&v=1.6.1L&data=${encodeURIComponent(data)}`
    }
    case 'taoba':
      return `https://www.taoba.club/idols/detail?id=${encodeURIComponent(project.id)}`
    case 'weidian':
    default: {
      const data = JSON.stringify({ itemId: project.id })
      return `https://thor.weidian.com/detail/getItemSkuInfo/1.0?param=${encodeURIComponent(data)}`
    }
  }
}

function extractSnapshot(project, payload) {
  let amount
  let supporters
  let name

  const skus = payload?.result?.skuInfos || payload?.skuInfos
  if (Array.isArray(skus) && skus.length) {
    amount = 0
    supporters = 0
    for (const entry of skus) {
      const sku = entry?.skuInfo || entry
      const sold = toNumber(sku?.sold ?? sku?.sales ?? sku?.itemStock)
      const price = toNumber(sku?.discountPrice ?? sku?.price ?? sku?.itemDiscountHighPrice)
      amount += sold * price
      supporters += sold
    }
    name = findString(payload, ['title', 'name', 'itemName', 'skuTitle'])
  }

  const prices = payload?.data?.prices
  if (amount === undefined && Array.isArray(prices) && prices.length) {
    amount = 0
    supporters = 0
    for (const item of prices) {
      const price = toNumber(item?.pricestr ?? item?.price ?? item?.discountPrice)
      const sold = toNumber(item?.salestock ?? item?.sold ?? item?.sales)
      amount += price * sold
      supporters += sold
    }
    name = findString(payload, ['title', 'name', 'goodsName'])
  }

  if (amount === undefined) {
    amount = findNumber(payload, [
      'backer_money', 'backerMoney', 'total_amount', 'totalAmount',
      'donation', 'amount', 'money', 'sum',
    ])
  }
  if (supporters === undefined) {
    supporters = findNumber(payload, [
      'backer_count', 'backerCount', 'supporter_count', 'supporterCount',
      'backers', 'people', 'joinusers', 'count',
    ])
  }
  if (!name) name = findString(payload, ['name', 'title', 'projectName', 'itemName'])

  if (amount === undefined || !Number.isFinite(amount)) {
    throw new Error('未能从接口响应中解析出金额，请检查项目 ID 或配置自定义 api')
  }

  return { amount: Math.round(amount * 100) / 100, supporters: Math.max(0, Math.round(supporters ?? 0)), name, updatedAt: Date.now() }
}

async function request(ctx, url, headers, timeout) {
  // 优先使用 Koishi 的 http 服务（可统一配置代理/超时）；裸 Context 下回退到 Node 内置 fetch。
  if (ctx.http && typeof ctx.http.get === 'function') {
    return ctx.http.get(url, { headers, timeout: timeout * 1000 })
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout * 1000)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  } finally {
    clearTimeout(timer)
  }
}

async function fetchSnapshot(ctx, project, timeout) {
  const headers = { 'User-Agent': UA, Accept: '*/*' }
  if (project.cookie) headers.Cookie = project.cookie
  const response = await request(ctx, buildUrl(project), headers, timeout)
  return extractSnapshot(project, parseLooseJson(response))
}

/* --------------------------------- 插件主体 -------------------------------- */

const projectSchema = Schema.object({
  platform: Schema.union([
    Schema.const('weidian'), Schema.const('modian'),
    Schema.const('owhat'), Schema.const('taoba'),
  ]).description('众筹平台').default('weidian'),
  id: Schema.string().required().description('项目 / 商品 ID'),
  name: Schema.string().default('').description('项目备注名'),
  api: Schema.string().default('').description('可选：自定义接口地址'),
  cookie: Schema.string().role('secret').default('').description('可选：平台登录 Cookie'),
})

const Config = Schema.object({
  teams: Schema.array(Schema.object({
    name: Schema.string().required().description('队伍名称'),
    channels: Schema.array(Schema.string()).default([]).description('该队伍所在群，格式 platform:channelId'),
    projects: Schema.array(projectSchema).default([]).description('该队伍的集资项目'),
  })).default([]).description('PK 队伍列表，至少配置两队'),
  startTime: Schema.string().default('').description('开始时间，如 2026-11-25 20:00:00'),
  endTime: Schema.string().default('').description('结束时间，如 2026-11-26 20:00:00'),
  interval: Schema.number().min(10).default(60).description('轮询间隔（秒）'),
  summaryMinutes: Schema.number().min(0).default(0).description('战况自动播报间隔（分钟，0 表示关闭）'),
  admins: Schema.array(Schema.string()).default([]).description('管理员用户 ID'),
  autoNotice: Schema.boolean().default(true).description('自动播报开始/结束/领先变化'),
  requestTimeout: Schema.number().min(1).max(60).default(10).description('网络请求超时（秒）'),
})

exports.name = 'fundraising-pk'
exports.usage = '集资 PK 对抗插件。配置 teams / startTime / endTime 后自动计分播报；群内发送「pk」查看战况，「pk帮助」查看全部命令。'
exports.Config = Config

exports.apply = (ctx, config) => {
  const logger = ctx.logger('fundraising-pk')
  const statePath = path.join(ctx.baseDir || process.cwd(), 'fundraising-pk-state.json')
  const state = {
    snapshots: {},
    times: { start: config.startTime, end: config.endTime },
    autoNotice: config.autoNotice,
    flags: { started: false, ended: false },
    leader: '',
    lastSummary: 0,
  }
  let timer
  let started = false

  const isAdmin = (session) => config.admins.includes(session.userId)
  const projectKey = (project) => `${project.platform}:${project.id}`

  async function loadState() {
    try {
      const raw = JSON.parse(await fs.readFile(statePath, 'utf8'))
      if (raw && typeof raw === 'object') {
        state.snapshots = raw.snapshots || {}
        state.times = raw.times || state.times
        state.autoNotice = raw.autoNotice ?? config.autoNotice
        state.flags = raw.flags || state.flags
        state.leader = raw.leader || ''
        state.lastSummary = raw.lastSummary || 0
      }
    } catch {
      // 使用默认状态
    }
  }

  async function saveState() {
    try {
      await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')
    } catch (error) {
      logger.warn(`保存状态失败：${error.message}`)
    }
  }

  async function broadcast(text) {
    const channels = new Set(config.teams.flatMap((team) => team.channels))
    for (const channel of channels) {
      const { platform, id } = parseChannel(channel)
      const bot = ctx.bots.find((item) => item.platform === platform && item.status === 'online')
        || ctx.bots.find((item) => item.platform === platform)
        || (platform ? undefined : ctx.bots[0])
      if (!bot) {
        logger.warn(`未找到可发送消息的机器人：${channel}`)
        continue
      }
      try {
        await bot.sendMessage(id, text)
      } catch (error) {
        logger.warn(`发送消息到 ${channel} 失败：${error.message}`)
      }
    }
  }

  function board() {
    const rows = config.teams.map((team) => {
      let amount = 0
      let supporters = 0
      for (const project of team.projects) {
        const snapshot = state.snapshots[projectKey(project)]
        if (snapshot) {
          amount += snapshot.amount
          supporters += snapshot.supporters
        }
      }
      return { name: team.name, amount: Math.round(amount * 100) / 100, supporters }
    })
    return rows.sort((a, b) => b.amount - a.amount)
  }

  function countdown() {
    const start = parseTime(state.times.start)
    const end = parseTime(state.times.end)
    const now = Date.now()
    if (start && now < start) return `距离开始：${formatDuration(start - now)}`
    if (end && now < end) return `距离结束：${formatDuration(end - now)}`
    if (end) return 'PK已结束!下次努力!'
    return '未设置结束时间'
  }

  function formatBoard(withCountdown = true) {
    const rows = board()
    if (!rows.length) return '当前没有配置 PK 队伍，请在插件配置中添加 teams。'
    const lines = ['【集资 PK 战况】']
    rows.forEach((row, index) => {
      lines.push(`${index + 1}. ${row.name} —— ${money(row.amount)} 元 / ${row.supporters} 人`)
    })
    if (withCountdown) lines.push(countdown())
    return lines.join('\n')
  }

  function formatTeams() {
    if (!config.teams.length) return '当前没有配置 PK 队伍。'
    return config.teams.map((team, index) => {
      const projects = team.projects.map((project) => `${project.platform}:${project.id}${project.name ? `(${project.name})` : ''}`).join('，')
      return `${index + 1}. ${team.name}\n   项目：${projects || '无'}\n   播报群：${team.channels.join('，') || '无'}`
    }).join('\n\n')
  }

  async function poll() {
    const tasks = []
    for (const team of config.teams) {
      for (const project of team.projects) {
        tasks.push(
          fetchSnapshot(ctx, project, config.requestTimeout)
            .then((snapshot) => { state.snapshots[projectKey(project)] = snapshot })
            .catch((error) => logger.warn(`抓取 ${project.platform}:${project.id} 失败：${error.message}`)),
        )
      }
    }
    await Promise.allSettled(tasks)
    await saveState()

    const rows = board()
    const leader = rows[0]?.amount > 0 ? rows[0].name : ''
    if (state.autoNotice && leader && leader !== state.leader) {
      await broadcast(`【PK 战况】${leader} 暂时领先！\n${formatBoard(false)}`)
    }
    state.leader = leader

    const start = parseTime(state.times.start)
    const end = parseTime(state.times.end)
    const now = Date.now()
    if (state.autoNotice && start && now >= start && !state.flags.started) {
      state.flags.started = true
      await broadcast(`【PK 开始】激斗！塞纳河之夏！\n${formatBoard(false)}`)
    }
    if (state.autoNotice && end && now >= end && !state.flags.ended) {
      state.flags.ended = true
      await broadcast(`【PK 结束】${formatBoard(false)}\nPK已结束!下次努力!`)
    }
    if (config.summaryMinutes > 0 && start && end && now >= start && now < end
      && now - state.lastSummary >= config.summaryMinutes * 60 * 1000) {
      state.lastSummary = now
      await broadcast(formatBoard())
    }
    await saveState()
  }

  ctx.on('ready', async () => {
    if (started) return
    started = true
    await loadState()
    await poll()
    timer = ctx.setInterval(() => poll(), Math.max(10, config.interval) * 1000)
    logger.info(`集资 PK 已启动，共 ${config.teams.length} 支队伍`)
  })

  ctx.on('dispose', () => {
    if (timer) clearInterval(timer)
  })

  ctx.command('pk', '查看集资 PK 战况')
    .alias('PK').alias('Pk').alias('pK')
    .action(() => formatBoard())

  ctx.command('pk榜', '查看 PK 排名').alias('pk排行')
    .action(() => formatBoard(false))

  ctx.command('pk队伍', '查看 PK 队伍与项目配置')
    .action(() => formatTeams())

  ctx.command('pk刷新', '立即刷新 PK 数据（管理员）')
    .action(async ({ session }) => {
      if (!isAdmin(session)) return '您没有权限执行此命令。'
      await poll()
      return formatBoard()
    })

  ctx.command('pk时间 <start:string> <end:string>', '设置 PK 起止时间（管理员）')
    .action(async ({ session }, start, end) => {
      if (!isAdmin(session)) return '您没有权限执行此命令。'
      const startTime = parseTime(start)
      const endTime = parseTime(end)
      if (!startTime || !endTime || endTime <= startTime) return '时间格式错误，示例：pk时间 2026-11-25T20:00:00+08:00 2026-11-26T20:00:00+08:00'
      state.times = { start, end }
      state.flags = { started: false, ended: false }
      state.lastSummary = 0
      await saveState()
      return `PK 时间已设置为 ${new Date(startTime).toLocaleString('zh-CN')} 至 ${new Date(endTime).toLocaleString('zh-CN')}。`
    })

  ctx.command('pk开始', '立即开始 PK（管理员）')
    .action(async ({ session }) => {
      if (!isAdmin(session)) return '您没有权限执行此命令。'
      const now = Date.now()
      const end = parseTime(state.times.end)
      state.times = {
        start: new Date(now).toISOString(),
        end: end && end > now ? state.times.end : new Date(now + 3600_000).toISOString(),
      }
      state.flags = { started: false, ended: false }
      await saveState()
      await poll()
      return `PK 已开始。${countdown()}`
    })

  ctx.command('pk结束', '立即结束 PK（管理员）')
    .action(async ({ session }) => {
      if (!isAdmin(session)) return '您没有权限执行此命令。'
      state.times.end = new Date().toISOString()
      await saveState()
      await poll()
      return formatBoard()
    })

  ctx.command('pk通知 [action:string]', '开启/关闭自动播报（管理员）')
    .action(async ({ session }, action) => {
      if (!isAdmin(session)) return '您没有权限执行此命令。'
      if (action === 'on' || action === '开启') state.autoNotice = true
      else if (action === 'off' || action === '关闭') state.autoNotice = false
      else state.autoNotice = !state.autoNotice
      await saveState()
      return `自动播报已${state.autoNotice ? '开启' : '关闭'}。`
    })

  ctx.command('pk帮助', '查看 PK 插件命令')
    .action(() => [
      '集资 PK 插件命令：',
      '  pk / PK —— 查看战况与倒计时',
      '  pk榜 —— 仅查看排名',
      '  pk队伍 —— 查看队伍与项目配置',
      '  pk刷新 —— 立即刷新数据（管理员）',
      '  pk时间 <开始> <结束> —— 设置起止时间（管理员）',
      '  pk开始 / pk结束 —— 立即开始或结束（管理员）',
      '  pk通知 [on|off] —— 开关自动播报（管理员）',
    ].join('\n'))
}
