# 创客实验室工具资质闸门

面向科技展览馆创客实验室工具资质、材料领用和事故停用的 TypeScript 后端服务。每次工具领用在发生当下留下可解释的准入判定，并冻结历史条件快照。

需要 Node.js 22 或更高版本。执行 `npm ci` 安装依赖，`npm test` 完成编译与测试，`npm start` 启动服务，默认监听 8000 端口，`GET /health` 确认进程状态。也可以 `docker compose up --build` 启动容器。运行时数据写入 `.runtime/store.json`（可用 `STORE_FILE` 覆盖）。

> 无法访问 npm registry 的环境可用 `npm run test:strip`：通过 Node 22 内置类型擦除构建到 `dist/` 后运行同一套测试；正式类型检查仍以 `tsc`（`npm run build`）为准。

## 架构

- `src/domain/`：枚举（对齐 `reference/domain.json`）、领域类型与纯函数准入策略 `evaluateAdmission`，输出逐条条件与判定快照。
- `src/store/`：JSON 文件存储，承诺链互斥队列串行化全部变更，保证并发领料临界区原子。
- `src/service/lab-service.ts`：领用、归还、事故、复查、小组视图、事故追溯等业务规则。
- `src/http/`：原生 `node:http` 路由，无第三方运行时依赖。

## HTTP 接口

基础数据（管理员/排课侧）：

- `POST /admin/students` `/mentors` `/safety-officers` `/equipment` `/tools` `/qualifications` `/notices` `/material-batches` `/consents`
- `POST /admin/equipment/:id/status`（available / locked / decommissioned）
- `POST /admin/notices/:id/revoke`

领用流转：

- `POST /checkouts`：body 含 `studentId, toolId, mentorId, groupId, cardSwipeId, materialBatchId?, quantity?`。准入失败返回 `403` 与逐条 `conditions`；重复刷卡返回原借用与 `duplicatedSwipe: true`。
- `POST /loans/:id/return`
- `POST /maintenance/mark-overdue`

事故与复查：

- `POST /incidents`（可带 `loanId`，同时锁设备与借用记录）
- `POST /incidents/:id/review`（仅安全负责人，`cleared: true` 才解锁）
- `GET /incidents`、`GET /incidents/:id/trace`

角色视图：

- `GET /groups/:id`：当班导师、成员可操作工具、缺失条件、未归还项目。

所有时间字段为毫秒时间戳；接口支持可选 `at/now` 注入便于回放与测试。
