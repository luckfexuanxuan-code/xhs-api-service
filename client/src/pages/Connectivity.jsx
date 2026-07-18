import { useState, useEffect } from 'react'
import { adminApi } from '../services/api.jsx'

// 三种状态的展示样式
const STATUS_META = {
  successful: { color: '#16a34a', bg: '#dcfce7' },
  error:      { color: '#dc2626', bg: '#fee2e2' },
  timeout:    { color: '#d97706', bg: '#fef3c7' }
}

function StatusBadge({ status }) {
  const m = STATUS_META[status] || { color: '#475569', bg: '#f1f5f9' }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 999,
      fontSize: 12, fontWeight: 600, color: m.color, background: m.bg
    }}>{status}</span>
  )
}

function SummaryCards({ summary }) {
  if (!summary) return null
  const items = [
    { key: 'successful', val: summary.successful, color: '#16a34a', bg: '#dcfce7', sub: '#15803d' },
    { key: 'timeout',    val: summary.timeout,    color: '#d97706', bg: '#fef3c7', sub: '#b45309' },
    { key: 'error',      val: summary.error,      color: '#dc2626', bg: '#fee2e2', sub: '#b91c1c' }
  ]
  return (
    <div style={{ display: 'flex', gap: 16, margin: '16px 0' }}>
      {items.map(i => (
        <div key={i.key} style={{ flex: 1, textAlign: 'center', padding: '12px 0', background: i.bg, borderRadius: 8 }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: i.color }}>{i.val}</div>
          <div style={{ fontSize: 12, color: i.sub }}>{i.key}</div>
        </div>
      ))}
    </div>
  )
}

function ResultTable({ result }) {
  if (!result) return null
  return (
    <>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontSize: 13 }}>
            <th style={{ padding: '8px 6px' }}>数据接口</th>
            <th style={{ padding: '8px 6px' }}>type</th>
            <th style={{ padding: '8px 6px' }}>状态</th>
            <th style={{ padding: '8px 6px', textAlign: 'right' }}>响应时间</th>
            <th style={{ padding: '8px 6px' }}>说明</th>
          </tr>
        </thead>
        <tbody>
          {result.results.map(r => (
            <tr key={r.type} style={{ borderBottom: '1px solid #f1f5f9' }}>
              <td style={{ padding: '10px 6px', fontWeight: 600, color: '#0f172a' }}>{r.name}</td>
              <td style={{ padding: '10px 6px', color: '#94a3b8', fontSize: 12, fontFamily: 'monospace' }}>{r.type}</td>
              <td style={{ padding: '10px 6px' }}><StatusBadge status={r.status} /></td>
              <td style={{ padding: '10px 6px', textAlign: 'right', fontWeight: 600, color: r.status === 'successful' ? '#0f172a' : '#cbd5e1' }}>
                {r.status === 'successful' ? `${r.response_time_ms} ms` : '—'}
              </td>
              <td style={{ padding: '10px 6px', color: '#94a3b8', fontSize: 12 }}>{r.error || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ color: '#cbd5e1', fontSize: 12, marginTop: 12 }}>
        测试时间：{result.tested_at}{result.test_key ? ` · 测试密钥：${result.test_key}` : ''}
      </p>
    </>
  )
}

function Connectivity() {
  // —— 上游 ——
  const [upTesting, setUpTesting] = useState(false)
  const [upResult, setUpResult] = useState(null)
  // —— 下游 ——
  const [downTesting, setDownTesting] = useState(false)
  const [downResult, setDownResult] = useState(null)
  const [keyInfo, setKeyInfo] = useState(null)      // { configured, masked }
  const [keyInput, setKeyInput] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [editingKey, setEditingKey] = useState(false)
  // —— 通用 ——
  const [error, setError] = useState(null)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    adminApi.getDownstreamTestKey().then(res => setKeyInfo(res.data.data)).catch(() => {})
  }, [])

  const flash = (text, isErr = false) => {
    if (isErr) { setError(text); setTimeout(() => setError(null), 4000) }
    else { setMsg(text); setTimeout(() => setMsg(null), 3000) }
  }

  const runUpstream = async () => {
    setUpTesting(true); setError(null)
    try {
      const res = await adminApi.testConnectivity()
      setUpResult(res.data.data)
    } catch (e) {
      flash(e.response?.data?.error || e.message || '测试失败', true)
    }
    setUpTesting(false)
  }

  const saveKey = async () => {
    if (!keyInput.trim()) { flash('请输入测试密钥', true); return }
    setSavingKey(true)
    try {
      const res = await adminApi.setDownstreamTestKey(keyInput.trim())
      setKeyInfo(res.data.data)
      setKeyInput(''); setEditingKey(false)
      flash('测试密钥已保存')
    } catch (e) {
      flash(e.response?.data?.error || '保存失败', true)
    }
    setSavingKey(false)
  }

  const runDownstream = async () => {
    if (!keyInfo?.configured) { flash('请先设置下游测试密钥', true); return }
    setDownTesting(true); setError(null)
    try {
      const res = await adminApi.testConnectivityDownstream()
      setDownResult(res.data.data)
    } catch (e) {
      flash(e.response?.data?.error || e.message || '测试失败', true)
    }
    setDownTesting(false)
  }

  return (
    <div>
      {msg && <div className="message message-success">{msg}</div>}
      {error && <div className="message message-error">{error}</div>}

      <div className="page-header">
        <div className="page-title-block">
          <h1>连通性测试</h1>
          <p>探活上游供应商和本服务接口，检查响应时间、超时和错误状态。</p>
        </div>
        <div className="page-header-meta">
          单接口超时 20 秒 · 并发执行
        </div>
      </div>

      {/* ===== 上游（数据供应商）===== */}
      <div className="card">
        <div className="card-header">
          <h2>上游数据 API 连通性</h2>
          <button className="btn btn-primary" onClick={runUpstream} disabled={upTesting}>
            {upTesting ? '测试中…（最长约 21 秒）' : '开始测试'}
          </button>
        </div>
        <p style={{ color: '#64748b', fontSize: 13, marginTop: 4 }}>
          直接探活各数据接口的<strong>上游供应商</strong>。单接口超时 <strong>20 秒</strong>、并发执行。
          <span style={{ color: '#16a34a' }}> successful</span> 显示响应时间，
          <span style={{ color: '#d97706' }}> timeout</span> 超 20 秒未响应，
          <span style={{ color: '#dc2626' }}> error</span> 连接失败/上游报错。
          仅探活，<strong>不计费</strong>。
        </p>
        <SummaryCards summary={upResult?.summary} />
        <ResultTable result={upResult} />
      </div>

      {/* ===== 下游（本平台对外 /api/*）===== */}
      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-header">
          <h2>下游接口连通性（本平台对外）</h2>
          <button className="btn btn-primary" onClick={runDownstream} disabled={downTesting || !keyInfo?.configured}>
            {downTesting ? '测试中…（最长约 21 秒）' : '测下游（会扣费）'}
          </button>
        </div>
        <p style={{ color: '#64748b', fontSize: 13, marginTop: 4 }}>
          用指定测试密钥打本平台 <code>/api/*</code> 接口，走<strong>完整链路</strong>（鉴权→计费→转发上游）。
          单接口超时 <strong>20 秒</strong>。<strong style={{ color: '#dc2626' }}>注意：成功的接口会真实扣费（每个约 0.04 元）</strong>。
        </p>

        {/* 测试密钥管理 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '12px 0', padding: '10px 12px', background: '#f8fafc', borderRadius: 8 }}>
          <span style={{ fontSize: 13, color: '#475569' }}>测试密钥：</span>
          {!editingKey ? (
            <>
              <span style={{ fontFamily: 'monospace', fontSize: 13, color: keyInfo?.configured ? '#0f172a' : '#94a3b8' }}>
                {keyInfo?.configured ? keyInfo.masked : '（未设置）'}
              </span>
              <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setEditingKey(true)}>
                {keyInfo?.configured ? '更换' : '设置'}
              </button>
            </>
          ) : (
            <>
              <input
                type="text"
                className="form-control"
                placeholder="粘贴专用测试密钥（Authorization）"
                value={keyInput}
                onChange={e => setKeyInput(e.target.value)}
                style={{ flex: 1, fontFamily: 'monospace', fontSize: 13 }}
              />
              <button className="btn btn-primary btn-sm" onClick={saveKey} disabled={savingKey}>
                {savingKey ? '保存中…' : '保存'}
              </button>
              <button className="btn btn-sm" onClick={() => { setEditingKey(false); setKeyInput('') }}>取消</button>
            </>
          )}
        </div>

        <SummaryCards summary={downResult?.summary} />
        <ResultTable result={downResult} />
      </div>
    </div>
  )
}

export default Connectivity
