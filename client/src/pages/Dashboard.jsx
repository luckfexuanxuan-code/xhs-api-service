import { useState, useEffect } from 'react'
import { adminApi } from '../services/api.jsx'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, BarChart, Bar, ComposedChart, LabelList,
  PieChart, Pie, Cell, AreaChart, Area, ReferenceLine
} from 'recharts'
import * as echarts from 'echarts/core'
import { MapChart } from 'echarts/charts'
import { TooltipComponent, VisualMapComponent, GeoComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import chinaGeoJson from '../assets/china.json'

echarts.use([MapChart, TooltipComponent, VisualMapComponent, GeoComponent, CanvasRenderer])
echarts.registerMap('china', chinaGeoJson)

const PIE_COLORS = [
  '#2563eb', '#10b981', '#f59e0b', '#ef4444',
  '#6366f1', '#06b6d4', '#84cc16', '#64748b'
]


function PieTooltip({ active, payload }) {
  if (active && payload && payload.length) {
    const d = payload[0]
    return (
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: '#0f172a' }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{d.name}</div>
        <div>调用: <strong>{d.value.toLocaleString()}</strong></div>
        <div>占比: <strong>{(d.payload.percent * 100).toFixed(1)}%</strong></div>
      </div>
    )
  }
  return null
}

function AmountPieTooltip({ active, payload }) {
  if (active && payload && payload.length) {
    const d = payload[0]
    return (
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: '#0f172a' }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{d.name}</div>
        <div>消费: <strong>¥{d.value.toFixed(4)}</strong></div>
        <div>占比: <strong>{(d.payload.percent * 100).toFixed(1)}%</strong></div>
      </div>
    )
  }
  return null
}

function UserUsageTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload
  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 13px', fontSize: 12, color: '#0f172a', boxShadow: '0 4px 16px rgba(0,0,0,0.08)' }}>
      <div style={{ fontWeight: 600, marginBottom: 7 }}>{row.user_name}</div>
      <div style={{ color: '#64748b', marginBottom: 5 }}>真实用户 · {row.key_count} 个活跃 API Key</div>
      <div>调用次数：<strong>{row.total_calls.toLocaleString()}</strong></div>
      <div>成功 / 失败：<strong>{row.success_calls.toLocaleString()} / {row.failed_calls.toLocaleString()}</strong></div>
      <div>消费金额：<strong>¥{row.total_amount.toFixed(2)}</strong></div>
    </div>
  )
}

// 分布环形图：左侧环形(中心显示总计) + 右侧单列图例(名称 / 数值 / 占比对齐)
function DistributionDonut({ items, total, fmt, centerLabel, tooltip }) {
  if (!items || items.length === 0) {
    return <div style={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 13 }}>暂无数据</div>
  }
  return (
    <div style={{ height: 280, display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ width: '44%', height: '100%', position: 'relative', flexShrink: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={items} cx="50%" cy="50%" innerRadius={52} outerRadius={82} paddingAngle={2} dataKey="value" stroke="none">
              {items.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
            </Pie>
            <Tooltip content={tooltip} />
          </PieChart>
        </ResponsiveContainer>
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', pointerEvents: 'none' }}>
          <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 2 }}>{centerLabel}</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>{fmt(total)}</div>
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 7 }}>
        {items.map((e, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: PIE_COLORS[i % PIE_COLORS.length], flexShrink: 0 }} />
            <span style={{ color: '#475569', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
            <span style={{ color: '#94a3b8', fontSize: 11, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{fmt(e.value)}</span>
            <span style={{ color: '#0f172a', fontWeight: 600, flexShrink: 0, width: 46, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{(e.percent * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function DailyTooltip({ active, payload, label, avgAmount }) {
  if (!active || !payload?.length) return null
  const calls = payload.find(p => p.dataKey === 'total_calls')?.value || 0
  const amount = payload.find(p => p.dataKey === 'total_amount')?.value || 0
  const recharge = payload.find(p => p.dataKey === 'total_recharge')?.value || 0
  const diff = avgAmount > 0 ? ((amount - avgAmount) / avgAmount * 100) : 0
  const isAbove = diff >= 0
  return (
    <div style={{
      background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
      padding: '12px 16px', fontSize: 12, color: '#0f172a',
      boxShadow: '0 4px 16px rgba(0,0,0,0.10)', minWidth: 160
    }}>
      <div style={{ fontWeight: 600, marginBottom: 10, color: '#475569', borderBottom: '1px solid #f1f5f9', paddingBottom: 8 }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: 2, background: '#3b82f6', flexShrink: 0 }} />
          <span style={{ color: '#64748b', flex: 1 }}>调用次数</span>
          <strong style={{ color: '#0f172a' }}>{calls.toLocaleString()}</strong>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#0ea5e9', flexShrink: 0 }} />
          <span style={{ color: '#64748b', flex: 1 }}>消费金额</span>
          <strong style={{ color: '#0ea5e9' }}>¥{amount.toFixed(2)}</strong>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', flexShrink: 0 }} />
          <span style={{ color: '#64748b', flex: 1 }}>充值金额</span>
          <strong style={{ color: '#10b981' }}>¥{recharge.toFixed(2)}</strong>
        </div>
        {avgAmount > 0 && (
          <div style={{
            marginTop: 4, paddingTop: 7, borderTop: '1px solid #f1f5f9',
            fontSize: 11, color: isAbove ? '#0ea5e9' : '#10b981', fontWeight: 500
          }}>
            消费较日均 {isAbove ? '↑' : '↓'} {Math.abs(diff).toFixed(1)}%
          </div>
        )}
      </div>
    </div>
  )
}

const formatLocalDate = (date = new Date()) => {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// 接口健康程度配色（按每小时成功率）。无数据用灰色，避免误读为健康。
const healthColor = (rate) => {
  if (rate === null || rate === undefined) return { bg: '#e2e8f0', fg: '#64748b' }
  if (rate >= 95) return { bg: '#16a34a', fg: '#fff' }
  if (rate >= 80) return { bg: '#84cc16', fg: '#fff' }
  if (rate >= 50) return { bg: '#f59e0b', fg: '#fff' }
  if (rate >= 20) return { bg: '#f97316', fg: '#fff' }
  return { bg: '#dc2626', fg: '#fff' }
}

// 健康热力图表格（上游/下游两个分区复用）。rows: [{ key, label, hourly:[{hour,date,total,success,success_rate}] }]
function renderHealthTable(rows, colLabel) {
  if (!rows.length) return null
  return (
    <div style={{ overflowX: 'auto', marginTop: 8 }}>
      <table style={{ borderCollapse: 'separate', borderSpacing: 3, width: '100%' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', fontSize: 11, color: '#94a3b8', fontWeight: 600, paddingRight: 8, minWidth: 96 }}>{colLabel}</th>
            {(rows[0]?.hourly || []).map((h, i) => (
              <th key={i} style={{ fontSize: 9, color: '#cbd5e1', fontWeight: 500, textAlign: 'center' }}>{h.hour.slice(0, 2)}</th>
            ))}
            <th style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, paddingLeft: 8, textAlign: 'right', minWidth: 52 }}>近24h</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const ratedHours = row.hourly.filter(h => h.success_rate !== null && h.success_rate !== undefined)
            const dayHealth = ratedHours.length
              ? Math.round((ratedHours.reduce((s, h) => s + h.success_rate, 0) / ratedHours.length) * 100) / 100
              : null
            return (
              <tr key={row.key}>
                <td style={{ fontSize: 12, color: '#0f172a', fontWeight: 600, paddingRight: 8, whiteSpace: 'nowrap' }}>{row.label}</td>
                {row.hourly.map((h, hi) => {
                  const c = healthColor(h.success_rate)
                  return (
                    <td key={hi} style={{ padding: 0 }}>
                      <div
                        title={`${row.label} ${h.date} ${h.hour}\n成功率: ${h.success_rate === null ? '无数据' : h.success_rate + '%'}\n成功 ${h.success} / 总 ${h.total}`}
                        style={{ background: c.bg, borderRadius: 3, height: 20, minWidth: 16 }}
                      />
                    </td>
                  )
                })}
                <td style={{ textAlign: 'right', paddingLeft: 8, fontSize: 12, fontWeight: 700, color: healthColor(dayHealth).bg }}>
                  {dayHealth === null ? '无数据' : `${dayHealth}%`}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function MetricRing({ value, label, sublabel, color, fontSize = 18, size = 136, innerRadius = 48, outerRadius = 64 }) {
  return (
    <div className="dashboard-ring-metric" style={{ minWidth: size }}>
      <div className="dashboard-ring-visual" style={{ width: size, height: size }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={[{ value: 1 }]}
              dataKey="value"
              innerRadius={innerRadius}
              outerRadius={outerRadius}
              fill={color}
              startAngle={90}
              endAngle={-270}
              stroke="none"
              isAnimationActive={false}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="dashboard-ring-value" style={{ fontSize }}>{value}</div>
      </div>
      <div className="dashboard-ring-label">{label}</div>
      {sublabel && <div className="dashboard-ring-subvalue" style={{ color }}>{sublabel}</div>}
    </div>
  )
}

function Dashboard() {
  const [stats, setStats] = useState({
    totalUsers: 0,
    activeUsers: 0,
    totalAuths: 0,
    blockedAuths: 0,
    totalCalls: 0,
    totalAmount: 0,
    blockedUsers: 0,
    blockedIps: 0,
    newToday: 0,
    new7d: 0,
    new30d: 0
  })
  const [endpointStats, setEndpointStats] = useState([])
  // 用户地区分布（每用户一个代表IP解析省份），跟「消费趋势」共享 dailyRange 时间窗口
  const [regionItems, setRegionItems] = useState([])
  const [regionLoading, setRegionLoading] = useState(false)
  // 接口调用/消费分布用：跟右侧「接口调用趋势」「用户调用统计」共享 selectedDate，切一天联动一天
  const [dailyEndpointStats, setDailyEndpointStats] = useState([])
  const [upstreamBalances, setUpstreamBalances] = useState([])
  const [upstreamBalanceLoading, setUpstreamBalanceLoading] = useState(true)
  const [upstreamUsage, setUpstreamUsage] = useState([])
  const [loading, setLoading] = useState(true)

  const [todayStats, setTodayStats] = useState({ calls: 0, amount: 0, successCalls: 0, upstreamCost: 0, profit: 0 })
  const [selectedDate, setSelectedDate] = useState(formatLocalDate())
  const [hourlyData, setHourlyData] = useState([])
  const [hourlyHealth, setHourlyHealth] = useState([])
  const [hourlyHealthUpstreams, setHourlyHealthUpstreams] = useState([])
  const [minuteData, setMinuteData] = useState([])
  const [userDailyData, setUserDailyData] = useState([])
  const [endpointList, setEndpointList] = useState([])
  const [selectedEndpoint, setSelectedEndpoint] = useState('')
  const [chartLoading, setChartLoading] = useState(false)

  const [dailyRange, setDailyRange] = useState(14)
  const [dailyData, setDailyData] = useState([])
  const [dailyLoading, setDailyLoading] = useState(false)

  useEffect(() => {
    loadDashboardData()
    loadEndpointList()
    loadUpstreamBalance()
    adminApi.getUpstreamUsage()
      .then(res => setUpstreamUsage(res.data.data?.items || []))
      .catch(() => {})
  }, [])

  // 上游余额独立异步加载：仪表盘先渲染，余额单独显示「加载中…」。
  // 后端查上游较慢（后台预热），若暂时还是「查询中…」就轮询几次直到拿到真实值。
  const loadUpstreamBalance = async (attempt = 0) => {
    try {
      const res = await adminApi.getUpstreamBalance()
      const items = res.data.data?.items || []
      setUpstreamBalances(items)
      const hasData = items.some(it => it.balance_str)
      if (hasData || attempt >= 5) {
        setUpstreamBalanceLoading(false)
        return
      }
      // 余额由实时流量拦截写入，刚重启可能还没数据，短轮询几次
      setTimeout(() => loadUpstreamBalance(attempt + 1), 3000)
    } catch (e) {
      setUpstreamBalanceLoading(false)
    }
  }

  useEffect(() => {
    loadDailyData()
    loadRegionData()
  }, [dailyRange])

  useEffect(() => {
    loadChartData()
    loadUserDailyData()
  }, [selectedDate, selectedEndpoint])

  useEffect(() => {
    loadDailyEndpointStats()
  }, [selectedDate])

  const loadDailyData = async () => {
    setDailyLoading(true)
    try {
      const end = new Date()
      const start = new Date()
      start.setDate(start.getDate() - dailyRange + 1)
      const res = await adminApi.getDailyStatistics({
        start_date: formatLocalDate(start),
        end_date: formatLocalDate(end)
      })
      setDailyData(res.data.data?.days || [])
    } catch (e) {
      console.error('加载消费趋势失败:', e)
    }
    setDailyLoading(false)
  }

  const loadRegionData = async () => {
    setRegionLoading(true)
    try {
      const end = new Date()
      const start = new Date()
      start.setDate(start.getDate() - dailyRange + 1)
      const res = await adminApi.getUserRegionDistribution({
        start_date: formatLocalDate(start),
        end_date: formatLocalDate(end)
      })
      setRegionItems(res.data.data?.items || [])
    } catch (e) {
      console.error('加载地区分布失败:', e)
    }
    setRegionLoading(false)
  }

  const loadEndpointList = async () => {
    try {
      const response = await adminApi.getEndpointList()
      setEndpointList(response.data.data?.endpoints || [])
    } catch (e) {
      console.error('加载接口列表失败:', e)
    }
  }

  const loadChartData = async () => {
    setChartLoading(true)
    try {
      const [hourlyRes, minuteRes, healthRes] = await Promise.all([
        adminApi.getHourlyStatistics({ date: selectedDate, endpoint: selectedEndpoint || undefined }),
        adminApi.getMinuteStatistics({ date: selectedDate, endpoint: selectedEndpoint || undefined }),
        adminApi.getHourlyHealth({ date: selectedDate })
      ])
      setHourlyData(hourlyRes.data.data?.hourly || [])
      setMinuteData(minuteRes.data.data?.minutes || [])
      setHourlyHealth(healthRes.data.data?.endpoints || [])
      setHourlyHealthUpstreams(healthRes.data.data?.upstreams || [])
    } catch (e) {
      console.error('加载图表数据失败:', e)
    }
    setChartLoading(false)
  }

  const loadUserDailyData = async () => {
    try {
      const userRes = await adminApi.getDailyUserStatistics({
        date: selectedDate,
        endpoint: selectedEndpoint || undefined
      })
      setUserDailyData(userRes.data.data?.users || [])
    } catch (e) {
      console.error('加载用户调用统计失败:', e)
    }
  }

  // 接口调用分布 / 接口消费分布用：只看 selectedDate 当天（不受 selectedEndpoint 筛选，否则分布图就没意义了）
  const loadDailyEndpointStats = async () => {
    try {
      const res = await adminApi.getEndpointStatistics({ start_date: selectedDate, end_date: selectedDate })
      setDailyEndpointStats(res.data.data?.endpoints || [])
    } catch (e) {
      console.error('加载当日接口分布失败:', e)
    }
  }

  const loadDashboardData = async () => {
    try {
      const now = new Date()
      const weekAgo = new Date(now)
      weekAgo.setDate(weekAgo.getDate() - 7)
      const weekStart = formatLocalDate(weekAgo)
      const weekEnd = formatLocalDate(now)

      const today = formatLocalDate(now)
      const [accountRes, authRes, usageRes, endpointRes, todayEndpointRes, blockedUsersRes, blockedIpsRes] = await Promise.all([
        adminApi.listUserAccounts(),
        adminApi.listAuth(),
        adminApi.getUsageStatistics(),
        adminApi.getEndpointStatistics({ start_date: weekStart, end_date: weekEnd }),
        adminApi.getEndpointStatistics({ start_date: today, end_date: today }),
        adminApi.listBlockedUsers(),
        adminApi.listBlockedIps()
      ])

      const userAccounts = accountRes.data.data || []
      const auths = authRes.data.data || []
      const totalAuths = auths.length
      const blockedAuths = blockedUsersRes.data.count || auths.filter(auth => auth.blocked).length
      const activeUsers = userAccounts.filter(user =>
        (user.auths || []).some(auth => auth.enabled && !auth.blocked)
      ).length
      const blockedUsers = userAccounts.filter(user => {
        const userAuths = user.auths || []
        return userAuths.length > 0 && userAuths.every(auth => auth.blocked)
      }).length
      const usage = usageRes.data.data || {}
      const endpoints = endpointRes.data.data?.endpoints || []
      const todayEndpoints = todayEndpointRes.data.data?.endpoints || []

      let totalCalls = 0
      let totalAmount = 0
      if (usage.users) {
        usage.users.forEach(u => {
          totalCalls += u.total_calls || 0
          totalAmount += u.total_amount || 0
        })
      }

      const todayCalls = todayEndpoints.reduce((s, e) => s + (e.total_calls || 0), 0)
      const todayAmount = todayEndpoints.reduce((s, e) => s + (e.total_amount || 0), 0)
      const todaySuccessCalls = todayEndpoints.reduce((s, e) => s + (e.success_calls || 0), 0)
      const todayUpstreamCost = todayEndpoints.reduce((s, e) => s + (e.total_cost || 0), 0)
      const todayProfit = todayAmount - todayUpstreamCost
      setTodayStats({
        calls: todayCalls,
        amount: todayAmount.toFixed(2),
        successCalls: todaySuccessCalls,
        upstreamCost: todayUpstreamCost.toFixed(2),
        profit: todayProfit.toFixed(2)
      })

      // 新增用户数：按 created_at 的日期(YYYY-MM-DD)与本地日期比较
      const todayStr = formatLocalDate(now)
      const d7 = formatLocalDate(new Date(now.getTime() - 6 * 86400000))
      const d30 = formatLocalDate(new Date(now.getTime() - 29 * 86400000))
      let newToday = 0, new7d = 0, new30d = 0
      userAccounts.forEach(u => {
        const d = (u.created_at || '').slice(0, 10)
        if (!d) return
        if (d === todayStr) newToday++
        if (d >= d7) new7d++
        if (d >= d30) new30d++
      })

      setStats({
        totalUsers: userAccounts.length,
        activeUsers,
        totalAuths,
        blockedAuths,
        totalCalls,
        totalAmount: totalAmount.toFixed(2),
        blockedUsers,
        blockedIps: blockedIpsRes.data.count || 0,
        newToday,
        new7d,
        new30d
      })

      setEndpointStats(endpoints.slice(0, 5))
    } catch (e) {
      console.error('加载仪表盘数据失败:', e)
    }
    setLoading(false)
  }

  const changeDate = (delta) => {
    const current = new Date(selectedDate)
    current.setDate(current.getDate() + delta)
    const newDate = formatLocalDate(current)
    if (newDate <= formatLocalDate()) {
      setSelectedDate(newDate)
    }
  }

  const isToday = selectedDate === formatLocalDate()

  const epShortName = (type) => endpointList.find(e => e.type === type)?.shortName || type

  // 分布饼图：接口多了之后只显示占比前 N 名，其余聚合为「其他」，避免饼图碎成几十片、图例排很长把卡片撑乱
  const TOP_PIE = 8
  const topNDist = (list, valKey) => {
    const arr = (list || []).filter(e => (e[valKey] || 0) > 0).slice().sort((a, b) => (b[valKey] || 0) - (a[valKey] || 0))
    const total = arr.reduce((s, x) => s + (x[valKey] || 0), 0)
    const items = arr.slice(0, TOP_PIE).map(e => ({ name: epShortName(e.endpoint), value: e[valKey] || 0, percent: total > 0 ? (e[valKey] || 0) / total : 0 }))
    const restVal = arr.slice(TOP_PIE).reduce((s, x) => s + (x[valKey] || 0), 0)
    if (restVal > 0) items.push({ name: `其他 (${arr.length - TOP_PIE}个)`, value: restVal, percent: total > 0 ? restVal / total : 0 })
    return { items, total }
  }

  if (loading) {
    return <div className="loading">加载中...</div>
  }

  const todayTotal = minuteData.reduce((sum, item) => sum + item.count, 0)
  const minuteTicks = Array.from({ length: 25 }, (_, i) => `${String(i % 24).padStart(2, '0')}:00`)
  const callsDisplay = stats.totalCalls > 99999
    ? (stats.totalCalls / 10000).toFixed(1) + 'w'
    : stats.totalCalls.toLocaleString()
  const userStatusData = [
    { name: '活跃用户', value: stats.activeUsers, fill: '#10b981' },
    { name: '停用用户', value: Math.max(0, stats.totalUsers - stats.activeUsers - stats.blockedUsers), fill: '#d1d5db' },
    { name: '全部Auth屏蔽', value: stats.blockedUsers, fill: '#ef4444' },
  ]
  const userStatusFiltered = userStatusData.filter(d => d.value > 0)
  const securityBarData = [
    { name: '屏蔽Auth', value: stats.blockedAuths },
    { name: '封禁IP', value: stats.blockedIps },
  ]

  return (
    <div>
      <div className="page-header">
        <div className="page-title-block">
          <h1>运营概览</h1>
          <p>查看接口调用、消费、用户活跃与服务健康状态。</p>
        </div>
        <div className="page-header-meta">
          {selectedDate} · {selectedEndpoint ? epShortName(selectedEndpoint) : '全部接口'}
        </div>
      </div>

      <div className="card dashboard-overview-grid">
        <div className="dashboard-panel dashboard-panel-pad-right">
          <div className="card-header">
            <h2>用户状态</h2>
            <span style={{ color: '#64748b', fontSize: 12 }}>总Auth {stats.totalAuths}</span>
          </div>
          <div style={{ height: 200, display: 'flex', alignItems: 'center' }}>
            <div style={{ position: 'relative', width: 160, height: '100%', flexShrink: 0 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={userStatusFiltered.length > 0 ? userStatusFiltered : [{ name: '无数据', value: 1, fill: '#e5e7eb' }]}
                    cx="50%" cy="50%"
                    innerRadius={52} outerRadius={76}
                    dataKey="value" paddingAngle={2}
                    isAnimationActive={true}
                  >
                    {(userStatusFiltered.length > 0 ? userStatusFiltered : [{ fill: '#e5e7eb' }]).map((entry, i) => (
                      <Cell key={i} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v, n) => [v + ' 个', n]} />
                </PieChart>
              </ResponsiveContainer>
              <div style={{
                position: 'absolute', inset: 0,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                pointerEvents: 'none'
              }}>
                <div style={{ fontSize: 26, fontWeight: 700, color: '#0f172a', lineHeight: 1 }}>{stats.totalUsers}</div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>用户总数</div>
              </div>
            </div>
            <div style={{ flex: 1, paddingLeft: 12 }}>
              {[
                { name: '活跃用户', value: stats.activeUsers, color: '#10b981' },
                { name: '停用用户', value: Math.max(0, stats.totalUsers - stats.activeUsers - stats.blockedUsers), color: '#d1d5db' },
                { name: '全部Auth屏蔽', value: stats.blockedUsers, color: '#ef4444' },
              ].map((item, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: item.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: 13, color: '#64748b' }}>{item.name}</span>
                  <strong style={{ fontSize: 15, color: '#0f172a' }}>{item.value}</strong>
                </div>
              ))}
              <div style={{ borderTop: '1px solid #f1f5f9', marginTop: 2, paddingTop: 10 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ flex: 1, fontSize: 13, color: '#64748b' }}>今日新增</span>
                  <strong style={{ fontSize: 18, color: '#10b981' }}>+{stats.newToday}</strong>
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4, textAlign: 'right' }}>
                  近7天 +{stats.new7d} · 近30天 +{stats.new30d} · 总Auth {stats.totalAuths}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="dashboard-panel dashboard-panel-pad-middle">
          <div className="card-header">
            <h2>调用 & 消费</h2>
            <span style={{ color: '#94a3b8', fontSize: 12 }}>近7天 / 今日</span>
          </div>
          <div style={{ height: 200, display: 'grid', gridTemplateColumns: 'repeat(4, minmax(98px, 1fr))', alignItems: 'center', gap: 8 }}>
            <MetricRing
              value={callsDisplay}
              label="总调用次数"
              sublabel={`今日 ${todayStats.calls.toLocaleString()}`}
              color="#f59e0b"
              fontSize={callsDisplay.length > 6 ? 14 : 18}
              size={108}
              innerRadius={38}
              outerRadius={52}
            />
            <MetricRing
              value={`¥${stats.totalAmount}`}
              label="总消费金额"
              sublabel={`今日 ¥${todayStats.amount}`}
              color="#10b981"
              fontSize={String(stats.totalAmount).length > 7 ? 13 : 16}
              size={108}
              innerRadius={38}
              outerRadius={52}
            />
            <MetricRing
              value={`¥${todayStats.upstreamCost}`}
              label="今日成本"
              sublabel={`成功 ${todayStats.successCalls.toLocaleString()} 次`}
              color="#0ea5e9"
              fontSize={String(todayStats.upstreamCost).length > 6 ? 13 : 16}
              size={108}
              innerRadius={38}
              outerRadius={52}
            />
            <MetricRing
              value={`¥${todayStats.profit}`}
              label="今日净利润"
              sublabel={`收入 ¥${todayStats.amount}`}
              color={Number(todayStats.profit) >= 0 ? '#16a34a' : '#ef4444'}
              fontSize={String(todayStats.profit).length > 6 ? 13 : 16}
              size={108}
              innerRadius={38}
              outerRadius={52}
            />
          </div>
        </div>

        <div className="dashboard-panel dashboard-panel-pad-left">
          <div className="card-header">
            <h2>安全概览</h2>
            <span className="dashboard-upstream-balances">
              上游余额：{upstreamBalanceLoading
                ? <span style={{ color: '#94a3b8' }}>加载中…</span>
                : (upstreamBalances.length === 0
                  ? <span style={{ color: '#94a3b8' }}>暂无</span>
                  : upstreamBalances.map((it, i) => (
                    <span key={it.key} className="dashboard-upstream-balance">
                      {it.name} <strong>{it.balance_str || '暂无'}</strong>
                    </span>
                  )))}
            </span>
          </div>
          <div style={{ height: 200, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <ResponsiveContainer width="100%" height={140}>
              <BarChart
                layout="vertical"
                data={securityBarData}
                margin={{ top: 10, right: 55, left: 58, bottom: 10 }}
              >
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--bg-subtle, #f1f5f9)" />
                <XAxis type="number" stroke="#cbd5e1" fontSize={11} allowDecimals={false} />
                <YAxis type="category" dataKey="name" stroke="#cbd5e1" fontSize={12} width={56} />
                <Tooltip formatter={(v) => [v + ' 个', '数量']} />
                <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={30} minPointSize={4}>
                  <Cell fill="#f59e0b" />
                  <Cell fill="#ef4444" />
                  <LabelList dataKey="value" position="right" style={{ fontSize: 13, fontWeight: 600, fill: '#0f172a' }} formatter={v => v + ' 个'} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* 第一行：接口调用分布 | 接口调用趋势 */}
      <div className="card dashboard-split-grid">

        {/* 左：接口调用分布（跟右侧「接口调用趋势」共享 selectedDate，切一天联动一天） */}
        <div className="dashboard-panel dashboard-panel-pad-right">
          <div className="card-header">
            <h2>接口调用分布</h2>
            <span style={{ color: '#94a3b8', fontSize: 12 }}>{selectedDate}</span>
          </div>
          {(() => {
            const dist = topNDist(dailyEndpointStats, 'total_calls')
            return <DistributionDonut items={dist.items} total={dist.total} centerLabel="总调用"
              fmt={(v) => (v || 0).toLocaleString()} tooltip={<PieTooltip />} />
          })()}
        </div>

        {/* 右：接口调用趋势 */}
        <div className="dashboard-panel dashboard-panel-pad-left">
          <div className="card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
            <h2>接口调用趋势</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <select className="form-control" value={selectedEndpoint} onChange={e => setSelectedEndpoint(e.target.value)} style={{ width: 140 }}>
                <option value="">全部接口</option>
                {endpointList.map(ep => <option key={ep.type} value={ep.type}>{ep.name}</option>)}
              </select>
              <button className="btn btn-sm btn-secondary" onClick={() => changeDate(-1)}>&lt;</button>
              <span style={{ fontSize: 12, color: '#94a3b8', minWidth: 86, textAlign: 'center' }}>{selectedDate}</span>
              <button className="btn btn-sm btn-secondary" onClick={() => changeDate(1)} disabled={isToday}>&gt;</button>
            </div>
          </div>
          <div style={{ height: 280, marginTop: 4 }}>
            {chartLoading ? (
              <div className="dashboard-chart-empty">加载中...</div>
            ) : !hourlyData.some(d => d.total > 0) ? (
              <div className="dashboard-chart-empty">{selectedDate} 暂无数据</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={hourlyData} margin={{ top: 5, right: 16, left: 0, bottom: 5 }}>
                  <defs>
                    <linearGradient id="callBarGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#60a5fa" stopOpacity={0.78} />
                      <stop offset="100%" stopColor="#2dd4bf" stopOpacity={0.42} />
                    </linearGradient>
                    <linearGradient id="callGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#1e3a8a" stopOpacity={0.18} />
                      <stop offset="95%" stopColor="#1e3a8a" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-subtle, #f1f5f9)" vertical={false} />
                  <XAxis dataKey="hour" stroke="#cbd5e1" fontSize={10} tickFormatter={v => v.slice(0, 2)} />
                  <YAxis stroke="#cbd5e1" fontSize={11} allowDecimals={false} width={32} />
                  <Tooltip contentStyle={{ backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: 6, color: '#0f172a' }} formatter={(v) => [v, '调用次数']} />
                  <Bar dataKey="total" fill="url(#callBarGradient)" radius={[4, 4, 0, 0]} maxBarSize={20} opacity={0.92} />
                  <Area type="monotone" dataKey="total" stroke="#1e3a8a" strokeWidth={2.4} fill="url(#callGradient)" dot={false} activeDot={{ r: 4, fill: '#2dd4bf', stroke: '#fff', strokeWidth: 2 }} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

      </div>

      {/* 第二行：接口消费分布 | 用户调用统计 */}
      <div className="card dashboard-split-grid">

        {/* 左：接口消费分布（跟右侧「用户调用统计」共享 selectedDate，切一天联动一天） */}
        <div className="dashboard-panel dashboard-panel-pad-right">
          <div className="card-header">
            <h2>接口消费分布</h2>
            <span style={{ color: '#94a3b8', fontSize: 12 }}>{selectedDate}</span>
          </div>
          {(() => {
            const dist = topNDist(dailyEndpointStats, 'total_amount')
            return <DistributionDonut items={dist.items} total={dist.total} centerLabel="总消费"
              fmt={(v) => '¥' + (v || 0).toFixed(2)} tooltip={<AmountPieTooltip />} />
          })()}
        </div>

        {/* 右：用户调用统计 */}
        <div className="dashboard-panel dashboard-panel-pad-left">
          <div className="card-header">
            <h2>用户调用统计</h2>
            <span style={{ color: '#94a3b8', fontSize: 12 }}>{selectedDate} · {selectedEndpoint || '全部接口'}</span>
          </div>
          <div style={{ height: 280, marginTop: 4 }}>
            {userDailyData.length === 0 ? (
              <div className="dashboard-chart-empty">当日暂无调用数据</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={userDailyData.slice(0, 10)} margin={{ top: 5, right: 16, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-subtle, #f1f5f9)" />
                  <XAxis dataKey="user_name" stroke="#cbd5e1" fontSize={11} />
                  <YAxis yAxisId="left" stroke="#cbd5e1" fontSize={11} width={32} />
                  <YAxis yAxisId="right" orientation="right" stroke="#cbd5e1" fontSize={11} tickFormatter={v => `¥${v}`} width={40} />
                  <Tooltip content={<UserUsageTooltip />} />
                  <Legend />
                  <Bar yAxisId="left" dataKey="total_calls" fill="#f59e0b" name="调用次数" radius={[4, 4, 0, 0]} />
                  <Line yAxisId="right" type="monotone" dataKey="total_amount" stroke="#10b981" strokeWidth={2} name="消费金额" dot={{ fill: '#10b981', r: 3 }} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

      </div>

      {/* 消费趋势曲线 */}
      {(() => {
        const totalCalls = dailyData.reduce((s, d) => s + d.total_calls, 0)
        const totalAmount = dailyData.reduce((s, d) => s + d.total_amount, 0)
        const totalRecharge = dailyData.reduce((s, d) => s + (d.total_recharge || 0), 0)
        const activeDays = dailyData.filter(d => d.total_calls > 0).length
        const avgAmount = activeDays > 0 ? totalAmount / activeDays : 0
        const peakDay = dailyData.reduce((best, d) => d.total_amount > (best?.total_amount ?? -1) ? d : best, null)
        const tickInterval = dailyRange <= 7 ? 0 : dailyRange <= 14 ? 1 : Math.ceil(dailyRange / 10) - 1
        return (
          <div className="card">
            <div className="card-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <h2>消费趋势</h2>
                <div className="segmented-control">
                  {[7, 14, 30].map(d => (
                    <button key={d} className={dailyRange === d ? 'active' : ''} onClick={() => setDailyRange(d)}>{d}天</button>
                  ))}
                </div>
              </div>
            </div>

            {/* KPI 汇总行 */}
            {!dailyLoading && totalCalls > 0 && (
              <div className="dashboard-mini-metrics">
                {[
                  { label: '期间总调用', value: totalCalls.toLocaleString() + ' 次', color: '#3b82f6' },
                  { label: '期间总消费', value: '¥' + totalAmount.toFixed(2), color: '#0ea5e9' },
                  { label: '期间总充值', value: '¥' + totalRecharge.toFixed(2), color: '#10b981' },
                  { label: '单日消费峰值', value: peakDay ? `¥${peakDay.total_amount.toFixed(2)}  ${peakDay.date.slice(5)}` : '-', color: '#6366f1' },
                ].map((item, i) => (
                  <div className="dashboard-mini-metric" key={i}>
                    <div className="dashboard-mini-metric-label">{item.label}</div>
                    <div className="dashboard-mini-metric-value" style={{ color: item.color }}>{item.value}</div>
                  </div>
                ))}
              </div>
            )}

            {/* 图表 */}
            <div style={{ height: 220 }}>
              {dailyLoading ? (
                <div className="dashboard-chart-empty">加载中...</div>
              ) : totalCalls === 0 ? (
                <div className="dashboard-chart-empty">暂无数据</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={dailyData} margin={{ top: 8, right: 60, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                    <XAxis
                      dataKey="date" axisLine={false} tickLine={false}
                      tick={{ fill: '#94a3b8', fontSize: 11 }}
                      tickFormatter={v => v.slice(5)}
                      interval={tickInterval}
                    />
                    <YAxis
                      yAxisId="calls" axisLine={false} tickLine={false}
                      tick={{ fill: '#94a3b8', fontSize: 11 }} width={36}
                      allowDecimals={false}
                    />
                    <YAxis
                      yAxisId="amount" orientation="right" axisLine={false} tickLine={false}
                      tick={{ fill: '#94a3b8', fontSize: 11 }} width={52}
                      tickFormatter={v => `¥${v}`}
                    />
                    <Tooltip content={(props) => <DailyTooltip {...props} avgAmount={avgAmount} />} />
                    {avgAmount > 0 && (
                      <ReferenceLine
                        yAxisId="amount" y={avgAmount}
                        stroke="#0ea5e9" strokeDasharray="5 4" strokeOpacity={0.4} strokeWidth={1.5}
                        label={{ value: '均值', position: 'insideTopRight', fill: '#0ea5e9', fontSize: 10, opacity: 0.6 }}
                      />
                    )}
                    <Bar
                      yAxisId="calls" dataKey="total_calls" name="调用次数"
                      fill="#3b82f6" opacity={0.55} radius={[3, 3, 0, 0]}
                      maxBarSize={dailyRange <= 7 ? 28 : dailyRange <= 14 ? 18 : 12}
                    />
                    <Bar
                      yAxisId="amount" dataKey="total_recharge" name="充值金额"
                      fill="#10b981" opacity={0.5} radius={[3, 3, 0, 0]}
                      maxBarSize={dailyRange <= 7 ? 28 : dailyRange <= 14 ? 18 : 12}
                    />
                    <Line
                      yAxisId="amount" type="linear" dataKey="total_amount" name="消费金额"
                      stroke="#0ea5e9" strokeWidth={2.5} dot={false}
                      activeDot={{ r: 5, fill: '#0ea5e9', stroke: '#fff', strokeWidth: 2 }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        )
      })()}

      {/* 用户活跃趋势：日活跃用户数 & 日消费用户数 */}
      {(() => {
        const peakActive = dailyData.reduce((m, d) => Math.max(m, d.active_users || 0), 0)
        const peakPaying = dailyData.reduce((m, d) => Math.max(m, d.paying_users || 0), 0)
        const validDays = dailyData.filter(d => (d.active_users || 0) > 0)
        const avgActive = validDays.length ? validDays.reduce((s, d) => s + (d.active_users || 0), 0) / validDays.length : 0
        const avgPaying = validDays.length ? validDays.reduce((s, d) => s + (d.paying_users || 0), 0) / validDays.length : 0
        const tickInterval = dailyRange <= 7 ? 0 : dailyRange <= 14 ? 1 : Math.ceil(dailyRange / 10) - 1
        const hasData = peakActive > 0
        return (
          <div className="card">
            <div className="card-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <h2>用户活跃趋势</h2>
                <span style={{ color: '#94a3b8', fontSize: 13 }}>按账户去重 · 跟随上方时间范围（{dailyRange}天）</span>
              </div>
            </div>

            {!dailyLoading && hasData && (
              <div className="dashboard-mini-metrics">
                {[
                  { label: '日活跃用户峰值', value: peakActive + ' 人', color: '#3b82f6' },
                  { label: '日活跃用户均值', value: avgActive.toFixed(1) + ' 人', color: '#3b82f6' },
                  { label: '日消费用户峰值', value: peakPaying + ' 人', color: '#0ea5e9' },
                  { label: '日消费用户均值', value: avgPaying.toFixed(1) + ' 人', color: '#0ea5e9' },
                ].map((item, i) => (
                  <div className="dashboard-mini-metric" key={i}>
                    <div className="dashboard-mini-metric-label">{item.label}</div>
                    <div className="dashboard-mini-metric-value" style={{ color: item.color }}>{item.value}</div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ height: 220 }}>
              {dailyLoading ? (
                <div className="dashboard-chart-empty">加载中...</div>
              ) : !hasData ? (
                <div className="dashboard-chart-empty">暂无数据</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dailyData} margin={{ top: 8, right: 20, left: 0, bottom: 0 }} barGap={6} barCategoryGap="28%">
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                    <XAxis
                      dataKey="date" axisLine={false} tickLine={false}
                      tick={{ fill: '#94a3b8', fontSize: 11 }}
                      tickFormatter={v => v.slice(5)}
                      interval={tickInterval}
                    />
                    <YAxis
                      axisLine={false} tickLine={false}
                      tick={{ fill: '#94a3b8', fontSize: 11 }} width={36}
                      allowDecimals={false}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: 6, color: '#0f172a', fontSize: 12 }}
                      labelFormatter={v => `日期 ${v}`}
                      formatter={(value, name) => [`${value} 人`, name]}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar
                      dataKey="active_users" name="日活跃用户"
                      fill="#3b82f6" radius={[4, 4, 0, 0]}
                      maxBarSize={dailyRange <= 7 ? 30 : dailyRange <= 14 ? 22 : 14}
                    />
                    <Bar
                      dataKey="paying_users" name="日消费用户"
                      fill="#0ea5e9" radius={[4, 4, 0, 0]}
                      maxBarSize={dailyRange <= 7 ? 30 : dailyRange <= 14 ? 22 : 14}
                    />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        )
      })()}

      {/* 热门接口 Top 5 横向柱状图 */}
      <div className="card">
        <div className="card-header">
          <h2>热门接口 Top 5（近7天）</h2>
          <span style={{ color: '#666', fontSize: 13 }}>颜色：绿≥90% 黄≥70% 红&lt;70%（成功率）</span>
        </div>
        <div style={{ height: 260, marginTop: 10 }}>
          {endpointStats.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#64748b' }}>暂无数据</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                layout="vertical"
                data={endpointStats.map(ep => ({
                  name: epShortName(ep.endpoint),
                  调用次数: ep.total_calls,
                  _ep: ep,
                }))}
                margin={{ top: 5, right: 80, left: 80, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--bg-subtle, #f1f5f9)" />
                <XAxis type="number" stroke="#cbd5e1" fontSize={11} allowDecimals={false} />
                <YAxis type="category" dataKey="name" stroke="#cbd5e1" fontSize={12} width={75} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: 6, color: '#0f172a' }}
                  formatter={(value, name, props) => {
                    const ep = props.payload._ep
                    return [`${value.toLocaleString()} 次  |  成功率 ${ep.success_rate}%  |  ¥${ep.total_amount.toFixed(4)}`, '调用']
                  }}
                />
                <Bar dataKey="调用次数" radius={[0, 4, 4, 0]} maxBarSize={24}>
                  {endpointStats.map((ep, i) => (
                    <Cell key={i} fill={ep.success_rate >= 90 ? '#10b981' : ep.success_rate >= 70 ? '#f59e0b' : '#ef4444'} />
                  ))}
                  <LabelList dataKey="调用次数" position="right" style={{ fontSize: 12, fill: '#94a3b8' }} formatter={v => v.toLocaleString()} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* 用户地区分布：每个用户(authorization)取一个代表IP解析省份，中国地图展示，跟「消费趋势」
          共享 dailyRange 时间窗口。是"这个用户大概在哪"，不是"这个省份被调用了多少次"。 */}
      {(() => {
        const byProvince = {}
        let unknownCount = 0
        regionItems.forEach(it => {
          if (it.province === '未知' || it.province === '内网/本机') { unknownCount++; return }
          if (!byProvince[it.province]) byProvince[it.province] = []
          byProvince[it.province].push(it.name)
        })
        const mapData = Object.entries(byProvince).map(([name, names]) => ({ name, value: names.length, names }))
        const maxCount = Math.max(1, ...mapData.map(d => d.value))
        const option = {
          tooltip: {
            trigger: 'item',
            confine: true,
            formatter: (params) => {
              const d = params.data
              if (!d || !d.names || !d.names.length) return `${params.name}<br/>暂无用户`
              return `<strong>${params.name}</strong>（${d.value}人）<br/>${d.names.join('、')}`
            }
          },
          visualMap: {
            min: 0,
            max: maxCount,
            left: 'left',
            bottom: '4%',
            text: ['多', '少'],
            inRange: { color: ['#dbeafe', '#3b82f6', '#1e3a8a'] },
            calculable: true,
            itemWidth: 12,
            itemHeight: 90,
            textStyle: { fontSize: 11, color: '#64748b' }
          },
          series: [{
            type: 'map',
            map: 'china',
            roam: true,
            label: { show: false },
            emphasis: { label: { show: true, fontSize: 11 }, itemStyle: { areaColor: '#fbbf24' } },
            itemStyle: { borderColor: '#fff', borderWidth: 1, areaColor: '#f1f5f9' },
            data: mapData
          }]
        }
        return (
          <div className="card">
            <div className="card-header">
              <h2>用户地区分布</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {unknownCount > 0 && (
                  <span style={{ color: '#94a3b8', fontSize: 12 }}>另有 {unknownCount} 个用户地区未知/内网，不计入地图</span>
                )}
                <span style={{ color: '#94a3b8', fontSize: 12 }}>近{dailyRange}天 · 按用户去重，非调用次数</span>
              </div>
            </div>
            <div style={{ height: 720, marginTop: 10 }}>
              {regionLoading ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#64748b' }}>加载中...</div>
              ) : mapData.length === 0 ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#64748b' }}>暂无数据</div>
              ) : (
                <ReactEChartsCore echarts={echarts} option={option} style={{ height: '100%', width: '100%' }} />
              )}
            </div>
          </div>
        )
      })()}

      {/* 上游使用分布（近24小时 · 上游视角）：各上游实际服务量/成功率/成本 + 被切换次数。
          与下方"接口健康程度"（客户视角）互补：切换救回的调用不影响健康图，但会在这里的"被切换"列现形 */}
      <div className="card">
        <div className="card-header">
          <h2>上游使用分布</h2>
          <span style={{ color: '#94a3b8', fontSize: 12 }}>近24小时 · 按实际服务的上游聚合（多上游切换的真实分担情况）</span>
        </div>
        {upstreamUsage.length === 0 ? (
          <div style={{ color: '#64748b', fontSize: 13, padding: '20px 0' }}>暂无数据（该功能上线后的调用才带上游标记）</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13 }}>
              <thead>
                <tr style={{ color: '#64748b', textAlign: 'left' }}>
                  <th style={{ padding: '6px 10px' }}>上游</th>
                  <th style={{ padding: '6px 10px', textAlign: 'right' }}>服务次数</th>
                  <th style={{ padding: '6px 10px', textAlign: 'right' }}>成功率</th>
                  <th style={{ padding: '6px 10px', textAlign: 'right' }}>上游成本</th>
                  <th style={{ padding: '6px 10px', textAlign: 'right' }}>被切换次数</th>
                </tr>
              </thead>
              <tbody>
                {upstreamUsage.map(u => (
                  <tr key={u.upstream} style={{ borderTop: '1px solid var(--bg-subtle, #f1f5f9)' }}>
                    <td style={{ padding: '6px 10px', fontWeight: 600 }}>{u.name}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right' }}>{u.total.toLocaleString()}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 600,
                      color: u.success_rate === null ? '#94a3b8' : u.success_rate >= 95 ? '#16a34a' : u.success_rate >= 80 ? '#f59e0b' : '#dc2626' }}>
                      {u.success_rate === null ? '-' : `${u.success_rate}%`}
                    </td>
                    <td style={{ padding: '6px 10px', textAlign: 'right' }}>¥{u.cost.toFixed(4)}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', color: u.switched_away > 0 ? '#f59e0b' : '#94a3b8', fontWeight: u.switched_away > 0 ? 700 : 400 }}>
                      {u.switched_away}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 接口健康程度（近24小时 · 每个接口 × 每小时成功率）— 置于最底部 */}
      <div className="card">
        <div className="card-header">
          <h2>接口健康程度</h2>
          <span style={{ color: '#94a3b8', fontSize: 12 }}>近24小时（当前往回）· 每接口每小时成功率(%)</span>
        </div>
        {chartLoading ? (
          <div style={{ color: '#64748b', fontSize: 13, padding: '20px 0' }}>加载中...</div>
        ) : hourlyHealth.length === 0 && hourlyHealthUpstreams.length === 0 ? (
          <div style={{ color: '#64748b', fontSize: 13, padding: '20px 0' }}>暂无数据</div>
        ) : (
          <>
            {hourlyHealthUpstreams.length > 0 && (
              <>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', marginTop: 10 }}>
                  上游供应商
                  <span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: 8 }}>含被切换的失败尝试——上游真实状态，不被候选链切换掩盖</span>
                </div>
                {renderHealthTable(
                  hourlyHealthUpstreams.map(u => ({ key: `${u.upstream}|${u.api || ''}`, label: u.name, hourly: u.hourly })),
                  '上游接口'
                )}
              </>
            )}
            <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', marginTop: 16 }}>
              下游对外接口
              <span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: 8 }}>客户视角——切换救回的调用计为成功</span>
            </div>
            {renderHealthTable(
              hourlyHealth.map(ep => ({ key: ep.endpoint, label: epShortName(ep.endpoint), hourly: ep.hourly })),
              '接口'
            )}
            <div style={{ display: 'flex', gap: 14, marginTop: 14, fontSize: 11, color: '#64748b', flexWrap: 'wrap' }}>
              {[
                { c: '#e2e8f0', l: '无数据' },
                { c: '#16a34a', l: '≥95% 健康' }, { c: '#84cc16', l: '80–95%' },
                { c: '#f59e0b', l: '50–80%' }, { c: '#f97316', l: '20–50%' },
                { c: '#dc2626', l: '<20% 异常' }
              ].map(item => (
                <span key={item.l} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: item.c, display: 'inline-block' }} />{item.l}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

    </div>
  )
}

export default Dashboard
