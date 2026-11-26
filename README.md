# @sxedward/koishi-plugin-fundraising-pk

跨群集资 PK 对抗插件，适用于 **Koishi v4**。功能参考 CoolQ 插件 `me.cqp.lyt.grouppk`（集资 PK 3.5）：多队伍、多平台项目汇总计分、倒计时、领先变化与开始/结束播报。计分完全在 Koishi 进程内完成，不依赖原插件的私有鉴权/同步服务器。

## 安装

将本目录放入 Koishi 工作区的 `plugins/` 下，或执行：

```bash
npm install @sxedward/koishi-plugin-fundraising-pk
```

旧包名 `koishi-plugin-fundraising-pk` 已弃用，请改用上面的新作用域包；Koishi 控制台可执行 `koishi add sxedward/koishi-plugin-fundraising-pk` 安装。

无需编译（CommonJS）。在 `koishi.yml` 中启用：

```yaml
plugins:
  fundraising-pk:
    admins:
      - 'onebot:10000'
    startTime: '2026-11-25T20:00:00+08:00'
    endTime: '2026-11-26T20:00:00+08:00'
    interval: 60
    summaryMinutes: 30         # 每 30 分钟自动播报战况，0 为关闭
    autoNotice: true
    teams:
      - name: '一组'
        channels:
          - 'onebot:111111111'
        projects:
          - platform: weidian
            id: '123456789'
            name: '一组微店'
      - name: '二组'
        channels:
          - 'onebot:222222222'
        projects:
          - platform: modian
            id: '12345'
            name: '二组摩点'
```

至少配置两队；每队可配置多个项目，金额与人数按队求和后排名。

## 命令

| 命令 | 说明 |
| --- | --- |
| `pk`（或 `PK` / `Pk` / `pK`） | 查看战况、排名与倒计时 |
| `pk榜` | 仅查看排名 |
| `pk队伍` | 查看队伍、项目和播报群配置 |
| `pk刷新` | 立即刷新数据（管理员） |
| `pk时间 <开始> <结束>` | 设置起止时间（管理员，ISO 8601 格式，见上例） |
| `pk开始` / `pk结束` | 立即开始 / 结束（管理员） |
| `pk通知 [on\|off]` | 开关自动播报，省略参数则切换（管理员） |
| `pk帮助` | 查看命令列表 |

## 行为说明

- 启动时静默抓取一次作为基线；此后每 `interval` 秒轮询。
- 领先队伍发生变化、到达开始/结束时间、`summaryMinutes` 到期时，自动向所有队伍的播报群发送消息；可用 `pk通知 off` 关闭。
- 运行状态保存在 Koishi 工作目录下的 `fundraising-pk-state.json`，重启后保留时间与领先状态。
- 平台接口可能调整：项目支持 `api` 字段覆盖请求地址、`cookie` 字段提供登录态。返回 JSON 中含 `amount` / `backer_money` / `donation` 与 `backer_count` / `people` 等字段即可解析。
- 如需与其他插件共用已抓取的数据，可同时安装 `koishi-plugin-weidian-monitor`；两个插件各自独立运行，互不依赖。

## 联系作者

- 邮箱：`sxedward@163.com`
- QQ：`827679511`
- GitHub：<https://github.com/sxedward>
- 问题反馈：<https://github.com/sxedward/sxedward-koishi-plugin-fundraising-pk/issues>
- 更新日志：[CHANGELOG.md](./CHANGELOG.md)
