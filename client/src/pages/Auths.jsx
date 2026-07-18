import { useState, useEffect, useCallback } from 'react'
import { adminApi } from '../services/api.jsx'


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

function PriceModal({ target, onClose, endpointList }) {
  const [prices, setPrices] = useState({})
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    const init = Object.fromEntries(endpointList.map(ep => [ep.type, ep.price]))
    const params = target.user_id ? { user_id: target.user_id } : { authorization: target.authorization }
    adminApi.getUserPrices(params)
      .then(r => { Object.assign(init, r.data.data || {}); setPrices(init) })
      .catch(() => setPrices(init))
  }, [target, endpointList])

  const saveAll = async () => {
    setSaving(true)
    try {
      for (const [ep, price] of Object.entries(prices)) {
        const v = parseFloat(price)
        if (!isNaN(v) && v >= 0) {
          await adminApi.setUserPrice(
            target.user_id
              ? { user_id: target.user_id, endpoint: ep, price: v }
              : { authorization: target.authorization, endpoint: ep, price: v }
          )
        }
      }
      setMsg({ text: '已保存', type: 'success' })
      setTimeout(() => { setMsg(null); onClose() }, 800)
    } catch (e) { setMsg({ text: e.response?.data?.error || '保存失败', type: 'error' }) }
    setSaving(false)
  }

  return (
    <Modal title={`定价 - ${target.username || target.name}`} onClose={onClose} width={620}>
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

// 频率设置：对某 scope（global/user/auth）的某接口设置最小调用间隔（秒）。N 秒内只放行一次；留空/0 = 不限。
function ThrottleModal({ scope, scopeId, title, onClose, endpointList }) {
  const [intervals, setIntervals] = useState({})
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    adminApi.getThrottles(scope, scopeId)
      .then(r => setIntervals(r.data.data || {}))
      .catch(() => setIntervals({}))
  }, [scope, scopeId])

  const saveAll = async () => {
    setSaving(true)
    try {
      for (const ep of endpointList) {
        const raw = intervals[ep.type]
        const v = (raw === '' || raw === undefined || raw === null) ? 0 : parseInt(raw, 10)
        if (Number.isFinite(v) && v >= 0) {
          await adminApi.setThrottle(scope, scopeId, ep.type, v)
        }
      }
      setMsg({ text: '已保存', type: 'success' })
      setTimeout(() => { setMsg(null); onClose() }, 800)
    } catch (e) { setMsg({ text: e.response?.data?.error || '保存失败', type: 'error' }) }
    setSaving(false)
  }

  const scopeHint = scope === 'global'
    ? '【全局】对所有用户和所有密钥的该接口生效。密钥级 / 用户级设置会覆盖此值。'
    : scope === 'user'
      ? '【用户级】对该用户名下所有密钥的该接口生效。该用户下某密钥的密钥级设置会覆盖此值。'
      : '【密钥级】仅对该密钥生效，优先级最高，覆盖用户级与全局。'

  return (
    <Modal title={`频率设置 - ${title || ''}`} onClose={onClose} width={620}>
      {msg && <div className={`message message-${msg.type}`}>{msg.text}</div>}
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
        {scopeHint}<br />
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

function Auths() {
  const [auths, setAuths] = useState([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState(null)
  const [modal, setModal] = useState(null)
  const [filter, setFilter] = useState('all') // all | bound | unbound
  const [search, setSearch] = useState('')
  const [endpointList, setEndpointList] = useState([])

  const showMsg = useCallback((text, type = 'success') => {
    setMessage({ text, type })
    setTimeout(() => setMessage(null), 3000)
  }, [])

  const closeModal = useCallback(() => setModal(null), [])

  const loadAuths = async () => {
    try {
      const [r, epR] = await Promise.all([
        adminApi.listAuth(),
        adminApi.getEndpointList()
      ])
      setAuths(r.data.data || [])
      setEndpointList(epR.data.data?.endpoints || [])
    } catch (_) { showMsg('加载失败', 'error') }
    setLoading(false)
  }

  useEffect(() => { loadAuths() }, [])

  const filtered = auths.filter(a => {
    if (filter === 'bound' && !a.user_id) return false
    if (filter === 'unbound' && a.user_id) return false
    if (search) {
      const s = search.toLowerCase()
      return a.authorization.toLowerCase().includes(s) || a.name.toLowerCase().includes(s) || (a.username || '').toLowerCase().includes(s)
    }
    return true
  })

  // ---- 操作 ----
  const handleToggle = async (auth) => {
    try { await adminApi.toggleAuth(auth.authorization, !auth.enabled); loadAuths() }
    catch (_) { showMsg('操作失败', 'error') }
  }

  const handleBlock = async (auth) => {
    if (!confirm(`确定${auth.blocked ? '解除屏蔽' : '屏蔽'} ${auth.name}？`)) return
    try {
      if (auth.blocked) await adminApi.unblockUser(auth.authorization)
      else await adminApi.blockUser(auth.authorization, '管理员手动屏蔽')
      loadAuths()
    } catch (_) { showMsg('操作失败', 'error') }
  }

  const handleDelete = async (auth) => {
    if (!confirm(`确定删除 Auth「${auth.name}」？`)) return
    try { await adminApi.deleteUser(auth.authorization); showMsg('已删除'); loadAuths() }
    catch (e) { showMsg(e.response?.data?.error || '删除失败', 'error') }
  }

  const handleRecharge = async (e) => {
    e.preventDefault()
    const { authorization, amount } = modal.data
    try {
      const r = await adminApi.recharge(authorization, parseFloat(amount))
      showMsg(`充值成功，新余额: ¥${r.data.new_balance}`)
      closeModal(); loadAuths()
    } catch (e) { showMsg(e.response?.data?.error || '充值失败', 'error') }
  }

  const handleSetBalance = async (e) => {
    e.preventDefault()
    const { authorization, amount } = modal.data
    try {
      const r = await adminApi.setBalance(authorization, parseFloat(amount))
      showMsg(`余额已设置为 ¥${r.data.balance}`)
      closeModal(); loadAuths()
    } catch (e) { showMsg(e.response?.data?.error || '设置失败', 'error') }
  }

  const handleSetQuota = async (e) => {
    e.preventDefault()
    const { authorization, quota } = modal.data
    try {
      const r = await adminApi.setAuthQuota(authorization, quota)
      showMsg(`配额已设置为 ¥${r.data.data.quota}`)
      closeModal(); loadAuths()
    } catch (e) { showMsg(e.response?.data?.error || '设置失败', 'error') }
  }

  const handleCreate = async (e) => {
    e.preventDefault()
    const { name, description, initial_balance } = modal.data
    try {
      await adminApi.createAuth({ name, description, initial_balance: parseFloat(initial_balance) || 0 })
      showMsg('创建成功'); closeModal(); loadAuths()
    } catch (e) { showMsg(e.response?.data?.error || '创建失败', 'error') }
  }

  const handleBindToUser = async (e) => {
    e.preventDefault()
    const { authorization, userId } = modal.data
    try {
      const r = await adminApi.bindAuthToUser(authorization, userId)
      showMsg(`绑定成功，转移余额 ¥${r.data.data.transferred_balance}`)
      closeModal(); loadAuths()
    } catch (e) { showMsg(e.response?.data?.error || '绑定失败', 'error') }
  }

  if (loading) return <div className="loading">加载中...</div>

  const boundCount = auths.filter(a => a.user_id).length
  const unboundCount = auths.filter(a => !a.user_id).length

  return (
    <div>
      {message && <div className={`message message-${message.type}`}>{message.text}</div>}

      <div className="page-header">
        <div className="page-title-block">
          <h1>Auth 管理</h1>
          <p>管理接口密钥、散号余额、用户绑定和访问状态。</p>
        </div>
        <div className="page-header-actions">
          <button className="btn btn-primary" onClick={() => setModal({ type: 'create', data: { name: '', description: '', initial_balance: '' } })}>
            + 新建散号 Auth
          </button>
        </div>
      </div>

      {/* 筛选栏 */}
      <div className="page-toolbar">
        <div style={{ display: 'flex', gap: 0, border: '1px solid #e2e8f0', borderRadius: 6, overflow: 'hidden' }}>
          {[['all', '全部'], ['bound', '已绑定'], ['unbound', '散号']].map(([key, label]) => (
            <button key={key} onClick={() => setFilter(key)}
              style={{ padding: '6px 14px', border: 'none', cursor: 'pointer', fontSize: 13, background: filter === key ? '#0ea5e9' : '#0f172a', color: filter === key ? '#fff' : '#64748b', transition: 'all 0.12s' }}>
              {label}
            </button>
          ))}
        </div>
        <input className="form-control" style={{ width: 220 }} placeholder="搜索 Auth Key / 名称 / 用户名"
          value={search} onChange={e => setSearch(e.target.value)} />
        <span className="page-header-meta">共 {auths.length} 个 · 已绑定用户 {boundCount} · 散号 {unboundCount} · 显示 {filtered.length} 条</span>
      </div>

      <div className="card">
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>Auth Key</th>
                <th>所属用户</th>
                <th>余额</th>
                <th>配额</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0
                ? <tr><td colSpan={8} style={{ textAlign: 'center', color: '#64748b', padding: 30 }}>暂无数据</td></tr>
                : filtered.map(auth => (
                  <tr key={auth.authorization}>
                    <td>
                      <strong>{auth.name}</strong>
                      {auth.is_default && <span className="badge badge-primary" style={{ fontSize: 10, marginLeft: 5 }}>默认</span>}
                      {auth.description && <div style={{ fontSize: 11, color: '#64748b' }}>{auth.description}</div>}
                    </td>
                    <td><CopyText text={auth.authorization} short /></td>
                    <td>
                      {auth.user_id
                        ? <div>
                            <span style={{ color: '#2563eb', fontSize: 13 }}>{auth.username}</span>
                            <div style={{ fontSize: 11, color: '#64748b' }}><CopyText text={auth.user_id} /></div>
                          </div>
                        : <span style={{ color: '#64748b', fontSize: 12 }}>散号</span>
                      }
                    </td>
                    <td style={{ fontWeight: 600, color: (auth.user_id ? 0 : auth.balance) < 1 ? '#f87171' : '#0f172a' }}>
                      {auth.user_id
                        ? <span style={{ color: '#64748b', fontSize: 12 }}>用户余额</span>
                        : `¥${(auth.balance || 0).toFixed(2)}`
                      }
                    </td>
                    <td style={{ fontSize: 13 }}>
                      {auth.quota === 'unlimited'
                        ? <span style={{ color: '#94a3b8' }}>unlimited</span>
                        : <span style={{ fontWeight: 600, color: Number(auth.quota) <= 0 ? '#f87171' : '#0f172a' }}>¥{Number(auth.quota || 0).toFixed(2)}</span>
                      }
                    </td>
                    <td>
                      {auth.blocked
                        ? <span className="badge badge-danger">已屏蔽</span>
                        : auth.enabled
                          ? <span className="badge badge-success">正常</span>
                          : <span className="badge badge-warning">已禁用</span>
                      }
                    </td>
                    <td style={{ fontSize: 12, color: '#94a3b8' }}>{auth.created_at}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {!auth.user_id && <>
                          <button className="btn btn-sm btn-success"
                            onClick={() => setModal({ type: 'recharge', data: { authorization: auth.authorization, name: auth.name, balance: auth.balance, amount: '' } })}>
                            充值
                          </button>
                          <button className="btn btn-sm btn-warning"
                            onClick={() => setModal({ type: 'setBalance', data: { authorization: auth.authorization, name: auth.name, balance: auth.balance, amount: String(auth.balance || 0) } })}>
                            设余额
                          </button>
                          <button className="btn btn-sm btn-primary"
                            onClick={() => setModal({ type: 'price', data: { authorization: auth.authorization, name: auth.name } })}>
                            定价
                          </button>
                          <button className="btn btn-sm btn-secondary"
                            onClick={() => setModal({ type: 'bind', data: { authorization: auth.authorization, name: auth.name, userId: '' } })}>
                            绑定用户
                          </button>
                        </>}
                        <button className="btn btn-sm btn-primary"
                          onClick={() => setModal({ type: 'quota', data: { authorization: auth.authorization, name: auth.name, quota: auth.quota === 'unlimited' ? '' : auth.quota } })}>
                          配额
                        </button>
                        <button className="btn btn-sm btn-primary"
                          onClick={() => setModal({ type: 'throttle', data: { scope: 'auth', scopeId: auth.authorization, title: `密钥 ${auth.name || auth.authorization.slice(0, 10)}` } })}>
                          频率
                        </button>
                        <button className="btn btn-sm btn-secondary" onClick={() => handleToggle(auth)}>
                          {auth.enabled ? '禁用' : '启用'}
                        </button>
                        <button className={`btn btn-sm ${auth.blocked ? 'btn-success' : 'btn-danger'}`} onClick={() => handleBlock(auth)}>
                          {auth.blocked ? '解屏蔽' : '屏蔽'}
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={() => handleDelete(auth)}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 新建散号 */}
      {modal?.type === 'create' && (
        <Modal title="新建散号 Auth" onClose={closeModal}>
          <form onSubmit={handleCreate}>
            <div className="form-group">
              <label>名称 *</label>
              <input className="form-control" required value={modal.data.name}
                onChange={e => setModal({ ...modal, data: { ...modal.data, name: e.target.value } })} />
            </div>
            <div className="form-group">
              <label>描述</label>
              <input className="form-control" value={modal.data.description}
                onChange={e => setModal({ ...modal, data: { ...modal.data, description: e.target.value } })} />
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

      {/* 充值 */}
      {modal?.type === 'recharge' && (
        <Modal title={`充值 - ${modal.data.name}`} onClose={closeModal}>
          <form onSubmit={handleRecharge}>
            <div className="form-group">
              <label>当前余额</label>
              <input className="form-control" value={`¥${(modal.data.balance || 0).toFixed(2)}`} disabled />
            </div>
            <div className="form-group">
              <label>充值金额 *</label>
              <input className="form-control" type="number" step="0.01" min="0.01" required value={modal.data.amount}
                onChange={e => setModal({ ...modal, data: { ...modal.data, amount: e.target.value } })} />
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={closeModal}>取消</button>
              <button type="submit" className="btn btn-success">确认充值</button>
            </div>
          </form>
        </Modal>
      )}

      {/* 设置余额 */}
      {modal?.type === 'setBalance' && (
        <Modal title={`设置余额 - ${modal.data.name}`} onClose={closeModal}>
          <form onSubmit={handleSetBalance}>
            <div className="form-group">
              <label>当前余额</label>
              <input className="form-control" value={`¥${(modal.data.balance || 0).toFixed(2)}`} disabled />
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

      {/* 设置配额 */}
      {modal?.type === 'quota' && (
        <Modal title={`设置配额 - ${modal.data.name}`} onClose={closeModal}>
          <form onSubmit={handleSetQuota}>
            <div className="form-group">
              <label>剩余配额（元）</label>
              <input className="form-control" type="number" step="0.01" min="0" value={modal.data.quota}
                onChange={e => setModal({ ...modal, data: { ...modal.data, quota: e.target.value } })} />
              <small style={{ color: '#94a3b8', marginTop: 4, display: 'block' }}>
                该密钥最多还能从余额里消费这么多，用完即停。<br />
                如需不限额，填一个很大的数即可；<strong>留空将提示失败</strong>。
              </small>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={closeModal}>取消</button>
              <button type="submit" className="btn btn-primary">确认设置</button>
            </div>
          </form>
        </Modal>
      )}

      {/* 定价 */}
      {modal?.type === 'price' && <PriceModal target={modal.data} onClose={closeModal} endpointList={endpointList} />}

      {/* 频率设置 */}
      {modal?.type === 'throttle' && <ThrottleModal scope={modal.data.scope} scopeId={modal.data.scopeId} title={modal.data.title} onClose={closeModal} endpointList={endpointList} />}

      {/* 绑定到用户 */}
      {modal?.type === 'bind' && (
        <Modal title={`绑定到用户 - ${modal.data.name}`} onClose={closeModal}>
          <form onSubmit={handleBindToUser}>
            <div className="form-group">
              <label>Auth Key</label>
              <input className="form-control" value={modal.data.authorization} disabled />
            </div>
            <div className="form-group">
              <label>目标用户ID *</label>
              <input className="form-control" placeholder="u_xxxxxxxxxxxxxxxx" required value={modal.data.userId}
                onChange={e => setModal({ ...modal, data: { ...modal.data, userId: e.target.value } })} />
              <small style={{ color: '#94a3b8', marginTop: 4, display: 'block' }}>
                绑定后余额转入用户账户，后续消费从用户余额扣除
              </small>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={closeModal}>取消</button>
              <button type="submit" className="btn btn-primary">确认绑定</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}

export default Auths
