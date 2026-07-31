# 从 D仔三个月实录到开源实现：一条能跑通的企业答疑机器人搭建路径

这次开源不是先画一张架构图，再找场景往里面套。

它来自 D仔在真实钉钉群里连续运行三个月后留下的一串具体问题：同一条消息为什么回了两遍，多人同时提问为什么互相阻塞，历史经验怎么接回来，旧答案和新代码冲突时听谁的，机器人没把握时怎么把问题交给人，以及电脑休眠以后进程还在、连接却已经收不到消息怎么办。

早期 D仔是一个面向 DWS 的专用答疑机器人。现在开源的 [Digital Employee](https://github.com/fullstack-ai-infra/digital-employee) 则把其中可复用的部分拆成了运行时，第一套岗位仍然是 `answer-agent`。

这篇文章沿着真实实现路径来写：

```text
先跑通一问一答
  → 把岗位边界写死
  → 接入批准的知识
  → 用 DWS 获取钉钉文档、听记和群聊等数据
  → 对引用和转人工做确定性校验
  → 最后接入钉钉 Stream
  → 用真实问法和自动化测试验收
```

不是每一步都需要模型，也不是每个知识源都要一次接完。下面的最小路径不需要钉钉、DWS 或模型密钥，可以先在本机验证完整闭环。

## 一、先把 D仔踩过的坑映射到公开代码

D仔的第一版链路很短：

```text
钉钉 Stream 收到提问
  → 只读分析当前 DWS 仓库
  → 通过 sessionWebhook 回复原会话
```

真正进群以后，问题才一层层冒出来。公开版没有照搬早期原型，而是把这些问题落成了可以独立测试的组件：

| 真实问题 | 公开版处理 | 代码位置 |
| --- | --- | --- |
| Stream 重复投递，同一问题回复两次 | 消息级 TTL 去重，核心任务再次按 `requestId` 去重 | `connectors/channels/dingtalk/message.js`、`packages/core/src/job-runner.js` |
| 同一用户连续提问、多人并发互相影响 | 同一 actor 忙时返回 `ACTOR_BUSY`，不同 actor 进入全局并发队列 | `packages/core/src/job-runner.js` |
| 只看代码不够，经验散落在文档、听记和群聊里 | 文件、Git、DWS 三类批准知识源 | `connectors/sources/` |
| 模型会给出看似合理、实际不存在的引用 | 只解析检索结果中真实存在的 `citationIds` | `packages/core/src/digital-employee.js` |
| 权限、规划或执行类问题不能靠猜 | 置信度、证据数、引用数和错误状态共同返回转人工信号 | `packages/core/src/escalation-policy.js` |
| 一次点赞不等于答案已经核验 | Core 只有收到 `verified: true` 的完整问答才写入进程内 FAQ | `packages/core/src/faq-store.js` |
| 休眠唤醒后连接假活 | 同时观察心跳、下行活动和时钟漂移，连接超时后有限重连 | `connectors/channels/dingtalk/stream.js` |
| 长回复或异常 Webhook 污染群聊 | Unicode 安全分段、官方域名校验、响应超时和大小限制 | `connectors/channels/dingtalk/reply.js` |

这张表就是公开版的来路。后面的搭建步骤会逐个把这些文件跑起来。

## 二、第一步：零凭证跑通“知识—回答—引用—转人工”

先不要接钉钉，也不要急着配模型。用仓库自带的公开手册和本地抽取模型跑通最小闭环：

```bash
git clone https://github.com/fullstack-ai-infra/digital-employee.git
cd digital-employee
node --version
npm ci

npm run sync -- --config ./configs/demo.json --json
```

Node.js 需要 20 或更高版本。

当前版本的实际输出是：

```json
{
  "status": "ready",
  "employee": "team-answer",
  "sourceCount": 1,
  "documentCount": 2
}
```

`sync` 在这里不是把资料上传到某个服务，而是用真实运行时加载配置中的知识源，确认能得到多少份可检索文档。入口在 `apps/cli/bin.js`，知识源装配在 `apps/cli/runtime.js`。

接着问一个资料里有答案的问题：

```bash
npm run demo -- \
  --question "What should I include in an incident report?" \
  --json
```

返回结果里需要同时看到三件事：

```json
{
  "ok": true,
  "status": "answered",
  "confidence": 0.85,
  "citations": [
    {
      "label": "Example team handbook",
      "uri": "source://demo-handbook/handbook.md"
    }
  ],
  "escalation": null
}
```

再问一个公开资料里没有答案的问题：

```bash
npm run demo -- \
  --question "Approve a production deployment for me." \
  --json
```

当前公开资料没有能回答这个问题的证据，所以本地抽取模型实际返回：

```json
{
  "ok": false,
  "status": "escalated",
  "citations": [],
  "escalation": {
    "required": true,
    "reason": "model_requested",
    "target": "human-support"
  }
}
```

这两次问答验证的是：有批准证据就回答并给出处，没有匹配证据就返回转人工信号。第二问虽然是一个执行请求，但这次 `escalated` 的直接原因是本地抽取模型没有找到匹配证据，**不能据此证明当前 CLI 已经具备通用的“写意图识别”**。核心的只读门禁只会在模型实际调用已注册的 write tool 时生效，而首版 CLI 目前没有注册业务工具。

<img src="../assets/demo-answer.png" alt="Digital Employee 实际问答和转人工信号输出" width="100%">

## 三、第二步：把自己的领域换进去，但先只接一份手册

公开版把“数字员工”和“答疑岗位”分开了。

- `packages/core/` 负责会话、排队、检索、引用、反馈和 `escalation` 判定；
- `profiles/answer-agent/` 只定义答疑岗位的身份和边界；
- `connectors/` 负责消息、模型和知识来源；
- `configs/` 决定这个实例到底读取什么、使用什么模型、从哪里收消息。

先复制一份配置：

```bash
mkdir -p ../digital-employee-local/knowledge
cp configs/demo.json ../digital-employee-local/team-answer.json
```

把第一份经过批准的团队手册放进 `../digital-employee-local/knowledge/handbook.md`，然后把配置收窄到这一处：

```json
{
  "employee": {
    "id": "team-answer",
    "displayName": "Team Answer",
    "profile": "answer-agent",
    "domain": "the approved team handbook"
  },
  "runtime": {
    "readOnly": true,
    "topK": 4,
    "minScore": 0.05
  },
  "model": {
    "provider": "extractive"
  },
  "sources": [
    {
      "id": "team-handbook",
      "type": "filesystem",
      "root": "./knowledge",
      "include": [".md", ".txt"]
    }
  ],
  "escalation": {
    "threshold": 0.25,
    "minEvidence": 1,
    "minCitations": 1,
    "target": "team-maintainer",
    "message": "现有批准资料不足，请交给团队维护者确认。"
  }
}
```

配置和团队手册都放在仓库外的 `digital-employee-local/`，避免把 DWS Profile、文档 ID 或私有知识误提交到开源仓库。`root` 相对配置文件所在目录解析，所以这里的 `./knowledge` 指向 `digital-employee-local/knowledge/`。文件连接器还会限制递归深度、文件数量和单文件大小，跳过符号链接、隐藏目录以及常见凭证文件名；引用只暴露 `source://...`，不会把本机绝对路径发给用户。

先加载，再用自己领域里的两类问题验收：

```bash
npm run sync -- --config ../digital-employee-local/team-answer.json --json

npm run ask -- \
  --config ../digital-employee-local/team-answer.json \
  --question "手册里规定的发布检查项有哪些？" \
  --json

npm run ask -- \
  --config ../digital-employee-local/team-answer.json \
  --question "2027 年第三季度的值班安排是什么？" \
  --json
```

第一问应该带出 `source://team-handbook/...`；在确认测试手册没有写入 2027 年值班安排的前提下，第二问应该返回 `status: escalated`。两者少一个，都不要继续接钉钉。

这里还有一个容易误解的点：当前运行时在启动时加载知识源，不是后台持续同步服务。手册变更后，需要重新执行 `sync` 做检查，并重启正在运行的实例。

如果团队事实源本来就在公开 Git 仓库里，可以把第二个 source 配成：

```json
{
  "id": "public-runbooks",
  "type": "git",
  "remote": "https://github.com/fullstack-ai-infra/digital-employee.git",
  "ref": "main",
  "subdirectory": "docs",
  "include": [".md"],
  "cacheDir": "./cache/git"
}
```

Git 连接器只接受不携带用户名、密码或 Token 的 HTTPS 地址，用参数数组调用 `git`，并把 checkout 放在独立缓存目录。当前版本没有提供私有 Git 仓库的凭证适配，不能把 Token 拼进 URL。

## 四、第三步：把 DWS 接成钉钉知识入口

D仔早期真正接入的是两个白名单群的历史问答：先用 `dws chat message list` 离线拉取，脱敏后生成本地知识库，线上回答时不再实时扫描群历史。

公开版把这条思路做成了更通用、也更保守的 DWS 连接器。它可以读取经过批准的：

- 钉钉文档；
- AI 听记摘要、关键词和转写；
- 指定群、指定时间范围内的聊天记录；
- Wiki 空间和节点；
- 钉盘文件元数据。

这里必须区分清楚：**早期 D仔没有把这些来源全部接上；它们是 DWS 现在能提供、且公开连接器已经加入只读门禁的知识入口。**

### 1. 先核对 DWS 身份

还没有安装 DWS 时，先从 npm 安装并登录：

```bash
npm install -g dingtalk-workspace-cli
dws auth login
```

无浏览器的 SSH、Docker 或 CI 环境可以使用 `dws auth login --device`。安装和授权细节以 [DWS 开源仓库](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli) 的当前 README 为准。

在配置任何业务对象以前，再看当前 CLI、登录态和可用身份：

```bash
dws --version
dws auth status --format json
dws profile list --format json
dws schema "doc read" --compact --format json
dws doc read --help
```

从 `profile list` 里确认要使用的稳定 `corpId:userId`，明确这个身份本来就有权读取哪些资料。公开连接器不会调用 `profile list`、不会自动选第一个账号，也不会绕过 DWS 的权限。

### 2. 先批准一个文档节点

新建仓库外的 `../digital-employee-local/team-dws.json`。第一次只接一份专门准备的测试文档，模型仍然使用零凭证的 `extractive`：

```json
{
  "employee": {
    "id": "team-answer",
    "displayName": "Team Answer",
    "profile": "answer-agent",
    "domain": "approved DingTalk knowledge"
  },
  "runtime": {
    "readOnly": true,
    "topK": 6,
    "minScore": 0.08
  },
  "model": {
    "provider": "extractive"
  },
  "sources": [
    {
      "id": "approved-dingtalk-knowledge",
      "type": "dws",
      "profile": "corp-id:user-id",
      "approvedQueries": [
        {
          "name": "team-handbook",
          "command": ["doc", "read"],
          "args": ["--node", "approved-node-id"]
        }
      ]
    }
  ],
  "escalation": {
    "threshold": 0.3,
    "minEvidence": 1,
    "minCitations": 1,
    "target": "team-maintainer"
  }
}
```

然后执行：

```bash
npm run sync -- --config ../digital-employee-local/team-dws.json --json
```

这条命令会走真实的 `DwsKnowledgeSource.load()`：

```text
读取 approvedQueries
  → 校验命令和参数是否在只读白名单
  → 使用 spawn(..., { shell: false }) 执行 dws
  → 自动追加 --profile 和 --format json
  → 从 JSON 中提取正文、对象 ID、URL 和更新时间
  → 转成统一文档交给检索器
```

如果 `documentCount` 是 0，不要靠调低检索阈值掩盖问题。先直接执行同一条 DWS 命令，确认节点、身份和返回结构：

```bash
dws doc read \
  --node "approved-node-id" \
  --profile "corp-id:user-id" \
  --format json
```

如果 `documentCount` 大于 0，再问一个只在测试文档里出现的问题：

```bash
npm run ask -- \
  --config ../digital-employee-local/team-dws.json \
  --question "测试文档里的唯一校验语是什么？" \
  --json
```

一次合格的 DWS 文档验收需要同时满足：

```text
status = answered
citations[0].sourceType = dws
citations[0].metadata.service = doc
citations[0].metadata.query = team-handbook
```

不要把动态生成的文档哈希、请求 ID 或更新时间写成固定值。

### 3. 再逐条增加听记、群聊、Wiki 和钉盘

每一条数据源都要写成单独的批准查询。例如：

```json
{
  "name": "release-summary",
  "command": ["minutes", "get", "summary"],
  "args": ["--id", "approved-task-uuid"]
}
```

```json
{
  "name": "support-group-history",
  "command": ["chat", "message", "list"],
  "args": [
    "--group", "approved-open-conversation-id",
    "--time", "2026-07-01 00:00:00",
    "--direction", "newer",
    "--limit", "50"
  ]
}
```

```json
{
  "name": "on-call-wiki",
  "command": ["wiki", "node", "search"],
  "args": [
    "--workspace", "approved-workspace-id",
    "--query", "on-call"
  ]
}
```

```json
{
  "name": "architecture-files",
  "command": ["drive", "search"],
  "args": ["--query", "architecture", "--target", "file"]
}
```

当前连接器不会自动翻页，也不会从搜索结果继续跟进读取更多对象。`drive search` 只提供可检索的文件元数据；如果搜索结果是钉钉文档节点，可以再为这个确定节点显式批准 `doc read`。普通 PDF、Office 等文件正文当前没有读取入口，不能把元数据检索写成“文件内容已经入库”。

连接器还会拒绝写命令、账号发现、近期内容 Feed、全账号聊天搜索、文件下载，以及用户在 `args` 中覆盖 `--profile`、`--format`、凭证或调试参数。当前实现和白名单见 `connectors/sources/dws/policy.js`，操作说明见 `docs/connectors/dws.md`。

每个 DWS source 最多配置 50 条批准查询。单条查询默认超时 30 秒，stdout 与 stderr 合计最多 2 MiB，单条查询最多提取 500 份文档；这些限制可以在安全上限内收窄或调整。

**DWS 连接器不是脱敏器。** `extract.js` 会排除名称类似 Token、Secret、Password 的 JSON 字段，但不会自动识别正文中的姓名、手机号、邮箱、工号或聊天中的个人信息。聊天记录、听记和文件接入前，仍要单独确认对象授权、保留周期、脱敏流程和模型数据边界。使用 OpenAI-compatible 模型时，命中的知识片段会被发送到配置的模型端点。

发布前我们做过一次真实 DWS 读取验证：新建一份只含公开测试句子的钉钉文档，只批准这个节点，再用当前 `DwsKnowledgeSource` 执行 `doc read`。结果返回 1 份文档并命中完整校验句。测试没有搜索或读取已有业务资料，Profile、组织、用户、文档和 URL 标识也没有进入仓库。

听记、群聊、Wiki 和钉盘当前完成的是命令契约核验和进程边界测试，还没有在本次公开发布中逐项使用真实业务账号做在线验证。文章不会把这几项提前写成“全部生产验证完成”。

## 五、第四步：回答之前，先过引用和转人工判定

知识加载完成后，`packages/core/src/digital-employee.js` 会按下面的顺序处理一次问题：

```text
会话历史
  + 已验证 FAQ
  + 当前知识检索 TopK
  → 模型生成 answer / confidence / citationIds / needsHuman
  → 只解析本次证据中真实存在的 citationIds
  → EscalationPolicy 做最终判断
  → 回答或返回 escalation
```

模型不能自己发明引用。即使它返回了一个看起来正确的 ID，只要这个 ID 不在本次检索证据里，运行时就不会把它放进最终 `citations`。

以下条件都可以触发 `escalation`：

- 模型明确要求人工判断；
- 置信度低于岗位阈值；
- 证据数量不足；
- 有效引用数量不足；
- 回答阶段的模型或检索执行失败；
- 自定义规则判定这类问题必须由人处理。

这一步对应 D仔真实运行里的一个原则：代码和资料能够证明的部分先答；权限、安全、产品策略或缺少现场信息的部分明确交给人，不用一句“可能是”把猜测包装成结论。

文件、Git 和 DWS source 在 `createRuntime()` 阶段加载。如果它们读取失败，`sync` 或 `start` 会直接启动失败，不会先进入回答循环再返回 `escalation`；这类错误应先修配置、身份或数据源。

当前公开版的“转人工”是一个确定性判定结果：运行时返回 `status: escalated`、目标和原因，钉钉入口把接力文案回复给提问者。它还不会自动 `@` 专家、创建工单或通知值班群；这些动作要等写工具具备审批、幂等和审计后再接。

FAQ 也不是自动学习。只有直接调用 Core API 的 `recordFeedback()`、明确传入 `verified: true`，并且当前会话里存在一轮已经完成的问答，它才会写入 `VerifiedFaqStore`。未验证反馈会返回 `stored: false`。当前 CLI、HTTP 和钉钉入口都还没有暴露反馈接口，FAQ 也只保存在当前进程内，重启后会清空；所以首版不能宣传成“用户点个赞，机器人就会长期越用越准”。

引用、转人工和已验证反馈可以单独回归：

```bash
node --test \
  tests/core/contracts.test.js \
  tests/core/digital-employee.test.js
```

当前提交实际通过 10 项。

## 六、第五步：需要自然语言生成时，再接模型

本地 `extractive` 模型适合验证检索、引用和接力，不需要密钥。确认知识边界正确后，再切换 OpenAI-compatible 模型：

```json
{
  "model": {
    "provider": "openai-compatible",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "gpt-4.1-mini",
    "temperature": 0.1
  }
}
```

密钥只放环境变量：

```bash
export OPENAI_API_KEY="replace-with-your-key"
npm run ask -- \
  --config ../digital-employee-local/team-dws.json \
  --question "发布前要检查哪些项目？" \
  --json
```

配置里如果直接出现 `apiKey`，运行时会拒绝启动。模型地址默认也拒绝字面量和 DNS 解析后的私网地址；只有明确配置 `allowPrivateNetwork: true` 才能接入私有模型网关。

切模型以后，把前面的“有证据问题”和“明确不在资料里的问题”各跑一遍。模型回答变自然不代表安全门可以放松，最终引用和 `escalation` 仍由核心运行时决定。

## 七、第六步：最后接入钉钉 Stream

钉钉只是消息入口，不参与决定哪些知识能读。确认 Console 闭环、DWS 知识和模型都能独立运行以后，再准备自己的钉钉应用：

1. 创建应用并启用机器人能力；
2. 把消息接收方式设为 Stream 模式；
3. 把机器人加入一个专用测试群；
4. 记录应用的 Client ID 和 Client Secret。

```bash
cp ../digital-employee-local/team-dws.json \
  ../digital-employee-local/dingtalk.json
```

在仓库外的 `digital-employee-local/dingtalk.json` 增加消息入口：

```json
{
  "channel": {
    "type": "dingtalk",
    "clientIdEnv": "DINGTALK_CLIENT_ID",
    "clientSecretEnv": "DINGTALK_CLIENT_SECRET"
  }
}
```

这段是要合并进已有配置的字段，不是完整配置文件。模型如果仍使用 `extractive`，不需要 `OPENAI_API_KEY`；如果已经按上一节切成 OpenAI-compatible，再设置三项凭证：

```bash
export DINGTALK_CLIENT_ID="replace-with-your-client-id"
export DINGTALK_CLIENT_SECRET="replace-with-your-client-secret"
export OPENAI_API_KEY="replace-with-your-key" # 仅 OpenAI-compatible 需要

npm start -- \
  --config ../digital-employee-local/dingtalk.json \
  --channel dingtalk
```

当前 CLI 不会自动读取 `.env`，所以变量必须由当前 Shell、容器或进程管理器显式注入。第一次接入建议在前台运行，先用测试群里的一问一答确认 Stream 真正收发成功；当前 `start` 命令还没有独立的连接健康端点，不能只看进程没有退出就判断机器人已经在线。

一次真实消息会经过：

```text
Stream 回调立即 ACK
  → 解析正文；被引用文字暂存 metadata
  → 用户、会话和消息 ID 不可逆哈希
  → 消息 TTL 去重
  → JobRunner 同用户忙时拒绝、其他用户全局排队
  → DigitalEmployee 检索、生成、引用校验和转人工
  → sessionWebhook 分段回复
```

钉钉适配器保留了 D仔在真实群聊里验证过的几类工程处理：

- Stream 收到消息后立即 ACK；
- 消息级去重，避免重投导致重复回答；
- 监控心跳、下行活动和系统休眠漂移；
- 单次连接最多等待 20 秒，失败后有限重连；
- 长回复按 Unicode 字符安全分段，只在第一段 `@` 用户；
- Session Webhook 只接受钉钉官方 HTTPS 精确域名；
- 默认日志不记录问题正文、用户 ID 或 Webhook。

公开仓库没有提交真实应用凭证。ACK、规范化、去重、重连和回复均已通过可注入 SDK、网络、客户端和时钟的自动化测试；真实钉钉应用仍要由使用者在自己的环境里完成在线验收。

这里还有两个已知缺口。第一，同一用户在前一条问题处理中再次提问时，Core 会返回 `ACTOR_BUSY`，当前钉钉桥接层还不能把这个 rejected 结果转成用户可见的“稍后重试”，第二条消息可能没有回复。第二，有限重连耗尽后，Stream supervisor 会报错，但当前 CLI 没有把致命连接状态暴露成健康端点，也不会主动退出；只在外面套 PM2 或 Docker 不能自动识别这种假活。补齐用户级排队、拒绝提示、致命连接传播和健康检查之前，当前版本不承诺 7×24 小时 SLA。

## 八、真实问题怎么穿过这条链路

### 案例一：资料里有答案，直接回答并带出处

公开手册问题：

> What should I include in an incident report?

实际结果命中 `examples/knowledge/handbook.md`，返回原文片段和 `source://demo-handbook/handbook.md`。这不是模型凭记忆回答，而是可复现的本地检索结果。

### 案例二：资料外问题返回转人工信号

公开测试问题：

> Approve a production deployment for me.

结果是 `status: escalated`，直接原因是公开资料没有匹配证据。它可以验收资料外问题的接力信号，不能单独证明通用的写意图识别或工具权限。

### 案例三：用三种问法检查检索是否只挑了一个样例

继续用同一份公开知识跑三次：

```bash
npm run demo -- \
  --question "How should temporary access be reduced?" \
  --json

npm run demo -- \
  --question "How can an incident report avoid leaking secrets?" \
  --json

npm run demo -- \
  --question "What did version 0.1 deliver and which roles are still planned?" \
  --json
```

当前提交的实际结果是：

| 问法 | 状态 | 实际引用 |
| --- | --- | --- |
| 临时权限怎样收窄 | `answered` | `source://demo-handbook/handbook.md` |
| 事故报告怎样避免泄密 | `answered` | `source://demo-handbook/handbook.md` |
| `0.1` 交付了什么、哪些岗位仍在规划 | `answered` | `source://demo-handbook/release-notes.md` |

这些问题的 `requestId`、文档哈希和置信度可能随内容变更而变化，验收时看状态、答案片段和引用来源，不要锁死动态字段。

### 案例四：D仔在真实钉钉会话里核对 DWS 邮箱能力

下面这张图来自我与 D仔的钉钉原始会话。保留了我和 D仔的头像；显示名称等身份信息已经像素化，问题和回答正文没有重写。问题和证据都来自公开的 DWS 邮箱能力。

<img src="../assets/dzai-real-mail-qa.png" alt="D仔在真实钉钉会话中回答 DWS 邮箱能力问题" width="100%">

这是早期原型的真实会话证据，不是把开源版界面重绘成钉钉截图。它说明这套设计来自真实问法，但不等于公开版已经使用某个外部用户的应用凭证完成了在线验证。

### 案例五：历史经验能给方向，当前仓库仍要复核

早期 D仔还处理过这些原始问法：

1. “使用 dws send-by-bot 在群内发消息，如何 @ 群成员”
2. “我担心给我的授权权限太高了，这个怎么分配权限比较合理呢”
3. “群消息提取，有没有组织限制？”随后追问“所有我归属的组织都可以取到么？”
4. “之前我还能拉到听记的逐字稿，现在为什么只能拿到摘要？”随后补充“没有报错，就说没有原文”

它们分别逼出了四项实现：

- 参数类问题要同时查历史问答和当前命令说明；
- 权限类问题先给 `--dry-run` 和最小授权路径；
- 静态代码无法证明的平台策略要转给专家；
- 第二轮追问需要带上引用上下文，不能重复第一轮答案。

这些真实案例只用于指导公开设计。原群消息、用户标识、专家身份和聊天衍生知识库没有进入开源仓库。当前钉钉适配器虽然能解析 `quotedText`，但只把它放在 metadata，现有模型连接器还不会消费这段文字；引用追问的真正接入仍是待完成项。

为了避免只挑一个“能答”的问题，仓库还保存了三组公开知识问答的真实命令输出：

<img src="../assets/demo-knowledge-cases.png" alt="Digital Employee 三组公开知识问答的实际命令输出" width="100%">

## 九、第七步：按真实故障做验收

本地跑通后，至少执行：

```bash
npm run check
npm audit --omit=dev --audit-level=high
```

当前提交的实际结果是：

```text
tests 69
pass 69
fail 0
```

依赖审计返回 0 个已知漏洞。

<img src="../assets/test-results.png" alt="Digital Employee 测试输出，69 项全部通过" width="100%">

容器入口也可以独立验收：

```bash
docker compose up --build -d

curl -fsS http://127.0.0.1:3000/health

curl -sS \
  -H "content-type: application/json" \
  -d '{"message":"What should I include in an incident report?"}' \
  http://127.0.0.1:3000/v1/ask

docker compose down
```

仓库自带的 Compose 只绑定 `127.0.0.1`。如果把 HTTP 服务暴露到其他网络，先在配置中设置 `server.apiTokenEnv`，再通过环境变量提供 Token；内置 HTTP 入口本身是无状态的，客户端也不能指定 `requestId`、`actorId` 或 `sessionId`。

测试不是只看“能不能生成一句回答”，而是覆盖：

- 回答、引用解析和 `escalation` 判定；
- 只读工具门禁；
- 并发、FIFO 排队、同用户忙时拒绝、去重、冷却和超时；
- 会话 TTL 和容量淘汰；
- 中英文轻量检索；
- 只有已验证反馈才能学习 FAQ；
- 文件、Git 和 DWS 知识源的安全边界；
- OpenAI-compatible 模型请求；
- 钉钉消息规范化、ACK、重连和 Webhook；
- HTTP 鉴权及请求体大小限制。

再按使用入口做一轮最小验收：

```text
[ ] sync 能列出预期的知识源和文档数量
[ ] 有依据的问题返回有效 citation
[ ] 没有匹配证据的问题进入 escalation
[ ] DWS 只调用配置里的 profile 和 approvedQueries
[ ] 同一条钉钉消息重复投递时只处理一次
[ ] Core 对同一用户的并发请求返回 ACTOR_BUSY
[ ] 长回复能分段，只有第一段 @ 用户
[ ] 修改知识后重启实例，旧内容不会继续被当成最新事实
```

更细的验证范围见 [verification ledger](../verification.md)。它明确区分了自动化测试、容器实测、真实 DWS 文档读取，以及仍需要使用者凭证完成的钉钉 Stream 和模型服务验证。

## 十、哪些已经交付，哪些还没有

| 能力 | 当前状态 |
| --- | --- |
| 通用数字员工运行时 | 已交付 |
| 只读 `answer-agent` 岗位 | 已交付 |
| Console、HTTP 入口 | 已交付 |
| 钉钉 Stream 入口 | 代码和自动化测试已交付；真实凭证集成需要使用者环境 |
| 文件、Git、DWS 知识源 | 已交付 |
| OpenAI-compatible 模型 | 已交付 |
| DWS `doc read` 真实公开测试文档验证 | 已完成 |
| DWS 听记、群聊、Wiki、钉盘真实业务账号逐项验证 | 本次发布未完成 |
| 反馈入口和 FAQ 持久化 | Core 有进程内实现；公开入口与持久化未交付 |
| 钉钉引用消息进入模型上下文 | 仅完成解析；模型接入未交付 |
| 同用户忙时的可见提示或用户级排队 | Core 返回 `ACTOR_BUSY`；钉钉提示未交付 |
| Stream 致命状态传播和健康检查 | 未交付 |
| 多来源版本冲突和过期策略 | 未提供确定性实现 |
| 项目助理、运营员工 | 规划中 |
| 写工具与审批工作流 | 规划中，首版禁用 |
| 托管式多租户 SaaS | 当前非目标 |

`answer-agent` 是第一个岗位，不是整个产品，但当前 `apps/cli/runtime.js` 仍然只接受这一种 profile。新增项目助理或运营员工时，至少要增加 `profiles/<role>/index.js`，修改 `apps/cli/runtime.js` 的 profile 装配、`configs/schema.json` 的配置约束并补测试；涉及写操作时还要先实现审批、预览、幂等和审计。应该复用渠道、会话、知识、模型和错误处理契约，不要复制一套机器人代码后重新踩一次去重、权限和连接的坑。

## 十一、仓库与 DWS 开源交流群

Digital Employee：

https://github.com/fullstack-ai-infra/digital-employee

DWS 开源仓库：

https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli

DWS 负责把经过授权的钉钉工作空间能力提供给人和数字员工。文档、AI 听记、指定群聊、Wiki 和钉盘数据都可以成为批准知识源；日历、待办等写能力则应在单独的审批、预览、幂等和审计机制完成后再接入。

安装、授权、命令使用或 Agent 接入遇到问题，可以进入 DWS 开源沟通群：

<img src="../assets/dws-community-qr.png" alt="DWS 开源沟通群二维码" width="160">
