# 看板推进记录与存量迁移

项目左栏的「推进记录」，独立于任务看板和全局 Agent 状态。每条记录按 SQLite 提交序号显示来源、时间、原因与 applied/ignored/pending 状态；引用同一事件的 Agent 记录显示判断结果、实际工具调用和真实结果。操作失败显示回滚原因，不将提案当作执行完成。

远端同步、仓库事实与检查预约分别可查看。完整事件资料默认折叠，便于检查来源和因果 ID。列表支持任务筛选及基于 seq 的前后分页，不用时间戳分页以免漏掉同时发生的事件。

内部 `project.changed` 记录实际聚合变更，事件内发生的修改带对应 causeId；直接本地修改只记录发生的事实，不冒充群成员。状态、外部事实与 Agent 决定通过查询投影关联，保留现有单一数据库和事件体系。

## 存量兼容

启动时，对每个已有项目写入一次 `project.history.imported` 基线及持久标记。基线保留原任务状态、工单、负责人和 Issue 关联：

- 未明确 issueRole 的历史关联按 reference 解释，导入不会批量关闭历史 Issue。
- 未配置 deliveryMode 的历史任务继续按 report 交付，不追溯要求旧任务补 PR。
- 旧待验收迁移复用现有静默验收快照恢复入口；不会将缺少原始证据的历史状态包装为新完成事实。
- 已消费的事件、原工单、通知回执和未完成 Effects 均保留；导入不重放历史验收和群消息。
- 基线、标记同事务提交；重启反复恢复不会重复导入。

用原状态目录启动可继续现有项目。备份和升级步骤见[部署与运维](../deployment.zh-CN.md)。

## 默认配置与查询

审计事件是内部事实，不提供可关闭或改写的 JSON 行为，以免业务记录丢失。现有默认统一配置 `{"sources":{},"on":{}}` 即可使用。GitHub 的 Issue、PR 与评论事件共用该来源的默认 JSON。 [仓库事件](repository.zh-CN.md)

`GET /orchestrator/api/projects/:id/history?before=<seq>` 返回 entries、next、notifications、synchronization、remote、checks。每页最多 100 条，next 为下一页游标；同一项目的 agent-runs 与 events 查询接口保持兼容。

通知从当前事件或 Agent run 显式携带项目因果标识，并展示 Outbox 的实际 pending/sent/dropped 回执；不以群 ID 猜测归属。sent 只表示发送接口接受，不能证明客户端已读。迁移不会根据旧消息补造这些关联。

## 日常查看和容量维护

打开「推进记录」，点顶部的待人工答复、待验收、待发送或同步失败可直接查看对应记录。「活动时间线」按日期排列，按任务筛选后仍可翻阅较早的匹配记录。点开一条事件，查看实际状态、判断依据和来源。需要排查群消息或模型提案时，勾选「显示消息原文和 Agent 提案事件」。原始证据可能包含聊天文字、内部链接和工单证据，适合授权的管理者阅读。

「推进记录 → 项目统计」每分钟读取一次数据。`GET /orchestrator/api/projects/:id/history/statistics` 提供当前项目的事件总量、过去 7 天新增的数量和 JSON 字节数、各类型增量以及通知回执统计。JSON 字节数可用于查找主要增量来源。

在左侧总菜单打开「工作区记录」，可查看最近 50 条工单与最近 50 条未归属项目的事件。项目的「执行记录」显示从该项目发起或已关联到其任务的工单。

「工作区记录 → 存储」通过 `GET /orchestrator/api/projects/workspace/storage` 显示共享的 SQLite 主库、WAL、可复用页和磁盘可用空间。磁盘剩余小于 1 GiB 或 WAL 达到 64 MiB 时显示预警。

1. 磁盘紧张时，先腾出存储或扩容。确认热点事件类型后再评估是否要控制来源频率或归档。保持投递回执、未完成事件和去重依据可用。
2. WAL 持续增长时，先检查长时间读取和事务。安排维护窗口并正常停服务后，再核对 checkpoint 状态。由 SQLite 管理 `-wal` 和 `-shm` 文件。 [SQLite WAL 维护](https://sqlite.org/wal.html#avoiding_excessively_large_wal_files)
3. 主库持续增长时，先用 SQLite 在线备份生成可恢复副本并对副本运行 `PRAGMA quick_check`。只有在可复用页明显且确需回收文件空间时，才安排离线 `VACUUM`。它需要额外空间，最坏可达原主库大小的两倍。 [SQLite 备份](https://sqlite.org/backup.html) · [VACUUM](https://sqlite.org/lang_vacuum.html)
4. 需要长期设上限时，由团队先选保留周期和审计字段。保留事件 ID、序号、因果、业务结果和未完成状态，再把历史大正文移到受控归档。现有版本提供保留量统计，历史归档和清除需另行确认策略。
