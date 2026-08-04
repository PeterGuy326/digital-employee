# ADR 0002：Runner 执行协议与平台边界

- 状态：V0.3 技术预览接受
- 日期：2026-08-04
- 范围：平台任务进入卖家机器后，`digital-employee` 如何验证并执行

## 背景

数字员工可以部署在卖家的本地电脑或服务器，但具体模型循环仍由
Claude Code、Qoder、Qwen Code、CodeBuddy 等 Agent Host 提供。平台不能直接
信任卖家机器，卖家机器也不能执行一个无法验证来源、包版本和有效期的任务。

Runner 是外层执行角色，不是新的 Agent loop，也不是市场计费模块。它需要把
平台任务安全地转换为一次现有 `runEmployeePackage()` 调用，并把宿主事件转换为
可校验的执行证据。

所有应用/服务员工都运行在发布者或运营者自己的电脑或服务器上。Runner 只主动
向平台发起出站 claim、heartbeat 和 receipt 请求，不要求用户机器暴露入站端口；
平台不托管可执行员工包、不读取本地路径，也不持有 Agent Host 凭证。

## 决策

1. 平台发送 Ed25519 签名的任务信封。签名绑定原始 payload 字节，并使用独立、
   带版本的 task domain，避免与回执或其他协议消息混用。
2. 任务必须绑定 task、run、attempt、lease、Quote、reservation、seller、Runner、
   employee id/version/package digest、Agent Host、输入、nonce 和 UTC 有效期。
3. Runner 在调用 Agent Host 前完成签名、协议、时间、租约、重放和员工包摘要校验；
   任一条件不满足都不启动模型。
4. Runner 只调用显式注册且通过 package-aware preflight 的 Host Adapter，不自动
   回退到其他 Host 或 `standalone-v1`。
5. Runner 把标准 Host 事件映射为有序、hash-chain 的 Runner 事件；终态回执绑定
   event count、最终 event digest、执行结果和汇总用量，并由 Runner key 签名。
6. Runner 签名只证明来源和完整性，不证明用量真实，也不包含 Credit、费率、平台费
   或卖家应收。计费可信性和结算仍由私有平台控制面决定。
7. heartbeat 不能只返回一个可变的过期时间；每次续租都返回完整、重新签名的任务
   payload。除 `leaseExpiresAt` 单调增加外，task/run/attempt/fencing/nonce、员工包、
   Engine、输入和 Quote 身份必须逐字节保持不变。

## 执行语义

- 交付语义是 at-least-once，不承诺外部 Agent Host 恰好执行一次。
- lease attempt 是 fencing token；旧 attempt 的事件和回执不能完成新 attempt。
- attempt 数量有硬上限；超过上限后保持预留等待平台超时/人工策略，不能无限增长审计
  状态或偷偷重置 fencing。
- 重放存储是 Runner 部署必须提供的端口。内存实现只用于单进程技术预览和测试。
- 当前员工默认只读。未来开放写操作前，业务动作还必须有独立幂等键、审批策略和
  隔离环境，不能依赖 Runner task id 代替业务幂等。
- 不记录或传输 chain-of-thought。审计只包含标准事件、必要输出、用量声明和摘要。
- 时间有效区间统一为半开区间 `[issuedAt, expiresAt)`；Runner/平台允许最多 30 秒钟差，
  但生产状态转换仍使用平台观测时间。Runner 在 lease 结束前预留 5 秒上传安全窗。

## 包完整性

任务携带的是员工包声明文件集合的确定性 SHA-256 摘要。执行路径必须校验实际交给
Host Adapter 的同一组字节，不能先摘要一组路径、再从可变工作区执行另一组内容。
软链接、未声明文件和摘要后的替换必须 fail closed。

## 安全与隐私

- 签名不提供加密；生产传输必须使用双向 TLS 或等价私有通道。
- 私钥来自部署环境或密钥服务，不能进入员工包、事件、日志或回执。
- payload、事件数、单事件和总输出都必须有硬上限。
- 错误只暴露稳定 machine code，不回显签名、私钥、完整输入或宿主凭证。
- 平台 public key 与 Runner private key 是不同信任方向的密钥，key id 支持轮换。

## 放弃的方案

- **Runner 自己实现模型循环：** 与 Agent Host 边界冲突并重复建设。
- **只靠 HTTPS、不做消息签名：** 离线重试、队列和中间存储无法保留端到端完整性。
- **Runner 签名后直接计费：** 卖家控制签名进程和用量来源，无法证明用量真实。
- **宣称 exactly-once：** 网络中断时无法判断外部 Host 是否已经启动，必须依赖
  at-least-once 加幂等状态机。

## 后续演进

V0.3 提供协议、一次性执行器和可替换的 replay/transport 端口。长期在线 Runner
服务、设备认证、自动更新、沙箱资源隔离和平台网络 API 分阶段实现，不进入核心
Agent Host 适配器。
