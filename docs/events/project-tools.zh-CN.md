# 项目 Agent 工具

工具是服务端可执行的领域操作。模型从实时目录选择并组合调用；增加能力时注册工具及参数 Schema，无需增加消息关键词或意图分支。工具不直接调用远端网络，耗时副作用进入已有可靠动作队列。

| 工具 | 参数要点 | 结果 |
| --- | --- | --- |
| `project.inspect` | 空对象 | 当前项目、任务、工单报告、成员和团队目录 |
| `member.add` | `memberId`，目录中的现有成员 | 加入当前项目；重复加入不会重复建成员 |
| `task.create` | 标题及描述、验收条件、负责人、依赖等 | 新任务及其真实 ID，默认待办 |
| `task.update` | `taskId` 和 `changes` | 仅更新提供的字段，保留其他字段 |
| `project.update` | 名称、描述、目标、planning/active/paused 状态、autoAdvance 中至少一项 | 项目实际状态和目标 |
| `progress.record` | `taskId`、`summary`、可选 `blocker`、`links`、`corrects` | 追加实际进展和作者来源，可更正本人记录 |
| `tracking.request` | `taskId`、可选 `focus` | 启动对指定任务的一次只读检查，提醒以回执为准 |
| `conversation.mention` | `memberId`，当前项目的成员 ID | 按本条群消息的明确请求，为最终答复指定一名原生 @ 收件人；实际发送以回执为准 |
| `follow_up.schedule` | `taskId`、ISO UTC `at`、`reason` | 保存一次任务检查预约，替换该任务旧预约，时间范围 1 分钟至 30 天 |
| `follow_up.cancel` | `taskId` | 取消当前任务检查预约，包括撤销尚未落地的到期反应 |
| `runtime.inspect` | 无 | 核对实际运行能力、消息发送方式及最近发送结果，不能变更原生权限 |
| `conversation.preferences.inspect/update` | 无 / `revision`、`value` | 读取或保存会话的格式及风格偏好，独立于项目 |
| `task.start` | `taskId` | 把任务标为进行中，可和进展记录一起提交 |
| `task.stop` | `taskId` | 停止当前执行，保留历史 |
| `task.follow_up` | `taskId`、`text` | 向当前执行 Agent 传递补充信息 |
| `issue.create` | `taskId` | 为任务创建或取回 Issue，使用项目关联的仓库；远端完成后回写并通知 |
| `discussion.reply` | `taskId`、`url`、`text` | 向任务关联的 PR 或行讨论登记可靠回复，实际发送以回执为准 |
| `delivery.submit` | `taskId`、`summary`、可选 `links`；验收任务还需 `outcome` | 提交结果和证据，或提交对应交付版本的验收结论 |
| `review.decide` | `taskId`、`reviewId`、accepted/rejected、`reason` | 兼容按验收 ID 提交的已有入口 |

完整字段以 `GET /orchestrator/api/projects/tools` 返回的 JSON Schema 为准，与服务端校验共用定义。每个工具都重新检查项目身份；任务 ID 必须属于当前项目。正在执行的任务修改交付范围前须先停止执行。

例如，模型可在同一批次先 `member.add`，再通过 `task.update` 补充验收条件和分工。任何一步失败，整批回滚；模型下一轮看到真实错误再调整。需要先创建任务再启动时，下一轮从创建结果取得真实 ID，不能编造 ID。

`ownerId` 指向执行人。项目 Agent 可以作为成员加入项目，从同一负责人列表指派。验收使用一项关联到交付版本的任务，其负责人可以单独指派。

群里通过验收任务提交结论，由服务端按其负责人及交付版本校验。网页管理者代为提交时保留本地操作者和依据。

`execution.start` 是可选的运行能力。确实需要独立工作区、执行命令或续跑时，Agent 可按授权为原任务创建后台工单。通过现有资料就能完成的任务可以直接提交结果。

已有任务的旧分工和历史验收快照原样读取。新提交的结果会生成验收任务，旧任务有已知的验收分工时沿用到这项任务。旧工具提案继续按入队时的语义结算，升级无需改写 SQLite 数据。

本模块默认随项目 Agent 安装，无需新增环境变量或单独启用每个工具。消息事件的开关、默认指导与配置方法见[项目消息事件](communication.zh-CN.md)。项目 `autoAdvance` 作为自主跟进授权开关保留；推进已由就绪、阻塞及预约检查事件唤起 Agent，日常扫描不再直接派工。
