# curl 命令手册

## 环境变量

```bash
BASE="https://api.galaxysapi.com"   # 远程访问
BASE="http://localhost:9090"       # 在服务器上直接操作（推荐）
KEY="YOUR_AUTH_KEY"
```

---

## 一、用户账户管理

### 1.1 创建用户

创建一个用户账户，同时自动生成第一个 `sk-` 格式的 Auth Key。
用户之间余额独立，一个用户可以有多个 Auth，所有 Auth 共享该用户的余额。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| username | string | ✅ | 用户名，显示用 |
| initial_balance | float | ❌ | 初始余额，默认 0 |
| user_id | string | ❌ | 指定用户ID（`u_` 开头），不填自动生成 |

```bash
curl -s "$BASE/admin/create_user_account" \
  -H "X-Admin-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"username":"张三","initial_balance":100}' | python3 -m json.tool
```

返回示例：
```json
{
  "message": "成功",
  "data": {
    "user_id": "u_877938b9ad7b4451",
    "username": "张三",
    "balance": 100,
    "authorization": "YOUR_AUTH_KEY...",
    "created_at": "2026-05-20 10:00:00"
  }
}
```

---

### 1.2 列出所有用户

返回所有用户账户及其下的 Auth 列表、余额。

```bash
curl -s "$BASE/admin/list_user_accounts" \
  -H "X-Admin-Key: $KEY" | python3 -m json.tool
```

返回按创建时间倒序，每个用户包含 `user_id`、`username`、`balance`、`auth_count`、`auths` 列表。

---

### 1.3 查询单个用户详情

返回用户的余额、Auth 列表（含每个 Auth 的状态）、当前定价配置。

| 参数 | 说明 |
|------|------|
| user_id | 用户ID |

```bash
curl -s "$BASE/admin/get_user_account?user_id=u_xxx" \
  -H "X-Admin-Key: $KEY" | python3 -m json.tool
```

---

### 1.4 修改用户名

仅修改显示名称，不影响余额和 Auth。

```bash
curl -s "$BASE/admin/rename_user_account" \
  -H "X-Admin-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"u_xxx","username":"新名字"}' | python3 -m json.tool
```

---

### 1.5 删除用户

**危险操作**：级联删除该用户下所有 Auth、调用日志、使用统计、充值记录、价格配置。删除后无法恢复。

```bash
curl -s "$BASE/admin/delete_user_account" \
  -H "X-Admin-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"u_xxx"}' | python3 -m json.tool
```

---

## 二、余额管理

### 2.1 充值（余额累加）

向用户账户充值，余额在原有基础上累加。会写入充值记录（type: recharge）。

| 参数 | 说明 |
|------|------|
| user_id | 用户ID |
| amount | 充值金额，必须 > 0 |

```bash
curl -s "$BASE/admin/recharge_user" \
  -H "X-Admin-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"u_xxx","amount":50}' | python3 -m json.tool
```

返回示例：
```json
{
  "message": "成功",
  "data": {
    "user_id": "u_xxx",
    "previous_balance": 10.0,
    "recharge_amount": 50.0,
    "new_balance": 60.0
  }
}
```

---

### 2.2 设置余额（直接覆盖）

直接将用户余额设为指定值，不受原有余额影响。会写入充值记录（type: set_balance）。
适合修正错误余额，或将用户余额归零。

| 参数 | 说明 |
|------|------|
| user_id | 用户ID |
| amount | 目标余额，≥ 0 |

```bash
curl -s "$BASE/admin/set_user_balance" \
  -H "X-Admin-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"u_xxx","amount":100}' | python3 -m json.tool
```

---

### 2.3 查询充值记录

查询用户的所有余额变动记录，包含充值、设置余额、创建账户等操作。

| 参数 | 说明 |
|------|------|
| user_id | 用户ID |
| type | 类型过滤（可选）：`recharge`充值 / `set_balance`设置余额 / `create`创建账户 / `bind_transfer`绑定转入 |
| start_date | 开始日期，格式 `YYYY-MM-DD`（可选）|
| end_date | 结束日期，格式 `YYYY-MM-DD`（可选）|

```bash
# 查全部
curl -s "$BASE/admin/get_user_recharge_log?user_id=u_xxx" \
  -H "X-Admin-Key: $KEY" | python3 -m json.tool

# 只看充值记录
curl -s "$BASE/admin/get_user_recharge_log?user_id=u_xxx&type=recharge" \
  -H "X-Admin-Key: $KEY" | python3 -m json.tool

# 按日期筛选
curl -s "$BASE/admin/get_user_recharge_log?user_id=u_xxx&start_date=2026-05-01&end_date=2026-05-20" \
  -H "X-Admin-Key: $KEY" | python3 -m json.tool
```

---

## 三、Auth 管理

一个用户可以有多个 Auth Key（`sk-` 格式），所有 Auth 共享该用户余额。
Auth 是用户实际调用 API 时使用的凭证。

### 3.1 在用户下新建 Auth

为已有用户新增一个 Auth Key。

| 参数 | 说明 |
|------|------|
| user_id | 用户ID |
| name | Auth 备注名（可选，默认用用户名）|

```bash
curl -s "$BASE/admin/create_auth_for_user" \
  -H "X-Admin-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"u_xxx","name":"爬虫脚本A"}' | python3 -m json.tool
```

---

### 3.2 列出所有 Auth

返回所有 Auth 的状态，包含是否启用、是否屏蔽、绑定的用户、当前余额。

```bash
curl -s "$BASE/admin/list_auth" \
  -H "X-Admin-Key: $KEY" | python3 -m json.tool
```

> 注意：绑定用户的 Auth 余额字段显示的是该 Auth 本身的余额（始终为0），实际可用余额在用户账户上。

---

### 3.3 启用 / 停用 Auth

停用后该 Auth 无法调用任何接口，返回 401。适合临时禁用某个 Key 而不删除。

```bash
# 停用
curl -s "$BASE/admin/toggle_auth" \
  -H "X-Admin-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"authorization":"sk-xxx","enabled":false}' | python3 -m json.tool

# 启用
curl -s "$BASE/admin/toggle_auth" \
  -H "X-Admin-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"authorization":"sk-xxx","enabled":true}' | python3 -m json.tool
```

---

### 3.4 屏蔽 Auth

屏蔽后该 Auth 调用接口返回 403，区别于停用（401）。
通常由攻击检测自动触发，也可管理员手动执行。

| 参数 | 说明 |
|------|------|
| authorization | Auth Key |
| reason | 屏蔽原因（可选，默认"管理员手动屏蔽"）|

```bash
curl -s "$BASE/admin/block_user" \
  -H "X-Admin-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"authorization":"sk-xxx","reason":"余额不足持续攻击"}' | python3 -m json.tool
```

---

### 3.5 解封 Auth

解除屏蔽，同时清空该 Auth 的攻击记录计数，使其可以重新使用。

```bash
curl -s "$BASE/admin/unblock_user" \
  -H "X-Admin-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"authorization":"sk-xxx"}' | python3 -m json.tool
```

---

### 3.6 清除攻击记录

仅清空攻击计数（不解除屏蔽）。适合用户余额充值后，消除之前的余额不足攻击记录，防止下次扣费触发自动封禁。

```bash
curl -s "$BASE/admin/clear_attack_records" \
  -H "X-Admin-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"authorization":"sk-xxx"}' | python3 -m json.tool
```

---

### 3.7 删除 Auth

删除单个 Auth Key 及其所有调用日志、统计数据、充值记录。不影响用户账户余额和其他 Auth。

```bash
curl -s "$BASE/admin/delete_user" \
  -H "X-Admin-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"authorization":"sk-xxx"}' | python3 -m json.tool
```

---

## 四、定价管理

每个用户可以有独立的接口单价，覆盖系统默认价格（¥0.04）。
不设置则使用默认价格。

### 4.1 查询用户当前价格

返回该用户所有接口的当前单价。

```bash
curl -s "$BASE/admin/get_user_prices?user_id=u_xxx" \
  -H "X-Admin-Key: $KEY" | python3 -m json.tool
```

---

### 4.2 修改接口单价

为某个用户的某个接口设置自定义价格。设置为 0 表示该接口对该用户免费。

| 参数 | 说明 |
|------|------|
| user_id | 用户ID |
| endpoint | 接口名，如 `search_note`、`douyin_search_video` |
| price | 单价（元），≥ 0 |

```bash
# 将搜索笔记价格改为 0.05 元
curl -s "$BASE/admin/set_user_price" \
  -H "X-Admin-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"u_xxx","endpoint":"search_note","price":0.05}' | python3 -m json.tool
```

可用接口名：`get_note_detail` / `get_note_detail_video` / `search_note` / `get_note_comment` / `get_note_sub_comment` / `get_user_info` / `user_note_list` / `tag_notes` / `douyin_video_detail` / `douyin_comment` / `douyin_sub_comment` / `douyin_search_video` / `douyin_search_image_text`

---

## 五、IP 黑名单

封禁后该 IP 的所有请求直接返回 403，不消耗余额。

### 5.1 封禁 IP

```bash
curl -s "$BASE/admin/block_ip" \
  -H "X-Admin-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"ip":"1.2.3.4","reason":"恶意扫描"}' | python3 -m json.tool
```

### 5.2 解封 IP

```bash
curl -s "$BASE/admin/unblock_ip" \
  -H "X-Admin-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"ip":"1.2.3.4"}' | python3 -m json.tool
```

### 5.3 列出所有封禁 IP

```bash
curl -s "$BASE/admin/list_blocked_ips" \
  -H "X-Admin-Key: $KEY" | python3 -m json.tool
```

---

## 六、调用日志

### 6.1 导出调用日志

返回每次 API 调用的详细记录：时间、接口、是否成功、扣费金额、IP、错误信息。

| 参数 | 说明 |
|------|------|
| authorization | 按 Auth 过滤（可选）|
| start_date | 开始日期，格式 `YYYY-MM-DD`（可选）|
| end_date | 结束日期，格式 `YYYY-MM-DD`（可选）|
| sort_by_time | `true` 按时间正序，默认按时间倒序（可选）|

```bash
# 全部日志
curl -s "$BASE/admin/export_call_logs" \
  -H "X-Admin-Key: $KEY" | python3 -m json.tool

# 指定用户 + 日期范围
curl -s "$BASE/admin/export_call_logs?authorization=sk-xxx&start_date=2026-05-01&end_date=2026-05-20" \
  -H "X-Admin-Key: $KEY" | python3 -m json.tool
```

> ⚠️ 数据库较大时不建议不加日期范围直接导出全部。

---

### 6.2 删除用户调用日志

删除指定 Auth 的全部调用日志，释放数据库空间。不影响使用统计汇总数据。

```bash
curl -s -X DELETE "$BASE/admin/delete_user_call_logs?authorization=sk-xxx" \
  -H "X-Admin-Key: $KEY" | python3 -m json.tool
```

---

## 七、统计查询

### 7.1 接口调用统计

按接口聚合，返回各接口的调用次数、成功率、总消费。

| 参数 | 说明 |
|------|------|
| start_date | 开始日期（可选，不填查全部）|
| end_date | 结束日期（可选）|

```bash
# 近7天
curl -s "$BASE/admin/get_endpoint_statistics?start_date=2026-05-13&end_date=2026-05-20" \
  -H "X-Admin-Key: $KEY" | python3 -m json.tool
```

---

### 7.2 用户使用统计

按用户汇总调用次数和消费总额。

```bash
# 所有用户
curl -s "$BASE/admin/get_usage_statistics" \
  -H "X-Admin-Key: $KEY" | python3 -m json.tool

# 指定用户（含按天、按接口明细）
curl -s "$BASE/admin/get_usage_statistics?authorization=sk-xxx" \
  -H "X-Admin-Key: $KEY" | python3 -m json.tool
```

---

### 7.3 查询上游余额

查询上游 API 服务商（星音）账户的剩余余额，60 秒内有缓存。

```bash
curl -s "$BASE/admin/get_upstream_balance" \
  -H "X-Admin-Key: $KEY" | python3 -m json.tool
```

---

## 八、用户自助接口（无需管理员 Key）

以下接口用户可以自己调用，只需要自己的 Auth Key，不消耗余额。

### 8.1 查询余额

返回当前 Auth 可用余额、用户名、创建时间。

```bash
curl -s "$BASE/api/get_balance" \
  -H "Authorization: sk-xxx" | python3 -m json.tool
```

---

### 8.2 查询自己的调用记录

| 参数 | 说明 |
|------|------|
| start_date | 开始日期（可选）|
| end_date | 结束日期（可选）|
| endpoint | 按接口过滤（可选）|
| success | `true` 只看成功 / `false` 只看失败（可选）|

```bash
curl -s "$BASE/api/get_call_logs?start_date=2026-05-01&end_date=2026-05-20" \
  -H "Authorization: sk-xxx" | python3 -m json.tool
```

---

### 8.3 查询自己的充值记录

```bash
curl -s "$BASE/api/get_recharge_log" \
  -H "Authorization: sk-xxx" | python3 -m json.tool
```

---

## 九、快捷组合

### 查看余额最多的前 10 个用户

```bash
curl -s "$BASE/admin/list_user_accounts" -H "X-Admin-Key: $KEY" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)['data']
data.sort(key=lambda x: x['balance'], reverse=True)
print(f'{'用户ID':<22} {'余额':>10}  用户名')
print('-' * 50)
for u in data[:10]:
    print(f\"{u['user_id']:<22} ¥{u['balance']:>9.2f}  {u['username']}\")
"
```

---

### 列出所有被屏蔽的 Auth

```bash
curl -s "$BASE/admin/list_blocked_users" -H "X-Admin-Key: $KEY" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)['data']
if not data:
    print('无屏蔽用户')
else:
    for u in data:
        print(f\"{u['authorization'][:24]}...  {u['name']}  {u['blocked_at']}  {u['block_reason']}\")
"
```

---

### 批量充值（从文件读取）

```bash
# 先创建 recharge_list.txt，每行格式：user_id 金额
# u_abc123 50
# u_def456 100

while read uid amount; do
  result=$(curl -s "$BASE/admin/recharge_user" \
    -H "X-Admin-Key: $KEY" \
    -H "Content-Type: application/json" \
    -d "{\"user_id\":\"$uid\",\"amount\":$amount}")
  msg=$(echo $result | python3 -c "import json,sys; print(json.load(sys.stdin).get('message','?'))")
  new_bal=$(echo $result | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',{}).get('new_balance',''))" 2>/dev/null)
  echo "$uid  充值 $amount 元  $msg  新余额: $new_bal"
done < recharge_list.txt
```
