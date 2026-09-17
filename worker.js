const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function ok(body, contentType = 'application/json') {
  return new Response(body, { headers: { ...CORS_HEADERS, 'Content-Type': contentType } });
}

function err(msg, status = 500) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function cfg(envKey, env) {
  const isProd = envKey !== 'nonprod';
  const c = {
    baseUrl:      isProd ? env.PROD_BASE_URL     : env.NONPROD_BASE_URL,
    tenant:       isProd ? env.PROD_TENANT       : env.NONPROD_TENANT,
    clientId:     isProd ? env.PROD_CLIENT_ID    : env.NONPROD_CLIENT_ID,
    clientSecret: isProd ? env.PROD_CLIENT_SECRET: env.NONPROD_CLIENT_SECRET,
  };
  // All values come from Cloudflare vars/secrets — nothing tenant-specific is hardcoded here.
  const missing = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Worker not configured for ${isProd ? 'prod' : 'nonprod'}: missing ${missing.join(', ')}`);
  return c;
}

function staticHeaders(c) {
  return {
    'x-rdp-version':      '8.1',
    'x-rdp-clientId':     'rdpclient',
    'x-rdp-userId':       `${c.tenant}.systemadmin@syndigo.com`,
    'auth-client-id':     c.clientId,
    'auth-client-secret': c.clientSecret,
    'x-rdp-tenantId':     c.tenant,
    'Origin':             c.baseUrl,
    'User-Agent':         'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'DNT':                '1',
  };
}

function authHeaders(c, cookie, csrf, referer) {
  return { ...staticHeaders(c), 'Cookie': cookie, 'x-rdp-ct': csrf, 'Referer': referer };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const path = new URL(request.url).pathname;

    try {
      if (path === '/api/connectorstates') return await connectorStates(request, env);
      if (path === '/api/publish')         return await publish(request, env);
      if (path === '/api/status')          return await status(request, env);
      if (path === '/api/report')          return await report(request, env);
      return err('Not found', 404);
    } catch (e) {
      return err(e.message);
    }
  },
};

async function connectorStates(request, env) {
  const body = await request.json();
  const c    = cfg(body._env, env);
  delete body._env;

  const r = await fetch(`${c.baseUrl}/api/connectorService/get`, {
    method: 'POST',
    headers: { ...staticHeaders(c), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return ok(await r.text());
}

async function publish(request, env) {
  const body   = await request.json();
  const c      = cfg(body._env, env);
  const cookie = body._cookie || '';
  const csrf   = body._csrf   || '';
  delete body._env; delete body._cookie; delete body._csrf;

  // Tenant-specific user id is injected here (from PROD_/NONPROD_TENANT) so the dashboard stays tenant-agnostic.
  const jd = body?.proxyObject?.data?.jsonData;
  if (jd) jd.requestHeaders = { ...(jd.requestHeaders || {}), 'x-rdp-userId': `${c.tenant}.systemadmin@syndigo.com_user` };

  const r = await fetch(`${c.baseUrl}/data/pass-through/proxyservice/call`, {
    method: 'POST',
    headers: {
      ...authHeaders(c, cookie, csrf, `${c.baseUrl}/search-thing?appInstanceId=rsoRhPrOOni7G3FNQc`),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return ok(await r.text());
}

async function status(request, env) {
  const body   = await request.json();
  const c      = cfg(body._env, env);
  const cookie = body._cookie || '';
  const csrf   = body._csrf   || '';
  const taskId = body.taskId  || '';
  const paths  = body.paths   || '';

  const r = await fetch(`${c.baseUrl}/data/eventData.json?uil=&sdl=en-US&ssi=internal`, {
    method: 'POST',
    headers: {
      ...authHeaders(c, cookie, csrf, `${c.baseUrl}/task-detail?id=${taskId}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ paths, method: 'get' }),
  });
  return ok(await r.text());
}

async function report(request, env) {
  const body   = await request.json();
  const c      = cfg(body._env, env);
  const cookie = body._cookie || '';
  const csrf   = body._csrf   || '';
  const taskId = body.taskId  || '';

  const prepResp = await fetch(`${c.baseUrl}/data/binarystreamobjectservice/prepareDownload`, {
    method: 'POST',
    headers: {
      ...authHeaders(c, cookie, csrf, `${c.baseUrl}/task-detail?id=${taskId}`),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([{
      binaryStreamObject: { id: `${taskId}_report.csv`, type: 'app-shopify-report', data: {} },
    }]),
  });

  const prepData    = await prepResp.json();
  const downloadUrl = prepData?.response?.binaryStreamObjects?.[0]?.properties?.downloadURL;
  if (!downloadUrl) return err('Report not ready', 404);

  const csvResp = await fetch(downloadUrl);
  return ok(await csvResp.text(), 'text/csv');
}
