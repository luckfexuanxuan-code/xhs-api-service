"""
XHS API 管理接口示例代码
服务地址: http://8.140.241.29:9090
"""

import requests

BASE_URL = "http://8.140.241.29:9090"
ADMIN_KEY = "YOUR_AUTH_KEY"   # X-Admin-Key


# ============================================================
# 1. 创建用户
# ============================================================
def create_user(username: str, user_id: str = None, initial_balance: float = 0):
    """
    创建用户账户，同时自动生成第一个 sk- 开头的 Auth。

    :param username:        用户名（必填）
    :param user_id:         用户ID，格式 u_xxxxxxxxxxxxxxxx（不填则自动生成）
    :param initial_balance: 初始余额，默认 0
    :return: { user_id, username, balance, authorization, created_at }
    """
    payload = {
        "username": username,
        "initial_balance": initial_balance
    }
    if user_id:
        payload["user_id"] = user_id

    resp = requests.post(
        f"{BASE_URL}/admin/create_user_account",
        json=payload,
        headers={"X-Admin-Key": ADMIN_KEY}
    )
    return resp.json()

# 示例
# result = create_user("张三", initial_balance=100)
# print(result)
# {
#   "message": "成功",
#   "data": {
#     "user_id": "u_877938b9ad7b4451",
#     "username": "张三",
#     "balance": 100,
#     "authorization": "YOUR_AUTH_KEY...",  ← 自动生成的第一个 Auth
#     "created_at": "2026-05-14 20:03:13"
#   }
# }


# ============================================================
# 2. 创建 Auth（管理员）
# ============================================================
def create_auth_for_user(user_id: str, name: str = None):
    """
    在指定用户下创建新的 Auth（需要管理员密钥）。

    :param user_id: 用户ID
    :param name:    Auth 备注名（不填则使用用户名）
    :return: { authorization, user_id, created_at }
    """
    payload = {"user_id": user_id}
    if name:
        payload["name"] = name

    resp = requests.post(
        f"{BASE_URL}/admin/create_auth_for_user",
        json=payload,
        headers={"X-Admin-Key": ADMIN_KEY}
    )
    return resp.json()

# 示例
# result = create_auth_for_user("u_877938b9ad7b4451", name="爬虫脚本A")
# print(result)
# {
#   "message": "成功",
#   "data": {
#     "authorization": "YOUR_AUTH_KEY...",
#     "user_id": "u_877938b9ad7b4451",
#     "created_at": "2026-05-14 20:03:14"
#   }
# }


# ============================================================
# 2b. 创建 Auth（用户自助，无需管理员密钥）
# ============================================================
def create_auth_self(user_id: str):
    """
    用户凭 user_id 自助创建新 Auth，不需要管理员密钥。

    :param user_id: 用户ID
    :return: { authorization, user_id, created_at }
    """
    resp = requests.post(
        f"{BASE_URL}/user/create_auth",
        json={"user_id": user_id}
    )
    return resp.json()

# 示例
# result = create_auth_self("u_877938b9ad7b4451")
# print(result)
# {
#   "message": "成功",
#   "data": {
#     "authorization": "sk-9a1f3c...",
#     "user_id": "u_877938b9ad7b4451",
#     "created_at": "2026-05-14 20:10:00"
#   }
# }


# ============================================================
# 3. 删除 Auth
# ============================================================
def delete_auth(authorization: str):
    """
    删除指定 Auth（管理员操作，不影响用户余额）。

    :param authorization: Auth Key
    :return: { message, cleaned }
    """
    resp = requests.post(
        f"{BASE_URL}/admin/delete_user",
        json={"authorization": authorization},
        headers={"X-Admin-Key": ADMIN_KEY}
    )
    return resp.json()

# 示例
# result = delete_auth("YOUR_AUTH_KEY...")
# print(result)
# {
#   "message": "成功",
#   "cleaned": { "user": 1, "prices": 0, "usage": 0, "recharge": 0, "call_logs": 0 }
# }


# ============================================================
# 4. 获取用户余额
# ============================================================
def get_balance(authorization: str):
    """
    使用 Auth Key 查询当前余额。
    绑定了用户的 Auth 返回的是用户总余额。

    :param authorization: Auth Key（sk- 开头或旧格式均可）
    :return: { balance, name, created_at, user_id }
    """
    resp = requests.get(
        f"{BASE_URL}/api/get_balance",
        headers={"Authorization": authorization}
    )
    return resp.json()

# 示例
# result = get_balance("YOUR_AUTH_KEY...")
# print(result)
# {
#   "message": "成功",
#   "data": {
#     "balance": 10.0,
#     "name": "张三",
#     "created_at": "2026-05-14 20:03:13",
#     "user_id": "u_877938b9ad7b4451"
#   }
# }


# ============================================================
# 5. 获取用户 Auth 列表
# ============================================================
def get_user_auths(user_id: str):
    """
    获取用户下所有 Auth 的详情，以及用户余额、价格配置。

    :param user_id: 用户ID
    :return: { user_id, username, balance, last_used_at, auths: [...], prices: {...} }
    """
    resp = requests.get(
        f"{BASE_URL}/admin/get_user_account",
        params={"user_id": user_id},
        headers={"X-Admin-Key": ADMIN_KEY}
    )
    return resp.json()

# 示例
# result = get_user_auths("u_877938b9ad7b4451")
# data = result["data"]
# print(f"余额: {data['balance']}")
# print(f"Auth 数量: {len(data['auths'])}")
# for auth in data["auths"]:
#     print(f"  {auth['authorization']}  状态:{'正常' if auth['enabled'] and not auth['blocked'] else '异常'}  创建:{auth['created_at']}")
#
# 输出:
# 余额: 10.0
# Auth 数量: 2
#   YOUR_AUTH_KEY...  状态:正常  创建:2026-05-14 20:03:13
#   YOUR_AUTH_KEY...    状态:正常  创建:2026-05-14 20:03:14


# ============================================================
# 6. 获取用户充值记录
# ============================================================
def get_recharge_log(user_id: str, type_filter: str = None,
                     start_date: str = None, end_date: str = None):
    """
    查询用户的充值/余额变动记录。

    :param user_id:      用户ID
    :param type_filter:  类型过滤（可选）:
                           recharge      - 充值
                           set_balance   - 设置余额
                           create        - 创建账户
                           bind_transfer - 绑定Auth余额转入
    :param start_date:   开始日期，格式 YYYY-MM-DD（可选）
    :param end_date:     结束日期，格式 YYYY-MM-DD（可选）
    :return: { records: [...], count, total_recharge }
    """
    params = {"user_id": user_id}
    if type_filter:
        params["type"] = type_filter
    if start_date:
        params["start_date"] = start_date
    if end_date:
        params["end_date"] = end_date

    resp = requests.get(
        f"{BASE_URL}/admin/get_user_recharge_log",
        params=params,
        headers={"X-Admin-Key": ADMIN_KEY}
    )
    return resp.json()

# 示例
# result = get_recharge_log("u_877938b9ad7b4451")
# data = result["data"]
# print(f"共 {data['count']} 条，总充值 ¥{data['total_recharge']}")
# for r in data["records"]:
#     print(f"  {r['timestamp']}  {r['type']}  {'+' if r['amount']>=0 else ''}{r['amount']}  {r['remark']}")
#
# 输出:
# 共 1 条，总充值 ¥10
#   2026-05-14 20:03:13  create  +10  创建用户账户，初始余额 10 元


# ============================================================
# 完整流程示例
# ============================================================
if __name__ == "__main__":
    # # 1. 创建用户
    # res = create_user("测试客户", initial_balance=50)
    # user_id = res["data"]["user_id"]
    # first_auth = res["data"]["authorization"]
    # print(f"创建用户: {user_id}，初始Auth: {first_auth[:20]}...")

    # # 2. 再创建一个 Auth
    # res2 = create_auth_for_user(user_id, name="脚本B")
    # second_auth = res2["data"]["authorization"]
    # print(f"新建Auth: {second_auth[:20]}...")

    # # 3. 查询余额
    # bal = get_balance(first_auth)
    # print(f"余额: ¥{bal['data']['balance']}")

    # # 4. 查询 Auth 列表
    user_id="u_33016b957482a827"  # 替换为实际用户ID
    detail = get_user_auths(user_id)
    print(detail)

    # # 5. 查询充值记录
    # log = get_recharge_log(user_id)
    # print(f"充值记录: {log['data']['count']} 条")

    # # 6. 删除第二个 Auth
    # delete_auth(second_auth)
    # print("已删除第二个 Auth")
