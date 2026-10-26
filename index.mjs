// magpie provider plugin: Today.app — DeepSeek V4.1 Flash / GLM 5.3
//
// v0.1.1. Protocol ported from Main8986/today-proxy (core.py,
// server.py): the Today app's internal API, translated into OpenAI chat
// completions. Unlike the Python service, this runs inside magpie: no
// separate process, no port, no AUTH_TOKENS file.
//
// Login: phone + SMS code (autoclaw's phoneSmsMethod pattern):
//   prompts ask for the phone number -> authorize sends the OTP ->
//   host asks the user for the code -> callback verifies it and keeps
//   the session token. The 115-second JWT is minted on demand inside
//   fetch, never by hand.
//
// Known limits of this scaffold (same as today-proxy, by design):
//   - The upstream has NO function calling: tool_call is false, so
//     agentic agents can only plain-chat through it.
//   - The upstream has NO token streaming: fetch waits for the full
//     reply, then slices it into SSE chunks so the UI still progresses.
//   - Usage token counts are character counts, as today-proxy reports
//     them; the upstream does not return token usage.

const AUTH_BASE = "https://auth.todayai.cn";
const API_BASE = "https://api.todayai.cn";
const APP_VERSION = "1.23.0";
const CLIENT_CAPS = [
  "chat.browser.v1",
  "connectors.account_management.v1",
  "chat.brief_card.v1",
  "chat.qa_cardflow_single.v1",
  "chat.health_metric_card.v1",
  "chat.automation_card.v1",
  "chat.follow_up_recommendations.v1",
  "chat.message_reactions.unicode.v1",
].join(",");
const UA =
  "Today/1.23.0 Version/1.23.0 Build/2768 " +
  "Device/(OnePlus;OP5D2BL1)(PKG110; Android 15) NetType/WiFi";
const ORIGIN = "https://todayai.cn";

// Short and long names the agent may ask for -> upstream optionId.
// Unknown names are a 400, never a silent fallback (today-proxy's rule:
// a silent fallback would burn the wrong model's quota invisibly).
const NAME2OPT = {
  "deepseek": "model.deepseek-v4.1-flash",
  "deepseek-v4.1-flash": "model.deepseek-v4.1-flash",
  "model.deepseek-v4.1-flash": "model.deepseek-v4.1-flash",
  "glm": "model.glm-5.3",
  "glm-5.3": "model.glm-5.3",
  "model.glm-5.3": "model.glm-5.3",
};

// Models the provider declares to magpie. tool_call is false on purpose:
// the upstream is plain chat, it cannot take tool calls.
const MODELS = {
  "deepseek": {
    name: "DeepSeek V4.1 Flash",
    id: "deepseek",
    limit: { context: 128000, output: 32000 },
    reasoning: false,
    tool_call: false,
  },
  "glm-5.3": {
    name: "GLM 5.3",
    id: "glm-5.3",
    limit: { context: 128000, output: 32000 },
    reasoning: false,
    tool_call: false,
  },
};

// ---------------------------------------------------------------- utils

const randHex = (n) =>
  [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jwtExp(token) {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return Number(JSON.parse(json).exp ?? 0);
  } catch {
    return 0;
  }
}

class TodayError extends Error {
  constructor(msg, status, body = "") {
    super(msg);
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------- client

class TodayClient {
  constructor(session, deviceId, userId) {
    this.session = session;
    this.deviceId = deviceId || `d_${randHex(10)}`;
    this.userId = userId || null;
    this.jwt = null;
    this.jwtExp = 0;
  }

  baseHeaders(extra = {}) {
    const h = {
      "X-Client-Platform": "android",
      "X-Timezone": "Asia/Shanghai",
      "Accept-Language": "zh-CN",
      "X-App-Version": APP_VERSION,
      "X-Client-Capabilities": CLIENT_CAPS,
      "X-Device-Id": this.deviceId,
      "User-Agent": UA,
      "Origin": ORIGIN,
      "Accept": "application/json",
    };
    if (this.userId) h["X-User-Id"] = this.userId;
    return { ...h, ...extra };
  }

  async http(url, method = "GET", body = null, auth = null) {
    const headers = this.baseHeaders({ "Content-Type": "application/json" });
    if (auth) headers["Authorization"] = auth;
    const res = await fetch(url, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text };
  }

  // Mint a fresh JWT from the session token. Refreshes 20s before expiry
  // so a request never starts on a JWT about to die.
  async refreshJwt(force = false) {
    if (!force && this.jwt && Date.now() / 1000 < this.jwtExp - 20) return this.jwt;
    const { status, text } = await this.http(
      `${AUTH_BASE}/api/auth/token`,
      "GET",
      null,
      `Bearer ${this.session}`,
    );
    if (status !== 200) throw new TodayError("session token exchange failed", status, text.slice(0, 300));
    const d = JSON.parse(text);
    this.jwt = d.token;
    this.jwtExp = Date.now() / 1000 + Number(d.expiresIn || 115);
    const exp = jwtExp(this.jwt);
    if (exp) this.jwtExp = exp;
    if (!this.userId) {
      try {
        const payload = JSON.parse(
          Buffer.from(this.jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
        );
        this.userId = payload.sub ?? null;
      } catch { /* keep userId empty; the header is optional */ }
    }
    return this.jwt;
  }

  // One API call with a single 401 retry on a forced JWT refresh.
  async api(path, method = "GET", body = null) {
    let jwt = await this.refreshJwt();
    let r = await this.http(`${API_BASE}${path}`, method, body, `Bearer ${jwt}`);
    if (r.status === 401) {
      jwt = await this.refreshJwt(true);
      r = await this.http(`${API_BASE}${path}`, method, body, `Bearer ${jwt}`);
    }
    return r;
  }

  async pricing() {
    const { status, text } = await this.api("/v1/pricing/status");
    if (status !== 200) throw new TodayError("pricing/status failed", status, text.slice(0, 300));
    return JSON.parse(text).data.status;
  }

  async selectedModel() {
    try {
      return (await this.pricing()).modelOptions?.selectedOptionId ?? null;
    } catch {
      return null;
    }
  }

  async setModel(optionId) {
    if ((await this.selectedModel()) === optionId) return;
    const { status, text } = await this.api("/v1/pricing/model-option", "PUT", { optionId });
    if (status !== 200) throw new TodayError("model switch failed", status, text.slice(0, 300));
  }

  async send(text) {
    const body = { message: text, clientMessageId: `msg_${randHex(32)}` };
    const { status, text: out } = await this.api("/v1/messages", "POST", body);
    if (![200, 201, 202].includes(status)) throw new TodayError("send failed", status, out.slice(0, 500));
    return JSON.parse(out);
  }

  async listMessages(limit = 50) {
    const { status, text } = await this.api(`/v1/conversations/messages?isMainChat=true&limit=${limit}`);
    if (status !== 200) throw new TodayError("messages list failed", status, text.slice(0, 300));
    return JSON.parse(text).data;
  }

  // Poll until this thread's assistant message is completed. The upstream
  // has no token stream, so this returns the full text; fetch slices it
  // into SSE chunks afterwards, exactly as today-proxy does.
  async waitReply(threadId, { timeout = 180, signal } = {}) {
    const deadline = Date.now() + timeout * 1000;
    let last = "";
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("aborted");
      const data = await this.listMessages(50);
      for (const m of data.items ?? []) {
        if (m.threadId !== threadId || m.role !== "assistant") continue;
        const txt = messageText(m);
        if (txt) last = txt;
        if (m.state === "completed") return last;
      }
      await sleep(800);
    }
    if (last) return last;
    throw new TodayError(`upstream did not answer within ${timeout}s`, 504);
  }
}

function messageText(msg) {
  let out = "";
  for (const p of msg.body?.parts ?? []) {
    if (p.messageType === "text") out += p.content?.text ?? "";
  }
  return out;
}

// ------------------------------------------------------- prompt shaping
// Port of today-proxy's flatten_messages / _as_text: the upstream takes
// one flat message, so system prompts and history are folded into text.

function asText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
  return c == null ? "" : String(c);
}

function flattenMessages(messages) {
  const system = messages.filter((m) => m.role === "system").map((m) => asText(m.content));
  const turns = messages.filter((m) => m.role !== "system");
  if (!turns.length) return system.join("\n");
  if (turns.length === 1 && !system.length) return asText(turns[0].content);
  const buf = [];
  if (system.length) buf.push(`[系统指令]\n${system.join("\n\n")}`);
  if (turns.length > 1) {
    buf.push("[历史对话]");
    for (const m of turns.slice(0, -1)) {
      buf.push(`${m.role === "user" ? "用户" : "助手"}：${asText(m.content)}`);
    }
    buf.push("[当前消息]");
  }
  buf.push(asText(turns[turns.length - 1].content));
  return buf.join("\n");
}

function anthropicToOpenAI(body) {
  const msgs = [];
  if (body.system) msgs.push({ role: "system", content: asText(body.system) });
  for (const m of body.messages ?? []) {
    msgs.push({ role: m.role === "assistant" ? "assistant" : "user", content: asText(m.content) });
  }
  return msgs;
}

// ------------------------------------------------------------- responses

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function openAIChunks(id, created, model, reply) {
  const chunks = [
    { id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
  ];
  for (let i = 0; i < reply.length; i += 12) {
    chunks.push({ id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { content: reply.slice(i, i + 12) }, finish_reason: null }] });
  }
  chunks.push({ id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  return chunks;
}

function sseStream(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function openAIReply(reply, model, stream) {
  const id = `chatcmpl-${randHex(32)}`;
  const created = Math.floor(Date.now() / 1000);
  if (!stream) {
    return jsonResponse({
      id, object: "chat.completion", created, model,
      choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: reply.length, total_tokens: reply.length },
    });
  }
  return new Response(sseStream(openAIChunks(id, created, model, reply)), {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

// ------------------------------------------------------------------ login
// Phone + SMS code, autoclaw's phoneSmsMethod pattern:
//   prompts ask for the phone -> authorize sends the OTP and returns
//   {method: "code", callback} -> the host asks the user for the code ->
//   callback verifies it. authorize must THROW on failure: returning
//   {type: "failed"} would be misread by the host as an "auto" branch.

const phoneSmsMethod = {
  type: "oauth",
  label: "Today 手机验证码登录",
  prompts: [
    { type: "text", key: "phone", message: "手机号（11 位，不带 +86）", placeholder: "13800138000",
      validate: (v) => (/^1\d{10}$/.test(String(v ?? "").trim()) ? undefined : "11 位手机号") },
  ],
  async authorize(inputs) {
    const phone = String(inputs?.phone ?? "").trim();
    if (!/^1\d{10}$/.test(phone)) throw new Error("请输入 11 位手机号（不带 +86）");
    const full = `+86${phone}`;
    const deviceId = `d_${randHex(10)}`;
    const send = await fetch(`${AUTH_BASE}/api/auth/phone-number/send-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phoneNumber: full }),
    });
    if (!send.ok) throw new Error(`发送验证码失败: HTTP ${send.status}`);
    return {
      url: "",
      instructions: `验证码已发送到 ${phone.slice(0, 3)}****${phone.slice(-4)} 的短信，请输入收到的验证码。`,
      method: "code",
      async callback(code) {
        const v = await fetch(`${AUTH_BASE}/api/auth/phone-number/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phoneNumber: full, code: String(code).trim() }),
        });
        const d = await v.json().catch(() => ({}));
        if (!v.ok || !d.token) return { type: "failed", error: `登录失败: ${d.msg ?? `HTTP ${v.status}`}` };
        return {
          type: "success",
          // The host only persists an OAuth sign-in when it carries a
          // refresh token (host.js save(): no refresh and no key means
          // nothing is stored, yet the sign-in still reads "done" — the
          // exact "signed in, but magpie can't list it" banner). Today's
          // session token IS the long-lived credential JWTs are minted
          // from, so it plays both roles here.
          access: d.token,
          refresh: d.token,
          deviceId,
          accountId: d.user?.nickname ?? phone,
          uid: d.user?.id != null ? String(d.user.id) : undefined,
        };
      },
    };
  },
};

// ------------------------------------------------------------------ plugin

export const TodayAuthPlugin = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {};
    cfg.provider["today"] ??= {
      name: "Today",
      npm: "@ai-sdk/openai-compatible",
      api: API_BASE,
      models: MODELS,
    };
  },

  auth: {
    provider: "today",
    methods: [phoneSmsMethod],

    // The session token does not expire on a schedule; JWTs are minted
    // per request inside fetch. Refresh only proves the session still
    // mints, and throws (marking the account expired) when it does not.
    async refresh(auth) {
      const tc = new TodayClient(auth.access, auth.deviceId, auth.userId);
      await tc.refreshJwt(true);
      return {};
    },

    // Quota card: pricing/status -> windows, per the host's usage contract.
    async usage(getAuth) {
      const auth = await getAuth();
      if (auth?.type !== "oauth" || !auth.access) return {};
      const tc = new TodayClient(auth.access, auth.deviceId, auth.userId);
      const st = await tc.pricing();
      const u = st.usage ?? {};
      const windows = (u.breakdown?.items ?? []).map((it) => ({
        name: it.display?.title ?? it.key,
        used: it.usedPercent ?? 0,
        resetsAt: u.resetAt,
      }));
      return { plan: st.plan, windows, signIn: "kept" };
    },

    async loader(getAuth) {
      const auth = await getAuth();
      if (auth?.type !== "oauth" || !auth.access) return {};
      const tc = new TodayClient(auth.access, auth.deviceId, auth.userId);
      return {
        baseURL: API_BASE,
        async fetch(input, init) {
          const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : "");
          let body;
          try {
            body = JSON.parse(raw);
          } catch {
            return jsonResponse({ error: { message: "not a JSON chat request", type: "invalid_request_error" } }, 400);
          }
          // Anthropic-shaped requests (Claude Code) fold into the same path.
          const messages = body.messages && body.system !== undefined
            ? anthropicToOpenAI(body)
            : (body.messages ?? []);
          const stream = !!body.stream;
          const timeout = Number(body.timeout ?? 180);
          let model = String(body.model ?? "deepseek");
          if (model.startsWith("today/")) model = model.slice("today/".length);
          const opt = NAME2OPT[model.toLowerCase()];
          if (!opt) {
            return jsonResponse({ error: { message: `unknown model '${model}'; available: ${Object.keys(NAME2OPT).sort().join(", ")}`, type: "invalid_request_error" } }, 400);
          }
          try {
            await tc.setModel(opt);
            const text = flattenMessages(messages);
            if (!text.trim()) {
              return jsonResponse({ error: { message: "empty prompt", type: "invalid_request_error" } }, 400);
            }
            const sent = await tc.send(text);
            const threadId = sent.threadId ?? sent.thread_id;
            const reply = await tc.waitReply(threadId, { timeout, signal: init?.signal });
            return openAIReply(reply, model, stream);
          } catch (e) {
            const status = e instanceof TodayError && e.status ? e.status : 502;
            return jsonResponse({ error: { message: String(e?.message ?? e), type: "upstream_error" } }, status);
          }
        },
      };
    },
  },
});

// Exported for tests, as the community plugins do.
export const _internal = {
  NAME2OPT,
  MODELS,
  flattenMessages,
  asText,
  messageText,
  jwtExp,
  TodayClient,
};
