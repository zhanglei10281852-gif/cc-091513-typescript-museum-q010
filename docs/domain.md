# 领域说明

创客工具按风险等级要求不同培训、导师监督和监护授权。领用时点的人员资质、设备状态与材料批次共同决定能否操作，事故停用需要独立的复查链路。

## 风险等级与准入条件

| 条件 | basic | supervised | restricted |
| --- | --- | --- | --- |
| 设备未停用（`tool_operational`） | 是 | 是 | 是 |
| 无生效安全公告（`safety_notice_clear`） | 是 | 是 | 是 |
| 培训资质存在且 `active`、未过复认证期限 | 是 | 是 | 是 |
| 本组导师当班（`mentor_in_group` + `mentor_on_duty`） | — | 是 | 是 |
| 监护人有效授权（`guardian_consent`） | 仅工具显式要求 | 仅工具显式要求 | 是 |
| 材料批次可用（`material_batch`） | 工具要求时 | 工具要求时 | 工具要求时 |
| 库存有余量（`tool_inventory`） | 是 | 是 | 是 |
| 本人无同工具未归还借出（`no_open_loan`） | 是 | 是 | 是 |

工具可通过 `requiresGuardian` / `requiresMaterial` 在风险等级之外追加要求。
资质过期（`expiresAt <= now`）或安全公告生效（`effectiveAt <= now` 且未解除）时，新领用立即拒绝。

## 判定快照与可解释性

每次 `/checkouts`（无论批准或拒绝）都生成一条 `decision` 记录，内含 `DecisionSnapshot`：
判定时间、风险等级、设备状态、库存余量、培训版本/认证日期/到期日、当班导师与排班、
监护授权、材料批次、生效公告以及逐项 `checks`。快照只增不改，
事后资质变化或公告变动不影响历史借出当时采用的条件——事故追溯以此为准。

## 借出生命周期

- **幂等刷卡**：同一 `requestId` 重复到达只回放首次借出（HTTP 200，`reused: true`），
  不重复扣料；被拒刷卡重复请求幂等回放原始拒绝（403，`details.reused: true`），不产生新判定。
- **未归还不流转**：同一人对同一工具存在未归还借出时拒绝新领用。
- **库存下限**：判定、落库与材料扣减在同一同步临界区内完成并原子持久化。
- **普通归还**：`POST /loans/:id/return`。关联事故未解除时拒绝（事故锁定独立于归还）。

## 事故锁定链路

1. `POST /incidents`：安全公告随事故即时下发并生效，工具新领用全拒；关联借出追加
   `locked` 事件但**不算归还**。
2. `POST /incidents/:id/review`：仅 `safety_officer` 可复查（open → reviewed）。
3. `POST /incidents/:id/release`：必须先复查，且仅安全负责人可解除
   （reviewed → released），解除时 lift 事故公告，普通归还随后闭环。

## 视图

- `GET /groups/:id/overview`：导师视角——每位成员对每台工具的可操作范围
  （能力模式不考核当场库存与本人未归还、不要求当场选料）、逐项缺失条件、
  未归还项目及其事故锁定状态。
- `GET /incidents/:id/trace`：安全视角——事故 → 借出 → 当时培训版本 →
  材料批次 → 值班导师/监护人 → 原始准入判定。

## HTTP 接口

`POST /people`、`POST /groups`、`POST /groups/:id/members`、
`PUT /tools/:id`、`POST /tools/:id/status`、
`PUT /people/:personId/qualifications/:toolId`、
`POST /mentors/:id/duty`、`POST /duties/:id/end`、
`POST /consents`、`PUT /materials/:id`、
`POST /notices`、`POST /notices/:id/lift`、
`POST /checkouts`、`POST /loans/:id/return`、`GET /loans`、
`POST /incidents`、`POST /incidents/:id/review`、`POST /incidents/:id/release`、
`GET /incidents/:id/trace`、`GET /decisions`。

错误统一为 `{ error, message, details }`，状态码：400 校验、403 准入拒绝/越权、
404 不存在、409 状态冲突（重复刷卡、锁定中归还、未复查解除等）。

`reference/domain.json` 保存公开的工具风险、资质状态和借用事件枚举。
运行时状态写入 `.runtime/`（可用 `STATE_FILE` 覆盖路径）。
