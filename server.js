const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || '');
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

if (!BOT_TOKEN || !MONGO_URI || !ADMIN_USERNAME || !ADMIN_PASSWORD || !ADMIN_ID) {
    console.error('❌ Missing env: BOT_TOKEN, MONGO_URI, ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_ID required.');
    process.exit(1);
}

const WEBHOOK_SECRET = crypto.createHash('sha256').update('wh' + BOT_TOKEN).digest('hex').slice(0, 32);

const DAILY = 1000;
const TASK_REWARD = 500;
const REF_BONUS = 500;
const MIN_WITHDRAW = 5000;
const COOLDOWN = 24 * 60 * 60 * 1000;
const BOT_USERNAME = 'AlphaXEarnTg_bot';

// YouTube: Submit ke kitni der baad Claim allowed hoga (instant click abuse rokne ke liye).
// 0 kar do agar delay nahi chahiye.
const YT_CLAIM_DELAY = 10 * 1000;

// Verification ke liye channels (app khulne par dono join hone zaroori)
const VERIFY_CHANNELS = [
    { id: '@updatechanneluta', name: 'Channel 1' },
    { id: '@paymentchanneluta', name: 'Channel 2' }
];

// Telegram task (auto verify)
const TASK_CHANNEL = { id: '@cryptotech16', name: 'Telegram Channel 2' };

// YouTube tasks (Open -> Submit -> Claim)
const YT_TASKS = ['yt1', 'yt2'];

const WELCOME_TEXT = '🔥 <b>Welcome to AlphaX!</b>\n\n' +
    '⛏️ Claim your Free Rewards every 24 hours.\n\n' +
    '🎁 Complete tasks and invite friends to earn extra rewards.\n\n' +
    '💰 Earn more by staying active and completing daily activities.\n\n' +
    '👇 Join our official channels and then open the bot to get started!\n\n' +
    '🚀 Start earning with AlphaX today!';

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

const User = mongoose.model('User', new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    username: { type: String, default: 'User' },
    balance: { type: Number, default: 0 },
    lastClaimTime: { type: Number, default: 0 },
    isVerified: { type: Boolean, default: false },
    isBanned: { type: Boolean, default: false },
    tasks: {
        tg2: { type: Boolean, default: false },
        yt1: { type: Boolean, default: false },
        yt2: { type: Boolean, default: false }
    },
    referredBy: { type: String, default: null },
    refCredited: { type: Boolean, default: false },
    referrals: { type: Array, default: [] },
    totalWithdrawn: { type: Number, default: 0 },
    withdrawals: { type: Array, default: [] },
    createdAt: { type: Number, default: Date.now }
}));

// userId unique: ek user ki ek waqt mein sirf ek pending withdrawal
const PendingRequest = mongoose.model('PendingRequest', new mongoose.Schema({
    reqId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, unique: true },
    amount: { type: Number, required: true },
    address: { type: String, required: true }
}));

// YouTube pending claim: userId unique => ek user ka ek waqt mein sirf ek pending claim.
// Submit par banta hai, Claim par delete hota hai.
const PendingClaim = mongoose.model('PendingClaim', new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    task: { type: String, required: true },
    createdAt: { type: Number, default: Date.now }
}));

// ---------- MULTIPLE ACCOUNT DETECTION (1 device = 1 account) ----------
const DEVICE_LOCK = true;   // false = detection band
const FP_LOCK = true;       // true = phone ke fingerprint se bhi block (alag Telegram app / app data clear karne wale bhi pakde jayenge). Same model ke 2 alag phones par galat block ka thoda risk, uske liye admin "Reset Device" hai.

const Device = mongoose.model('Device', new mongoose.Schema({
    deviceId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    fp: { type: String, default: '', index: true },    // strict fingerprint (hardware + canvas)
    fp2: { type: String, default: '', index: true },   // hardware-only fingerprint
    ip: { type: String, default: '' },
    createdAt: { type: Number, default: Date.now },
    lastSeen: { type: Number, default: Date.now }
}));

// IPv6 ke liye pehle 4 groups (/64), IPv4 poora
function normIp(ip) {
    ip = String(ip || '').replace(/^::ffff:/, '');
    if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':');
    return ip;
}

// 1 mobile = 1 account. 3 layer:
//  1) deviceId same                         -> same phone + same app
//  2) fp (strict fingerprint) same          -> same phone, alag Telegram app / data clear
//  3) fp2 (hardware) same + IP same         -> same phone, canvas/webview alag ho tab bhi
// returns null (ok) | 'conflict' | 'missing'
async function deviceConflict(userId, deviceId, fp, fp2, ip) {
    if (!deviceId || deviceId.length < 8 || deviceId.length > 100) return 'missing';

    if (FP_LOCK && fp) {
        const other = await Device.findOne({ fp, userId: { $ne: userId } });
        if (other) return 'conflict';
    }
    if (FP_LOCK && fp2 && ip) {
        const other = await Device.findOne({ fp2, ip, userId: { $ne: userId } });
        if (other) return 'conflict';
    }

    let d = await Device.findOne({ deviceId });
    if (!d) {
        try { d = await Device.create({ deviceId, userId, fp, fp2, ip }); }
        catch (e) { d = await Device.findOne({ deviceId }); }   // race: dusri request ne pehle bana di
    }
    if (d && d.userId !== userId) return 'conflict';

    // owner ka latest fingerprint/IP update rakho
    if (d && (d.fp !== fp || d.fp2 !== fp2 || d.ip !== ip)) {
        await Device.updateOne({ deviceId }, { $set: { fp, fp2, ip, lastSeen: Date.now() } });
    }
    return null;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wrap = fn => (req, res, next) => fn(req, res, next).catch(e => {
    console.log('Error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tg(method, body) {
    try {
        const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(8000)
        });
        return await r.json();
    } catch (e) {
        console.log('Telegram error:', method, e.message);
        return { ok: false, description: e.message };
    }
}

const sendMsg = (chat_id, text, reply_markup, html = true) =>
    tg('sendMessage', { chat_id, text, reply_markup, ...(html ? { parse_mode: 'HTML' } : {}) });

// true = member, false = not member, null = Telegram error
async function isMember(channel, userId) {
    const r = await tg('getChatMember', { chat_id: channel, user_id: Number(userId) });
    if (!r.ok) {
        console.log('getChatMember failed for', channel, r.description || '');
        return null;
    }
    const s = r.result.status;
    return ['member', 'administrator', 'creator'].includes(s) || (s === 'restricted' && r.result.is_member === true);
}

// Verification: dono channels check. returns { ok, missing } ya { error }
async function checkVerifyChannels(userId) {
    const missing = [];
    for (const ch of VERIFY_CHANNELS) {
        const m = await isMember(ch.id, userId);
        if (m === null) return { error: 'Channel check failed' };
        if (!m) missing.push(ch.name);
    }
    return { ok: missing.length === 0, missing };
}

// Telegram security check (YouTube Submit/Claim par use hota hai):
// user verified ho + abhi bhi required channels mein ho.
// Fail par { error } return karta hai, pass par null.
async function telegramGuard(user) {
    if (!user.isVerified) return 'Please verify channels first.';
    const c = await checkVerifyChannels(user.id);
    if (c.error) return 'Could not verify right now, please try again shortly';
    if (!c.ok) {
        await User.updateOne({ id: user.id }, { isVerified: false });
        return 'Must join all channels and tap Check again.';
    }
    return null;
}

function validateInitData(initData) {
    if (!initData || initData.length > 4096) return null;
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash) return null;
    p.delete('hash');
    const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
    const a = Buffer.from(calc), b = Buffer.from(hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 86400) return null;
    try { return JSON.parse(p.get('user')); } catch (e) { return null; }
}

function displayName(u) { return u.username ? `@${u.username}` : (u.first_name || 'User'); }

async function auth(req, res, next) {
    try {
        const u = validateInitData(req.headers['x-init-data']);
        if (!u || !u.id) return res.status(401).json({ ok: false, error: 'Please open via bot.' });
        const id = String(u.id);
        const user = await User.findOneAndUpdate(
            { id },
            { $set: { username: displayName(u) } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        if (user.isBanned) return res.status(403).json({ ok: false, banned: true, error: 'Your account is banned.' });

        if (DEVICE_LOCK) {
            const dev = await deviceConflict(
                id,
                String(req.headers['x-device-id'] || '').trim(),
                String(req.headers['x-device-fp'] || '').trim().slice(0, 64),
                String(req.headers['x-device-fp2'] || '').trim().slice(0, 64),
                normIp(req.ip)
            );
            if (dev === 'conflict') {
                return res.status(403).json({ ok: false, code: 'MULTI_ACCOUNT', error: 'Multiple account detected. Only one account per device is allowed.' });
            }
            if (dev === 'missing') {
                return res.status(400).json({ ok: false, error: 'Please reopen the app from the bot.' });
            }
        }

        req.user = user;
        next();
    } catch (e) {
        console.log('Auth error:', e);
        res.status(500).json({ ok: false, error: 'Server error' });
    }
}

// proof: { task, status: 'ready' } => frontend Submit ki jagah Claim button dikhaye
function publicUser(u, pending) {
    return {
        id: u.id,
        username: u.username,
        balance: u.balance,
        lastClaimTime: u.lastClaimTime,
        serverTime: Date.now(),
        isVerified: u.isVerified,
        tasks: {
            tg2: !!(u.tasks && u.tasks.tg2),
            yt1: !!(u.tasks && u.tasks.yt1),
            yt2: !!(u.tasks && u.tasks.yt2)
        },
        proof: pending ? { task: pending.task, status: 'ready' } : null,
        referrals: u.referrals,
        withdrawals: u.withdrawals.slice(0, 50)
    };
}

async function userView(u) {
    const p = await PendingClaim.findOne({ userId: u.id });
    return publicUser(u, p);
}

// CORS: mini app kisi bhi host se khule, API calls kaam karein
app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-init-data, x-device-id, x-device-fp, x-device-fp2');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('OK'));
app.get('/api/ping', (req, res) => res.json({ ok: true, version: 'v7' }));

// ---------- USER API ----------

app.post('/api/me', auth, wrap(async (req, res) => {
    let u = req.user;
    if (u.isVerified) {
        const r = await checkVerifyChannels(u.id);
        if (r.ok === false) {
            await User.updateOne({ id: u.id }, { isVerified: false });
            u = await User.findOne({ id: u.id });
        }
    }
    res.json({ ok: true, data: await userView(u) });
}));

app.post('/api/verify', auth, wrap(async (req, res) => {
    const u = req.user;
    const r = await checkVerifyChannels(u.id);
    if (r.error) return res.json({ ok: false, error: 'Could not verify right now, please try again shortly' });
    if (!r.ok) return res.json({ ok: false, missing: r.missing, error: 'Must join all channels and tap Check again.' });

    await User.updateOne({ id: u.id }, { isVerified: true });

    if (u.referredBy && !u.refCredited) {
        const claimed = await User.findOneAndUpdate(
            { id: u.id, refCredited: false },
            { refCredited: true }
        );
        if (claimed) {
            const ref = await User.findOneAndUpdate({ id: u.referredBy }, {
                $inc: { balance: REF_BONUS },
                $push: { referrals: { id: u.id, date: new Date().toISOString(), bonus: REF_BONUS } }
            });
            if (ref) sendMsg(ref.id, `🎁 <b>New referral joined!</b>\nUser ID: <code>${esc(u.id)}</code>\n+${REF_BONUS} SHIBA added to your balance.`);
        }
    }
    const fresh = await User.findOne({ id: u.id });
    res.json({ ok: true, data: await userView(fresh) });
}));

app.post('/api/claim', auth, wrap(async (req, res) => {
    if (!req.user.isVerified) return res.json({ ok: false, error: 'Please verify channels first.' });

    const c = await checkVerifyChannels(req.user.id);
    if (c.error) return res.json({ ok: false, error: 'Could not verify right now, please try again shortly' });
    if (!c.ok) {
        await User.updateOne({ id: req.user.id }, { isVerified: false });
        return res.json({ ok: false, error: 'Must join all channels and tap Check again.' });
    }

    const now = Date.now();
    const u = await User.findOneAndUpdate(
        { id: req.user.id, lastClaimTime: { $lte: now - COOLDOWN } },
        { $inc: { balance: DAILY }, $set: { lastClaimTime: now } },
        { new: true }
    );
    if (!u) return res.json({ ok: false, error: 'Not ready yet. Come back later.' });
    res.json({ ok: true, data: await userView(u) });
}));

// Telegram Channel 2 task: membership server check karta hai
app.post('/api/task', auth, wrap(async (req, res) => {
    const u = req.user;
    const taskId = String(req.body.taskId || '');
    if (taskId !== 'tg2') return res.json({ ok: false, error: 'Invalid task' });
    if (!u.isVerified) return res.json({ ok: false, error: 'Please verify channels first.' });

    const m = await isMember(TASK_CHANNEL.id, u.id);
    if (m === null) return res.json({ ok: false, error: 'Could not verify right now, please try again shortly' });
    if (!m) return res.json({ ok: false, error: 'Please join the channel first!' });

    const done = await User.findOneAndUpdate(
        { id: u.id, 'tasks.tg2': { $ne: true } },
        { $set: { 'tasks.tg2': true }, $inc: { balance: TASK_REWARD } },
        { new: true }
    );
    if (!done) return res.json({ ok: false, error: 'Task already claimed.' });
    res.json({ ok: true, data: await userView(done) });
}));

// ---------- YOUTUBE TASKS (Open -> Submit -> Claim) ----------
// 1) Open: frontend sirf YouTube link kholta hai (server call ki zaroorat nahi)
// 2) Submit: pending claim ban jata hai (ek user = ek pending)
// 3) Claim: reward milta hai, pending delete, task hamesha ke liye done

async function ytSubmit(req, res) {
    const u = req.user;
    const taskId = String(req.body.taskId || '');
    if (!YT_TASKS.includes(taskId)) return res.json({ ok: false, error: 'Invalid task' });

    const guard = await telegramGuard(u);
    if (guard) return res.json({ ok: false, error: guard });

    // Task pehle claim ho chuka ho to dobara nahi
    if (u.tasks && u.tasks[taskId]) return res.json({ ok: false, error: 'Task already claimed.' });

    // Pehle se koi pending claim ho to doosra submit nahi hoga
    const existing = await PendingClaim.findOne({ userId: u.id });
    if (existing) {
        // Same task dobara Submit: error nahi, state wapas bhejo taake UI Claim button dikhaye
        if (existing.task === taskId) {
            return res.json({ ok: true, alreadySubmitted: true, data: await userView(u) });
        }
        return res.json({ ok: false, error: 'Please claim your pending reward first.', data: await userView(u) });
    }

    // unique index userId => race condition mein bhi sirf ek create hoga
    try {
        await PendingClaim.create({ userId: u.id, task: taskId, createdAt: Date.now() });
    } catch (e) {
        return res.json({ ok: false, error: 'Please claim your pending reward first.' });
    }
    res.json({ ok: true, data: await userView(u) });
}

async function ytClaim(req, res) {
    const u = req.user;

    const guard = await telegramGuard(u);
    if (guard) return res.json({ ok: false, error: guard });

    const pending = await PendingClaim.findOne({ userId: u.id });
    if (!pending) return res.json({ ok: false, error: 'Nothing to claim. Tap Submit first.' });

    const wait = pending.createdAt + YT_CLAIM_DELAY - Date.now();
    if (wait > 0) {
        return res.json({ ok: false, error: `Please wait ${Math.ceil(wait / 1000)}s and try again.` });
    }

    // Atomic delete: double-click par bhi reward sirf ek baar
    const pr = await PendingClaim.findOneAndDelete({ userId: u.id, task: pending.task });
    if (!pr) return res.json({ ok: false, error: 'Nothing to claim. Tap Submit first.' });

    const key = `tasks.${pr.task}`;
    const done = await User.findOneAndUpdate(
        { id: u.id, [key]: { $ne: true } },
        { $set: { [key]: true }, $inc: { balance: TASK_REWARD } },
        { new: true }
    );
    if (!done) return res.json({ ok: false, error: 'Task already claimed.' });
    res.json({ ok: true, data: await userView(done) });
}

app.post('/api/yt/submit', auth, wrap(ytSubmit));
app.post('/api/yt/claim', auth, wrap(ytClaim));
// Purane frontend ke liye aliases (agar frontend abhi purane URLs use kar raha ho)
app.post('/api/proof/start', auth, wrap(ytSubmit));
app.post('/api/proof/claim', auth, wrap(ytClaim));

app.post('/api/withdraw', auth, wrap(async (req, res) => {
    const u = req.user;
    const amt = Math.floor(Number(req.body.amount));
    const address = String(req.body.address || '').trim();

    if (!u.isVerified) return res.json({ ok: false, error: 'Please verify channels first.' });
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return res.json({ ok: false, error: 'Invalid BEP-20 wallet address!' });
    if (!Number.isFinite(amt) || amt < MIN_WITHDRAW) return res.json({ ok: false, error: `Minimum withdrawal is ${MIN_WITHDRAW} SHIBA!` });

    const reqId = 'wd_' + crypto.randomBytes(6).toString('hex');

    try {
        await PendingRequest.create({ reqId, userId: u.id, amount: amt, address });
    } catch (e) {
        return res.json({ ok: false, error: 'You already have a pending withdrawal request.' });
    }

    let upd;
    try {
        upd = await User.findOneAndUpdate(
            { id: u.id, balance: { $gte: amt } },
            {
                $inc: { balance: -amt },
                $push: { withdrawals: { $each: [{ id: reqId, amount: amt, address, status: 'PENDING', date: new Date().toISOString() }], $position: 0 } }
            },
            { new: true }
        );
    } catch (e) {
        await PendingRequest.deleteOne({ reqId });
        throw e;
    }
    if (!upd) {
        await PendingRequest.deleteOne({ reqId });
        return res.json({ ok: false, error: 'Insufficient balance!' });
    }

    sendMsg(ADMIN_ID,
        `📤 <b>New Withdraw Request</b>\n\n👤 User ID: <code>${esc(u.id)}</code>\n💰 Amount: <b>${amt} SHIBA</b>\n🏦 Address: <code>${esc(address)}</code>`,
        { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${reqId}` }, { text: '❌ Reject', callback_data: `reject_${reqId}` }]] }
    );
    res.json({ ok: true, data: await userView(upd) });
}));

// ---------- WITHDRAW RESOLVE ----------

async function resolveWithdraw(reqId, approve) {
    const pr = await PendingRequest.findOneAndDelete({ reqId: String(reqId) });
    if (!pr) return { ok: false, message: 'Request already handled / not found' };

    const af = { arrayFilters: [{ 'w.id': reqId }] };
    if (approve) {
        await User.updateOne(
            { id: pr.userId },
            { $set: { 'withdrawals.$[w].status': 'PAID' }, $inc: { totalWithdrawn: pr.amount } },
            af
        );
        sendMsg(pr.userId, `✅ Your withdrawal of <b>${pr.amount} SHIBA</b> has been approved and paid!`);
    } else {
        await User.updateOne(
            { id: pr.userId },
            { $set: { 'withdrawals.$[w].status': 'DECLINED' }, $inc: { balance: pr.amount } },
            af
        );
        sendMsg(pr.userId, `❌ Your withdrawal of <b>${pr.amount} SHIBA</b> was declined and the amount was refunded.`);
    }
    return { ok: true, pr };
}

// ---------- TELEGRAM WEBHOOK ----------

app.post('/api/webhook', async (req, res) => {
    if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) return res.sendStatus(403);
    res.sendStatus(200);

    try {
        const update = req.body;

        // Text messages (/start, /admin)
        if (update.message && update.message.text !== undefined) {
            const msg = update.message;
            const chatId = String(msg.chat.id);
            const text = msg.text || '';
            if (msg.chat.type !== 'private') return;

            const known = await User.findOne({ id: chatId });
            if (known && known.isBanned) return sendMsg(chatId, '⚠️ <b>Access Denied:</b> Your account has been banned.');

            if (text.startsWith('/start')) {
                const m = text.match(/^\/start\s+(\d{1,20})$/);
                let referrer = m ? m[1] : null;
                if (referrer === chatId) referrer = null;
                if (referrer && !(await User.exists({ id: referrer }))) referrer = null;

                const name = displayName(msg.from);
                const user = await User.findOneAndUpdate(
                    { id: chatId },
                    { $set: { username: name } },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                );
                if (referrer && !user.referredBy && !user.isVerified) {
                    await User.updateOne({ id: chatId, referredBy: null }, { referredBy: referrer });
                }

                const kb = [[
                    { text: '📢 Join AlphaX Official', url: 'https://t.me/updatechanneluta' },
                    { text: '💳 Payments Channel', url: 'https://t.me/paymentchanneluta' }
                ]];
                await sendMsg(chatId, WELCOME_TEXT, { inline_keyboard: kb });
            } else if (text === '/admin' && chatId === ADMIN_ID) {
                await sendMsg(chatId, '👑 <b>AlphaX Admin</b>',
                    PUBLIC_URL ? { inline_keyboard: [[{ text: '🔐 Admin Login Panel', url: `${PUBLIC_URL}/admin/login` }]] } : undefined);
            }

        // Withdraw buttons
        } else if (update.callback_query) {
            const q = update.callback_query;
            const chatId = String(q.message.chat.id);
            const data = q.data || '';

            const m = data.match(/^(approve|reject)_(wd_[a-f0-9]+)$/);
            if (!m) return;

            if (chatId !== ADMIN_ID) return tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Unauthorized!' });

            const approve = m[1] === 'approve';
            const r = await resolveWithdraw(m[2], approve);
            if (!r.ok) return tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Already handled!' });

            tg('editMessageText', {
                chat_id: chatId,
                message_id: q.message.message_id,
                parse_mode: 'HTML',
                text: `${approve ? '✅ <b>Approved</b>' : '❌ <b>Rejected</b>'}\nUser ID: ${esc(r.pr.userId)}\nAmount: ${r.pr.amount} SHIBA`
            });
            tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Done!' });
        }
    } catch (e) {
        console.log('Webhook error:', e);
    }
});

// ---------- ADMIN PANEL ----------

const sessions = new Map();
const attempts = new Map();
const parseCookies = h => Object.fromEntries(
    (h || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(p => [p[0], decodeURIComponent(p.slice(1).join('='))])
);
const safeEq = (a, b) => {
    const x = crypto.createHash('sha256').update(String(a)).digest();
    const y = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
};

function checkAdmin(req, res, next) {
    const t = parseCookies(req.headers.cookie).admin_session;
    if (t && sessions.has(t) && sessions.get(t) > Date.now()) return next();
    if (req.method === 'GET') return res.redirect('/admin/login');
    return res.status(401).json({ ok: false, message: 'Not logged in' });
}

app.get('/admin/login', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Admin Login</title><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>*{box-sizing:border-box;font-family:'Segoe UI',sans-serif}body{background:#0c0a09;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.c{background:#1c1917;border:1px solid #292524;padding:30px;border-radius:16px;width:90%;max-width:360px;text-align:center}h2{color:#f5a623}input{width:100%;padding:12px;margin-bottom:12px;background:#0c0a09;border:1px solid #44403c;color:#fff;border-radius:8px}button{width:100%;padding:12px;background:#f5a623;color:#000;font-weight:bold;border:none;border-radius:8px;cursor:pointer}</style></head>
<body><div class="c"><h2>🔐 AlphaX Admin</h2><form action="/admin/login" method="POST"><input name="username" placeholder="Username" required><input type="password" name="password" placeholder="Password" required><button>Login</button></form></div></body></html>`);
});

app.post('/admin/login', (req, res) => {
    const ip = req.ip;
    const a = attempts.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 15 * 60 * 1000) { a.n = 0; a.t = Date.now(); }
    if (a.n >= 5) return res.status(429).send('Too many attempts. Try again in 15 minutes.');

    const { username = '', password = '' } = req.body;
    if (safeEq(username, ADMIN_USERNAME) && safeEq(password, ADMIN_PASSWORD)) {
        attempts.delete(ip);
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, Date.now() + 24 * 3600 * 1000);
        res.setHeader('Set-Cookie',
            `admin_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${PUBLIC_URL.startsWith('https') ? '; Secure' : ''}`);
        return res.redirect('/admin/dashboard');
    }
    a.n++;
    attempts.set(ip, a);
    res.send(`<script>alert('Invalid Credentials!');location.href='/admin/login'</script>`);
});

app.get('/admin/logout', (req, res) => {
    const t = parseCookies(req.headers.cookie).admin_session;
    if (t) sessions.delete(t);
    res.setHeader('Set-Cookie', 'admin_session=; Path=/; HttpOnly; Max-Age=0');
    res.redirect('/admin/login');
});

app.get('/admin/dashboard', checkAdmin, wrap(async (req, res) => {
    const [totalUsers, verified, pending, agg] = await Promise.all([
        User.countDocuments(),
        User.countDocuments({ isVerified: true }),
        PendingRequest.find({}).sort({ _id: -1 }),
        User.aggregate([{ $group: { _id: null, bal: { $sum: '$balance' }, paid: { $sum: '$totalWithdrawn' } } }])
    ]);
    const s = agg[0] || { bal: 0, paid: 0 };
    const q = String(req.query.search || '').trim().slice(0, 64);
    const found = q ? await User.findOne({ $or: [{ id: q }, { username: q.startsWith('@') ? q : '@' + q }] }) : null;

    const reqRows = pending.map(r => `<tr><td>${esc(r.userId)}</td><td><b>${r.amount} SHIBA</b></td><td><code>${esc(r.address)}</code></td>
<td><button class="b g" data-act="req" data-do="approve" data-id="${esc(r.reqId)}">Approve</button> <button class="b r" data-act="req" data-do="reject" data-id="${esc(r.reqId)}">Reject</button></td></tr>`).join('');

    const userBox = found ? `<div class="box">
<p>👤 <b>${esc(found.username)}</b> | ID: <code>${esc(found.id)}</code></p>
<p>💰 Balance: <b>${found.balance} SHIBA</b> | 📤 Total Withdrawn: <b>${found.totalWithdrawn}</b></p>
<p>✅ Verified: ${found.isVerified ? 'Yes' : 'No'} | 🚫 Banned: ${found.isBanned ? 'Yes' : 'No'} | 👥 Referrals: ${found.referrals.length} | Referred by: ${esc(found.referredBy || 'Direct')}</p>
<div class="row"><input type="number" id="amt" placeholder="Amount">
<button class="b g" data-act="bal" data-do="add" data-uid="${esc(found.id)}">+ Add</button>
<button class="b r" data-act="bal" data-do="cut" data-uid="${esc(found.id)}">- Cut</button>
<button class="b r" data-act="ban" data-do="ban" data-uid="${esc(found.id)}">Ban</button>
<button class="b g" data-act="ban" data-do="unban" data-uid="${esc(found.id)}">Unban</button>
<button class="b" data-act="dev" data-uid="${esc(found.id)}">Reset Device</button></div>
<div class="row"><input id="smsg" placeholder="Message to this user"><button class="b" data-act="msg" data-uid="${esc(found.id)}">Send</button></div></div>`
        : (q ? '<p style="color:#ef4444">User not found!</p>' : '');

    res.send(`<!DOCTYPE html><html><head><title>AlphaX Admin</title><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>*{box-sizing:border-box;font-family:'Segoe UI',sans-serif}body{background:#0c0a09;color:#f3f4f6;margin:0;padding:16px}h1{color:#f5a623;font-size:22px;margin:0}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.lo{background:#ef4444;color:#fff;padding:6px 12px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:bold}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.st{background:#1c1917;border:1px solid #292524;border-radius:12px;padding:14px}.st small{color:#a8a29e;font-size:11px;text-transform:uppercase}.st div{font-size:19px;font-weight:bold;color:#f5a623;margin-top:6px}
.card{background:#1c1917;border:1px solid #292524;border-radius:12px;padding:16px;margin-bottom:16px}.card h3{color:#f5a623;margin:0 0 10px;font-size:15px}
input,textarea{background:#0c0a09;border:1px solid #44403c;color:#fff;padding:10px;border-radius:8px;width:100%;font-size:14px}.row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}.row input{flex:1;min-width:120px}
.b{background:#f5a623;color:#000;border:none;font-weight:bold;padding:9px 14px;border-radius:8px;cursor:pointer}.b.g{background:#22c55e;color:#fff}.b.r{background:#ef4444;color:#fff}
table{width:100%;border-collapse:collapse}th,td{padding:8px;text-align:left;border-bottom:1px solid #292524;font-size:12px;word-break:break-all}th{color:#a8a29e}.box{background:#0c0a09;padding:12px;border-radius:8px;border:1px solid #292524;margin-top:10px;font-size:13px;line-height:1.8}</style></head><body>
<div class="top"><h1>👑 AlphaX Admin</h1><a class="lo" href="/admin/logout">Logout</a></div>
<div class="grid">
<div class="st"><small>Total Users</small><div>${totalUsers}</div></div>
<div class="st"><small>Verified Users</small><div>${verified}</div></div>
<div class="st"><small>Users' Balance</small><div>${Math.floor(s.bal)} SHIBA</div></div>
<div class="st"><small>Paid Out</small><div>${Math.floor(s.paid)} SHIBA</div></div>
<div class="st"><small>Pending Requests</small><div>${pending.length}</div></div></div>
<div class="card"><h3>⏳ Pending Withdrawal Requests</h3>${pending.length ? `<table><tr><th>User ID</th><th>Amount</th><th>Wallet</th><th>Action</th></tr>${reqRows}</table>` : '<p style="color:#a8a29e;font-size:12px">No pending requests.</p>'}</div>
<div class="card"><h3>🔍 Search & Manage User</h3><form method="GET" class="row"><input name="search" placeholder="Telegram ID or @username" value="${esc(q)}"><button class="b">Search</button></form>${userBox}</div>
<div class="card"><h3>📢 Broadcast</h3><textarea id="bc" rows="3" placeholder="Message to all users..."></textarea><button class="b" style="margin-top:10px;width:100%" data-act="bc">Send Broadcast</button></div>
<script>
async function post(u,b){const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const d=await r.json();alert(d.message||'Done');return d}
document.addEventListener('click',async e=>{const b=e.target.closest('[data-act]');if(!b)return;const a=b.dataset.act;let d;
if(a==='req')d=await post('/admin/action',{reqId:b.dataset.id,action:b.dataset.do});
else if(a==='bal'){const amount=document.getElementById('amt').value;if(!amount)return alert('Enter amount');d=await post('/admin/balance',{userId:b.dataset.uid,amount,action:b.dataset.do})}
else if(a==='ban')d=await post('/admin/ban',{userId:b.dataset.uid,action:b.dataset.do});
else if(a==='dev'){if(!confirm('Reset device lock for this user?'))return;d=await post('/admin/resetdevice',{userId:b.dataset.uid})}
else if(a==='msg'){const message=document.getElementById('smsg').value;if(!message)return;d=await post('/admin/msg',{userId:b.dataset.uid,message})}
else if(a==='bc'){const message=document.getElementById('bc').value;if(!message)return;if(!confirm('Send to all users?'))return;d=await post('/admin/broadcast',{message})}
if(a!=='msg'&&a!=='bc')location.reload()});
</script></body></html>`);
}));

app.post('/admin/action', checkAdmin, wrap(async (req, res) => {
    const { reqId, action } = req.body;
    if (!['approve', 'reject'].includes(action)) return res.json({ ok: false, message: 'Invalid action' });
    const r = await resolveWithdraw(reqId, action === 'approve');
    if (!r.ok) return res.json({ ok: false, message: r.message });
    res.json({ ok: true, message: `Request ${action}d!` });
}));

app.post('/admin/balance', checkAdmin, wrap(async (req, res) => {
    const { userId, action } = req.body;
    const amt = Math.floor(Number(req.body.amount));
    if (!Number.isFinite(amt) || amt <= 0) return res.json({ ok: false, message: 'Invalid amount' });

    let u;
    if (action === 'add') {
        u = await User.findOneAndUpdate({ id: String(userId) }, { $inc: { balance: amt } }, { new: true });
    } else {
        u = await User.findOneAndUpdate(
            { id: String(userId), balance: { $gte: amt } },
            { $inc: { balance: -amt } },
            { new: true }
        );
    }
    if (!u) return res.json({ ok: false, message: 'User not found or balance too low' });

    sendMsg(u.id, action === 'add'
        ? `🎁 Admin added +${amt} SHIBA to your balance!`
        : `⚠️ Admin deducted ${amt} SHIBA from your balance.`);
    res.json({ ok: true, message: `Done. New balance: ${u.balance} SHIBA` });
}));

app.post('/admin/ban', checkAdmin, wrap(async (req, res) => {
    const ban = req.body.action === 'ban';
    const u = await User.findOneAndUpdate({ id: String(req.body.userId) }, { isBanned: ban }, { new: true });
    if (!u) return res.json({ ok: false, message: 'User not found' });
    sendMsg(u.id, ban ? '🚫 <b>Account Banned</b> by admin.' : '✅ <b>Account Unbanned</b> by admin.');
    res.json({ ok: true, message: ban ? 'User banned' : 'User unbanned' });
}));

app.post('/admin/resetdevice', checkAdmin, wrap(async (req, res) => {
    const r = await Device.deleteMany({ userId: String(req.body.userId) });
    res.json({ ok: true, message: `Device lock reset (${r.deletedCount} device removed).` });
}));

app.post('/admin/msg', checkAdmin, wrap(async (req, res) => {
    const u = await User.findOne({ id: String(req.body.userId) });
    if (!u) return res.json({ ok: false, message: 'User not found' });
    await sendMsg(u.id, `📩 Message from Admin:\n\n${String(req.body.message).slice(0, 3000)}`, undefined, false);
    res.json({ ok: true, message: 'Message sent!' });
}));

app.post('/admin/broadcast', checkAdmin, wrap(async (req, res) => {
    const message = String(req.body.message || '').slice(0, 3500);
    if (!message.trim()) return res.json({ ok: false, message: 'Empty message' });
    const ids = (await User.find({ isBanned: false }, { id: 1 })).map(u => u.id);
    res.json({ ok: true, message: `Broadcast started for ${ids.length} users.` });
    for (const id of ids) {
        await sendMsg(id, message, undefined, false);
        await sleep(60);
    }
}));

// ---------- START ----------

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    if (PUBLIC_URL.startsWith('https://')) {
        const r = await tg('setWebhook', {
            url: `${PUBLIC_URL}/api/webhook`,
            secret_token: WEBHOOK_SECRET,
            allowed_updates: ['message', 'callback_query']
        });
        console.log(r.ok ? '✅ Telegram webhook set' : '❌ Webhook failed', r.description || '');
    } else {
        console.log('⚠️ PUBLIC_URL (https) not set - webhook not configured.');
    }
});
