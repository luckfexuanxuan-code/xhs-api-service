import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './hooks/useAuth.jsx'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Users from './pages/Users'
import Auths from './pages/Auths'
import Statistics from './pages/Statistics'
import Logs from './pages/Logs'
import ApiTest from './pages/ApiTest'
import Connectivity from './pages/Connectivity'
import Settings from './pages/Settings'
import Layout from './components/Layout'

// 受保护的路由
function ProtectedRoute({ children }) {
  const { isLoggedIn, loading } = useAuth()

  if (loading) {
    return <div className="loading">加载中...</div>
  }

  if (!isLoggedIn) {
    return <Navigate to="/login" replace />
  }

  return children
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter basename="/dashboard">
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }>
            <Route index element={<Dashboard />} />
            <Route path="users" element={<Users />} />
            <Route path="auths" element={<Auths />} />
            <Route path="statistics" element={<Statistics />} />
            <Route path="logs" element={<Logs />} />
            <Route path="api-test" element={<ApiTest />} />
            <Route path="connectivity" element={<Connectivity />} />
            <Route path="settings" element={<Settings />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}

export default App
