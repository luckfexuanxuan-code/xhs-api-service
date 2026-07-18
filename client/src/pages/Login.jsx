import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const { login } = useAuth()
  const navigate = useNavigate()

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    const result = await login(username, password)

    if (result.success) {
      navigate('/')
    } else {
      setError(result.error)
    }

    setLoading(false)
  }

  return (
    <div className="login-container">
      <div className="login-brand">
        <div className="login-brand-top">
          <div className="login-brand-badge">
            <span className="login-brand-badge-dot"></span>
            XHS API Platform
          </div>
          <div className="login-brand-title">小红书API<br />数据服务管理系统</div>
          <div className="login-brand-subtitle">
            小红书 / 抖音数据接口计费代理平台，多上游自动切换，按次计费、失败退费。
          </div>
          <div className="login-features">
            <div className="login-feature"><span className="login-feature-dot"></span>密钥管理 · 余额与配额</div>
            <div className="login-feature"><span className="login-feature-dot"></span>实时调用统计 · 收入成本利润</div>
            <div className="login-feature"><span className="login-feature-dot"></span>多上游候选链 · 故障自动切换</div>
            <div className="login-feature"><span className="login-feature-dot"></span>风控限流 · 自动封禁</div>
          </div>
        </div>
        <div className="login-grid-pattern"></div>
        <div className="login-brand-footer">XHS API 管理后台 v1.2</div>
      </div>

      <div className="login-form-panel">
        <div className="login-box">
          <div className="login-box-title">欢迎回来</div>
          <div className="login-box-subtitle">请登录管理员账户</div>

          {error && <div className="login-error">{error}</div>}

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>用户名</label>
              <input
                type="text"
                className="form-control"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="请输入用户名"
                required
              />
            </div>

            <div className="form-group">
              <label>密码</label>
              <div className="password-wrapper">
                <input
                  type={showPassword ? 'text' : 'password'}
                  className="form-control"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="请输入密码"
                  required
                  style={{ paddingRight: 40 }}
                />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                      <line x1="1" y1="1" x2="23" y2="23"/>
                    </svg>
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                  )}
                </button>
              </div>
            </div>

            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading}
            >
              {loading ? '登录中...' : '登录'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}

export default Login
