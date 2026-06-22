const FUNNEL_URL = "https://volonuk.tailf820d5.ts.net";
const JSON_H = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
const ALLOWED_PATHS = new Set(["/state", "/set"]);

function shellSingleQuote(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function execOnVoloNuk(cmd, env) {
  const headers = { "Content-Type": "application/json" };
  if (env.AG_BRIDGE_SECRET) headers["X-Bridge-Token"] = env.AG_BRIDGE_SECRET;
  const response = await fetch(`${FUNNEL_URL}/exec`, {
    method: "POST",
    headers,
    body: JSON.stringify({ cmd, timeout: 10 }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return new Response(JSON.stringify({ error: "bridge_unavailable", status: response.status, detail: detail.slice(0, 200) }), { status: 502, headers: JSON_H });
  }
  const result = await response.json();
  if (result.exit_code !== 0) {
    return new Response(JSON.stringify({ error: "backend_error", stderr: result.stderr || "" }), { status: 502, headers: JSON_H });
  }
  return new Response(result.stdout || "", { headers: JSON_H });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!ALLOWED_PATHS.has(url.pathname)) {
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: JSON_H });
    }

    if (url.pathname === "/state" && request.method === "GET") {
      return execOnVoloNuk("python3 - <<'PY'\nimport urllib.request\nopener=urllib.request.build_opener(urllib.request.ProxyHandler({}))\nwith opener.open('http://127.0.0.1:8081/state', timeout=5) as r:\n    print(r.read().decode(), end='')\nPY", env);
    }

    if (url.pathname === "/set" && request.method === "POST") {
      const body = await request.text();
      const quotedBody = shellSingleQuote(body);
      return execOnVoloNuk(`python3 - ${quotedBody} <<'PY'\nimport sys, urllib.request\nbody = sys.argv[1].encode()\nopener=urllib.request.build_opener(urllib.request.ProxyHandler({}))\nreq = urllib.request.Request('http://127.0.0.1:8081/set', data=body, headers={'Content-Type':'application/json'}, method='POST')\nwith opener.open(req, timeout=5) as r:\n    print(r.read().decode(), end='')\nPY`, env);
    }

    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: JSON_H });
  }
};
