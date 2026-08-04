# Runner 实践路径

V0.3 的目标链路是：

```text
私有平台任务 → 发布者自有机器 Runner → digital-employee → Agent Host
             → 标准事件/签名回执 → 平台可信用量 → Credit 结算
```

所有应用/服务机器人都在发布者或运营者自己的电脑或服务器上执行。平台是纯控制面，
不托管员工包和 Agent Host，不保存本地路径或模型凭证，也不要求用户机器开放入站端口。

## 一次任务的顺序

1. 发布者在自己的机器上构建并校验员工包，计算确定性 `packageDigest`。
2. 上架时只把员工身份、版本、摘要、支持的 Engine 和价格版本登记到私有平台；员工包
   字节、本地路径和 Host 凭证留在发布者机器。
3. 买家接受不可变 Quote 后，平台先通过 `ReleaseAuthorizer` 确认该 Quote 对应的员工版本、
   包摘要和 Engine，再预留最大 Credit。
4. Runner 主动出站认领任务。平台返回 Ed25519 签名的完整任务和短租约；heartbeat 每次
   返回新的完整签名租约，不接受裸时间戳续期。
5. Runner 验证平台签名、身份、nonce、有效期和 fencing token，原子消费 replay claim，
   再按身份从本机解析员工包。任务不能指定本地路径。
6. Runner 将员工包复制成单次、只读密封快照，核对同一批字节的摘要后，调用本机显式
   注册的 Agent Host Adapter。
7. Host 事件被规范化并组成 hash chain；模型正文和 chain-of-thought 不进入计量事件。
   Runner 在租约安全窗前停止执行并提交绑定事件数和最终摘要的签名回执。
8. 平台验证当前 attempt、fencing、Runner key、事件链和回执，只把任务推进到待核验。
   独立 `UsageVerifier` 通过后，平台才从不可变 Quote 计算 Credit 并结算。

## 当前可嵌入接口

构建产物通过 `@fullstack-ai-infra/digital-employee/host-runtime` 暴露：

- `computeEmployeePackageDirectoryDigest()`：计算本机员工包摘要；
- `createSealedEmployeePackageSnapshot()`：创建单次密封快照；
- `RunnerLeaseState`：验证初始任务和完整签名续租；
- `executeOneShotRunnerTask()`：验证并执行一个任务，生成事件链和签名回执；
- `RunnerReplayGuardPort`：部署方必须提供的原子防重放端口；
- `InMemoryRunnerReplayGuard`：只用于单进程预览，重启后不安全。

长期 Runner 的传输层应把平台 API 映射为下面的调用关系，不能把平台返回的路径、命令
或凭证传进执行器：

```ts
const leaseState = await RunnerLeaseState.create({
  initialEnvelope: claimed.envelope,
  resolvePlatformPublicKey,
})

// 独立 heartbeat 循环收到平台完整签名 grant 后：
await leaseState.acceptRenewal(heartbeat.envelope)

const execution = await executeOneShotRunnerTask({
  taskEnvelope: claimed.envelope,
  runnerId: localConfig.runnerId,
  sellerId: localConfig.sellerId,
  resolvePlatformPublicKey,
  resolveLocalPackage: localPackageRegistry.resolve,
  hostRegistry: localHostRegistry,
  replayGuard: durableReplayGuard,
  receiptKeyId: localKey.id,
  receiptPrivateKey: localKey.privateKey,
  leaseState,
  onEvent: platformClient.appendEvent,
})

await platformClient.submitReceipt(execution.signedReceipt)
```

以上是嵌入接口示意，不是已经发布的网络 SDK。真实传输必须把每个 claim、heartbeat、
event 和 receipt 请求绑定到已认证的 Runner 设备主体；task/run/lease id 只是关联字段，
不能当 Bearer Token。

## 生产部署仍需补齐

- 私有平台 HTTP/gRPC API、mTLS/OAuth 设备认证和密钥轮换；
- Runner 长期进程、持久化 replay、断线重连、升级和本地运维；
- 将私有平台已交付的 PostgreSQL 迁移接入持久仓库、事务 outbox worker、抢占恢复和可观测性；
- 真实目录/订单实现的 `ReleaseAuthorizer`；
- 提供商签名账单或平台自有网关实现的独立 `UsageVerifier`；
- 写操作的业务幂等、审批、沙箱与争议处理；
- 收款、退款、卖家打款、税务和对账。

在这些能力完成前，V0.3 是可信边界和本机执行内核的技术预览，不是可公开运营的机器人
租赁平台。
