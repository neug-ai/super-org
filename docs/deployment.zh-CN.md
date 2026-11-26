# Super-Org 部署与运维

## 启动模式

| 用途 | 命令 | 所需环境 |
| --- | --- | --- |
| 本地维护项目、任务和成员 | `pnpm start:codex --projects-only` | Node.js 和 pnpm |
| 执行任务、处理项目消息和仓库反馈 | `pnpm start:codex --env-file .env` | 已认证的 Codex CLI，按需配置 GitHub 和钉钉 |

从 [Super-Org README](../README.zh-CN.md#快速体验)完成安装和构建。完整服务需要 Git，GitHub 联动需要真实的 `gh` 命令。Codex CLI 需要支持 app-server 动态工具。工作台默认位于 [本机 3082](http://127.0.0.1:3082/orchestrator/projects)，使用 `SUPERAGENT_PORT` 可改端口。全局「Agent 状态」用于检查运行条件与连接。当前由 Codex 完成规划与执行，其余检测到的本地命令会展示可用性。

从 [环境变量模板](../.env.template)创建本机 `.env`。本地执行可从以下设置开始，按账号可用性调整模型：

```dotenv
SUPERAGENT_STATE_DIR=/absolute/path/to/super-org/state-codex
SUPERAGENT_PORT=3082
CODEX_BINARY=codex
CODEX_SANDBOX=workspace-write
```

`CODEX_MODEL` 可按需指定。用于 env 文件的路径推荐写为绝对路径，Node 的 env 加载器不会展开 `~`。设为 `read-only` 时 Worker 文件写入受限，`workspace-write` 允许在任务工作区写入。macOS Keychain 和需要审批的命令仍按 Codex 原生权限处理，无头服务无法交互审批。可按本机需要审查并安装仓库提供的 [只读 GitHub 命令规则](../codex-readonly.rules)。

两个模式通过 `SUPERAGENT_STATE_DIR` 使用同一份数据库。目录有独占锁，切换时先停止原进程。已有部署继续使用实际状态目录路径。完整服务也可在没有群或仓库的情况下运行项目，未关联仓库的工单使用独立本地工作区。

文档和工作流以 Super-Org 为项目名。`SUPERAGENT_*` 环境变量、`dsh-superagent` 插件名及原有启动脚本仍是运行兼容标识，升级继续使用原配置键。

## 钉钉项目群

在钉钉应用中启用机器人和 Stream 接入，发布并把机器人加入群。使用同一机器人时保留一个接收服务。在 `.env` 同时填写 `DINGTALK_CLIENT_ID` 和 `DINGTALK_CLIENT_SECRET`。若要从空群提交首次纪要建项，将 `DINGTALK_OPEN_CONVERSATION_ID` 设为该群会话 ID。已有项目也可在项目设置中绑定会话 ID。

附件下载返回 `Forbidden.AccessDenied.IpNotInWhiteList` 时，请到当前应用的「开发管理 → 服务器出口 IP」核对钉钉报错中看到的出口地址。保存正确的出口 IP 后再重试下载。Stream 已连接时，服务端下载仍需通过这个检查。 [钉钉服务端接口常见问题](https://dingtalk.apifox.cn/doc-3662574)

应用已放行 IPv4 出口、部署环境同时有 IPv4 和 IPv6 时，可以用 `node --dns-result-order=ipv4first lib/codex-cli.js --env-file .env` 启动本机服务，使 Node.js 优先尝试 IPv4。沿用现有状态目录和启动环境。IP 白名单仍以钉钉实际收到的请求为准。 [Node.js 启动参数](https://nodejs.org/api/cli.html#--dns-result-orderorder)

读取钉钉文档卡片时，将 `DINGTALK_DOCUMENT_CORP_ID` 设为**该企业内部应用所属企业**的 Corp ID。给应用开通成员信息读权限及知识库读取权限。读取原生文字文档需要访问文档块接口的权限，读取已上传到钉钉文档空间的文件还需要企业存储文件读权限。应用的成员可见范围须覆盖发起请求的人，发起者须有相应文档的读取或下载权限。服务以当前群消息发送者为操作者调用钉钉接口。 [查询用户详情](https://dingtalk.apifox.cn/api-139715614) [钉钉文档权限](https://dingtalk.apifox.cn/doc-392510) [获取文件下载信息](https://dingtalk.apifox.cn/api-142019647)

当前机器人处理群内 @ 消息。建项入口群在绑定项目之前，`登记项目成员`（也可说「把我登记加入」）和 `项目会议纪要：…` 走建项流程，其他 @ 消息按钉钉来源准入规则交给通用 Agent。普通问答可直接回复，并延续当前群最近的问答。项目群成员也可直接聊天或查询知识库。配置 `SUPERAGENT_KNOWLEDGE_DIR` 可让项目 Agent 只读查阅该目录下的 Markdown。引用任务、交付或卡片时，客户端需提供可解析的引用字段。可在正文带任务短引用或明确名称。同一项目的后续通知按实际群绑定发送。会话 webhook 过期时由应用群发送接口投递，需要相应权限。项目回复支持会话级 Markdown 偏好。 [沟通事件](events/communication.zh-CN.md)

`DINGTALK_CARD_TEMPLATE_ID` 启用钉钉卡片。定时跟进会尝试原生 @ 已绑定钉钉账号的负责人。会话 webhook 过期后，机器人通过卡片发送原生 @。此时如果未配置卡片，会发送标有成员姓名的文字提醒，实际结果可在「推进记录 → 通知回执」查看。 `DINGTALK_GITHUB_NOTIFY_CONVERSATION_ID` 供独立 GitHub 通知和本地通用请求使用，项目群在各自的项目设置中绑定。 [钉钉卡片配置](../cards/README.md)

每条外部输入使用自己的卡片。任务拆分、交接和投递重试沿用这条输入的卡片。执行工单从当前输入的 `reply_card` 读取 `card_id`，通过 `orchestrator_report` 将它交给负责回复的主会话。每张卡片需要一次处理确认和明确的最终回复，等待回执由传输层自动发送。工单交接后由接手方继续处理原卡片。

`POST /orchestrator/api/requests` 是本机通用工单入口，使用 `X-Orchestrator-Request: 1` 和正文 `{"prompt":"..."}`，并依赖上述回复群。项目对话使用 `POST /orchestrator/api/projects/:id/messages`。查看项目操作的实时 schema 使用 `GET /orchestrator/api/projects/tools`。

## GitHub 仓库与权限

在项目中保存仓库 `owner/repository`。仓库可在项目建立后添加，也可留空。 `SUPERAGENT_REPOSITORY` 和 `SUPERAGENT_GITHUB_REPOSITORY` 是旧单仓库安装的配置，不是绑定新项目的必填项。

1. **认证。** 个人模式使用服务账号所配置的 GitHub CLI 登录。App 模式设置 `SUPERAGENT_GITHUB_AUTH=app`、App ID、私钥路径和 installation 映射。具体变量见 [模板](../.env.template)。私钥留在 checkout 外，由服务账号读取。
2. **配置来源。** 通过本机管理 API 启用 GitHub，并按需打开 Issue、PR 或评论观察。在 DSH 面板运行时可使用「设置 → 来源 → GitHub」。全局「Agent 状态」显示各仓库状态，认证就绪与是否监听是独立信息。
3. **配置项目事件。** 已关联的 Issue、PR 和评审反馈通过 GitHub 适配器读取。是否应用相应事实由 `sources.github` 的事件开关控制。若使用 `watch` 白名单，请按需包括 `issues`、`pull_requests` 和 `comments`。 [事件配置](events/README.zh-CN.md)
4. **检查操作者授权。** 对已关联 PR 的反馈，GitHub 账号需通过来源的允许名单。团队名册的外部账号资料与来源操作权限分别维护。在推进记录中可核对被忽略的反馈及原因。 [仓库协作](events/repository.zh-CN.md)

独立服务读取 `GET /orchestrator/api/settings`，在 `sources` 中找到 `id=github`，保留其 `value` 和 `revision`。修改 `value.enabled` 为 `true`，按需将 `value.config.observeIssues`、`observePulls` 或 `observeComments` 设为 `true`。将更新后的 `{ "value": ..., "revision": ... }` 发送到 `PUT /orchestrator/api/settings/source:github`。带 `X-Orchestrator-Request: 1` 和 JSON 请求头。调整评论权限时读取同一响应的 `blocks.policy`，更新 `value.sources.github.allowed` 后提交到 `PUT /orchestrator/api/settings/policy`。保留其他来源和策略字段，按返回结果刷新修订或重启。

App 模式需要对读取的仓库安装应用。首次启动可以用 `SUPERAGENT_GITHUB_INSTALLATIONS` 显式映射所有目标，第一个仓库用作启动校验目标。单 ID 模式使用 `SUPERAGENT_GITHUB_INSTALLATION_ID` 和 `SUPERAGENT_GITHUB_REPOSITORY` 指定校验仓库。App 校验要求上游仓库具备 Contents 读取及 Pull requests、Issues 写入权限，额外安装仓库具备 Contents 写入权限。已有部署改认证方式时通过来源设置保存 GitHub `app` 配置并按提示重启。环境变量主要用于初始设置，后续以数据库保存的来源设置为准。部署级单仓库监听启用时，启动会按该仓库的管理员名单同步 GitHub 来源授权。

## 项目管理入口

默认仅本机。独立项目管理模式可用 `SUPERAGENT_PROJECT_PREVIEW_IP` 指定本机网卡 IPv4，配合 `SUPERAGENT_PROJECT_PREVIEW_LAN=1` 允许同网段访问。设回 `0` 并重启恢复本机限制。

若需要在独立管理模式提供公网入口，设置 `SUPERAGENT_PROJECT_PUBLIC_ENABLED=1`、`SUPERAGENT_PROJECT_PUBLIC_ORIGIN=https://projects.example.com`，并用 `SUPERAGENT_PROJECT_PUBLIC_USER` 和 `SUPERAGENT_PROJECT_PUBLIC_PASSWORD` 配置账号和至少 16 字符的密码。以 `pnpm start:codex --env-file .env --projects-only` 启动。外部 HTTPS 反向代理指向 `127.0.0.1:3092` 或配置的专用端口，保留外部 Host 和浏览器 Origin，并由代理设置 `X-Forwarded-Proto: https`。登录账号具有项目编辑权限。完整 Agent 服务仍使用本机管理入口。

## 升级与数据迁移

升级时停止服务，对 `orchestrator.sqlite` 制作一致性备份，拉取代码，运行 `pnpm install --frozen-lockfile` 和 `pnpm check`，再用原状态目录启动。原任务、工单、配置和事件随数据库继续使用。换机继续执行还需要迁移工单工作区、Codex 会话和相关路径。 [存量兼容](events/project-history.zh-CN.md)

如需从 Mission Control 导入，先停止目标服务并备份源快照与目标库。构建后运行：

```sh
pnpm import:mission-control /path/to/mission-control/data /path/to/super-org-state
```

导入项目、任务、归档、目标和项目决定。目标映射为里程碑，首个顶层目标用作当前目标，无项目归属的记录进入导入收件箱。同一来源的已导入记录会被跳过。旧执行分派保留为任务文字，导入后由团队确认成员和分工。跨项目、缺失或成环的依赖需在源快照修正后重新导入。

开发用 `pnpm check` 做完整检查。真实模型专项可使用 `CODEX_SMOKE_BINARY=/path/to/codex pnpm test tests/codex-harness.spec.ts -t 'real read-only'`，运行于隔离状态目录并使用模拟的钉钉输出。

### 钉钉项目日程和会议

先在服务主机安装 `manage-aliding-meetings` 技能及其 Python SDK 依赖。将技能所需的阿里云凭证保存在仅服务账号可读的环境文件中。

用 `SUPERAGENT_DINGTALK_CALENDAR` 启用日程工具，参考 [配置示例](../.env.template)。配置包括 Python、技能目录、凭证文件的绝对路径，以及允许发起日程的钉钉企业 ID 和员工 ID。只添加已获准使用该凭证创建日程的发起人。

在项目钉钉群明确要求创建会议，提供标题、日期、起止时间，并 @ 每位要邀请的已登记成员。只创建本人日程时可说明「不邀请其他人」。服务以消息发送者作为日历账号，调用技能创建带原生钉钉会议的日程，并在同一会话反馈读回核验的会议号。若请求结果不确定，先在钉钉日历核对。服务不会自动重复提交。

也可查询、修改、取消通过机器人创建的日程，或添加参会人。可先说「列出我在本项目创建的日程」，再用标题和时间确认目标；查询当前状态时，服务用已保存的日程 ID 从钉钉读回。修改支持标题、描述和起止时间。补邀参会人时，在当前消息 @ 对应的已登记成员。取消和修改只作用于发起人在当前项目创建的日程。阿里钉应用须有相应接口权限。修改使用 SDK 的 `PatchEvent`。
