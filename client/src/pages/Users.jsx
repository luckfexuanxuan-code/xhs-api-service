import { useState, useEffect, useCallback } from 'react'
import { adminApi } from '../services/api.jsx'


// ==================== 通用小组件 ====================

function Modal({ title, onClose, children, width = 520 }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: width }}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        {children}
      </div>
    </div>
  )
}

function CopyText({ text, short = false }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    try {
      const ta = document.createElement('textarea')
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta)
      setCopied(true); setTimeout(() => setCopied(false), 1500)
    } catch (_) {}
  }
  return (
    <code style={{ fontSize: 11, cursor: 'pointer', color: copied ? '#52c41a' : undefined, wordBreak: 'break-all' }}
      onClick={copy} title="点击复制">
      {copied ? '已复制' : (short ? text.substring(0, 22) + '…' : text)}
    </code>
  )
}

// ==================== 定价弹窗 ====================

function PriceModal({ userId, username, onClose, endpointList }) {
  const [prices, setPrices] = useState({})
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    const init = Object.fromEntries(endpointList.map(ep => [ep.type, ep.price]))
    adminApi.getUserPrices({ user_id: userId })
      .then(r => { Object.assign(init, r.data.data || {}); setPrices(init) })
      .catch(() => setPrices(init))
  }, [userId, endpointList])

  const saveAll = async () => {
    setSaving(true)
    try {
      for (const [ep, price] of Object.entries(prices)) {
        const v = parseFloat(price)
        if (!isNaN(v) && v >= 0) await adminApi.setUserPrice({ user_id: userId, endpoint: ep, price: v })
      }
      setMsg({ text: '全部已保存', type: 'success' })
      setTimeout(() => { setMsg(null); onClose() }, 800)
    } catch (e) { setMsg({ text: e.response?.data?.error || '保存失败', type: 'error' }) }
    setSaving(false)
  }

  return (
    <Modal title={`定价 - ${username}`} onClose={onClose} width={620}>
      {msg && <div className={`message message-${msg.type}`}>{msg.text}</div>}
      <div style={{ maxHeight: 420, overflowY: 'auto' }}>
        <table style={{ width: '100%', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f8fafc' }}>
              <th style={{ padding: '8px 6px', textAlign: 'left' }}>接口</th>
              <th style={{ padding: '8px 6px', textAlign: 'center', width: 80 }}>默认</th>
              <th style={{ padding: '8px 6px', textAlign: 'center', width: 110 }}>自定义</th>
            </tr>
          </thead>
          <tbody>
            {endpointList.map(ep => (
              <tr key={ep.type} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '7px 6px' }}>
                  <div>{ep.name}</div><div style={{ fontSize: 10, color: '#64748b' }}>{ep.type}</div>
                </td>
                <td style={{ textAlign: 'center', color: '#64748b', padding: '7px 6px' }}>¥{ep.price}</td>
                <td style={{ textAlign: 'center', padding: '7px 6px' }}>
                  <input type="number" style={{ width: 85, padding: '3px 6px', textAlign: 'center' }}
                    value={prices[ep.type] ?? ''} step="0.01" min="0" placeholder={ep.price}
                    onChange={e => setPrices({ ...prices, [ep.type]: e.target.value })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>关闭</button>
        <button className="btn btn-primary" onClick={saveAll} disabled={saving}>{saving ? '保存中...' : '保存全部'}</button>
      </div>
    </Modal>
  )
}

// 频率设置（用户级）：对该用户名下所有密钥的某接口设置最小调用间隔（秒）。密钥级设置会覆盖此值。
function ThrottleModal({ userId, username, onClose, endpointList }) {
  const [intervals, setIntervals] = useState({})
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    adminApi.getThrottles('user', userId)
      .then(r => setIntervals(r.data.data || {}))
      .catch(() => setIntervals({}))
  }, [userId])

  const saveAll = async () => {
    setSaving(true)
    try {
      for (const ep of endpointList) {
        const raw = intervals[ep.type]
        const v = (raw === '' || raw === undefined || raw === null) ? 0 : parseInt(raw, 10)
        if (Number.isFinite(v) && v >= 0) await adminApi.setThrottle('user', userId, ep.type, v)
      }
      setMsg({ text: '已保存', type: 'success' })
      setTimeout(() => { setMsg(null); onClose() }, 800)
    } catch (e) { setMsg({ text: e.response?.data?.error || '保存失败', type: 'error' }) }
    setSaving(false)
  }

  return (
    <Modal title={`频率设置 - ${username}`} onClose={onClose} width={620}>
      {msg && <div className={`message message-${msg.type}`}>{msg.text}</div>}
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
        【用户级】对该用户名下<strong>所有密钥</strong>的该接口生效；某密钥的密钥级设置会覆盖此值。<br />
        每个接口的<strong>最小调用间隔（秒）</strong>：N 秒内只放行 1 次，其余请求返回 429（不计费、不转发上游）。留空或 0 表示不限制。
      </div>
      <div style={{ maxHeight: 420, overflowY: 'auto' }}>
        <table style={{ width: '100%', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f8fafc' }}>
              <th style={{ padding: '8px 6px', textAlign: 'left' }}>接口</th>
              <th style={{ padding: '8px 6px', textAlign: 'center', width: 150 }}>最小间隔(秒)</th>
            </tr>
          </thead>
          <tbody>
            {endpointList.map(ep => (
              <tr key={ep.type} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '7px 6px' }}>
                  <div>{ep.name}</div><div style={{ fontSize: 10, color: '#64748b' }}>{ep.type}</div>
                </td>
                <td style={{ textAlign: 'center', padding: '7px 6px' }}>
                  <input type="number" style={{ width: 100, padding: '3px 6px', textAlign: 'center' }}
                    value={intervals[ep.type] ?? ''} step="1" min="0" placeholder="不限"
                    onChange={e => setIntervals({ ...intervals, [ep.type]: e.target.value })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>关闭</button>
        <button className="btn btn-primary" onClick={saveAll} disabled={saving}>{saving ? '保存中...' : '保存全部'}</button>
      </div>
    </Modal>
  )
}

// ==================== Auth管理弹窗 ====================

function AuthManageModal({ user, onClose, showMsg }) {
  const [auths, setAuths] = useState(user.auths || [])
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [bindKey, setBindKey] = useState('')
  const [binding, setBinding] = useState(false)

  const reload = async () => {
    const r = await adminApi.getUserAccount(user.user_id)
    setAuths(r.data.data.auths || [])
  }

  const createAuth = async () => {
    setCreating(true)
    try {
      await adminApi.createAuthForUser(user.user_id, newName)
      setNewName(''); showMsg('Auth创建成功'); reload()
    } catch (e) { showMsg(e.response?.data?.error || '创建失败', 'error') }
    setCreating(false)
  }

  const bindExisting = async () => {
    if (!bindKey.trim()) return
    setBinding(true)
    try {
      const r = await adminApi.bindAuthToUser(bindKey.trim(), user.user_id)
      showMsg(`绑定成功，转移余额 ¥${r.data.data.transferred_balance}`)
      setBindKey(''); reload()
    } catch (e) { showMsg(e.response?.data?.error || '绑定失败', 'error') }
    setBinding(false)
  }

  const toggle = async (a) => {
    try { await adminApi.toggleAuth(a.authorization, !a.enabled); reload() }
    catch (_) { showMsg('操作失败', 'error') }
  }

  const block = async (a) => {
    if (!confirm(`确定${a.blocked ? '解除屏蔽' : '屏蔽'}？`)) return
    try {
      if (a.blocked) await adminApi.unblockUser(a.authorization)
      else await adminApi.blockUser(a.authorization, '管理员手动屏蔽')
      reload()
    } catch (_) { showMsg('操作失败', 'error') }
  }

  const del = async (a) => {
    if (!confirm('确定删除此Auth？')) return
    try { await adminApi.deleteUser(a.authorization); showMsg('已删除'); reload() }
    catch (_) { showMsg('删除失败', 'error') }
  }

  return (
    <Modal title={`Auth管理 - ${user.username}`} onClose={onClose} width={740}>
      <div style={{ background: '#f8fafc', borderRadius: 6, padding: '10px 12px', marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <input className="form-control" style={{ flex: 1, minWidth: 160 }}
            placeholder="新 Auth 备注名（可选）" value={newName}
            onChange={e => setNewName(e.target.value)} />
          <button className="btn btn-primary" onClick={createAuth} disabled={creating} style={{ whiteSpace: 'nowrap' }}>
            {creating ? '创建中...' : '+ 新建 Auth'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input className="form-control" style={{ flex: 1, minWidth: 200 }}
            placeholder="粘贴已有 Auth Key 进行绑定" value={bindKey}
            onChange={e => setBindKey(e.target.value)} />
          <button className="btn btn-secondary" onClick={bindExisting} disabled={binding} style={{ whiteSpace: 'nowrap' }}>
            {binding ? '绑定中...' : '绑定已有 Auth'}
          </button>
        </div>
      </div>

      <div style={{ maxHeight: 360, overflowY: 'auto' }}>
        {auths.length === 0
          ? <div style={{ padding: 30, textAlign: 'center', color: '#64748b' }}>暂无 Auth</div>
          : <table style={{ width: '100%', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  <th style={{ padding: '8px 6px', textAlign: 'left' }}>Auth Key</th>
                  <th style={{ padding: '8px 6px', textAlign: 'left' }}>名称</th>
                  <th style={{ padding: '8px 6px', textAlign: 'center', width: 72 }}>状态</th>
                  <th style={{ padding: '8px 6px', textAlign: 'left', width: 148 }}>创建时间</th>
                  <th style={{ padding: '8px 6px', textAlign: 'center', width: 170 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {auths.map(a => (
                  <tr key={a.authorization} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={{ padding: '8px 6px' }}><CopyText text={a.authorization} short /></td>
                    <td style={{ padding: '8px 6px', fontSize: 13 }}>
                      {a.name}
                      {a.is_default && <span className="badge badge-primary" style={{ fontSize: 10, marginLeft: 5 }}>默认</span>}
                    </td>
                    <td style={{ padding: '8px 6px', textAlign: 'center' }}>
                      {a.blocked
                        ? <span className="badge badge-danger" style={{ fontSize: 11 }}>屏蔽</span>
                        : a.enabled
                          ? <span className="badge badge-success" style={{ fontSize: 11 }}>正常</span>
                          : <span className="badge badge-warning" style={{ fontSize: 11 }}>禁用</span>
                      }
                    </td>
                    <td style={{ padding: '8px 6px', fontSize: 12, color: '#94a3b8' }}>{a.created_at}</td>
                    <td style={{ padding: '8px 6px', textAlign: 'center' }}>
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                        <button className="btn btn-sm btn-secondary" onClick={() => toggle(a)} style={{ padding: '2px 8px', fontSize: 12 }}>
                          {a.enabled ? '禁用' : '启用'}
                        </button>
                        <button className={`btn btn-sm ${a.blocked ? 'btn-success' : 'btn-warning'}`} onClick={() => block(a)} style={{ padding: '2px 8px', fontSize: 12 }}>
                          {a.blocked ? '解屏蔽' : '屏蔽'}
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={() => del(a)} style={{ padding: '2px 8px', fontSize: 12 }}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
        }
      </div>
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>关闭</button>
      </div>
    </Modal>
  )
}

// ==================== 充值记录弹窗 ====================

function RechargeLogModal({ userId, username, onClose }) {
  const [records, setRecords] = useState(null)
  const [loading, setLoading] = useState(false)
  const [typeFilter, setTypeFilter] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const params = { user_id: userId }
      if (typeFilter) params.type = typeFilter
      const r = await adminApi.getUserRechargeLog(params)
      setRecords(r.data.data)
    } catch (_) {}
    setLoading(false)
  }

  const typeLabel = { recharge: '充值', deduct: '扣减', set_balance: '设置余额', create: '创建', bind_transfer: '绑定转移' }

  return (
    <Modal title={`充值记录 - ${username}`} onClose={onClose} width={760}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="form-group" style={{ margin: 0 }}>
          <label style={{ fontSize: 12 }}>类型</label>
          <select className="form-control" style={{ width: 130 }} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">全部</option>
            <option value="recharge">充值</option>
            <option value="set_balance">设置余额</option>
            <option value="create">创建</option>
            <option value="bind_transfer">绑定转移</option>
          </select>
        </div>
        <button className="btn btn-primary" onClick={load} disabled={loading} style={{ height: 36 }}>
          {loading ? '查询中...' : '查询'}
        </button>
      </div>
      {records
        ? <div>
            <div style={{ marginBottom: 8, display: 'flex', gap: 15 }}>
              <span className="badge badge-success">{records.count} 条</span>
              <span style={{ fontSize: 13, color: '#ff2442', fontWeight: 600 }}>总充值: ¥{records.total_recharge}</span>
            </div>
            <div style={{ maxHeight: 380, overflowY: 'auto' }}>
              <table style={{ width: '100%', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    <th style={{ padding: 8 }}>时间</th>
                    <th style={{ padding: 8, textAlign: 'center' }}>类型</th>
                    <th style={{ padding: 8, textAlign: 'right' }}>变动</th>
                    <th style={{ padding: 8, textAlign: 'right' }}>变动前</th>
                    <th style={{ padding: 8, textAlign: 'right' }}>变动后</th>
                    <th style={{ padding: 8 }}>备注</th>
                  </tr>
                </thead>
                <tbody>
                  {records.records.length === 0
                    ? <tr><td colSpan={6} style={{ textAlign: 'center', color: '#64748b', padding: 30 }}>暂无记录</td></tr>
                    : records.records.map((r, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: 8, fontSize: 12 }}>{r.timestamp}</td>
                        <td style={{ padding: 8, textAlign: 'center' }}>
                          <span className="badge badge-primary" style={{ fontSize: 11 }}>{typeLabel[r.type] || r.type}</span>
                        </td>
                        <td style={{ padding: 8, textAlign: 'right', color: r.amount >= 0 ? '#52c41a' : '#ff4d4f', fontWeight: 600 }}>
                          {r.amount >= 0 ? '+' : ''}{r.amount}
                        </td>
                        <td style={{ padding: 8, textAlign: 'right' }}>¥{r.before_balance}</td>
                        <td style={{ padding: 8, textAlign: 'right' }}>¥{r.after_balance}</td>
                        <td style={{ padding: 8, fontSize: 12, color: '#94a3b8' }}>{r.remark}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        : <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>点击"查询"加载记录</div>
      }
      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>关闭</button>
      </div>
    </Modal>
  )
}

// ==================== 主组件 ====================

function Users() {
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState(null)
  const [modal, setModal] = useState(null)
  const [endpointList, setEndpointList] = useState([])
  const [search, setSearch] = useState('')

  const showMsg = useCallback((text, type = 'success') => {
    setMessage({ text, type })
    setTimeout(() => setMessage(null), 3000)
  }, [])

  const closeModal = useCallback(() => setModal(null), [])

  const load = async () => {
    try {
      const [r, epR] = await Promise.all([
        adminApi.listUserAccounts(),
        adminApi.getEndpointList()
      ])
      setAccounts(r.data.data || [])
      setEndpointList(epR.data.data?.endpoints || [])
    } catch (_) { showMsg('加载失败', 'error') }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  // ---- 操作 ----

  const handleCreate = async (e) => {
    e.preventDefault()
    const { userId, username, initial_balance } = modal.data
    try {
      const r = await adminApi.createUserAccount({
        user_id: userId.trim() || undefined,
        username: username.trim(),
        initial_balance: parseFloat(initial_balance) || 0
      })
      showMsg(`用户「${r.data.data.username}」创建成功`)
      closeModal(); load()
    } catch (e) { showMsg(e.response?.data?.error || '创建失败', 'error') }
  }

  const handleRename = async (e) => {
    e.preventDefault()
    try {
      await adminApi.renameUserAccount(modal.data.userId, modal.data.username)
      showMsg('已更新'); closeModal(); load()
    } catch (e) { showMsg(e.response?.data?.error || '修改失败', 'error') }
  }

  const handleRecharge = async (e) => {
    e.preventDefault()
    const dir = modal.data.direction === 'sub' ? -1 : 1
    const mag = Math.abs(parseFloat(modal.data.amount))
    if (!(mag > 0)) { showMsg('请输入大于0的金额', 'error'); return }
    try {
      const r = await adminApi.rechargeUser(modal.data.userId, dir * mag)
      showMsg(`${dir > 0 ? '增加' : '减少'}成功，新余额: ¥${r.data.data.new_balance}`)
      closeModal(); load()
    } catch (e) { showMsg(e.response?.data?.error || '操作失败', 'error') }
  }

  const handleSetBalance = async (e) => {
    e.preventDefault()
    try {
      const r = await adminApi.setUserBalance(modal.data.userId, parseFloat(modal.data.amount))
      showMsg(`余额已设置为 ¥${r.data.data.balance}`)
      closeModal(); load()
    } catch (e) { showMsg(e.response?.data?.error || '设置失败', 'error') }
  }

  const handleDelete = async (acc) => {
    if (!confirm(`确定删除用户「${acc.username}」？将级联删除 ${acc.auth_count} 个 Auth，不可恢复！`)) return
    try {
      await adminApi.deleteUserAccount(acc.user_id)
      showMsg('删除成功'); load()
    } catch (e) { showMsg(e.response?.data?.error || '删除失败', 'error') }
  }

  if (loading) return <div className="loading">加载中...</div>

  const totalBalance = accounts.reduce((s, a) => s + a.balance, 0)
  const totalAuths = accounts.reduce((s, a) => s + a.auth_count, 0)
  const kw = search.trim().toLowerCase()
  const filteredAccounts = kw
    ? accounts.filter(a => a.username.toLowerCase().includes(kw) || a.user_id.toLowerCase().includes(kw))
    : accounts

  return (
    <div>
      {message && <div className={`message message-${message.type}`}>{message.text}</div>}

      <div className="page-header">
        <div className="page-title-block">
          <h1>用户管理</h1>
          <p>管理客户账户、余额、Auth 绑定和充值记录。</p>
        </div>
        <div className="page-header-actions">
          <input
            className="form-control"
            style={{ width: 220, height: 36 }}
            placeholder="搜索用户名 / 用户 ID"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button className="btn btn-primary"
            onClick={() => setModal({ type: 'create', data: { userId: '', username: '', initial_balance: '' } })}>
            + 创建用户
          </button>
        </div>
      </div>

      <div className="page-toolbar">
        <div className="page-header-meta">
          {kw
            ? <>筛选到 <strong>{filteredAccounts.length}</strong> / {accounts.length} 个用户 · 总余额 ¥{totalBalance.toFixed(2)}</>
            : <>共 {accounts.length} 个用户 · {totalAuths} 个 Auth · 总余额 ¥{totalBalance.toFixed(2)}</>
          }
        </div>
      </div>

      <div className="card">
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>用户名</th>
                <th>用户 ID</th>
                <th>余额</th>
                <th>Auth 数</th>
                <th>创建时间</th>
                <th>最近使用</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredAccounts.length === 0
                ? <tr><td colSpan={7} style={{ textAlign: 'center', color: '#64748b', padding: 30 }}>{kw ? '无匹配用户' : '暂无用户'}</td></tr>
                : filteredAccounts.map(acc => (
                  <tr key={acc.user_id}>
                    <td><strong>{acc.username}</strong></td>
                    <td><CopyText text={acc.user_id} /></td>
                    <td>
                      <span style={{ fontWeight: 600, color: acc.balance < 1 ? '#f87171' : '#0f172a' }}>
                        ¥{acc.balance.toFixed(2)}
                      </span>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <span className="badge badge-primary">{acc.auth_count}</span>
                    </td>
                    <td style={{ fontSize: 12, color: '#94a3b8' }}>{acc.created_at}</td>
                    <td style={{ fontSize: 12, color: '#94a3b8' }}>{acc.last_used_at || '-'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        <button className="btn btn-sm btn-success"
                          onClick={() => setModal({ type: 'recharge', data: { userId: acc.user_id, username: acc.username, balance: acc.balance, amount: '' } })}>
                          充值
                        </button>
                        <button className="btn btn-sm btn-warning"
                          onClick={() => setModal({ type: 'setBalance', data: { userId: acc.user_id, username: acc.username, balance: acc.balance, amount: String(acc.balance) } })}>
                          设余额
                        </button>
                        <button className="btn btn-sm btn-primary"
                          onClick={() => setModal({ type: 'price', data: { userId: acc.user_id, username: acc.username } })}>
                          定价
                        </button>
                        <button className="btn btn-sm btn-primary"
                          onClick={() => setModal({ type: 'throttle', data: { userId: acc.user_id, username: acc.username } })}>
                          频率
                        </button>
                        <button className="btn btn-sm btn-secondary"
                          onClick={() => setModal({ type: 'edit', data: { userId: acc.user_id, username: acc.username } })}>
                          编辑
                        </button>
                        <button className="btn btn-sm btn-secondary"
                          onClick={() => setModal({ type: 'auths', data: acc })}>
                          Auth 管理
                        </button>
                        <button className="btn btn-sm btn-secondary"
                          onClick={() => setModal({ type: 'rechargeLog', data: { userId: acc.user_id, username: acc.username } })}>
                          记录
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={() => handleDelete(acc)}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 创建用户 */}
      {modal?.type === 'create' && (
        <Modal title="创建用户" onClose={closeModal}>
          <form onSubmit={handleCreate}>
            <div className="form-group">
              <label>用户名 *</label>
              <input className="form-control" required value={modal.data.username}
                onChange={e => setModal({ ...modal, data: { ...modal.data, username: e.target.value } })} />
            </div>
            <div className="form-group">
              <label>用户 ID（留空自动生成）</label>
              <input className="form-control" placeholder="u_33016b957482a827" value={modal.data.userId}
                onChange={e => setModal({ ...modal, data: { ...modal.data, userId: e.target.value } })} />
            </div>
            <div className="form-group">
              <label>初始余额</label>
              <input className="form-control" type="number" step="0.01" min="0" value={modal.data.initial_balance}
                onChange={e => setModal({ ...modal, data: { ...modal.data, initial_balance: e.target.value } })} />
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={closeModal}>取消</button>
              <button type="submit" className="btn btn-primary">创建</button>
            </div>
          </form>
        </Modal>
      )}

      {/* 编辑 */}
      {modal?.type === 'edit' && (
        <Modal title="编辑用户" onClose={closeModal}>
          <form onSubmit={handleRename}>
            <div className="form-group">
              <label>用户 ID</label>
              <input className="form-control" value={modal.data.userId} disabled />
            </div>
            <div className="form-group">
              <label>用户名 *</label>
              <input className="form-control" required value={modal.data.username}
                onChange={e => setModal({ ...modal, data: { ...modal.data, username: e.target.value } })} />
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={closeModal}>取消</button>
              <button type="submit" className="btn btn-primary">保存</button>
            </div>
          </form>
        </Modal>
      )}

      {/* 充值 / 调整余额 */}
      {modal?.type === 'recharge' && (() => {
        const isSub = modal.data.direction === 'sub'
        return (
        <Modal title={`调整余额 - ${modal.data.username}`} onClose={closeModal}>
          <form onSubmit={handleRecharge}>
            <div className="form-group">
              <label>当前余额</label>
              <input className="form-control" value={`¥${modal.data.balance.toFixed(2)}`} disabled />
            </div>
            <div className="form-group">
              <label>操作</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className={`btn ${!isSub ? 'btn-success' : 'btn-secondary'}`} style={{ flex: 1 }}
                  onClick={() => setModal({ ...modal, data: { ...modal.data, direction: 'add' } })}>增加（充值）</button>
                <button type="button" className={`btn ${isSub ? 'btn-danger' : 'btn-secondary'}`} style={{ flex: 1 }}
                  onClick={() => setModal({ ...modal, data: { ...modal.data, direction: 'sub' } })}>减少（扣减）</button>
              </div>
            </div>
            <div className="form-group">
              <label>{isSub ? '扣减' : '充值'}金额 *</label>
              <input className="form-control" type="number" step="0.01" min="0.01" required value={modal.data.amount}
                onChange={e => setModal({ ...modal, data: { ...modal.data, amount: e.target.value } })} />
              {modal.data.amount > 0 && (
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 6 }}>
                  调整后余额：¥{(modal.data.balance + (isSub ? -1 : 1) * Math.abs(parseFloat(modal.data.amount) || 0)).toFixed(2)}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={closeModal}>取消</button>
              <button type="submit" className={`btn ${isSub ? 'btn-danger' : 'btn-success'}`}>{isSub ? '确认扣减' : '确认充值'}</button>
            </div>
          </form>
        </Modal>
        )
      })()}

      {/* 设置余额 */}
      {modal?.type === 'setBalance' && (
        <Modal title={`设置余额 - ${modal.data.username}`} onClose={closeModal}>
          <form onSubmit={handleSetBalance}>
            <div className="form-group">
              <label>当前余额</label>
              <input className="form-control" value={`¥${modal.data.balance.toFixed(2)}`} disabled />
            </div>
            <div className="form-group">
              <label>设置为 *</label>
              <input className="form-control" type="number" step="0.01" min="0" required value={modal.data.amount}
                onChange={e => setModal({ ...modal, data: { ...modal.data, amount: e.target.value } })} />
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={closeModal}>取消</button>
              <button type="submit" className="btn btn-warning">确认设置</button>
            </div>
          </form>
        </Modal>
      )}

      {/* 定价 */}
      {modal?.type === 'price' && (
        <PriceModal userId={modal.data.userId} username={modal.data.username} onClose={closeModal} endpointList={endpointList} />
      )}

      {/* 频率设置（用户级） */}
      {modal?.type === 'throttle' && (
        <ThrottleModal userId={modal.data.userId} username={modal.data.username} onClose={closeModal} endpointList={endpointList} />
      )}

      {/* Auth管理 */}
      {modal?.type === 'auths' && (
        <AuthManageModal user={modal.data} onClose={closeModal} showMsg={showMsg} />
      )}

      {/* 充值记录 */}
      {modal?.type === 'rechargeLog' && (
        <RechargeLogModal userId={modal.data.userId} username={modal.data.username} onClose={closeModal} />
      )}
    </div>
  )
}

export default Users
