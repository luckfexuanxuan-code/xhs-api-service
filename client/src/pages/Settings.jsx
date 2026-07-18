import { useState, useEffect } from 'react'
import { adminApi } from '../services/api.jsx'

function Settings() {
  const [attackConfig, setAttackConfig] = useState(null)
  const [rateLimit, setRateLimit] = useState(null)
  const [rateLimitInput, setRateLimitInput] = useState('')
  const [savingRate, setSavingRate] = useState(false)
  const [blockedIps, setBlockedIps] = useState([])
  const [blockedUsers, setBlockedUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState(null)

  // 全局接口频率限制
  const [endpointList, setEndpointList] = useState([])
  const [globalThrottles, setGlobalThrottles] = useState({})
  const [savingThrottle, setSavingThrottle] = useState(false)
  const [throttleEndpoint, setThrottleEndpoint] = useState('')
  const [throttleInterval, setThrottleInterval] = useState('')

  // 接口默认价格（创建密钥/用户的初始价）
  const [defaultPrices, setDefaultPrices] = useState({})
  const [savingPrices, setSavingPrices] = useState(false)
  // 上游接口成本表（按上游原始接口粒度）；costEdits 存输入框的未保存修改，key = `${upstream}|${api}`
  const [upstreamApiCosts, setUpstreamApiCosts] = useState([])
  const [costEdits, setCostEdits] = useState({})
  const [savingUpstreamCost, setSavingUpstreamCost] = useState(false)

  // 接口状态（健康 / 风控）：客户文档页据此展示徽章、把风控接口沉底排序
  const [endpointStatuses, setEndpointStatuses] = useState({})
  const [togglingStatus, setTogglingStatus] = useState('')

  // IP封禁表单
  const [newBlockIp, setNewBlockIp] = useState('')
  const [newBlockReason, setNewBlockReason] = useState('')

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      const [configRes, rateRes, ipsRes, usersRes, epRes, throttleRes, priceRes, upstreamCostRes, statusRes] = await Promise.all([
        adminApi.getAttackConfig(),
        adminApi.getRateLimit(),
        adminApi.listBlockedIps(),
        adminApi.listBlockedUsers(),
        adminApi.getEndpointList(),
        adminApi.getThrottles('global'),
        adminApi.getDefaultPrices(),
        adminApi.getUpstreamApiCosts(),
        adminApi.getEndpointStatus()
      ])

      setAttackConfig(configRes.data.config)
      setRateLimit(rateRes.data.config)
      setRateLimitInput(String(rateRes.data.config.key_rate_limit_qps))
      setBlockedIps(ipsRes.data.data || [])
      setBlockedUsers(usersRes.data.data || [])
      setEndpointList(epRes.data.data?.endpoints || [])
      setGlobalThrottles(throttleRes.data.data || {})
      setDefaultPrices(priceRes.data.data || {})
      setUpstreamApiCosts(upstreamCostRes.data.data?.items || [])
      setCostEdits({})
      setEndpointStatuses(statusRes.data.data || {})
    } catch (e) {
      console.error('加载设置失败:', e)
    }
    setLoading(false)
  }

  const showMessage = (text, type = 'success') => {
    setMessage({ text, type })
    setTimeout(() => setMessage(null), 3000)
  }

  const handleSaveRateLimit = async () => {
    const v = rateLimitInput.trim()
    if (v === '' || !/^\d+$/.test(v)) {
      showMessage('请输入 ≥0 的整数（0 表示关闭限流）', 'error')
      return
    }
    setSavingRate(true)
    try {
      const res = await adminApi.setRateLimit(Number(v))
      showMessage('限流阈值已更新为 ' + res.data.data.key_rate_limit_qps + ' QPS')
      await loadSettings()
    } catch (e) {
      showMessage(e.response?.data?.error || '保存失败', 'error')
    }
    setSavingRate(false)
  }

  // 切换下拉选中的接口时，自动回填它当前的全局间隔
  const onSelectThrottleEndpoint = (type) => {
    setThrottleEndpoint(type)
    const cur = type ? globalThrottles[type] : ''
    setThrottleInterval(cur === undefined || cur === null ? '' : String(cur))
  }

  const handleSaveGlobalThrottle = async () => {
    if (!throttleEndpoint) { showMessage('请先选择接口', 'error'); return }
    const raw = String(throttleInterval).trim()
    const v = raw === '' ? 0 : parseInt(raw, 10)
    if (!Number.isFinite(v) || v < 0) { showMessage('请输入 ≥0 的整数（0 = 不限制）', 'error'); return }
    setSavingThrottle(true)
    try {
      await adminApi.setThrottle('global', '', throttleEndpoint, v)
      showMessage(v > 0 ? `已设置「${throttleEndpoint}」全局间隔 ${v} 秒` : `已取消「${throttleEndpoint}」全局限制`)
      await loadSettings()
    } catch (e) {
      showMessage(e.response?.data?.error || '保存失败', 'error')
    }
    setSavingThrottle(false)
  }

  const handleSaveDefaultPrices = async () => {
    setSavingPrices(true)
    try {
      for (const ep of endpointList) {
        const v = parseFloat(defaultPrices[ep.type])
        if (Number.isFinite(v) && v >= 0 && v !== ep.price) {
          await adminApi.setDefaultPrice(ep.type, v)
        }
      }
      showMessage('接口默认价格已保存')
      await loadSettings()
    } catch (e) {
      showMessage(e.response?.data?.error || '保存失败', 'error')
    }
    setSavingPrices(false)
  }

  const handleSaveUpstreamApiCosts = async () => {
    setSavingUpstreamCost(true)
    try {
      for (const item of upstreamApiCosts) {
        const key = `${item.upstream}|${item.api}`
        const raw = costEdits[key]
        if (raw === undefined) continue
        if (String(raw).trim() === '') {
          // 清空 = 恢复默认值（仅当之前有覆盖时才需要调接口）
          if (item.is_override) await adminApi.setUpstreamApiCost(item.upstream, item.api, '')
          continue
        }
        const v = parseFloat(raw)
        if (Number.isFinite(v) && v >= 0 && v !== item.cost) {
          await adminApi.setUpstreamApiCost(item.upstream, item.api, v)
        }
      }
      showMessage('上游接口成本已保存')
      await loadSettings()
    } catch (e) {
      showMessage(e.response?.data?.error || '保存失败', 'error')
    }
    setSavingUpstreamCost(false)
  }

  const handleResetUpstreamApiCost = async (item) => {
    try {
      await adminApi.setUpstreamApiCost(item.upstream, item.api, '')
      showMessage(`已恢复默认 ¥${item.default_cost}`)
      await loadSettings()
    } catch (e) {
      showMessage(e.response?.data?.error || '操作失败', 'error')
    }
  }

  const handleToggleEndpointStatus = async (type) => {
    const cur = endpointStatuses[type] === 'risk' ? 'risk' : 'healthy'
    const next = cur === 'risk' ? 'healthy' : 'risk'
    setTogglingStatus(type)
    try {
      await adminApi.setEndpointStatus(type, next)
      setEndpointStatuses({ ...endpointStatuses, [type]: next })
      showMessage(`「${type}」已标记为${next === 'risk' ? '风控' : '健康'}`)
    } catch (e) {
      showMessage(e.response?.data?.error || '操作失败', 'error')
    }
    setTogglingStatus('')
  }

  const handleBlockIp = async (e) => {
    e.preventDefault()
    if (!newBlockIp) return

    try {
      await adminApi.blockIp(newBlockIp, newBlockReason || '管理员手动封禁')
      showMessage('IP封禁成功')
      setNewBlockIp('')
      setNewBlockReason('')
      loadSettings()
    } catch (e) {
      showMessage(e.response?.data?.error || '封禁失败', 'error')
    }
  }

  const handleUnblockIp = async (ip) => {
    try {
      await adminApi.unblockIp(ip)
      showMessage('IP已解封')
      loadSettings()
    } catch (e) {
      showMessage('解封失败', 'error')
    }
  }

  const handleUnblockUser = async (authorization) => {
    try {
      await adminApi.unblockUser(authorization)
      showMessage('用户已解除屏蔽')
      loadSettings()
    } catch (e) {
      showMessage('解除屏蔽失败', 'error')
    }
  }

  if (loading) {
    return <div className="loading">加载中...</div>
  }

  return (
    <div>
      {message && (
        <div className={`message message-${message.type}`}>
          {message.text}
        </div>
      )}


      <div className="page-header">
        <div className="page-title-block">
          <h1>系统设置</h1>
          <p>配置风控策略、限流规则、接口价格和封禁名单。</p>
        </div>
        <div className="page-header-meta">
          全局策略 · 实时生效
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        {/* 攻击检测配置 */}
        <div className="card">
          <div className="card-header">
            <h2>攻击检测配置</h2>
          </div>
          {attackConfig && (
            <div>
              <div style={{ paddingBottom: 12, marginBottom: 12, borderBottom: '1px solid #f1f5f9' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', marginBottom: 6 }}>① 余额不足攻击 → 封禁密钥</div>
                <p style={{ margin: '2px 0' }}><strong>攻击阈值:</strong> {attackConfig.attack_threshold} 次</p>
                <p style={{ margin: '2px 0' }}><strong>时间窗口:</strong> {attackConfig.attack_window} 秒</p>
                <p style={{ color: '#666', marginTop: 6, fontSize: 13 }}>{attackConfig.description}</p>
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', marginBottom: 6 }}>② 客户端错误(非法参数) → 封禁密钥 + 拉黑IP</div>
                <p style={{ margin: '2px 0' }}><strong>封禁阈值:</strong> {attackConfig.key_ban_threshold} 次</p>
                <p style={{ margin: '2px 0' }}><strong>时间窗口:</strong> {attackConfig.key_ban_window} 秒</p>
                <p style={{ color: '#666', marginTop: 6, fontSize: 13 }}>{attackConfig.key_ban_description}</p>
              </div>
            </div>
          )}
        </div>

        {/* 单密钥限流配置（可改） */}
        <div className="card">
          <div className="card-header">
            <h2>单密钥限流</h2>
            {rateLimit && (
              <span className={`badge ${rateLimit.enabled ? 'badge-success' : 'badge-danger'}`}>
                {rateLimit.enabled ? '已启用' : '已关闭'}
              </span>
            )}
          </div>
          {rateLimit && (
            <div>
              <label style={{ display: 'block', fontSize: 13, color: '#475569', marginBottom: 6 }}>
                每个密钥每秒最大请求数（QPS，0 = 关闭限流）
              </label>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <input
                  type="number"
                  min="0"
                  step="1"
                  className="form-control"
                  value={rateLimitInput}
                  onChange={e => setRateLimitInput(e.target.value)}
                  style={{ width: 120 }}
                />
                <button className="btn btn-primary" onClick={handleSaveRateLimit} disabled={savingRate}>
                  {savingRate ? '保存中...' : '保存'}
                </button>
              </div>
              <p style={{ color: '#666', marginTop: 10, fontSize: 13 }}>{rateLimit.description}</p>
              <p style={{ color: '#94a3b8', marginTop: 6, fontSize: 12 }}>
                超限请求直接返回 429，不转发上游、不扣费、不写库。修改即时生效、重启不丢。
              </p>
            </div>
          )}
        </div>

        {/* IP黑名单 */}
        <div className="card">
          <div className="card-header">
            <h2>IP黑名单</h2>
            <span className="badge badge-danger">{blockedIps.length} 个</span>
          </div>
          <form onSubmit={handleBlockIp} style={{ marginBottom: 15 }}>
            <div style={{ display: 'flex', gap: 10 }}>
              <input
                type="text"
                className="form-control"
                placeholder="IP地址"
                value={newBlockIp}
                onChange={e => setNewBlockIp(e.target.value)}
                style={{ flex: 1 }}
              />
              <input
                type="text"
                className="form-control"
                placeholder="封禁原因（可选）"
                value={newBlockReason}
                onChange={e => setNewBlockReason(e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="submit" className="btn btn-danger">封禁</button>
            </div>
          </form>
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {blockedIps.length === 0 ? (
              <p style={{ color: '#999' }}>暂无封禁IP</p>
            ) : (
              blockedIps.map(item => (
                <div key={item.ip} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #eee' }}>
                  <div>
                    <strong>{item.ip}</strong>
                    <div style={{ fontSize: 12, color: '#999' }}>{item.reason}</div>
                  </div>
                  <button className="btn btn-sm btn-success" onClick={() => handleUnblockIp(item.ip)}>解封</button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 全局接口频率限制（一键设置所有用户和密钥） */}
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div className="card-header">
            <h2>全局接口频率限制</h2>
            <span style={{ fontSize: 12, color: '#64748b' }}>对所有用户和所有密钥生效（密钥级 / 用户级设置可覆盖）</span>
          </div>
          <p style={{ color: '#94a3b8', margin: '0 0 12px', fontSize: 12 }}>
            选择一个接口设置最小调用间隔（秒）：N 秒内只放行 1 次，其余请求返回 429（不计费、不转发上游）。填 0 = 取消该接口的全局限制。
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <select className="form-control" style={{ width: 240 }}
              value={throttleEndpoint}
              onChange={e => onSelectThrottleEndpoint(e.target.value)}>
              <option value="">— 选择接口 —</option>
              {endpointList.map(ep => (
                <option key={ep.type} value={ep.type}>
                  {ep.name}{globalThrottles[ep.type] ? `（当前 ${globalThrottles[ep.type]}s）` : ''}
                </option>
              ))}
            </select>
            <input type="number" min="0" step="1" placeholder="间隔（0=不限）"
              className="form-control" style={{ width: 140 }}
              value={throttleInterval}
              onChange={e => setThrottleInterval(e.target.value)} />
            <span style={{ color: '#475569', fontSize: 14 }}>秒</span>
            <button className="btn btn-primary" onClick={handleSaveGlobalThrottle} disabled={savingThrottle || !throttleEndpoint}>
              {savingThrottle ? '保存中...' : '保存'}
            </button>
          </div>

          {/* 已生效的全局限制 */}
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>当前已生效的全局限制：</div>
            {Object.keys(globalThrottles).length === 0 ? (
              <p style={{ color: '#94a3b8', fontSize: 13, margin: 0 }}>暂无</p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {Object.entries(globalThrottles).map(([type, sec]) => {
                  const ep = endpointList.find(e => e.type === type)
                  return (
                    <span key={type} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, fontSize: 12 }}>
                      {ep ? ep.name : type} · <strong>{sec}s</strong>
                      <button className="btn btn-sm btn-danger" style={{ padding: '0 6px', lineHeight: '18px' }}
                        onClick={async () => { await adminApi.setThrottle('global', '', type, 0); showMessage('已取消'); await loadSettings() }}>×</button>
                    </span>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* 接口默认价格（创建密钥/用户时的初始价） */}
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div className="card-header">
            <h2>接口默认价格</h2>
            <span style={{ fontSize: 12, color: '#64748b' }}>创建新密钥 / 新用户时套用的初始单价（元/次）</span>
          </div>
          <p style={{ color: '#94a3b8', margin: '0 0 12px', fontSize: 12 }}>
            修改后<strong>影响之后新建的密钥 / 用户</strong>；已存在密钥的价格不变（如需改单个密钥/用户，去对应页面「定价」）。
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '6px 20px' }}>
            {endpointList.map(ep => (
              <div key={ep.type} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid #f1f5f9' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13 }}>{ep.name}</div>
                  <div style={{ fontSize: 10, color: '#94a3b8' }}>{ep.type}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ color: '#94a3b8', fontSize: 12 }}>￥</span>
                  <input type="number" min="0" step="0.01"
                    className="form-control"
                    style={{ width: 90, textAlign: 'center' }}
                    value={defaultPrices[ep.type] ?? ''}
                    onChange={e => setDefaultPrices({ ...defaultPrices, [ep.type]: e.target.value })} />
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14 }}>
            <button className="btn btn-primary" onClick={handleSaveDefaultPrices} disabled={savingPrices}>
              {savingPrices ? '保存中...' : '保存默认价格'}
            </button>
          </div>
        </div>

        {/* 接口状态（健康 / 风控）：客户文档页据此展示徽章、把风控接口沉底排序 */}
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div className="card-header">
            <h2>接口状态（健康 / 风控）</h2>
            <span style={{ fontSize: 12, color: '#64748b' }}>点击徽章切换，客户文档页实时读取展示</span>
          </div>
          <p style={{ color: '#94a3b8', margin: '0 0 12px', fontSize: 12 }}>
            标记为「风控」的接口会在客户文档页侧边栏沉底、卡片标题带风控提示，不影响接口本身是否可调用，纯展示用途。
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '6px 20px' }}>
            {endpointList.map(ep => {
              const status = endpointStatuses[ep.type] === 'risk' ? 'risk' : 'healthy'
              const isRisk = status === 'risk'
              return (
                <div key={ep.type} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid #f1f5f9' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13 }}>{ep.name}</div>
                    <div style={{ fontSize: 10, color: '#94a3b8' }}>{ep.type}</div>
                  </div>
                  <button
                    className={`btn btn-sm ${isRisk ? 'btn-danger' : 'btn-success'}`}
                    style={{ minWidth: 56 }}
                    disabled={togglingStatus === ep.type}
                    onClick={() => handleToggleEndpointStatus(ep.type)}
                    title="点击切换状态"
                  >
                    {togglingStatus === ep.type ? '...' : (isRisk ? '风控' : '健康')}
                  </button>
                </div>
              )
            })}
          </div>
        </div>

        {/* 上游接口成本（按上游原始接口粒度，所有成本记账以此表为准） */}
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div className="card-header">
            <h2>上游接口成本</h2>
            <span style={{ fontSize: 12, color: '#64748b' }}>按上游原始接口设置单价（元/成功调用），所有成本记账以此表为准</span>
          </div>
          <p style={{ color: '#94a3b8', margin: '0 0 12px', fontSize: 12 }}>
            每次成功调用按「实际服务的上游接口」的单价入账成本，净利润 = 计费金额 − 成本（多上游切换时成本随实际服务方浮动）。
            清空输入框并保存 = 恢复默认值。
          </p>
          {[...new Set(upstreamApiCosts.map(i => i.upstream))].map(up => {
            const items = upstreamApiCosts.filter(i => i.upstream === up)
            return (
              <div key={up} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {items[0].upstream_name || up}
                  <span style={{ fontSize: 11, fontWeight: 400, color: '#94a3b8' }}>{up} · {items.length} 个接口</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '6px 20px' }}>
                  {items.map(item => {
                    const key = `${item.upstream}|${item.api}`
                    return (
                      <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '5px 0', borderBottom: '1px solid #f1f5f9' }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={item.api}>{item.api}</div>
                          <div style={{ fontSize: 10, color: '#94a3b8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                            title={item.used_by.map(u => u.name).join(' / ')}>
                            {item.used_by.length ? `用于: ${item.used_by.map(u => u.name).join(' / ')}` : '暂无对外接口引用'}
                            {item.is_override ? ` · 默认 ¥${item.default_cost}` : ''}
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                          {item.is_override && (
                            <button className="btn btn-sm" title={`恢复默认 ¥${item.default_cost}`}
                              style={{ padding: '0 6px', lineHeight: '20px', color: '#f59e0b' }}
                              onClick={() => handleResetUpstreamApiCost(item)}>↺</button>
                          )}
                          <span style={{ color: '#94a3b8', fontSize: 12 }}>￥</span>
                          <input
                            type="number"
                            min="0"
                            step="0.001"
                            className="form-control"
                            value={costEdits[key] ?? item.cost}
                            onChange={e => setCostEdits({ ...costEdits, [key]: e.target.value })}
                            style={{ width: 90, textAlign: 'center', ...(item.is_override ? { borderColor: '#f59e0b' } : {}) }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
          <div style={{ marginTop: 6 }}>
            <button className="btn btn-primary" onClick={handleSaveUpstreamApiCosts} disabled={savingUpstreamCost}>
              {savingUpstreamCost ? '保存中...' : '保存'}
            </button>
          </div>
        </div>

        {/* 已屏蔽用户 */}
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div className="card-header">
            <h2>已屏蔽用户</h2>
            <span className="badge badge-danger">{blockedUsers.length} 个</span>
          </div>
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            {blockedUsers.length === 0 ? (
              <p style={{ color: '#999' }}>暂无屏蔽用户</p>
            ) : (
              blockedUsers.map(user => (
                <div key={user.authorization} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #eee' }}>
                  <div>
                    <strong>{user.name}</strong>
                    <div style={{ fontSize: 12, color: '#999' }}>{user.block_reason}</div>
                    <div style={{ fontSize: 12, color: '#999' }}>屏蔽时间: {user.blocked_at}</div>
                  </div>
                  <button className="btn btn-sm btn-success" onClick={() => handleUnblockUser(user.authorization)}>解除屏蔽</button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default Settings
