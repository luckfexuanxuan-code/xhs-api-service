import { useState, useEffect, useRef } from 'react'
import { adminApi } from '../services/api.jsx'

// 上游列渲染：发生过候选链切换时显示切换路径（如 v5✗→xingyin），点击展开/收起各候选的失败原因
function UpstreamCell({ upstream, attemptsRaw }) {
  const [open, setOpen] = useState(false)
  let attempts = attemptsRaw
  if (typeof attempts === 'string' && attempts) {
    try { attempts = JSON.parse(attempts) } catch (_) { attempts = null }
  }
  if (!Array.isArray(attempts) || attempts.length === 0) return upstream || '-'
  const path = attempts.map(a => `${a.upstream}✗`).join('→') + '→' + (upstream || '全部失败')
  return (
    <span style={{ display: 'inline-block', textAlign: 'left' }}>
      <span
        onClick={() => setOpen(!open)}
        title="点击展开/收起切换详情"
        style={{ color: '#f59e0b', cursor: 'pointer', borderBottom: '1px dashed #f59e0b' }}
      >
        {path} {open ? '▴' : '▾'}
      </span>
      {open && (
        <div style={{ marginTop: 4, fontSize: 11, color: '#94a3b8', whiteSpace: 'normal', maxWidth: 340, lineHeight: 1.6 }}>
          {attempts.map((a, i) => (
            <div key={i}>✗ {a.upstream}{a.api ? ` (${a.api})` : ''}：{a.error || '失败'}</div>
          ))}
        </div>
      )}
    </span>
  )
}

function Logs() {
  const [activeTab, setActiveTab] = useState('records')
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [levelFilter, setLevelFilter] = useState('')
  const [message, setMessage] = useState(null)
  const logContainerRef = useRef(null)
  const intervalRef = useRef(null)

  // 调用记录（只看最新一页）
  const [records, setRecords] = useState([])
  const [recLoading, setRecLoading] = useState(false)
  const [recFilter, setRecFilter] = useState({ authorization: '', endpoint: '', status: '' })
  const recLimit = 50

  // 调用日志导出
  const [users, setUsers] = useState([])
  const [exportParams, setExportParams] = useState({
    authorization: '',
    start_date: '',
    end_date: ''
  })
  const [exportResult, setExportResult] = useState(null)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    loadLogs()
    loadUsers()
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
  }, [levelFilter])

  useEffect(() => {
    loadRecords()
  }, [recFilter])

  const loadRecords = async () => {
    setRecLoading(true)
    try {
      const response = await adminApi.getCallLogs({
        authorization: recFilter.authorization || undefined,
        endpoint: recFilter.endpoint || undefined,
        status: recFilter.status || undefined,
        limit: recLimit
      })
      setRecords(response.data.data.records || [])
    } catch (e) {
      showMessage(e.response?.data?.error || '加载调用记录失败', 'error')
    }
    setRecLoading(false)
  }

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(loadLogs, 2000)
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current)
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
  }, [autoRefresh])

  const loadUsers = async () => {
    try {
      const response = await adminApi.listAuth()
      setUsers(response.data.data || [])
    } catch (e) {
      console.error('加载用户列表失败:', e)
    }
  }

  const loadLogs = async () => {
    try {
      const response = await adminApi.getRealtimeLogs({ limit: 200, level: levelFilter })
      setLogs(response.data.data?.logs || [])

      // 自动滚动到底部
      if (logContainerRef.current && autoRefresh) {
        logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
      }
    } catch (e) {
      console.error('加载日志失败:', e)
    }
    setLoading(false)
  }

  const showMessage = (text, type = 'success') => {
    setMessage({ text, type })
    setTimeout(() => setMessage(null), 3000)
  }

  const handleClearLogs = async () => {
    if (!confirm('确定要清空日志缓冲区吗？')) return

    try {
      await adminApi.clearLogBuffer()
      setLogs([])
    } catch (e) {
      console.error('清空日志失败:', e)
    }
  }

  const handleDeleteUserLogs = async () => {
    if (!exportParams.authorization) return
    const userName = users.find(u => u.authorization === exportParams.authorization)?.name || '未知用户'
    if (!confirm(`确定要删除用户「${userName}」的所有调用日志吗？此操作不可恢复！`)) return

    try {
      const response = await adminApi.deleteUserCallLogs(exportParams.authorization)
      showMessage(`${response.data.data.message}`, 'success')
      setExportResult(null)
    } catch (e) {
      showMessage(e.response?.data?.error || '删除失败', 'error')
    }
  }

  const handleExportLogs = async () => {
    setExporting(true)
    setExportResult(null)

    try {
      const response = await adminApi.exportCallLogs({
        authorization: exportParams.authorization || undefined,
        start_date: exportParams.start_date || undefined,
        end_date: exportParams.end_date || undefined,
        limit: 1000
      })

      const data = response.data.data
      setExportResult(data)
      const total = data.total ?? data.count
      showMessage(data.truncated
        ? `共 ${total} 条，预览前 ${data.count} 条（完整数据请点下载）`
        : `成功导出 ${total} 条记录`)
    } catch (e) {
      showMessage(e.response?.data?.error || '导出失败', 'error')
    }
    setExporting(false)
  }

  // 完整数据从服务端生成文件下载（不受预览条数限制，也不卡前端）
  const downloadFile = async (fmt) => {
    if (!exportResult) return
    setExporting(true)
    try {
      const resp = await adminApi.exportCallLogsFile({
        authorization: exportParams.authorization || undefined,
        start_date: exportParams.start_date || undefined,
        end_date: exportParams.end_date || undefined,
        download: fmt
      })
      const blob = new Blob([resp.data], {
        type: fmt === 'csv' ? 'text/csv;charset=utf-8' : 'application/json'
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `call_logs_${new Date().toISOString().slice(0, 10)}.${fmt}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      showMessage(`已下载完整 ${fmt.toUpperCase()} 文件`)
    } catch (e) {
      showMessage('下载失败', 'error')
    }
    setExporting(false)
  }

  const downloadAsJson = () => downloadFile('json')

  const downloadAsCsv = () => downloadFile('csv')

  const copyToClipboard = () => {
    if (!exportResult || !exportResult.records) return
    try {
      const text = JSON.stringify(exportResult.records, null, 2)
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      showMessage('已复制到剪贴板')
    } catch (e) {
      showMessage('复制失败', 'error')
    }
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
          <h1>日志与审计</h1>
          <p>查看最新调用记录、实时运行日志，并按用户导出审计明细。</p>
        </div>
        <div className="page-header-meta">
          {activeTab === 'records' ? `最新 ${records.length} 条` : activeTab === 'realtime' ? '实时日志' : '导出'}
        </div>
      </div>

      {/* 标签页切换 */}
      <div className="page-toolbar">
        <button
          className={`btn ${activeTab === 'records' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setActiveTab('records')}
        >
          调用记录
        </button>
        <button
          className={`btn ${activeTab === 'realtime' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setActiveTab('realtime')}
        >
          实时日志
        </button>
        <button
          className={`btn ${activeTab === 'export' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setActiveTab('export')}
        >
          导出调用日志
        </button>
      </div>

      {/* 调用记录 */}
      {activeTab === 'records' && (
        <>
          <div className="page-toolbar" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <select
                className="form-control"
                value={recFilter.authorization}
                onChange={e => setRecFilter({ ...recFilter, authorization: e.target.value })}
                style={{ width: 160 }}
              >
                <option value="">全部用户</option>
                {users.map(user => (
                  <option key={user.authorization} value={user.authorization}>{user.name}</option>
                ))}
              </select>
              <select
                className="form-control"
                value={recFilter.status}
                onChange={e => setRecFilter({ ...recFilter, status: e.target.value })}
                style={{ width: 110 }}
              >
                <option value="">全部状态</option>
                <option value="success">成功</option>
                <option value="failed">失败</option>
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ color: '#64748b', fontSize: 13 }}>最新 {records.length} 条</span>
              <button className="btn btn-secondary" onClick={loadRecords} disabled={recLoading}>刷新</button>
            </div>
          </div>

          <div className="card" style={{ margin: '16px 24px 0' }}>
            {recLoading ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>加载中...</div>
            ) : records.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>暂无调用记录</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 13, whiteSpace: 'nowrap' }}>
                  <thead>
                    <tr style={{ background: '#0f172a' }}>
                      <th style={{ padding: 8, textAlign: 'left' }}>时间</th>
                      <th style={{ padding: 8, textAlign: 'left' }}>用户</th>
                      <th style={{ padding: 8, textAlign: 'left' }}>接口</th>
                      <th style={{ padding: 8, textAlign: 'center' }}>状态</th>
                      <th style={{ padding: 8, textAlign: 'left' }}>失败原因</th>
                      <th style={{ padding: 8, textAlign: 'right' }}>扣费</th>
                      <th style={{ padding: 8, textAlign: 'right' }}>成本</th>
                      <th style={{ padding: 8, textAlign: 'center' }}>上游</th>
                      <th style={{ padding: 8, textAlign: 'left' }}>IP</th>
                      <th style={{ padding: 8, textAlign: 'left' }}>请求参数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r) => (
                      <tr key={r.id} style={{ borderBottom: '1px solid #1e293b' }}>
                        <td style={{ padding: 8, fontSize: 12 }}>{r.timestamp}</td>
                        <td style={{ padding: 8 }}>
                          {r.username
                            ? <><div>{r.username}</div><div style={{ fontSize: 11, color: '#64748b' }}>{r.user_name || r.authorization?.slice(0, 8)}</div></>
                            : (r.user_name || '-')}
                        </td>
                        <td style={{ padding: 8 }}>{r.endpoint}</td>
                        <td style={{ padding: 8, textAlign: 'center' }}>
                          <span className={`badge ${r.success ? 'badge-success' : 'badge-danger'}`}>
                            {r.success ? '成功' : '失败'}
                          </span>
                        </td>
                        <td style={{ padding: 8, fontSize: 12, color: '#b91c1c' }}>{r.error_message || '-'}</td>
                        <td style={{ padding: 8, textAlign: 'right' }}>¥{r.amount ?? 0}</td>
                        <td style={{ padding: 8, textAlign: 'right', color: '#94a3b8' }}>{r.cost ? `¥${r.cost}` : '-'}</td>
                        <td style={{ padding: 8, textAlign: 'center', fontSize: 12 }}><UpstreamCell upstream={r.upstream} attemptsRaw={r.upstream_attempts} /></td>
                        <td style={{ padding: 8, fontSize: 12 }}>{r.client_ip || '-'}</td>
                        <td style={{ padding: 8, fontSize: 12, fontFamily: 'monospace' }}>{r.request_params || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* 实时日志 */}
      {activeTab === 'realtime' && (
        <>
          <div className="page-toolbar" style={{ justifyContent: 'space-between' }}>
            <span style={{ color: '#64748b', fontSize: 13 }}>共 {logs.length} 条记录</span>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <select
                className="form-control"
                value={levelFilter}
                onChange={e => setLevelFilter(e.target.value)}
                style={{ width: 120 }}
              >
                <option value="">全部级别</option>
                <option value="INFO">INFO</option>
                <option value="WARNING">WARNING</option>
                <option value="ERROR">ERROR</option>
              </select>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', color: '#94a3b8', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={e => setAutoRefresh(e.target.checked)}
                />
                自动刷新
              </label>
              <button className="btn btn-secondary" onClick={loadLogs} disabled={loading}>刷新</button>
              <button className="btn btn-danger" onClick={handleClearLogs}>清空</button>
            </div>
          </div>

          <div
            className="log-container"
            ref={logContainerRef}
            style={{ height: 'calc(100vh - 165px)', maxHeight: 'none', borderRadius: 8, border: '1px solid rgba(255,255,255,0.05)', margin: '16px 24px 0' }}
          >
            {logs.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#475569', padding: 40 }}>暂无日志</div>
            ) : (
              logs.map((log, index) => (
                <div key={index} className="log-entry">
                  <span className="log-time">{log.timestamp}</span>
                  <span className={`log-level log-level-${log.level}`}>{log.level}</span>
                  <span className="log-message">{log.message}</span>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {/* 导出调用日志 */}
      {activeTab === 'export' && (
        <div className="card">
          <div className="card-header">
            <h2>导出用户调用日志</h2>
            <span style={{ color: '#666', fontSize: 14 }}>查询并导出用户的 API 调用记录</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 20 }}>
            {/* 查询表单 */}
            <div>
              <div className="form-group">
                <label>选择用户</label>
                <select
                  className="form-control"
                  value={exportParams.authorization}
                  onChange={e => setExportParams({ ...exportParams, authorization: e.target.value })}
                >
                  <option value="">全部用户</option>
                  {users.map(user => (
                    <option key={user.authorization} value={user.authorization}>
                      {user.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label>开始日期</label>
                <input
                  type="date"
                  className="form-control"
                  value={exportParams.start_date}
                  onChange={e => setExportParams({ ...exportParams, start_date: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label>结束日期</label>
                <input
                  type="date"
                  className="form-control"
                  value={exportParams.end_date}
                  onChange={e => setExportParams({ ...exportParams, end_date: e.target.value })}
                />
              </div>

              <button
                className="btn btn-primary"
                onClick={handleExportLogs}
                disabled={exporting}
                style={{ width: '100%' }}
              >
                {exporting ? '查询中...' : '查询日志'}
              </button>

              {exportParams.authorization && (
                <button
                  className="btn btn-danger"
                  onClick={handleDeleteUserLogs}
                  style={{ width: '100%', marginTop: 10 }}
                >
                  删除该用户所有日志
                </button>
              )}
            </div>

            {/* 结果展示 */}
            <div style={{ minWidth: 0 }}>
              {exportResult ? (
                <div>
                  <div style={{ marginBottom: 15, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                    <div>
                      <span className="badge badge-success">共 {exportResult.total ?? exportResult.count} 条记录</span>
                      {exportResult.truncated && (
                        <span style={{ marginLeft: 8, color: '#f59e0b', fontSize: 12 }}>
                          数据较多，预览前 {exportResult.count} 条；完整数据请点下载
                        </span>
                      )}
                      {exportResult.start_date && (
                        <span style={{ marginLeft: 10, color: '#666', fontSize: 12 }}>
                          日期范围: {exportResult.start_date} ~ {exportResult.end_date}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      <button className="btn btn-sm btn-secondary" onClick={copyToClipboard}>
                        复制
                      </button>
                      <button className="btn btn-sm btn-success" onClick={downloadAsJson}>
                        下载 JSON
                      </button>
                      <button className="btn btn-sm btn-success" onClick={downloadAsCsv}>
                        下载 CSV
                      </button>
                    </div>
                  </div>

                  {/* 接口调用统计（用服务端按全量数据算好的 stats，预览被截断也准确）*/}
                  {exportResult.stats && exportResult.stats.total > 0 && (() => {
                    const st = exportResult.stats
                    const sortedStats = st.endpoints || []
                    return (
                      <div style={{ marginBottom: 15, padding: 15, background: '#eff6ff', borderRadius: 4, border: '1px solid #bfdbfe' }}>
                        <h4 style={{ margin: '0 0 10px 0', fontSize: 14, color: '#2563eb' }}>调用统计</h4>
                        <div style={{ display: 'flex', gap: 20, marginBottom: 12, flexWrap: 'wrap' }}>
                          <div style={{ padding: '6px 12px', background: '#f8fafc', borderRadius: 4, fontSize: 13 }}>
                            总调用: <strong>{st.total}</strong> 次
                          </div>
                          <div style={{ padding: '6px 12px', background: '#f8fafc', borderRadius: 4, fontSize: 13 }}>
                            成功率: <strong>{(st.success / st.total * 100).toFixed(1)}%</strong>
                          </div>
                          <div style={{ padding: '6px 12px', background: '#f8fafc', borderRadius: 4, fontSize: 13 }}>
                            总费用: <strong style={{ color: '#dc2626' }}>¥{st.cost.toFixed(2)}</strong>
                          </div>
                        </div>
                        <table style={{ width: '100%', fontSize: 12, borderRadius: 4 }}>
                          <thead>
                            <tr style={{ background: '#0f172a' }}>
                              <th style={{ padding: '6px 10px', textAlign: 'left' }}>接口</th>
                              <th style={{ padding: '6px 10px', textAlign: 'center' }}>调用次数</th>
                              <th style={{ padding: '6px 10px', textAlign: 'center' }}>成功次数</th>
                              <th style={{ padding: '6px 10px', textAlign: 'center' }}>成功率</th>
                              <th style={{ padding: '6px 10px', textAlign: 'right' }}>费用</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sortedStats.map((s) => (
                              <tr key={s.endpoint} style={{ borderBottom: '1px solid #e2e8f0' }}>
                                <td style={{ padding: '6px 10px' }}>{s.endpoint}</td>
                                <td style={{ padding: '6px 10px', textAlign: 'center' }}>{s.count}</td>
                                <td style={{ padding: '6px 10px', textAlign: 'center' }}>{s.success}</td>
                                <td style={{ padding: '6px 10px', textAlign: 'center' }}>{(s.success / s.count * 100).toFixed(1)}%</td>
                                <td style={{ padding: '6px 10px', textAlign: 'right' }}>¥{s.cost.toFixed(2)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                  })()}

                  {exportResult.records && exportResult.records.length > 0 ? (
                    <div style={{ maxHeight: 500, overflowY: 'auto', overflowX: 'auto' }}>
                      <table style={{ width: '100%', fontSize: 13, whiteSpace: 'nowrap' }}>
                        <thead>
                          <tr style={{ background: '#0f172a' }}>
                            <th style={{ padding: 8, textAlign: 'left' }}>时间</th>
                            <th style={{ padding: 8, textAlign: 'left' }}>密钥备注</th>
                            <th style={{ padding: 8, textAlign: 'left' }}>所属账户</th>
                            <th style={{ padding: 8, textAlign: 'left' }}>密钥</th>
                            <th style={{ padding: 8, textAlign: 'left' }}>接口</th>
                            <th style={{ padding: 8, textAlign: 'center' }}>状态</th>
                            <th style={{ padding: 8, textAlign: 'left' }}>失败原因</th>
                            <th style={{ padding: 8, textAlign: 'right' }}>扣费</th>
                            <th style={{ padding: 8, textAlign: 'right' }}>成本</th>
                            <th style={{ padding: 8, textAlign: 'center' }}>上游</th>
                            <th style={{ padding: 8, textAlign: 'left' }}>IP</th>
                            <th style={{ padding: 8, textAlign: 'left' }}>UA</th>
                            <th style={{ padding: 8, textAlign: 'left' }}>请求参数</th>
                          </tr>
                        </thead>
                        <tbody>
                          {exportResult.records.slice(0, 100).map((record, index) => {
                            const isSuccess = record.success === true || record.status_code === 200
                            const cost = record.amount ?? record.cost ?? 0
                            return (
                              <tr key={index} style={{ borderBottom: '1px solid #e2e8f0' }}>
                                <td style={{ padding: 8, fontSize: 12 }}>{record.timestamp}</td>
                                <td style={{ padding: 8 }}>{record.user_name || '-'}</td>
                                <td style={{ padding: 8 }}>{record.username || '-'}</td>
                                <td style={{ padding: 8, fontSize: 12, fontFamily: 'monospace' }} title={record.authorization || ''}>{record.authorization || '-'}</td>
                                <td style={{ padding: 8 }}>{record.endpoint}</td>
                                <td style={{ padding: 8, textAlign: 'center' }}>
                                  <span className={`badge ${isSuccess ? 'badge-success' : 'badge-danger'}`}>
                                    {isSuccess ? '成功' : '失败'}
                                  </span>
                                </td>
                                <td style={{ padding: 8, fontSize: 12, color: '#b91c1c', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }} title={record.error_message || ''}>{record.error_message || '-'}</td>
                                <td style={{ padding: 8, textAlign: 'right' }}>¥{cost}</td>
                                <td style={{ padding: 8, textAlign: 'right', color: '#94a3b8' }}>{record.cost ? `¥${record.cost}` : '-'}</td>
                                <td style={{ padding: 8, textAlign: 'center', fontSize: 12 }}><UpstreamCell upstream={record.upstream} attemptsRaw={record.upstream_attempts} /></td>
                                <td style={{ padding: 8, fontSize: 12 }}>{record.client_ip || '-'}</td>
                                <td style={{ padding: 8, fontSize: 12, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }} title={record.user_agent || ''}>{record.user_agent || '-'}</td>
                                <td style={{ padding: 8, fontSize: 12, fontFamily: 'monospace' }} title={record.request_params || ''}>{record.request_params || '-'}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                      {exportResult.records.length > 100 && (
                        <div style={{ padding: 15, textAlign: 'center', color: '#94a3b8', background: '#f8fafc' }}>
                          仅显示前 100 条记录，完整数据请下载导出
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ padding: 40, textAlign: 'center', color: '#64748b', background: '#f8fafc', borderRadius: 4 }}>
                      未找到符合条件的调用记录
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ padding: 60, textAlign: 'center', color: '#64748b', background: '#f8fafc', borderRadius: 4 }}>
                  <div style={{ fontSize: 48, marginBottom: 15 }}>📋</div>
                  <div>选择查询条件后点击"查询日志"</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Logs
