import { useState, useEffect } from 'react'
import { adminApi } from '../services/api.jsx'

function Statistics() {
  const [userStats, setUserStats] = useState([])
  const [keyStats, setKeyStats] = useState([])
  const [endpointStats, setEndpointStats] = useState([])
  const [selectedKey, setSelectedKey] = useState(null)
  const [keyDetail, setKeyDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('users')

  const [epStartDate, setEpStartDate] = useState('')
  const [epEndDate, setEpEndDate] = useState('')
  const [epDateLabel, setEpDateLabel] = useState('全部时间')

  useEffect(() => {
    loadStatistics()
  }, [])

  const loadStatistics = async () => {
    try {
      const [userRes, keyRes, endpointRes] = await Promise.all([
        adminApi.getUserUsageStatistics(),
        adminApi.getUsageStatistics(),
        adminApi.getEndpointStatistics()
      ])

      setUserStats(userRes.data.data?.users || [])
      setKeyStats(keyRes.data.data?.users || [])
      setEndpointStats(endpointRes.data.data?.endpoints || [])
    } catch (e) {
      console.error('加载统计数据失败:', e)
    }
    setLoading(false)
  }

  const loadEndpointStats = async (startDate, endDate, label) => {
    try {
      const params = {}
      if (startDate) params.start_date = startDate
      if (endDate) params.end_date = endDate
      const res = await adminApi.getEndpointStatistics(params)
      setEndpointStats(res.data.data?.endpoints || [])
      setEpStartDate(startDate || '')
      setEpEndDate(endDate || '')
      setEpDateLabel(label || (startDate ? `${startDate} ~ ${endDate}` : '全部时间'))
    } catch (e) {
      console.error('加载接口统计失败:', e)
    }
  }

  const quickDateRange = (days, label) => {
    const end = new Date()
    const start = new Date()
    start.setDate(start.getDate() - days)
    loadEndpointStats(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10), label)
  }

  const loadKeyDetail = async (authorization) => {
    try {
      const response = await adminApi.getUsageStatistics(authorization)
      setKeyDetail(response.data.data)
      setSelectedKey(authorization)
    } catch (e) {
      console.error('加载密钥详情失败:', e)
    }
  }

  if (loading) {
    return <div className="loading">加载中...</div>
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-title-block">
          <h1>调用与消费统计</h1>
        </div>
        <div className="page-header-meta">
          {activeTab === 'users'
            ? `用户 ${userStats.length}`
            : activeTab === 'keys'
              ? `密钥 ${keyStats.length}`
              : `接口 ${endpointStats.length} · ${epDateLabel}`}
        </div>
      </div>

      <div className="page-toolbar">
        <button
          className={`btn ${activeTab === 'users' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setActiveTab('users')}
        >
          用户统计
        </button>
        <button
          className={`btn ${activeTab === 'keys' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setActiveTab('keys')}
        >
          密钥统计
        </button>
        <button
          className={`btn ${activeTab === 'endpoints' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setActiveTab('endpoints')}
        >
          接口统计
        </button>
      </div>

      {activeTab === 'users' && (
        <div className="card">
          <div className="card-header">
            <h2>用户调用统计</h2>
            <span style={{ color: '#666' }}>共 {userStats.length} 个用户</span>
          </div>
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>用户</th>
                  <th>API Key</th>
                  <th>总调用次数</th>
                  <th>成功 / 失败</th>
                  <th>消费金额</th>
                  <th>接口数</th>
                  <th>首次调用</th>
                  <th>最近调用</th>
                </tr>
              </thead>
              <tbody>
                {userStats.length === 0 ? (
                  <tr>
                    <td colSpan="8" style={{ textAlign: 'center', color: '#999' }}>暂无用户数据</td>
                  </tr>
                ) : (
                  userStats.map(user => (
                    <tr key={user.user_id}>
                      <td>
                        <strong>{user.username || '未命名用户'}</strong>
                        <div><code style={{ fontSize: 11 }}>{user.user_id}</code></div>
                      </td>
                      <td>
                        <span>{user.active_key_count} / {user.key_count}</span>
                        <div style={{ fontSize: 11, color: '#888' }}>活跃 / 总数</div>
                      </td>
                      <td>{user.total_calls.toLocaleString()}</td>
                      <td>
                        <span style={{ color: '#52c41a' }}>{user.success_calls.toLocaleString()}</span>
                        {' / '}
                        <span style={{ color: user.failed_calls > 0 ? '#ff4d4f' : '#999' }}>{user.failed_calls.toLocaleString()}</span>
                      </td>
                      <td>¥{user.total_amount.toFixed(2)}</td>
                      <td>{user.endpoints_count}</td>
                      <td>{user.first_call || '-'}</td>
                      <td>{user.last_call || '-'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'keys' && (
        <div className="card">
          <div className="card-header">
            <h2>密钥调用统计</h2>
            <span style={{ color: '#666' }}>共 {keyStats.length} 个密钥</span>
          </div>
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>API Key</th>
                  <th>总调用次数</th>
                  <th>消费金额</th>
                  <th>接口数</th>
                  <th>首次调用</th>
                  <th>最近调用</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {keyStats.length === 0 ? (
                  <tr>
                    <td colSpan="7" style={{ textAlign: 'center', color: '#999' }}>暂无密钥调用数据</td>
                  </tr>
                ) : (
                  keyStats.map(key => (
                    <tr key={key.authorization}>
                      <td>
                        <code style={{ fontSize: 11 }}>{key.authorization}</code>
                        {key.name && <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{key.name}</div>}
                      </td>
                      <td>{key.total_calls.toLocaleString()}</td>
                      <td>¥{key.total_amount.toFixed(2)}</td>
                      <td>{key.endpoints_count}</td>
                      <td>{key.first_call || '-'}</td>
                      <td>{key.last_call || '-'}</td>
                      <td>
                        <button className="btn btn-sm btn-secondary" onClick={() => loadKeyDetail(key.authorization)}>
                          详情
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'endpoints' && (
        <div className="card">
          <div className="card-header">
            <h2>接口调用统计</h2>
            <span style={{ color: '#666' }}>共 {endpointStats.length} 个接口 · {epDateLabel}</span>
          </div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 15, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn btn-sm btn-secondary" onClick={() => loadEndpointStats('', '', '全部时间')}>全部</button>
            <button className="btn btn-sm btn-secondary" onClick={() => quickDateRange(1, '今天')}>今天</button>
            <button className="btn btn-sm btn-secondary" onClick={() => quickDateRange(7, '近7天')}>近7天</button>
            <button className="btn btn-sm btn-secondary" onClick={() => quickDateRange(30, '近30天')}>近30天</button>
            <span style={{ color: '#999', fontSize: 13 }}>|</span>
            <input type="date" className="form-control" style={{ width: 140, padding: '4px 8px', fontSize: 13 }} value={epStartDate} onChange={e => setEpStartDate(e.target.value)} />
            <span style={{ fontSize: 13 }}>~</span>
            <input type="date" className="form-control" style={{ width: 140, padding: '4px 8px', fontSize: 13 }} value={epEndDate} onChange={e => setEpEndDate(e.target.value)} />
            <button className="btn btn-sm btn-primary" onClick={() => loadEndpointStats(epStartDate, epEndDate)}>查询</button>
          </div>
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>接口名称</th>
                  <th>总调用次数</th>
                  <th>成功次数</th>
                  <th>失败次数</th>
                  <th>成功率</th>
                  <th>消费金额</th>
                  <th>使用密钥数</th>
                  <th>单价</th>
                </tr>
              </thead>
              <tbody>
                {endpointStats.length === 0 ? (
                  <tr>
                    <td colSpan="8" style={{ textAlign: 'center', color: '#999' }}>暂无数据</td>
                  </tr>
                ) : (
                  endpointStats.map((ep, index) => (
                    <tr key={index}>
                      <td><code>{ep.endpoint}</code></td>
                      <td>{ep.total_calls.toLocaleString()}</td>
                      <td style={{ color: '#52c41a' }}>{ep.success_calls.toLocaleString()}</td>
                      <td style={{ color: ep.failed_calls > 0 ? '#ff4d4f' : '#999' }}>{ep.failed_calls.toLocaleString()}</td>
                      <td>
                        <span className={`badge ${ep.success_rate >= 90 ? 'badge-success' : ep.success_rate >= 70 ? 'badge-warning' : 'badge-danger'}`}>
                          {ep.success_rate}%
                        </span>
                      </td>
                      <td>¥{ep.total_amount.toFixed(2)}</td>
                      <td>{ep.unique_users}</td>
                      <td>¥{ep.default_price}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selectedKey && keyDetail && (
        <div className="modal-overlay" onClick={() => setSelectedKey(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 700 }}>
            <div className="modal-header">
              <h3>API Key 详细统计</h3>
              <button className="modal-close" onClick={() => setSelectedKey(null)}>&times;</button>
            </div>

            <div style={{ marginBottom: 20 }}>
              <h4 style={{ marginBottom: 10 }}>总体统计</h4>
              <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                <div className="stat-card">
                  <h3>总调用次数</h3>
                  <div className="value" style={{ fontSize: 22 }}>{keyDetail.total_stats?.total_calls?.toLocaleString() || 0}</div>
                </div>
                <div className="stat-card">
                  <h3>总消费金额</h3>
                  <div className="value" style={{ fontSize: 22 }}>¥{keyDetail.total_stats?.total_amount?.toFixed(2) || '0.00'}</div>
                </div>
                <div className="stat-card">
                  <h3>使用接口数</h3>
                  <div className="value" style={{ fontSize: 22 }}>{Object.keys(keyDetail.total_stats?.endpoints || {}).length}</div>
                </div>
              </div>
            </div>

            <div>
              <h4 style={{ marginBottom: 10 }}>接口使用明细</h4>
              <div className="table-container" style={{ maxHeight: 300, overflowY: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>接口</th>
                      <th>调用次数</th>
                      <th>成功</th>
                      <th>失败</th>
                      <th>金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(keyDetail.total_stats?.endpoints || {}).map(([ep, stats]) => (
                      <tr key={ep}>
                        <td><code>{ep}</code></td>
                        <td>{stats.calls}</td>
                        <td style={{ color: '#52c41a' }}>{stats.success_calls}</td>
                        <td style={{ color: stats.failed_calls > 0 ? '#ff4d4f' : '#999' }}>{stats.failed_calls}</td>
                        <td>¥{stats.amount?.toFixed(2) || '0.00'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Statistics
