import { createContext, useContext, useState, useEffect } from 'react'
import { adminApi } from '../services/api.jsx'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [username, setUsername] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    checkLogin()
  }, [])

  const checkLogin = async () => {
    const adminKey = localStorage.getItem('adminKey')
    const savedUsername = localStorage.getItem('username')

    if (adminKey) {
      try {
        await adminApi.verifyLogin()
        setIsLoggedIn(true)
        setUsername(savedUsername || '')
      } catch (e) {
        localStorage.removeItem('adminKey')
        localStorage.removeItem('username')
        setIsLoggedIn(false)
      }
    }
    setLoading(false)
  }

  const login = async (username, password) => {
    try {
      const response = await adminApi.login(username, password)
      if (response.data.message === '成功') {
        localStorage.setItem('adminKey', response.data.admin_key)
        localStorage.setItem('username', response.data.username)
        setIsLoggedIn(true)
        setUsername(response.data.username)
        return { success: true }
      }
      return { success: false, error: response.data.error }
    } catch (e) {
      return { success: false, error: e.response?.data?.error || '登录失败' }
    }
  }

  const logout = () => {
    localStorage.removeItem('adminKey')
    localStorage.removeItem('username')
    setIsLoggedIn(false)
    setUsername('')
  }

  return (
    <AuthContext.Provider value={{ isLoggedIn, username, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}
