/**
 * Cyrus Bot v2.1 — Telegram bot on Cloudflare Workers
 * -------------------------------------------------------------
 * Fully automated pipeline (the bot ONLY deploys — the panel is
 * self-configured; no source patching is done anymore):
 *   verify token -> preflight permissions -> pick a free name
 *   -> create D1 -> deploy cyrus.js as a Worker -> ensure a
 *   workers.dev subdomain -> unlock panel -> create one unlimited
 *   user -> return the subscription link.
 *
 * The panel (cyrus.js) already bakes in: redirect of all browser
 * pages to t.me/kouroshasli, 6 default ports, 100 clean IPs and
 * Ads-Blocker ON. So this bot no longer patches the source.
 *
 * Single-file ES module. No external dependencies.
 */

/* ============================ Config ============================ */

const OPERATORS = [
	"ایرانسل",
	"همراه اول",
	"مخابرات",
	"رایتل",
	"آسیاتک",
	"شاتل",
	"پارس آنلاین",
	"ایرانیک",
];

// Map each operator button to header keywords used in ips.txt.
// Operators not listed here fall back to the general clean-IP pool.
const OPERATOR_KEYWORDS = {
	"ایرانسل": ["ایرانسل"],
	"همراه اول": ["همراه اول"],
	"مخابرات": ["مخابرات"],
	"رایتل": ["رایتل", "آپتل"],
	"آسیاتک": ["آسیاتک", "فیبر"],
	"شاتل": ["شاتل", "پیشگامان"],
};

// Preconfigured Cloudflare token-creation link (permissions preset).
const TOKEN_URL =
	"https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22workers_subdomain%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_analytics%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22ssl%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22dns_records%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22dns_records%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22zone_settings%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22zone_settings%22%2C%22type%22%3A%22read%22%7D%5D&accountId=*&zoneId=all&name=Kourosh-Panel";

function tokenKeyboard() {
	return { inline_keyboard: [[{ text: "🔑 ساخت توکن کلودفلر", url: TOKEN_URL }]] };
}

// Ports every created user gets (matches the panel default set).
const TLS_PORTS = ["443", "2053", "2083"];
const NONTLS_PORTS = ["8080", "80", "8880"];

const DEFAULT_IP_COUNT = 37; // clean IPs picked per operator
const CF_API = "https://api.cloudflare.com/client/v4";
const REDIRECT_URL = "https://t.me/kouroshasli";

/* ============================ Entry ============================ */

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/webhook") {
			return handleWebhook(request, env, ctx);
		}
		if (url.pathname === "/" || url.pathname === "/health") {
			return new Response("Cyrus Bot v2.1 is running.", { status: 200 });
		}
		return new Response("Not Found", { status: 404 });
	},
};

/* ======================= Telegram helpers ======================= */

async function tg(env, method, payload) {
	const res = await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/" + method, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	try {
		return await res.json();
	} catch {
		return { ok: false };
	}
}

function send(env, chatId, text, extra = {}) {
	return tg(env, "sendMessage", {
		chat_id: chatId,
		text,
		parse_mode: "HTML",
		disable_web_page_preview: true,
		...extra,
	});
}

function editText(env, chatId, messageId, text, extra = {}) {
	return tg(env, "editMessageText", {
		chat_id: chatId,
		message_id: messageId,
		text,
		parse_mode: "HTML",
		disable_web_page_preview: true,
		...extra,
	});
}

function answerCallback(env, id, text) {
	return tg(env, "answerCallbackQuery", { callback_query_id: id, text: text || "" });
}

function sendPhoto(env, chatId, photo, caption, extra = {}) {
	return tg(env, "sendPhoto", {
		chat_id: chatId,
		photo,
		caption,
		parse_mode: "HTML",
		...extra,
	});
}

function deleteMessage(env, chatId, messageId) {
	return tg(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
}

let cachedBotUsername = null;
async function botUsername(env) {
	if (env.BOT_USERNAME) return env.BOT_USERNAME;
	if (cachedBotUsername) return cachedBotUsername;
	const me = await tg(env, "getMe", {});
	cachedBotUsername = me && me.ok ? me.result.username : "";
	return cachedBotUsername;
}

function operatorKeyboard() {
	const rows = [];
	for (let i = 0; i < OPERATORS.length; i += 2) {
		const row = [{ text: OPERATORS[i], callback_data: "op:" + i }];
		if (OPERATORS[i + 1]) row.push({ text: OPERATORS[i + 1], callback_data: "op:" + (i + 1) });
		rows.push(row);
	}
	return { inline_keyboard: rows };
}

/* ========================= KV state ========================= */
// sess:<userId>  -> { step, token, accountId, chatId, operatorIdx, subUrl }
// queue          -> [ { userId, chatId } ]
// lock           -> { owner, ts }

function kvGet(env, key) {
	return env.QUEUE.get(key, "json");
}
function kvPut(env, key, val) {
	return env.QUEUE.put(key, JSON.stringify(val));
}
function kvDel(env, key) {
	return env.QUEUE.delete(key);
}
function getSession(env, userId) {
	return kvGet(env, "sess:" + userId);
}
function setSession(env, userId, sess) {
	return kvPut(env, "sess:" + userId, sess);
}

/* ========================= Webhook ========================= */

async function handleWebhook(request, env, ctx) {
	let update;
	try {
		update = await request.json();
	} catch {
		return new Response("ok");
	}
	try {
		if (update.callback_query) {
			await onCallback(env, ctx, update.callback_query);
		} else if (update.message && update.message.text) {
			await onMessage(env, ctx, update.message);
		}
	} catch (e) {
		console.log("webhook error", e && e.message);
	}
	return new Response("ok");
}

async function onMessage(env, ctx, msg) {
	const chatId = msg.chat.id;
	const userId = msg.from.id;
	const text = msg.text.trim();

	if (text === "/start") {
		await setSession(env, userId, { step: "await_token", chatId });
		await send(env, chatId, WELCOME, { reply_markup: tokenKeyboard() });
		return;
	}
	if (text === "/help") {
		await send(env, chatId, HELP);
		return;
	}
	if (text === "/cancel") {
		await removeFromQueue(env, userId);
		await kvDel(env, "sess:" + userId);
		await send(env, chatId, "✅ درخواست شما لغو شد. برای شروع دوباره /start را بزنید.");
		return;
	}
	if (text === "/status") {
		await sendStatus(env, chatId, userId);
		return;
	}

	// Otherwise: treat the text as a Cloudflare API token.
	let sess = (await getSession(env, userId)) || { chatId };
	if (sess.step === "processing" || sess.step === "queued") {
		// Block the user ONLY if their job is really active (owns a fresh lock
		// or still waits in the queue). Otherwise the session is stale — e.g.
		// the previous deploy FAILED or the processor died — so reset it and
		// let the user continue immediately instead of being stuck forever on
		// «در حال پردازش».
		if (await isUserJobActive(env, userId)) {
			if (sess.step === "processing") {
				await send(env, chatId, "⏳ درخواست شما در حال پردازش است. لطفاً صبور باشید.");
			} else {
				await sendStatus(env, chatId, userId);
			}
			// Kick the processor in case it died and left the queue behind.
			ctx.waitUntil(runProcessor(env));
			return;
		}
		sess = { step: "await_token", chatId };
		await setSession(env, userId, sess);
	}

	const token = text.split(/\s+/)[0];
	const waitMsg = await send(env, chatId, "⏳ در حال بررسی توکن و دسترسی‌ها...");
	const waitId = waitMsg && waitMsg.ok ? waitMsg.result.message_id : null;
	const show = (t, kb) => (waitId ? editText(env, chatId, waitId, t, kb ? { reply_markup: kb } : {}) : send(env, chatId, t, kb ? { reply_markup: kb } : {}));

	// 1) token valid?
	const verify = await cfVerifyToken(token);
	if (!verify.ok) {
		await show(TOKEN_INVALID, tokenKeyboard());
		return;
	}

	// 2) find an account this token can actually use
	const accounts = await cfListAccounts(token);
	if (!accounts.length) {
		await show(NO_ACCOUNT, tokenKeyboard());
		return;
	}
	let accountId = null;
	let lastMissing = [];
	for (const acc of accounts) {
		const chk = await cfCheckAccess(token, acc.id);
		if (chk.ok) { accountId = acc.id; break; }
		lastMissing = chk.missing;
	}
	if (!accountId) {
		await show(permissionText(lastMissing), tokenKeyboard());
		return;
	}

	await setSession(env, userId, { step: "await_operator", token, accountId, chatId });
	await show(TOKEN_OK, operatorKeyboard());
}

async function onCallback(env, ctx, cq) {
	const chatId = cq.message.chat.id;
	const userId = cq.from.id;
	const data = cq.data || "";

	if (!data.startsWith("op:")) {
		await answerCallback(env, cq.id);
		return;
	}
	const idx = parseInt(data.slice(3), 10);
	const sess = await getSession(env, userId);
	if (!sess || !sess.token || !sess.accountId) {
		await answerCallback(env, cq.id, "لطفاً ابتدا /start را بزنید.");
		return;
	}
	// Ignore re-clicks only while the job is REALLY active; after a failure
	// the user may tap an operator again to retry without resending the token.
	if ((sess.step === "processing" || sess.step === "queued") && (await isUserJobActive(env, userId))) {
		await answerCallback(env, cq.id, "⏳ درخواست قبلی شما هنوز در صف/در حال پردازش است.");
		return;
	}
	await answerCallback(env, cq.id, OPERATORS[idx] || "");

	sess.operatorIdx = idx;
	sess.step = "queued";
	await setSession(env, userId, sess);

	const queue = (await kvGet(env, "queue")) || [];
	if (!queue.find((j) => j.userId === userId)) {
		queue.push({ userId, chatId });
		await kvPut(env, "queue", queue);
	}

	const lock = await kvGet(env, "lock");
	if (lock && lock.owner && lock.owner !== userId && Date.now() - lock.ts < 300000) {
		const pos = queue.findIndex((j) => j.userId === userId) + 1;
		await editText(env, chatId, cq.message.message_id, queuedText(pos));
	} else {
		await editText(env, chatId, cq.message.message_id, STARTING);
	}

	ctx.waitUntil(runProcessor(env));
}

async function sendStatus(env, chatId, userId) {
	const lock = await kvGet(env, "lock");
	if (lock && lock.owner === userId) {
		await send(env, chatId, "⏳ درخواست شما هم‌اکنون در حال پردازش است.");
		return;
	}
	const queue = (await kvGet(env, "queue")) || [];
	const pos = queue.findIndex((j) => j.userId === userId);
	if (pos >= 0) await send(env, chatId, queuedText(pos + 1));
	else await send(env, chatId, "شما در صف نیستید. برای شروع /start را بزنید.");
}

async function removeFromQueue(env, userId) {
	const queue = (await kvGet(env, "queue")) || [];
	const next = queue.filter((j) => j.userId !== userId);
	if (next.length !== queue.length) await kvPut(env, "queue", next);
}

// A user's job counts as active ONLY if they own a fresh lock or are still in
// the queue. A leftover "processing"/"queued" session step alone does NOT
// count — that is exactly the stale state that used to lock users out.
async function isUserJobActive(env, userId) {
	const lock = await kvGet(env, "lock");
	if (lock && lock.owner === userId && Date.now() - lock.ts < 300000) return true;
	const queue = (await kvGet(env, "queue")) || [];
	return queue.some((j) => j.userId === userId);
}

/* ===================== Queue processor ===================== */

async function runProcessor(env) {
	const existing = await kvGet(env, "lock");
	if (existing && existing.owner && Date.now() - existing.ts < 300000) return;

	const me = "proc-" + Math.random().toString(36).slice(2);
	await kvPut(env, "lock", { owner: me, ts: Date.now() });
	await sleep(500);
	const check = await kvGet(env, "lock");
	if (!check || check.owner !== me) return; // lost the race

	try {
		while (true) {
			const queue = (await kvGet(env, "queue")) || [];
			if (queue.length === 0) break;
			const job = queue[0];
			await kvPut(env, "lock", { owner: job.userId, ts: Date.now(), runner: me });
			try {
				await processJob(env, job);
			} catch (e) {
				const m = String((e && e.message) || e);
				if (isPermissionMessage(m)) {
					await send(env, job.chatId, permissionText([]), { reply_markup: tokenKeyboard() });
				} else {
					await send(env, job.chatId, DEPLOY_FAILED + "\n\n<code>" + escapeHtml(m) + "</code>");
				}
				// CRITICAL FIX: never leave the session stuck on "processing" after
				// a failure — reset it so the user can retry right away and the
				// next users in the queue are not blocked either.
				try {
					const s = await getSession(env, job.userId);
					if (s && (s.step === "processing" || s.step === "queued")) {
						s.step = "await_token";
						await setSession(env, job.userId, s);
					}
				} catch {}
			}
			const q2 = (await kvGet(env, "queue")) || [];
			await kvPut(env, "queue", q2.filter((j) => j.userId !== job.userId));
			await kvPut(env, "lock", { owner: me, ts: Date.now() });
		}
	} finally {
		await kvDel(env, "lock");
	}
	const remaining = (await kvGet(env, "queue")) || [];
	if (remaining.length > 0) return runProcessor(env);
}

async function processJob(env, job) {
	const userId = job.userId;
	const chatId = job.chatId;
	const sess = await getSession(env, userId);
	if (!sess || sess.token == null) return;
	sess.step = "processing";
	await setSession(env, userId, sess);

	const token = sess.token;
	const accountId = sess.accountId;
	const operator = OPERATORS[sess.operatorIdx] || "";

	const statusMsg = await send(env, chatId, pipeline(1));
	const mid = statusMsg && statusMsg.ok ? statusMsg.result.message_id : null;
	const step = async (t) => {
		if (mid) await editText(env, chatId, mid, t);
		else await send(env, chatId, t);
	};

	// Pick a name free on BOTH Workers and D1 (numbered cyrus-1, cyrus-2, ...).
	const workerName = await cfPickFreeName(token, accountId, "cyrus");
	const panelUser = workerName.replace(/-/g, "_");

	// 1) Create D1. If the account hit the "databases per account" limit,
	//    exactly ONE old database is deleted to free capacity and the create
	//    is retried. Nothing is ever deleted when there is no limit error.
	const created = await cfCreateD1Safe(token, accountId, workerName, step);
	const dbId = created.dbId;
	const dbNote = created.freedNote;

	// 2) Fetch clean IPs for the operator (baked into the panel at deploy time)
	await step(pipeline(2));
	let ipNote = "";
	let ips = [];
	try {
		const ipsText = await fetchText(env.IPS_GITHUB_URL);
		const sel = selectOperatorIps(ipsText, operator, DEFAULT_IP_COUNT);
		ips = sel.ips;
		if (!sel.matched) ipNote = OPERATOR_IP_FALLBACK;
	} catch {
		ipNote = OPERATOR_IP_FALLBACK;
	}

	// 3) Deploy the self-configuring panel. It provisions its own password and
	//    an unlimited user (ads-blocker on, 6 ports, 37 IPs) on first run —
	//    the bot makes NO further API calls to the panel.
	await step(pipeline(3));
	const panelSrc = await fetchText(env.PANEL_GITHUB_URL);
	const bootCfg = {
		BOOT_USERNAME: panelUser,
		BOOT_PASSWORD: randomHex(40),
		BOOT_IPS: ips.join("\n"),
		BOOT_OPERATOR: operator || "all",
	};
	await cfDeployWorker(token, accountId, workerName, panelSrc, dbId, bootCfg);
	const subdomain = await cfEnsureAccountSubdomain(token, accountId);
	await cfEnableSubdomain(token, accountId, workerName);
	const base = "https://" + workerName + "." + subdomain + ".workers.dev";

	// 4) Trigger the panel self-bootstrap and confirm the sub link is live.
	await step(pipeline(4));
	const subUrl = base + "/sub/" + panelUser;
	await primePanel(subUrl);

	sess.step = "done";
	sess.subUrl = subUrl;
	await setSession(env, userId, sess);

	const uname = await botUsername(env);
	const caption = successText(subUrl, uname) + (ipNote ? "\n\n" + ipNote : "") + (dbNote ? "\n\n" + dbNote : "");
	const qrUrl =
		"https://api.qrserver.com/v1/create-qr-code/?size=512x512&margin=16&ecc=M&data=" +
		encodeURIComponent(subUrl);
	const extra = uname
		? { reply_markup: { inline_keyboard: [[{ text: "🚀 ساخت پنل جدید", url: "https://t.me/" + uname }]] } }
		: {};
	// Deliver the sub link + its QR code together in ONE clean message.
	if (mid) await deleteMessage(env, chatId, mid);
	const photo = await sendPhoto(env, chatId, qrUrl, caption, extra);
	if (!photo || !photo.ok) {
		// Fallback: if the photo could not be sent, deliver the details as text.
		await send(env, chatId, caption, extra);
	}
}

/* ==================== Cloudflare API ==================== */

async function cfGet(token, path) {
	try {
		const res = await fetch(CF_API + path, { headers: { Authorization: "Bearer " + token } });
		const data = await res.json().catch(() => ({}));
		return { status: res.status, ok: res.ok, data };
	} catch {
		return { status: 0, ok: false, data: {} };
	}
}

function isAuthErr(r) {
	if (r.status === 401 || r.status === 403) return true;
	if (r.data && r.data.success === false) {
		const codes = (r.data.errors || []).map((e) => e && e.code);
		if (codes.includes(9109) || codes.includes(9106) || codes.includes(10000)) return true;
	}
	return false;
}

function isPermissionMessage(m) {
	return /authentication error|authoriz|permission|9109|9106|10000|forbidden|not have access/i.test(String(m));
}

async function cfVerifyToken(token) {
	try {
		const res = await fetch(CF_API + "/user/tokens/verify", {
			headers: { Authorization: "Bearer " + token },
		});
		const data = await res.json();
		return { ok: !!(res.ok && data.success), data };
	} catch {
		return { ok: false };
	}
}

async function cfListAccounts(token) {
	const r = await cfGet(token, "/accounts");
	if (r.data && r.data.success && Array.isArray(r.data.result)) return r.data.result;
	return [];
}

// Verify the token can actually use D1, Workers Scripts and Workers Subdomain
// on this account. Returns { ok, missing: [labels] }.
async function cfCheckAccess(token, accountId) {
	const missing = [];
	const d1 = await cfGet(token, "/accounts/" + accountId + "/d1/database");
	if (isAuthErr(d1)) missing.push("Account · D1 · Edit");
	const wk = await cfGet(token, "/accounts/" + accountId + "/workers/scripts");
	if (isAuthErr(wk)) missing.push("Account · Workers Scripts · Edit");
	const sd = await cfGet(token, "/accounts/" + accountId + "/workers/subdomain");
	if (isAuthErr(sd)) missing.push("Account · Workers Subdomain · Edit");
	return { ok: missing.length === 0, missing };
}

async function cfCreateD1(token, accountId, name) {
	const res = await fetch(CF_API + "/accounts/" + accountId + "/d1/database", {
		method: "POST",
		headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
		body: JSON.stringify({ name }),
	});
	const data = await res.json().catch(() => ({}));
	if (!data.success) throw new Error("D1 create failed: " + errMsg(data));
	return data.result.uuid || data.result.id || data.result.database_id;
}

// Matches Cloudflare's D1 quota error, e.g.
// "System limit reached: databases per account (10)".
function isD1LimitError(m) {
	return /system limit reached|databases per account|too many databases/i.test(String(m));
}

async function cfListD1(token, accountId) {
	const r = await cfGet(token, "/accounts/" + accountId + "/d1/database?per_page=1000");
	if (r.data && r.data.success && Array.isArray(r.data.result)) return r.data.result;
	return [];
}

async function cfDeleteD1(token, accountId, dbId) {
	try {
		const res = await fetch(CF_API + "/accounts/" + accountId + "/d1/database/" + dbId, {
			method: "DELETE",
			headers: { Authorization: "Bearer " + token },
		});
		const data = await res.json().catch(() => ({}));
		return !!(res.ok && (!data || data.success !== false));
	} catch {
		return false;
	}
}

async function cfDeleteWorkerScript(token, accountId, name) {
	try {
		const res = await fetch(CF_API + "/accounts/" + accountId + "/workers/scripts/" + name + "?force=true", {
			method: "DELETE",
			headers: { Authorization: "Bearer " + token },
		});
		return res.ok;
	} catch {
		return false;
	}
}

// Free exactly ONE D1 database on the account so a new panel can be created.
// Called ONLY after Cloudflare returned the "databases per account" limit
// error — it never deletes anything otherwise.
// Preference: the OLDEST bot-made "cyrus-*" database first (its old worker is
// removed too if a binding blocks the deletion); only if no bot-made database
// exists, the oldest other database is removed.
async function cfFreeOneD1(token, accountId) {
	const dbs = await cfListD1(token, accountId);
	const byAge = dbs
		.slice()
		.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
	const isBotDb = (d) => /^cyrus-\d+$/i.test(d && d.name ? d.name : "");
	const candidates = [...byAge.filter(isBotDb), ...byAge.filter((d) => !isBotDb(d))];
	for (const db of candidates) {
		const id = db.uuid || db.id || db.database_id;
		if (!id) continue;
		if (await cfDeleteD1(token, accountId, id)) return db;
		// Deletion can be blocked while an old worker still binds the DB — for
		// bot-made panels remove that worker first, then retry once.
		if (isBotDb(db)) {
			await cfDeleteWorkerScript(token, accountId, db.name);
			if (await cfDeleteD1(token, accountId, id)) return db;
		}
	}
	return null;
}

// Create a D1 database; on the "databases per account" limit error, delete
// ONE old database (see cfFreeOneD1) and retry. Any other error is rethrown
// untouched and nothing is deleted.
async function cfCreateD1Safe(token, accountId, name, step) {
	const freed = [];
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			const dbId = await cfCreateD1(token, accountId, name);
			const freedNote = freed.length
				? "♻️ ظرفیت دیتابیس اکانت کلودفلر شما پر شده بود؛ برای آزادسازی، دیتابیس قدیمی «" +
					escapeHtml(freed.join("، ")) +
					"» به‌صورت خودکار حذف شد."
				: "";
			return { dbId, freedNote };
		} catch (e) {
			const m = String((e && e.message) || e);
			if (!isD1LimitError(m)) throw e;
			if (step) await step(D1_LIMIT_CLEANUP);
			const db = await cfFreeOneD1(token, accountId);
			if (!db) {
				throw new Error(
					"حساب کلودفلر شما به سقف تعداد دیتابیس (D1) رسیده و حذف خودکار ممکن نشد. لطفاً یک دیتابیس را از داشبورد کلودفلر حذف کنید و دوباره تلاش کنید.",
				);
			}
			freed.push(db.name || "");
			await sleep(1500);
		}
	}
	throw new Error("D1 create failed: limit cleanup did not free capacity");
}

async function cfDeployWorker(token, accountId, name, script, dbId, cfg) {
	const bindings = [{ type: "d1", name: "DB", id: dbId }];
	if (cfg) {
		for (const k of Object.keys(cfg)) {
			bindings.push({ type: "plain_text", name: k, text: String(cfg[k] == null ? "" : cfg[k]) });
		}
	}
	const metadata = {
		main_module: "worker.js",
		compatibility_date: "2026-07-20",
		compatibility_flags: ["nodejs_compat"],
		bindings,
	};
	const form = new FormData();
	form.append("metadata", JSON.stringify(metadata));
	form.append("worker.js", new File([script], "worker.js", { type: "application/javascript+module" }));
	const res = await fetch(CF_API + "/accounts/" + accountId + "/workers/scripts/" + name, {
		method: "PUT",
		headers: { Authorization: "Bearer " + token },
		body: form,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || (data && data.success === false)) throw new Error("Worker deploy failed: " + errMsg(data));
}

async function cfEnableSubdomain(token, accountId, name) {
	const res = await fetch(CF_API + "/accounts/" + accountId + "/workers/scripts/" + name + "/subdomain", {
		method: "POST",
		headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
		body: JSON.stringify({ enabled: true }),
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error("enable workers.dev failed: " + errMsg(data));
	}
}


async function cfListWorkerNames(token, accountId) {
	const r = await cfGet(token, "/accounts/" + accountId + "/workers/scripts");
	if (r.data && r.data.result) return r.data.result.map((s) => s.id);
	return [];
}

async function cfListD1Names(token, accountId) {
	const r = await cfGet(token, "/accounts/" + accountId + "/d1/database?per_page=100");
	if (r.data && r.data.result) return r.data.result.map((d) => d.name);
	return [];
}

async function cfPickFreeName(token, accountId, base) {
	const [scripts, dbs] = await Promise.all([
		cfListWorkerNames(token, accountId),
		cfListD1Names(token, accountId),
	]);
	const taken = new Set([...scripts, ...dbs]);
	let n = 1;
	while (taken.has(base + "-" + n)) n++;
	return base + "-" + n;
}

async function cfEnsureAccountSubdomain(token, accountId) {
	const res = await fetch(CF_API + "/accounts/" + accountId + "/workers/subdomain", {
		headers: { Authorization: "Bearer " + token },
	});
	const data = await res.json().catch(() => ({}));
	if (data && data.success && data.result && data.result.subdomain) {
		return data.result.subdomain;
	}
	// No workers.dev subdomain registered yet — create one automatically.
	for (let i = 0; i < 6; i++) {
		const name = "kourosh" + randomHex(6);
		const put = await fetch(CF_API + "/accounts/" + accountId + "/workers/subdomain", {
			method: "PUT",
			headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
			body: JSON.stringify({ subdomain: name }),
		});
		const pd = await put.json().catch(() => ({}));
		if (put.ok && pd.success) return name;
	}
	throw new Error("could not register a workers.dev subdomain automatically");
}

/* ==================== Panel API ==================== */

async function primePanel(subUrl, tries = 10) {
	// GETting the sub URL triggers the panel self-bootstrap (schema + default
	// unlimited user). Retry until it returns a real 200, which confirms the
	// worker is live, D1 is ready, and the user exists.
	let lastStatus = 0;
	let lastBody = "";
	for (let i = 0; i < tries; i++) {
		try {
			const res = await fetch(subUrl, {
				method: "GET",
				headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
				cf: { cacheTtl: 0 },
			});
			lastStatus = res.status;
			const body = await res.text().catch(() => "");
			lastBody = body.slice(0, 500);
			console.log(`[primePanel] try ${i + 1}/${tries} status=${res.status} url=${subUrl} body=${lastBody.slice(0, 200)}`);
			if (res.status === 200 && body && body.trim().length > 0) return true;
		} catch (e) {
			console.log(`[primePanel] try ${i + 1}/${tries} fetch error: ${e && e.message}`);
		}
		await sleep(1500);
	}
	throw new Error(`panel did not become ready — last status: ${lastStatus}, last body: ${lastBody.slice(0, 300)}`);
}

/* ============== IP selection ============== */
function isIpv4(s) {
	return /^(\d{1,3})(\.\d{1,3}){3}$/.test(s);
}
function parseIpBlocks(ipsText) {
	return ipsText.split("----------").map((b) => {
		const lines = b.split("\n").map((l) => l.trim()).filter(Boolean);
		const header = lines.find((l) => l.startsWith("#")) || "";
		const ips = [...new Set(lines.filter((l) => !l.startsWith("#") && !l.startsWith("[") && isIpv4(l)))];
		return { header, ips };
	});
}
function selectOperatorIps(ipsText, operator, count) {
	const blocks = parseIpBlocks(ipsText);
	const kws = OPERATOR_KEYWORDS[operator] || (operator ? [operator] : []);
	for (const blk of blocks) {
		if (blk.header.includes("دامنه")) continue;
		if (kws.some((k) => blk.header.includes(k)) && blk.ips.length) {
			return { ips: shuffle(blk.ips).slice(0, count), matched: true };
		}
	}
	let pool = [];
	const general = blocks.find((b) => b.header.includes("آیپی های ایران"));
	if (general && general.ips.length) pool = general.ips;
	else pool = blocks.filter((b) => !b.header.includes("دامنه")).flatMap((b) => b.ips);
	return { ips: shuffle(pool).slice(0, count), matched: false };
}

/* ============== Utilities ============== */
function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
function shuffle(arr) {
	const a = arr.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		const t = a[i];
		a[i] = a[j];
		a[j] = t;
	}
	return a;
}
function randomHex(n) {
	const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(n / 2)));
	return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, n);
}
async function fetchText(url) {
	const res = await fetch(url, { cf: { cacheTtl: 0 } });
	if (!res.ok) throw new Error("fetch failed " + res.status + " for " + url);
	return await res.text();
}
function errMsg(data) {
	if (data && data.errors && data.errors.length) {
		return data.errors.map((e) => e.message || JSON.stringify(e)).join("; ");
	}
	if (data && data.error) return data.error;
	return JSON.stringify(data).slice(0, 300);
}
function escapeHtml(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ============== Message templates (Persian) ============== */
const WELCOME =
	"👋 <b>به ربات کوروش خوش آمدید</b>\n\n" +
	"این ربات به‌صورت خودکار یک پنل اختصاصی روی اکانت کلودفلر شما می‌سازد و ساب‌لینک آماده تحویل می���دهد.\n\n" +
	"━━━━━━━━━━━━━━\n" +
	"<b>مرحله ۱ از ۲ — ساخت توکن</b>\n" +
	"روی دکمهٔ زیر بزنید، صفحهٔ ساخت توکن با دسترسی‌های لازم باز می‌شود؛ آن را <b>Create</b> کنید و توکن را همین‌جا بفرستید.\n\n" +
	"<b>دسترسی‌های ضروری توکن:</b>\n" +
	"• Account · Workers Scripts · Edit\n" +
	"• Account · D1 · Edit\n" +
	"• Account · Workers Subdomain · Edit\n" +
	"• Account · Account Settings · Read\n" +
	"• Account · Workers KV Storage · Edit\n\n" +
	"⚠️ این پنل کاملاً رایگان است و فروش آن ممنوع.";

const TOKEN_OK =
	"✅ <b>توکن تأیید و دسترسی‌ها بررسی شد</b>\n\n" +
	"━━━━━━━━━━━━━━\n" +
	"<b>مرحله ۲ از ۲ — انتخاب اپراتور</b>\n" +
	"اپراتور اینترنت خود را انتخاب کنید تا آی‌پی‌های تمیزِ مناسب انتخاب شوند:";

const TOKEN_INVALID =
	"❌ <b>توکن نامعتبر است</b>\n\n" +
	"توکن را درست کپی کرده‌اید؟ با دکمهٔ زیر یک توکن جدید بسازید و دوباره ارسال کنید.";

const NO_ACCOUNT =
	"❌ <b>هیچ اکانتی برای این توکن پیدا نشد</b>\n\n" +
	"مطمئن شوید توکن دسترسی «Account Settings · Read» دارد و برای همهٔ اکانت‌ها ساخته شده است. با دکمهٔ زیر توکن را دوباره بسازید.";

function permissionText(missing) {
	const list =
		missing && missing.length
			? missing.map((m) => "• " + m).join("\n")
			: "• Account · D1 · Edit\n• Account · Workers Scripts · Edit\n• Account · Workers Subdomain · Edit";
	return (
		"❌ <b>توکن دسترسی کافی ندارد</b>\n\n" +
		"برای ادامه، توکن باید این دسترسی‌ها را داشته باشد:\n" +
		list +
		"\n\n" +
		"روی دکمهٔ زیر بزنید، در صفحهٔ باز شده مطمئن شوید همهٔ دسترسی‌های بالا <b>انتخاب</b> شده‌اند، توکن را <b>Create</b> کنید و توکن جدید را بفرستید."
	);
}

const DEPLOY_FAILED =
	"❌ <b>خطا در راه‌اندازی پنل</b>\n" +
	"می‌توانید همین حالا توکن را دوباره ارسال کنید یا اپراتور را دوباره انتخاب کنید تا مجدد تلاش شود.\n" +
	"در صورت تکرار خطا با مدیر تماس بگیرید. @kouroshasli";

const D1_LIMIT_CLEANUP =
	"♻️ <b>ظرفیت دیتابیس اکانت شما پر است</b>\n" +
	"در حال حذف یک دیتابیس قدیمی برای آزادسازی ظرفیت و ادامهٔ خودکار ساخت پنل... لطفاً صبور باشید.";

const OPERATOR_IP_FALLBACK =
	"ℹ️ برای این اپراتور بلوک اختصاصی نبود؛ از مجموعهٔ آی‌پی‌های تمیز عمومی استفاده شد.";

const HELP =
	"🤖 <b>ربات کوروش</b>\n\n" +
	"/start — شروع و ساخت پنل\n" +
	"/status — بررسی وضعیت صف\n" +
	"/cancel — لغو درخواست\n" +
	"/help — راهنما";

function queuedText(position) {
	return (
		"⏳ <b>شما در صف هستید</b>\n\n" +
		"ربات در حال پردازش درخواست کاربر دیگری است.\n" +
		"موقعیت شما در صف: <b>#" + position + "</b>\n\n" +
		"پس از اتمام، درخواست شما به‌صورت خودکار پردازش می‌شود (نیازی به ارسال مجدد توکن نیست)."
	);
}

const STARTING = "✅ درخواست شما در حال شروع پردازش است... لطفاً صبور باشید.";

function pipeline(done) {
	const mark = (n) => (n < done ? "✅" : n === done ? "⏳" : "⬜");
	return (
		"⏳ <b>در حال راه‌اندازی پنل شما</b>\n\n" +
		mark(1) + " ساخت دیتابیس D1\n" +
		mark(2) + " دریافت آی‌پی‌های تمیز\n" +
		mark(3) + " استقرار و تنظیم خودکار پنل\n" +
		mark(4) + " ساخت و تحویل ساب‌لینک\n\n" +
		"لطفاً صبور باشید..."
	);
}

function successText(subUrl, uname) {
	return (
		"🎉 <b>پنل شما آماده است!</b>\n\n" +
		"🔗 <b>ساب‌لینک اختصاصی:</b>\n<code>" + escapeHtml(subUrl) + "</code>\n\n" +
		"━━━━━━━━━━━━━━\n" +
		"<b>راهنمای اتصال:</b>\n" +
		"1️⃣ اپلیکیشن v2rayNG یا NekoBox را نصب کنید\n" +
		"2️⃣ لینک بالا را کپی کنید\n" +
		"3️⃣ در اپ: Import config from Clipboard\n" +
		"4️⃣ یک پینگ کلی بگیرید و به سریع‌ترین سرور وصل شوید ☕️\n\n" +
		"⚙️ پورت‌ها: 443 · 2053 · 2083 · 8080 · 80 · 8880\n" +
		"🛡️ مسدودساز تبلیغات فعال است\n\n" +
		"⚠️ این سرویس کاملاً رایگان است؛ فروش آن کلاهبرداری است.\n" +
		"🚀 ساخت پنل رایگان: @" + (uname || "")
	);
}
