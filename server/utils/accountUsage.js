'use strict';

function parseJsonOrValue(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (_) {
    return value;
  }
}

function parseBoundedLimit(value, defaultLimit = 100, maxLimit = 500) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultLimit;
  return Math.min(parsed, maxLimit);
}

function listCallLogsPage(database, authorization, query = {}) {
  const limit = parseBoundedLimit(query.limit);
  const params = [authorization];
  let sql = `SELECT id, timestamp, endpoint, success, amount, client_ip, request_params, error_message
    FROM call_logs WHERE authorization = ?`;

  const beforeId = Number.parseInt(String(query.before_id ?? ''), 10);
  if (Number.isFinite(beforeId) && beforeId > 0) {
    sql += ' AND id < ?';
    params.push(beforeId);
  }
  if (query.start_date) {
    sql += ' AND timestamp >= ?';
    params.push(`${query.start_date} 00:00:00`);
  }
  if (query.end_date) {
    sql += ' AND timestamp <= ?';
    params.push(`${query.end_date} 23:59:59.999`);
  }
  if (query.endpoint) {
    sql += ' AND endpoint = ?';
    params.push(String(query.endpoint));
  }
  if (query.success === 'true' || query.success === 'false') {
    sql += ' AND success = ?';
    params.push(query.success === 'true' ? 1 : 0);
  }

  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit + 1);
  const rows = database.prepare(sql).all(...params);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const records = pageRows.map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    endpoint: row.endpoint,
    success: row.success === 1,
    amount: Number(row.amount || 0),
    client_ip: row.client_ip || '',
    request_params: parseJsonOrValue(row.request_params),
    error_message: row.error_message || ''
  }));

  return {
    records,
    count: records.length,
    limit,
    has_more: hasMore,
    next_cursor: hasMore && records.length ? records[records.length - 1].id : null
  };
}

function roundMetric(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

function normalizeDate(value, fallback) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}

function getUsageSummary(database, authorization, query = {}) {
  const startDate = normalizeDate(query.start_date, '2020-01-01');
  const endDate = normalizeDate(query.end_date, '2099-12-31');
  const requestedEndpoint = String(query.endpoint || '').trim();
  const seriesEndpoint = requestedEndpoint || 'ALL';
  const commonParams = [authorization, startDate, endDate, seriesEndpoint];

  const summaryRow = database.prepare(`SELECT
      COALESCE(SUM(calls), 0) AS calls,
      COALESCE(SUM(success_calls), 0) AS success_calls,
      COALESCE(SUM(failed_calls), 0) AS failed_calls,
      COALESCE(SUM(amount), 0) AS amount,
      COALESCE(SUM(cost), 0) AS cost,
      MIN(first_call) AS first_call,
      MAX(last_call) AS last_call
    FROM usage_statistics
    WHERE authorization = ? AND date >= ? AND date <= ? AND endpoint = ?`).get(...commonParams);

  const dailyRows = database.prepare(`SELECT date,
      SUM(calls) AS calls,
      SUM(success_calls) AS success_calls,
      SUM(failed_calls) AS failed_calls,
      SUM(amount) AS amount,
      SUM(cost) AS cost
    FROM usage_statistics
    WHERE authorization = ? AND date >= ? AND date <= ? AND endpoint = ?
    GROUP BY date ORDER BY date`).all(...commonParams);

  const endpointParams = [authorization, startDate, endDate];
  let endpointWhere = "endpoint != 'ALL'";
  if (requestedEndpoint) {
    endpointWhere = 'endpoint = ?';
    endpointParams.push(requestedEndpoint);
  }
  const endpointRows = database.prepare(`SELECT endpoint,
      SUM(calls) AS calls,
      SUM(success_calls) AS success_calls,
      SUM(failed_calls) AS failed_calls,
      SUM(amount) AS amount,
      SUM(cost) AS cost
    FROM usage_statistics
    WHERE authorization = ? AND date >= ? AND date <= ? AND ${endpointWhere}
    GROUP BY endpoint ORDER BY calls DESC, endpoint`).all(...endpointParams);

  const mapRow = (row) => ({
    ...row,
    calls: Number(row.calls || 0),
    success_calls: Number(row.success_calls || 0),
    failed_calls: Number(row.failed_calls || 0),
    amount: roundMetric(row.amount),
    cost: roundMetric(row.cost)
  });

  return {
    summary: {
      calls: Number(summaryRow.calls || 0),
      success_calls: Number(summaryRow.success_calls || 0),
      failed_calls: Number(summaryRow.failed_calls || 0),
      amount: roundMetric(summaryRow.amount),
      cost: roundMetric(summaryRow.cost),
      first_call: summaryRow.first_call || '',
      last_call: summaryRow.last_call || ''
    },
    daily_stats: dailyRows.map(mapRow),
    endpoint_stats: endpointRows.map(mapRow),
    start_date: startDate,
    end_date: endDate,
    endpoint: requestedEndpoint || null
  };
}

function listUserUsageSummary(database) {
  const rows = database.prepare(`
    WITH key_usage AS (
      SELECT u.user_id, u.authorization,
        COALESCE(SUM(CASE WHEN s.endpoint = 'ALL' THEN s.calls ELSE 0 END), 0) AS total_calls,
        COALESCE(SUM(CASE WHEN s.endpoint = 'ALL' THEN s.success_calls ELSE 0 END), 0) AS success_calls,
        COALESCE(SUM(CASE WHEN s.endpoint = 'ALL' THEN s.failed_calls ELSE 0 END), 0) AS failed_calls,
        COALESCE(SUM(CASE WHEN s.endpoint = 'ALL' THEN s.amount ELSE 0 END), 0) AS total_amount,
        COALESCE(SUM(CASE WHEN s.endpoint = 'ALL' THEN s.cost ELSE 0 END), 0) AS total_cost,
        MIN(CASE WHEN s.endpoint = 'ALL' THEN s.first_call END) AS first_call,
        MAX(CASE WHEN s.endpoint = 'ALL' THEN s.last_call END) AS last_call
      FROM users u
      LEFT JOIN usage_statistics s ON s.authorization = u.authorization
      WHERE u.user_id IS NOT NULL AND u.user_id != ''
      GROUP BY u.user_id, u.authorization
    ), endpoint_usage AS (
      SELECT u.user_id, COUNT(DISTINCT s.endpoint) AS endpoints_count
      FROM users u
      JOIN usage_statistics s ON s.authorization = u.authorization AND s.endpoint != 'ALL'
      WHERE u.user_id IS NOT NULL AND u.user_id != ''
      GROUP BY u.user_id
    )
    SELECT ua.user_id, ua.username,
      COUNT(ku.authorization) AS key_count,
      COALESCE(SUM(CASE WHEN ku.total_calls > 0 THEN 1 ELSE 0 END), 0) AS active_key_count,
      COALESCE(SUM(ku.total_calls), 0) AS total_calls,
      COALESCE(SUM(ku.success_calls), 0) AS success_calls,
      COALESCE(SUM(ku.failed_calls), 0) AS failed_calls,
      COALESCE(SUM(ku.total_amount), 0) AS total_amount,
      COALESCE(SUM(ku.total_cost), 0) AS total_cost,
      COALESCE(eu.endpoints_count, 0) AS endpoints_count,
      MIN(ku.first_call) AS first_call,
      MAX(ku.last_call) AS last_call
    FROM user_accounts ua
    LEFT JOIN key_usage ku ON ku.user_id = ua.user_id
    LEFT JOIN endpoint_usage eu ON eu.user_id = ua.user_id
    GROUP BY ua.user_id, ua.username, eu.endpoints_count
    ORDER BY total_calls DESC, ua.username
  `).all();

  return rows.map((row) => ({
    user_id: row.user_id,
    username: row.username,
    key_count: Number(row.key_count || 0),
    active_key_count: Number(row.active_key_count || 0),
    total_calls: Number(row.total_calls || 0),
    success_calls: Number(row.success_calls || 0),
    failed_calls: Number(row.failed_calls || 0),
    total_amount: roundMetric(row.total_amount),
    total_cost: roundMetric(row.total_cost),
    total_profit: roundMetric(Number(row.total_amount || 0) - Number(row.total_cost || 0)),
    endpoints_count: Number(row.endpoints_count || 0),
    first_call: row.first_call || '',
    last_call: row.last_call || ''
  }));
}

function listDailyUserUsageSummary(database, date, endpoint = 'ALL') {
  const rows = database.prepare(`
    SELECT ua.user_id, ua.username AS user_name,
      COUNT(DISTINCT u.authorization) AS key_count,
      SUM(s.calls) AS total_calls,
      SUM(s.success_calls) AS success_calls,
      SUM(s.failed_calls) AS failed_calls,
      SUM(s.amount) AS total_amount
    FROM usage_statistics s
    JOIN users u ON u.authorization = s.authorization
    JOIN user_accounts ua ON ua.user_id = u.user_id
    WHERE s.date = ? AND s.endpoint = ?
    GROUP BY ua.user_id, ua.username
    ORDER BY total_calls DESC, ua.username
  `).all(date, endpoint);

  return rows.map((row) => {
    const amount = roundMetric(row.total_amount);
    return {
      user_id: row.user_id,
      user_name: row.user_name,
      key_count: Number(row.key_count || 0),
      total_calls: Number(row.total_calls || 0),
      success_calls: Number(row.success_calls || 0),
      failed_calls: Number(row.failed_calls || 0),
      total_amount: amount,
      // 旧仪表盘字段名保留兼容；这里一直表示客户消费金额，不是上游成本。
      total_cost: amount
    };
  });
}

module.exports = {
  getUsageSummary,
  listUserUsageSummary,
  listDailyUserUsageSummary,
  listCallLogsPage,
  parseBoundedLimit
};
