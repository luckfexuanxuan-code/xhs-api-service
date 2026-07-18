import { useState, useEffect } from 'react'
import { adminApi } from '../services/api.jsx'

const PUBLIC_API_ORIGIN = 'https://api.galaxysapi.com'
const UPSTREAM_DISPLAY_NAMES = { xingyin: '星河', matcha: 'Matcha', tikhub: 'TikHub', datadrifter: 'Datadrifter', swagger: 'Swagger' }
const UPSTREAM_ORDER = ['swagger', 'xingyin', 'matcha', 'datadrifter', 'tikhub']

function groupUpstreamApis(list) {
  const groups = {}
  list.forEach(api => {
    const key = api.upstream || '其他'
    if (!groups[key]) groups[key] = []
    groups[key].push(api)
  })
  const keys = Object.keys(groups).sort((a, b) => {
    const ia = UPSTREAM_ORDER.indexOf(a)
    const ib = UPSTREAM_ORDER.indexOf(b)
    if (ia === -1 && ib === -1) return a.localeCompare(b)
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })
  return keys.map(key => ({
    upstream: key,
    label: UPSTREAM_DISPLAY_NAMES[key] || key,
    apis: groups[key]
  }))
}

function ApiTest() {
  const [activeTab, setActiveTab] = useState('upstream')
  const [message, setMessage] = useState(null)
  const [showPythonCode, setShowPythonCode] = useState(false)

  // 上游 API 测试
  const [upstreamApiList, setUpstreamApiList] = useState([])
  const [selectedUpstreamApi, setSelectedUpstreamApi] = useState('')
  const [upstreamParams, setUpstreamParams] = useState({})
  const [upstreamResult, setUpstreamResult] = useState(null)
  const [upstreamTesting, setUpstreamTesting] = useState(false)

  // 下游 API 测试
  const [billableEndpoints, setBillableEndpoints] = useState([])
  const [selectedDownstreamApi, setSelectedDownstreamApi] = useState('')
  const [downstreamParams, setDownstreamParams] = useState({})
  const [downstreamAuth, setDownstreamAuth] = useState('')
  const [downstreamResult, setDownstreamResult] = useState(null)
  const [downstreamTesting, setDownstreamTesting] = useState(false)

  // 默认测试参数（支持下划线和驼峰两种命名）
  const defaultTestValues = {
    // 下游API使用（下划线命名）
    note_id: '68663c5e000000000d027a20',
    user_id: '5659223450c4b4595d6c312c',
    keyword: '美食',
    sku_id: '68be7cbc8c331700011f89d1',
    comment_id: '',
    page: '1',
    start: '',
    cursor: '',
    sortType: '',
    sortStrategy: '',
    filterNoteType: '',
    min_price: '',
    max_price: '',
    sort: '',
    pageId: '5c014b045b29cb0001ead530',
    first_load_time: '',
    authorization: '',
    last_note_ct: '',
    last_note_id: '',
    cursor_score: '',
    session_id: '',
    start_date: '',
    end_date: '',
    endpoint: '',
    success: '',
    type: '',
    limit: '100',
    // 上游API使用（驼峰命名）
    noteId: '68663c5e000000000d027a20',
    userId: '5659223450c4b4595d6c312c',
    skuId: '68be7cbc8c331700011f89d1',
    commentId: '',
    searchId: '',
    sessionId: ''
  }

  // 下游 API 配置：免费接口固定，计费接口从后端拉取
  const FREE_ENDPOINTS = [
    { type: 'get_balance',     name: '获取余额',           url: '/api/get_balance',     method: 'GET',  params: [],                                                   price: 0 },
    { type: 'get_call_logs',   name: '查询用户调用记录',   url: '/api/get_call_logs',   method: 'GET',  params: ['start_date', 'end_date', 'endpoint', 'success', 'limit'], price: 0 },
    { type: 'get_recharge_log',name: '查询用户充值记录',   url: '/api/get_recharge_log',method: 'GET',  params: ['start_date', 'end_date', 'type', 'limit'],          price: 0 },
    { type: 'check_auth',      name: '查询 Auth 是否存在', url: '/admin/check_auth',    method: 'GET',  params: ['authorization'],                                    price: 0, adminAuth: true },
  ]
  const downstreamApiList = [...billableEndpoints, ...FREE_ENDPOINTS]

  useEffect(() => {
    loadUpstreamApiList()
    adminApi.getEndpointList().then(r => setBillableEndpoints(r.data.data?.endpoints || [])).catch(() => {})
  }, [])

  const loadUpstreamApiList = async () => {
    try {
      const response = await adminApi.getUpstreamApiList()
      setUpstreamApiList(response.data.data?.apis || [])
    } catch (e) {
      console.error('加载上游API列表失败:', e)
    }
  }

  const showMessage = (text, type = 'success') => {
    setMessage({ text, type })
    setTimeout(() => setMessage(null), 3000)
  }

  // 复制到剪贴板（兼容 HTTP）
  const copyToClipboard = (data) => {
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
    try {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      showMessage('已复制到剪贴板', 'success')
    } catch (e) {
      showMessage('复制失败', 'error')
    }
  }

  // 生成 Python 调用代码（使用当前输入的参数）
  const generatePythonCode = (apiConfig, isUpstream = false) => {
    if (!apiConfig) return ''
    const baseUrl = PUBLIC_API_ORIGIN
    const params = apiConfig.params || []
    const currentParams = isUpstream ? upstreamParams : downstreamParams
    const isPost = (apiConfig.method || 'GET').toUpperCase() === 'POST'

    const paramLines = params.map(p => {
      if (p === 'first_load_time') {
        return `    "first_load_time": str(int(time.time() * 1000))`
      }
      const val = currentParams[p] || defaultTestValues[p] || 'YOUR_VALUE'
      return `    "${p}": "${val}"`
    }).join(',\n')

    if (isUpstream) {
      // Matcha 协议：统一 POST /v1/call，body={api_id, params}，Bearer 认证
      if (apiConfig.upstream === 'matcha') {
        const mParamLines = params.map(p => {
          const val = currentParams[p] || defaultTestValues[p] || 'YOUR_VALUE'
          return `        "${p}": "${val}"`
        }).join(',\n')
        return `import requests

url = "${apiConfig.baseURL || ''}/v1/call"
headers = {
    "Authorization": "Bearer ${apiConfig.authorization || 'YOUR_MATCHA_KEY'}"
}
payload = {
    "api_id": "${apiConfig.api_id || ''}",
    "params": {
${mParamLines || '        # 无需参数'}
    }
}

response = requests.post(url, headers=headers, json=payload, timeout=30)
print(response.json())`
      }
      // datadrifter(V5/V4系列) 协议：POST JSON + X-API-KEY 认证（接口偶有 10s+ 响应，超时放宽到 60s）。
      // 注：这里之前误写成了 apiConfig.upstream === 'v5'，但后端 get_upstream_api_list 下发的
      // upstream 字段实际值是 'datadrifter'（内部标识，供应商侧才是V5/V4协议），导致这个分支从未真正
      // 命中过——datadrifter 的示例代码一直落到下面的默认分支，认证头错误地显示成了 Authorization，
      // 2026-07-11 修正。
      if (apiConfig.upstream === 'datadrifter') {
        return `import requests

url = "${apiConfig.baseURL || ''}${apiConfig.url}"
headers = {
    "X-API-KEY": "${apiConfig.authorization || 'YOUR_V5_KEY'}"
}
payload = {
${paramLines || '    # 无需参数'}
}

response = requests.post(url, headers=headers, json=payload, timeout=60)
print(response.json())`
      }
      // swagger 协议（2026-07-11 加）：GET + X-API-Key 头认证，参数走 query string，不是 JSON body
      if (apiConfig.upstream === 'swagger') {
        return `import requests

url = "${apiConfig.baseURL || ''}${apiConfig.url}"
headers = {
    "X-API-Key": "${apiConfig.authorization || 'YOUR_SWAGGER_KEY'}"
}
params = {
${paramLines || '    # 无需参数'}
}

response = requests.get(url, headers=headers, params=params, timeout=30)
print(response.json())`
      }
      // 上游接口需直连真实上游地址并携带上游密钥（均由后端 get_upstream_api_list 下发）
      const upstreamUrl = `${apiConfig.baseURL || ''}${apiConfig.url}`
      const upstreamAuth = apiConfig.authorization || 'YOUR_UPSTREAM_KEY'
      return `import time
import requests

url = "${upstreamUrl}"
headers = {
    "Authorization": "${upstreamAuth}"
}
params = {
${paramLines || '    # 无需参数'}
}

response = requests.post(url, headers=headers, json=params, timeout=30) if ${isPost ? 'True' : 'False'} else requests.get(url, headers=headers, params=params, timeout=30)
print(response.json())`
    }

    const isAdminApi = apiConfig.adminAuth
    const authHeader = isAdminApi
      ? `    "X-Admin-Key": "YOUR_ADMIN_KEY"`
      : `    "Authorization": "${downstreamAuth || 'YOUR_AUTH_KEY'}"`

    return `import time
import requests

url = "${baseUrl}${apiConfig.url}"
headers = {
${authHeader}
}
params = {
${paramLines || '    # 无需参数'}
}

response = requests.post(url, headers=headers, json=params, timeout=30) if ${isPost ? 'True' : 'False'} else requests.get(url, headers=headers, params=params, timeout=30)
data = response.json()
print(f"余额: {data.get('balance', 'N/A')}")
print(f"数据: {data.get('data', data)}")`
  }

  // 测试上游 API
  const handleTestUpstreamApi = async () => {
    if (!selectedUpstreamApi) {
      showMessage('请选择要测试的API', 'error')
      return
    }

    setUpstreamTesting(true)
    setUpstreamResult(null)

    const requestParams = { ...upstreamParams }
    if (selectedUpstreamApi === 'tag_notes') {
      requestParams.first_load_time = String(Date.now())
      setUpstreamParams(requestParams)
    }

    try {
      const response = await adminApi.testUpstreamApi(selectedUpstreamApi, requestParams)
      const resultData = response.data.data
      setUpstreamResult(resultData)

      // 搜索接口：自动回填翻页参数
      if (resultData && resultData.response) {
        const resp = typeof resultData.response === 'string' ? JSON.parse(resultData.response) : resultData.response
        if (resp.searchId || resp.sessionId) {
          const newParams = { ...upstreamParams }
          if (resp.searchId) newParams.searchId = resp.searchId
          if (resp.sessionId) newParams.sessionId = resp.sessionId
          setUpstreamParams(newParams)
        }
      }
    } catch (e) {
      setUpstreamResult({
        error: e.response?.data?.error || e.message,
        status_code: e.response?.status
      })
    }
    setUpstreamTesting(false)
  }

  // 测试下游 API
  const handleTestDownstreamApi = async () => {
    if (!selectedDownstreamApi) {
      showMessage('请选择要测试的API', 'error')
      return
    }

    const apiConfig = downstreamApiList.find(a => a.type === selectedDownstreamApi)
    if (!apiConfig) return

    if (!apiConfig.adminAuth && !downstreamAuth) {
      showMessage('请输入用户 Authorization', 'error')
      return
    }

    if (apiConfig.adminAuth && !localStorage.getItem('adminKey')) {
      showMessage('管理员登录已失效，请重新登录', 'error')
      return
    }

    setDownstreamTesting(true)
    setDownstreamResult(null)

    const requestParams = { ...downstreamParams }
    if (apiConfig.type === 'tag_notes') {
      requestParams.first_load_time = String(Date.now())
      setDownstreamParams(requestParams)
    }
    const isPost = (apiConfig.method || 'GET').toUpperCase() === 'POST'

    // 构建查询参数
    const queryParams = new URLSearchParams()
    for (const [key, value] of Object.entries(requestParams)) {
      if (value) queryParams.append(key, value)
    }

    const relativeUrl = isPost ? apiConfig.url : `${apiConfig.url}${queryParams.toString() ? '?' + queryParams.toString() : ''}`
    const requestUrl = PUBLIC_API_ORIGIN + relativeUrl
    const startTime = Date.now()

    try {
      const response = await fetch(requestUrl, {
        method: apiConfig.method,
        headers: {
          ...(apiConfig.adminAuth
            ? { 'X-Admin-Key': localStorage.getItem('adminKey') || '' }
            : { 'Authorization': downstreamAuth }),
          'Content-Type': 'application/json'
        },
        body: isPost ? JSON.stringify(requestParams) : undefined
      })

      const elapsedTime = Date.now() - startTime
      const data = await response.json()

      setDownstreamResult({
        status_code: response.status,
        elapsed_time_ms: elapsedTime,
        response: data,
        url: requestUrl
      })

      // 搜索接口：自动回填翻页参数
      if (data.searchId || data.sessionId) {
        const newParams = { ...downstreamParams }
        if (data.searchId) newParams.searchId = data.searchId
        if (data.sessionId) newParams.sessionId = data.sessionId
        setDownstreamParams(newParams)
      }
    } catch (e) {
      setDownstreamResult({
        error: e.message,
        elapsed_time_ms: Date.now() - startTime
      })
    }
    setDownstreamTesting(false)
  }

  const selectedUpstreamConfig = upstreamApiList.find(a => a.type === selectedUpstreamApi)
  const selectedDownstreamConfig = downstreamApiList.find(a => a.type === selectedDownstreamApi)

  return (
    <div>
      {message && (
        <div className={`message message-${message.type}`}>
          {message.text}
        </div>
      )}


      <div className="page-header">
        <div className="page-title-block">
          <h1>API 测试</h1>
          <p>测试上游数据接口和本服务对外接口，快速验证参数、响应和计费链路。</p>
        </div>
        <div className="page-header-meta">
          {activeTab === 'upstream' ? '上游直连 · 不计费' : '下游服务 · 按接口计费'}
        </div>
      </div>

      {/* 标签页切换 */}
      <div className="page-toolbar">
        <button
          className={`btn ${activeTab === 'upstream' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setActiveTab('upstream')}
        >
          上游 API 测试
        </button>
        <button
          className={`btn ${activeTab === 'downstream' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setActiveTab('downstream')}
        >
          下游 API 测试
        </button>
      </div>

      {/* 上游 API 测试 */}
      {activeTab === 'upstream' && (
        <div className="card">
          <div className="card-header">
            <h2>上游 API 测试</h2>
            <span style={{ color: '#666', fontSize: 14 }}>直接调用上游数据源接口（不计费）</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <div>
              <div className="form-group">
                <label>选择 API</label>
                <select
                  className="form-control"
                  value={selectedUpstreamApi}
                  onChange={e => {
                    setSelectedUpstreamApi(e.target.value)
                    const apiConfig = upstreamApiList.find(a => a.type === e.target.value)
                    if (apiConfig) {
                      const defaults = {}
                      apiConfig.params.forEach(param => {
                        if (param === 'first_load_time') {
                          defaults[param] = String(Date.now())
                        } else if (defaultTestValues[param]) {
                          defaults[param] = defaultTestValues[param]
                        }
                      })
                      setUpstreamParams(defaults)
                    } else {
                      setUpstreamParams({})
                    }
                    setUpstreamResult(null)
                  }}
                >
                  <option value="">请选择...</option>
                  {groupUpstreamApis(upstreamApiList).map(group => (
                    <optgroup key={group.upstream} label={group.label}>
                      {group.apis.map(api => (
                        <option key={api.type} value={api.type}>
                          {api.name} ({api.type})
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>

              {selectedUpstreamConfig && (
                <>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 15, padding: 10, background: '#f8fafc', borderRadius: 4 }}>
                    <strong>{selectedUpstreamConfig.method}</strong> {selectedUpstreamConfig.url}
                  </div>

                  {selectedUpstreamConfig.params.map(param => (
                    <div className="form-group" key={param}>
                      <label>{param}</label>
                      <input
                        type="text"
                        className="form-control"
                        value={upstreamParams[param] || ''}
                        onChange={e => setUpstreamParams({ ...upstreamParams, [param]: e.target.value })}
                        placeholder={param === 'first_load_time' ? '\u6d4b\u8bd5\u65f6\u7cfb\u7edf\u81ea\u52a8\u751f\u6210\uff0c\u65e0\u9700\u586b\u5199' : `Enter ${param}`}
                      />
                    </div>
                  ))}

                  <button
                    className="btn btn-primary"
                    onClick={handleTestUpstreamApi}
                    disabled={upstreamTesting}
                    style={{ width: '100%' }}
                  >
                    {upstreamTesting ? '测试中...' : '发送请求'}
                  </button>

                  {/* Python 调用代码 */}
                  <div style={{ marginTop: 15 }}>
                    <button
                      className="btn btn-secondary"
                      style={{ width: '100%', fontSize: 12 }}
                      onClick={() => setShowPythonCode(showPythonCode === 'upstream' ? false : 'upstream')}
                    >
                      {showPythonCode === 'upstream' ? '收起 Python 代码' : '查看 Python 调用代码'}
                    </button>
                    {showPythonCode === 'upstream' && (
                      <div style={{ marginTop: 10, position: 'relative' }}>
                        <button
                          className="btn btn-secondary"
                          style={{ position: 'absolute', top: 8, right: 8, padding: '2px 8px', fontSize: 11, zIndex: 1 }}
                          onClick={() => copyToClipboard(generatePythonCode(selectedUpstreamConfig, true))}
                        >
                          复制
                        </button>
                        <div style={{ background: '#1e1e1e', padding: 15, borderRadius: 4, overflow: 'auto' }}>
                          <pre style={{ fontSize: 12, margin: 0, color: '#d4d4d4', whiteSpace: 'pre-wrap' }}>
                            {generatePythonCode(selectedUpstreamConfig, true)}
                          </pre>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            <div style={{ background: '#f8fafc', borderRadius: 4, padding: 15, border: '1px solid rgba(255,255,255,0.07)' }}>
              <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h4 style={{ margin: 0 }}>响应结果</h4>
                {upstreamResult && !upstreamResult.error && (
                  <button
                    className="btn btn-secondary"
                    style={{ padding: '4px 12px', fontSize: 12 }}
                    onClick={() => copyToClipboard(upstreamResult.response)}
                  >
                    复制结果
                  </button>
                )}
              </div>
              {upstreamResult ? (
                <div>
                  {upstreamResult.error ? (
                    <div style={{ color: '#dc2626', padding: 15, background: '#fef2f2', borderRadius: 4 }}>
                      <strong>错误:</strong> {upstreamResult.error}
                    </div>
                  ) : (
                    <>
                      <div style={{ marginBottom: 10 }}>
                        <span className={`badge ${upstreamResult.status_code === 200 ? 'badge-success' : 'badge-danger'}`}>
                          状态码: {upstreamResult.status_code}
                        </span>
                        <span style={{ marginLeft: 10, color: '#94a3b8' }}>
                          耗时: {upstreamResult.elapsed_time_ms}ms
                        </span>
                      </div>
                      <div style={{ background: '#0f172a', padding: 15, borderRadius: 4, border: '1px solid rgba(255,255,255,0.07)', maxHeight: 'calc(100vh - 350px)', overflow: 'auto' }}>
                        <pre style={{ fontSize: 12, margin: 0, color: '#e2e8f0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                          {JSON.stringify(upstreamResult.response, null, 2)}
                        </pre>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div style={{ color: '#999', padding: 40, textAlign: 'center' }}>
                  选择 API 并填写参数后发送请求
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 下游 API 测试 */}
      {activeTab === 'downstream' && (
        <div className="card">
          <div className="card-header">
            <h2>下游 API 测试</h2>
            <span style={{ color: '#94a3b8', fontSize: 14 }}>测试本服务对外提供的接口（计费接口会扣费）</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <div>
              <div className="form-group">
                <label>选择 API</label>
                <select
                  className="form-control"
                  value={selectedDownstreamApi}
                  onChange={e => {
                    setSelectedDownstreamApi(e.target.value)
                    const apiConfig = downstreamApiList.find(a => a.type === e.target.value)
                    if (apiConfig) {
                      const defaults = {}
                      apiConfig.params.forEach(param => {
                        if (param === 'first_load_time') {
                          defaults[param] = String(Date.now())
                        } else if (apiConfig.paramExamples?.[param] !== undefined && apiConfig.paramExamples[param] !== '') {
                          defaults[param] = String(apiConfig.paramExamples[param])
                        } else if (defaultTestValues[param]) {
                          defaults[param] = defaultTestValues[param]
                        }
                      })
                      setDownstreamParams(defaults)
                    } else {
                      setDownstreamParams({})
                    }
                    setDownstreamResult(null)
                  }}
                >
                  <option value="">请选择...</option>
                  {downstreamApiList.map(api => (
                    <option key={api.type} value={api.type}>
                      {api.name} ({api.adminAuth ? '管理员接口' : `¥${api.price}`})
                    </option>
                  ))}
                </select>
              </div>

              {selectedDownstreamConfig && (
                <>
                  {!selectedDownstreamConfig.adminAuth && (
                    <div className="form-group">
                      <label>用户 Authorization *</label>
                      <input
                        type="text"
                        className="form-control"
                        value={downstreamAuth}
                        onChange={e => setDownstreamAuth(e.target.value)}
                        placeholder="请输入用户的 Authorization Key"
                      />
                    </div>
                  )}

                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 15, padding: 10, background: '#f8fafc', borderRadius: 4 }}>
                    <strong>{selectedDownstreamConfig.method}</strong> {PUBLIC_API_ORIGIN}{selectedDownstreamConfig.url}
                    <span style={{ float: 'right', color: selectedDownstreamConfig.adminAuth ? '#1677ff' : '#ff2442' }}>
                      {selectedDownstreamConfig.adminAuth ? '管理员接口' : `单价: ¥${selectedDownstreamConfig.price}`}
                    </span>
                  </div>

                  {selectedDownstreamConfig.params.map(param => (
                    <div className="form-group" key={param}>
                      <label>{param}</label>
                      <input
                        type="text"
                        className="form-control"
                        value={downstreamParams[param] || ''}
                        onChange={e => setDownstreamParams({ ...downstreamParams, [param]: e.target.value })}
                        placeholder={param === 'first_load_time' ? '\u6d4b\u8bd5\u65f6\u7cfb\u7edf\u81ea\u52a8\u751f\u6210\uff0c\u65e0\u9700\u586b\u5199' : `Enter ${param}`}
                      />
                    </div>
                  ))}

                  <button
                    className="btn btn-primary"
                    onClick={handleTestDownstreamApi}
                    disabled={downstreamTesting}
                    style={{ width: '100%' }}
                  >
                    {downstreamTesting ? '测试中...' : '发送请求'}
                  </button>

                  {selectedDownstreamConfig.price > 0 && (
                    <div style={{ marginTop: 10, fontSize: 12, color: '#faad14', textAlign: 'center' }}>
                      注意：此操作将从用户余额中扣除 ¥{selectedDownstreamConfig.price}
                    </div>
                  )}

                  {/* Python 调用代码 */}
                  <div style={{ marginTop: 15 }}>
                    <button
                      className="btn btn-secondary"
                      style={{ width: '100%', fontSize: 12 }}
                      onClick={() => setShowPythonCode(showPythonCode === 'downstream' ? false : 'downstream')}
                    >
                      {showPythonCode === 'downstream' ? '收起 Python 代码' : '查看 Python 调用代码'}
                    </button>
                    {showPythonCode === 'downstream' && (
                      <div style={{ marginTop: 10, position: 'relative' }}>
                        <button
                          className="btn btn-secondary"
                          style={{ position: 'absolute', top: 8, right: 8, padding: '2px 8px', fontSize: 11, zIndex: 1 }}
                          onClick={() => copyToClipboard(generatePythonCode(selectedDownstreamConfig, false))}
                        >
                          复制
                        </button>
                        <div style={{ background: '#1e1e1e', padding: 15, borderRadius: 4, overflow: 'auto' }}>
                          <pre style={{ fontSize: 12, margin: 0, color: '#d4d4d4', whiteSpace: 'pre-wrap' }}>
                            {generatePythonCode(selectedDownstreamConfig, false)}
                          </pre>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            <div style={{ background: '#f8fafc', borderRadius: 4, padding: 15, border: '1px solid rgba(255,255,255,0.07)' }}>
              <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h4 style={{ margin: 0 }}>响应结果</h4>
                {downstreamResult && !downstreamResult.error && (
                  <button
                    className="btn btn-secondary"
                    style={{ padding: '4px 12px', fontSize: 12 }}
                    onClick={() => copyToClipboard(downstreamResult.response)}
                  >
                    复制结果
                  </button>
                )}
              </div>
              {downstreamResult ? (
                <div>
                  {downstreamResult.error ? (
                    <div style={{ color: '#dc2626', padding: 15, background: '#fef2f2', borderRadius: 4 }}>
                      <strong>错误:</strong> {downstreamResult.error}
                    </div>
                  ) : (
                    <>
                      <div style={{ marginBottom: 10 }}>
                        <span className={`badge ${downstreamResult.status_code === 200 ? 'badge-success' : 'badge-danger'}`}>
                          状态码: {downstreamResult.status_code}
                        </span>
                        <span style={{ marginLeft: 10, color: '#94a3b8' }}>
                          耗时: {downstreamResult.elapsed_time_ms}ms
                        </span>
                      </div>
                      {downstreamResult.response?.balance !== undefined && (
                        <div style={{ marginBottom: 10, padding: 8, background: '#eff6ff', borderRadius: 4, color: '#1d4ed8' }}>
                          用户当前余额: <strong>¥{downstreamResult.response.balance}</strong>
                        </div>
                      )}
                      <div style={{ background: '#0f172a', padding: 15, borderRadius: 4, border: '1px solid rgba(255,255,255,0.07)', maxHeight: 'calc(100vh - 350px)', overflow: 'auto' }}>
                        <pre style={{ fontSize: 12, margin: 0, color: '#e2e8f0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                          {JSON.stringify(downstreamResult.response, null, 2)}
                        </pre>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div style={{ color: '#999', padding: 40, textAlign: 'center' }}>
                  选择 API 并填写参数后发送请求
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ApiTest
